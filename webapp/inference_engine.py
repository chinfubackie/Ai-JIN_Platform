"""
Inference Engine — shared YOLO model wrapper for camera streams

Multiple camera threads share cached model instances, keyed by (model_path, device)
to avoid reloading when the same model is used on different devices.
"""
import threading


class _SharedModel:
    def __init__(self):
        self._lock = threading.Lock()
        self._models: dict = {}  # key: (path, device)

    def predict(self, frame, model_path: str, conf=0.25, iou=0.45, imgsz=640, device="cpu"):
        from ultralytics import YOLO

        key = (model_path, device)
        with self._lock:
            model = self._models.get(key)
            if model is None:
                model = YOLO(model_path)
                self._models[key] = model
        return model.predict(
            frame, conf=conf, iou=iou, imgsz=imgsz, verbose=False, device=device
        )

    def unload(self):
        with self._lock:
            self._models.clear()


_shared = _SharedModel()


def predict(frame, model_path: str, conf=0.25, iou=0.45, imgsz=640, device="cpu"):
    return _shared.predict(frame, model_path, conf, iou, imgsz, device)


def unload_model():
    _shared.unload()
