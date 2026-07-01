"""
Inference Engine — shared YOLO model wrapper for camera streams

Multiple camera threads share one active model to avoid excessive GPU
memory consumption.  Model is (re)loaded only when the requested path
differs from the cached one.
"""
import threading
from typing import Optional


class _SharedModel:
    """Internal singleton — single YOLO instance shared across cameras."""

    def __init__(self):
        self._lock = threading.Lock()
        self._model = None
        self._path: Optional[str] = None

    def predict(self, frame, model_path: str, conf=0.25, iou=0.45, imgsz=640):
        from ultralytics import YOLO

        with self._lock:
            if self._path != model_path:
                self._model = YOLO(model_path)
                self._path = model_path
            model = self._model
        return model.predict(
            frame, conf=conf, iou=iou, imgsz=imgsz, verbose=False
        )

    def unload(self):
        with self._lock:
            self._model = None
            self._path = None


_shared = _SharedModel()


def predict(frame, model_path: str, conf=0.25, iou=0.45, imgsz=640):
    return _shared.predict(frame, model_path, conf, iou, imgsz)


def unload_model():
    _shared.unload()
