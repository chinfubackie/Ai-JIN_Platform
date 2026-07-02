"""
Camera Manager — จัดการกล้อง RTSP/USB แบบ Thread-safe

หัวใจของระบบ:
- 1 Camera = 1 Thread (capture + inference loop)
- Frame Buffer แบบ Ring Buffer (ไม่ค้าง)
- Auto-reconnect เมื่อกล้อง disconnect
- SSE Streaming สำหรับส่ง frame + results ไป Frontend
- Inference + Counting ในตัว
"""

import threading
import time
import json
import queue
import numpy as np
from pathlib import Path
from dataclasses import dataclass, field, asdict
from typing import Optional
from collections import deque

# ── Thread-safe ID generator ──
_camera_id_lock = threading.Lock()
_next_camera_id = 1


def _new_camera_id():
    global _next_camera_id
    with _camera_id_lock:
        _id = _next_camera_id
        _next_camera_id += 1
        return _id


@dataclass
class CameraConfig:
    """การตั้งค่าของกล้องแต่ละตัว"""
    source: str  # RTSP URL, "0" for USB camera 0, "/dev/video0"
    name: str = ""
    fps_target: int = 15  # target FPS for inference (not capture)
    width: int = 640
    height: int = 480
    conf_threshold: float = 0.25
    iou_threshold: float = 0.45
    model_path: str = ""  # empty = use current deployed model
    imgsz: int = 640
    enable_counting: bool = True
    enable_tracking: bool = True
    inference_every_n: int = 3  # run YOLO every N frames


@dataclass
class CameraState:
    """สถานะปัจจุบันของกล้อง"""
    id: int = 0
    status: str = "idle"  # idle | connecting | streaming | error | stopped
    fps: float = 0.0
    frame_count: int = 0
    uptime: float = 0.0
    error: str = ""
    source: str = ""
    name: str = ""
    model: str = ""
    detections: int = 0  # objects detected in last inference


class FrameBuffer:
    """Ring buffer สำหรับ frame ล่าสุด — ไม่ค้าง, ไม่ OOM"""

    def __init__(self, maxsize=30):
        self.maxsize = maxsize
        self._lock = threading.Lock()
        self._frames = deque(maxlen=maxsize)

    def put(self, frame):
        with self._lock:
            self._frames.append(frame)

    def latest(self):
        with self._lock:
            if not self._frames:
                return None
            return self._frames[-1]

    def clear(self):
        with self._lock:
            self._frames.clear()

    def __len__(self):
        with self._lock:
            return len(self._frames)


class _SSEBroadcastMixin:
    """ส่ง frame ไปยัง SSE subscribers — ใช้ร่วมกันระหว่าง CameraThread
    (จับภาพเองฝั่งเซิร์ฟเวอร์) และ BrowserCameraSession (รับเฟรมจาก
    เบราว์เซอร์ผ่าน HTTP POST) เพื่อให้ทั้งสองแบบใช้ /stream SSE เดียวกันได้"""

    def _broadcast_frame(self, frame):
        cv2 = self._cv2
        with self._sse_lock:
            if not self._sse_clients:
                return
            _, jpeg_data = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 60])
            frame_b64 = jpeg_data.tobytes().hex()

            msg = json.dumps({
                "type": "frame",
                "camera_id": self.camera_id,
                "ts": time.time(),
                "jpeg": frame_b64,
            })

            dead = []
            for i, q in enumerate(self._sse_clients):
                try:
                    q.put_nowait(f"data: {msg}\n\n")
                except queue.Full:
                    dead.append(i)

            for i in reversed(dead):
                self._sse_clients.pop(i)

    def subscribe_sse(self) -> queue.Queue:
        """ลงทะเบียน SSE subscriber — คืน Queue สำหรับรับ data"""
        q = queue.Queue(maxsize=60)
        with self._sse_lock:
            self._sse_clients.append(q)
        return q

    def unsubscribe_sse(self, q):
        """ยกเลิก SSE subscriber"""
        with self._sse_lock:
            try:
                self._sse_clients.remove(q)
            except ValueError:
                pass


