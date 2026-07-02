"""
Inference Engine — shared YOLO model wrapper for camera streams

Multiple camera threads share cached model instances, keyed by model
path, to avoid excessive GPU memory consumption. A model is loaded once
per distinct path and reused by every camera that references it.
"""
import threading


class _SharedModel:
    """Internal singleton — caches one YOLO instance per model path."""

    def __init__(self):
        self._lock = threading.Lock()
        self._models: dict = {}

    def predict(self, frame, model_path: str, conf=0.25, iou=0.45, imgsz=640):
        from ultralytics import YOLO

        with self._lock:
            model = self._models.get(model_path)
            if model is None:
                model = YOLO(model_path)
                self._models[model_path] = model
        return model.predict(
            frame, conf=conf, iou=iou, imgsz=imgsz, verbose=False
        )

    def unload(self):
        with self._lock:
            self._models.clear()


_shared = _SharedModel()


def predict(frame, model_path: str, conf=0.25, iou=0.45, imgsz=640):
    return _shared.predict(frame, model_path, conf, iou, imgsz)


def unload_model():
    _shared.unload()