class CameraThread(_SSEBroadcastMixin, threading.Thread):
    """เธรดสำหรับกล้อง 1 ตัว — จับภาพ + inference + ส่ง SSE"""

    def __init__(self, config: CameraConfig, camera_id: Optional[int] = None):
        super().__init__(daemon=True)
        self.config = config
        self.camera_id = camera_id if camera_id is not None else _new_camera_id()
        self.state = CameraState(
            id=self.camera_id,
            status="idle",
            source=config.source,
            name=config.name or config.source,
        )

        self._frame_buffer = FrameBuffer(maxsize=15)
        self._result_buffer = deque(maxlen=30)  # ผลลัพธ์ inference ล่าสุด
        self._result_lock = threading.Lock()

        self._stop_event = threading.Event()
        self._cap = None  # cv2.VideoCapture — created lazily in run()

        # สำหรับ SSE subscribers
        self._sse_clients: list[queue.Queue] = []
        self._sse_lock = threading.Lock()

        # ตัวแปรสำหรับ tracking และ counting
        self._tracker = None
        self._counting_engine = None
        self._frame_counter = 0

    def run(self):
        import cv2
        self._cv2 = cv2

        self.state.status = "connecting"
        self.state.uptime = time.time()

        # ถ้า source เป็นตัวเลข (USB camera index)
        try:
            cam_index = int(self.config.source)
            self._cap = cv2.VideoCapture(cam_index)
        except ValueError:
            self._cap = cv2.VideoCapture(self.config.source)

        if not self._cap or not self._cap.isOpened():
            self.state.status = "error"
            self.state.error = f"ไม่สามารถเปิดกล้อง: {self.config.source}"
            return

        # ตั้งค่า resolution
        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.config.width)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.config.height)

        self.state.status = "streaming"
        frame_count = 0
        fps_start = time.time()

        # Cooldown สำหรับ auto-reconnect
        reconnect_delay = 0

        from app import _resolve_training_model

        # Create counting engine
        from counting import CountingEngine
        self._counting_engine = CountingEngine(self.camera_id)

        while not self._stop_event.is_set():
            ret, frame = self._cap.read()

            if not ret:
                self.state.status = "error"
                self.state.error = "กล้อง disconnect"

                if reconnect_delay < 10:
                    reconnect_delay += 1
                time.sleep(reconnect_delay)

                self._cap.release()
                time.sleep(1)
                try:
                    cam_index = int(self.config.source)
                    self._cap = cv2.VideoCapture(cam_index)
                except ValueError:
                    self._cap = cv2.VideoCapture(self.config.source)

                if self._cap and self._cap.isOpened():
                    self.state.status = "streaming"
                    self.state.error = ""
                    reconnect_delay = 0
                    self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.config.width)
                    self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.config.height)
                continue

            reconnect_delay = 0

            try:
                # Resize ถ้าจำเป็น
                if frame.shape[1] != self.config.width or frame.shape[0] != self.config.height:
                    frame = cv2.resize(frame, (self.config.width, self.config.height))

                # ใส่ Frame buffer
                self._frame_buffer.put(frame)
                frame_count += 1
                self._frame_counter += 1

                # FPS counter
                elapsed = time.time() - fps_start
                if elapsed >= 2.0:
                    self.state.fps = frame_count / elapsed
                    self.state.frame_count += frame_count
                    frame_count = 0
                    fps_start = time.time()

                # Broadcast frame ไป SSE clients
                self._broadcast_frame(frame)

                # Run inference ทุก N frames
                if self._frame_counter % self.config.inference_every_n == 0:
                    self._run_inference(frame, _resolve_training_model)
            except Exception as e:
                # เฟรมเสียเฟรมเดียวไม่ควรทำให้ทั้ง thread ตาย — ข้ามแล้วไปต่อ
                self.state.error = f"Frame processing error: {e}"

            # Target FPS control
            target_interval = 1.0 / self.config.fps_target
            time.sleep(max(0, target_interval - 0.005))

        # Cleanup
        if self._cap:
            self._cap.release()
        self.state.status = "stopped"

    def _run_inference(self, frame, resolve_model):
        """Run YOLO inference + counting on a frame and broadcast results."""
        model_ref = self.config.model_path or ""
        if not model_ref:
            try:
                model_ref = resolve_model("best.pt")
            except Exception:
                model_ref = ""
        if not model_ref:
            return

        try:
            from inference_engine import predict

            conf = self.config.conf_threshold
            iou = self.config.iou_threshold
            results = predict(frame, model_ref, conf=conf, iou=iou, imgsz=self.config.imgsz)

            detections = []
            for result in results:
                for box, cls_id, conf_val in zip(result.boxes.xyxy, result.boxes.cls, result.boxes.conf):
                    x1, y1, x2, y2 = box.tolist()
                    detections.append({
                        "class_id": int(cls_id.item()),
                        "class_name": result.names.get(int(cls_id.item()), f"class_{int(cls_id.item())}"),
                        "confidence": float(conf_val.item()),
                        "bbox": [
                            x1 / frame.shape[1],
                            y1 / frame.shape[0],
                            x2 / frame.shape[1],
                            y2 / frame.shape[0],
                        ],
                    })

            self.state.model = model_ref
            self.state.detections = len(detections)
            self.state.error = ""

            if self.config.enable_counting and self._counting_engine and detections:
                counting_result = self._counting_engine.update(detections)
                self._broadcast_result(counting_result)
        except Exception as e:
            self.state.error = f"Inference error: {e}"

    def _broadcast_result(self, result_dict):
        """ส่ง inference result ไปยัง SSE subscribers (counting stats)"""
        with self._sse_lock:
            if not self._sse_clients:
                return
            with self._result_lock:
                self._result_buffer.append(result_dict)

            msg = json.dumps({
                "type": "result",
                "camera_id": self.camera_id,
                "ts": time.time(),
                **result_dict,
            })

            dead = []
            for i, q in enumerate(self._sse_clients):
                try:
                    q.put_nowait(f"data: {msg}\n\n")
                except queue.Full:
                    dead.append(i)

            for i in reversed(dead):
                self._sse_clients.pop(i)

    def stop(self):
        """หยุดกล้อง"""
        self._stop_event.set()

    def get_latest_frame(self):
        """ได้ frame ล่าสุด (สำหรับ inference)"""
        return self._frame_buffer.latest()

    def get_status(self) -> dict:
        """ได้สถานะกล้องปัจจุบัน"""
        return asdict(self.state)

    def get_counting_engine(self):
        return self._counting_engine


class BrowserCameraSession(_SSEBroadcastMixin):
    """กล้องที่รับเฟรมจากเบราว์เซอร์ของผู้ใช้เอง (getUserMedia) แทนที่จะเปิด
    cv2.VideoCapture ที่ฝั่งเซิร์ฟเวอร์ — ใช้เมื่ออยากนับ/ตรวจจับด้วยกล้อง
    ของเครื่องที่เปิดหน้าเว็บ ไม่ใช่กล้องที่ต่อกับเซิร์ฟเวอร์

    เบราว์เซอร์ POST เฟรมมาเรื่อย ๆ ที่ /api/cameras/browser/<id>/frame —
    ไม่มี capture loop ของตัวเอง (ไม่ใช่ Thread) เพราะไม่มีอะไรให้ pull;
    ทุกอย่างขับเคลื่อนจากเฟรมที่ push เข้ามา แต่ยังคง broadcast ผ่าน SSE
    เดียวกับ CameraThread เพื่อให้เครื่องอื่นดูสตรีมนี้ได้ด้วย"""

    def __init__(self, name: str, camera_id: Optional[int] = None,
                 conf_threshold: float = 0.25, iou_threshold: float = 0.45,
                 model_path: str = "", imgsz: int = 640,
                 enable_counting: bool = True):
        self.camera_id = camera_id if camera_id is not None else _new_camera_id()
        self.conf_threshold = conf_threshold
        self.iou_threshold = iou_threshold
        self.model_path = model_path
        self.imgsz = imgsz
        self.enable_counting = enable_counting

        self.state = CameraState(
            id=self.camera_id,
            status="streaming",
            source="browser",
            name=name or f"Browser cam #{self.camera_id}",
        )
        self.state.uptime = time.time()

        self._sse_clients: list[queue.Queue] = []
        self._sse_lock = threading.Lock()
        self._cv2 = None  # lazy import on first frame

        self._frame_count = 0
        self._fps_window_start = time.time()
        self._fps_window_count = 0

        from counting import CountingEngine
        self._counting_engine = CountingEngine(self.camera_id)

    def process_frame(self, jpeg_bytes: bytes, resolve_model) -> dict:
        """ถอดรหัสเฟรม JPEG จากเบราว์เซอร์ -> inference -> counting -> broadcast"""
        if self._cv2 is None:
            import cv2
            self._cv2 = cv2
        cv2 = self._cv2

        arr = np.frombuffer(jpeg_bytes, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("ไม่สามารถอ่านภาพที่ส่งมาได้")

        self._frame_count += 1
        self.state.frame_count = self._frame_count
        self._fps_window_count += 1
        elapsed = time.time() - self._fps_window_start
        if elapsed >= 2.0:
            self.state.fps = self._fps_window_count / elapsed
            self._fps_window_count = 0
            self._fps_window_start = time.time()

        self._broadcast_frame(frame)

        model_ref = self.model_path or ""
        if not model_ref:
            try:
                model_ref = resolve_model("best.pt")
            except Exception:
                model_ref = ""
        if not model_ref:
            return {"detections": [], "counting": None}

        try:
            from inference_engine import predict
            results = predict(
                frame, model_ref, conf=self.conf_threshold,
                iou=self.iou_threshold, imgsz=self.imgsz,
            )
            detections = []
            for result in results:
                for box, cls_id, conf_val in zip(result.boxes.xyxy, result.boxes.cls, result.boxes.conf):
                    x1, y1, x2, y2 = box.tolist()
                    detections.append({
                        "class_id": int(cls_id.item()),
                        "class_name": result.names.get(int(cls_id.item()), f"class_{int(cls_id.item())}"),
                        "confidence": float(conf_val.item()),
                        "bbox": [
                            x1 / frame.shape[1],
                            y1 / frame.shape[0],
                            x2 / frame.shape[1],
                            y2 / frame.shape[0],
                        ],
                    })

            self.state.model = model_ref
            self.state.detections = len(detections)
            self.state.error = ""

            counting_result = None
            if self.enable_counting and detections:
                counting_result = self._counting_engine.update(detections)
                self._broadcast_result(counting_result)

            return {"detections": detections, "counting": counting_result}
        except Exception as e:
            self.state.error = f"Inference error: {e}"
            return {"detections": [], "counting": None, "error": self.state.error}

    def _broadcast_result(self, result_dict):
        with self._sse_lock:
            if not self._sse_clients:
                return
            msg = json.dumps({
                "type": "result",
                "camera_id": self.camera_id,
                "ts": time.time(),
                **result_dict,
            })
            dead = []
            for i, q in enumerate(self._sse_clients):
                try:
                    q.put_nowait(f"data: {msg}\n\n")
                except queue.Full:
                    dead.append(i)
            for i in reversed(dead):
                self._sse_clients.pop(i)

    def stop(self):
        self.state.status = "stopped"

    def get_status(self) -> dict:
        return asdict(self.state)

    def get_counting_engine(self):
        return self._counting_engine


class CameraManager:
    """Manager กลางสำหรับกล้องทุกตัว — thread-safe"""

    def __init__(self):
        self._cameras: dict[int, CameraThread] = {}
        self._lock = threading.Lock()

    def add_camera(self, config: CameraConfig) -> int:
        """เพิ่มกล้องใหม่ — return camera_id"""
        thread = CameraThread(config)
        with self._lock:
            self._cameras[thread.camera_id] = thread
        thread.start()
        return thread.camera_id

    def add_browser_session(self, **kwargs) -> int:
        """เพิ่มกล้องที่รับเฟรมจากเบราว์เซอร์ (ไม่มี capture thread) — return camera_id"""
        session = BrowserCameraSession(**kwargs)
        with self._lock:
            self._cameras[session.camera_id] = session
        return session.camera_id

    def remove_camera(self, camera_id: int):
        """ลบกล้อง"""
        with self._lock:
            thread = self._cameras.pop(camera_id, None)
        if thread:
            thread.stop()

    def restart_camera(self, camera_id: int) -> bool:
        """เริ่มกล้องที่หยุด/error ใหม่ โดยใช้ config เดิมและ camera_id เดิม
        (Thread เดิมจบไปแล้วจึง start ซ้ำไม่ได้ ต้องสร้าง Thread ใหม่)
        ใช้ได้กับกล้องแบบ CameraThread เท่านั้น — BrowserCameraSession ไม่มี
        capture thread ให้ restart (ฝั่งเบราว์เซอร์เป็นคน push เฟรมเอง)"""
        with self._lock:
            old = self._cameras.get(camera_id)
            if old is None or not isinstance(old, CameraThread):
                return False
            new_thread = CameraThread(old.config, camera_id=camera_id)
            self._cameras[camera_id] = new_thread
        old.stop()
        new_thread.start()
        return True

    def get_camera(self, camera_id: int) -> Optional[CameraThread]:
        with self._lock:
            return self._cameras.get(camera_id)

    def list_cameras(self) -> list[dict]:
        """รายการกล้องทั้งหมด"""
        with self._lock:
            return [t.get_status() for t in self._cameras.values()]

    def stop_all(self):
        """หยุดกล้องทั้งหมด"""
        with self._lock:
            threads = list(self._cameras.values())
            self._cameras.clear()
        for t in threads:
            t.stop()


# ── Singleton ──
camera_manager = CameraManager()
