import importlib
import sys
import types
from io import BytesIO
from pathlib import Path


def load_app(monkeypatch, tmp_path):
    monkeypatch.setenv("MODEL_PATH", str(tmp_path / "models"))
    monkeypatch.setenv("DATASET_PATH", str(tmp_path / "dataset"))
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    try:
        import app
        return importlib.reload(app)
    finally:
        try:
            sys.path.remove(str(Path(__file__).resolve().parents[1]))
        except ValueError:
            pass


def install_fake_vision_stack(monkeypatch):
    class FakeBox:
        xyxy = [types.SimpleNamespace(tolist=lambda: [10.2, 20.4, 110.8, 220.1])]
        cls = [0]
        conf = [0.8765]

    class FakeResult:
        orig_shape = (480, 640)
        names = {0: "part_a"}
        boxes = [FakeBox()]

    class FakeYOLO:
        calls = []

        def __init__(self, model_path):
            self.model_path = model_path

        def predict(self, **kwargs):
            FakeYOLO.calls.append({"model_path": self.model_path, **kwargs})
            return [FakeResult()]

    ultralytics_mod = types.ModuleType("ultralytics")
    ultralytics_mod.YOLO = FakeYOLO

    cv2_mod = types.ModuleType("cv2")
    cv2_mod.IMREAD_COLOR = 1
    cv2_mod.imdecode = lambda arr, flags: object()

    monkeypatch.setitem(sys.modules, "ultralytics", ultralytics_mod)
    monkeypatch.setitem(sys.modules, "cv2", cv2_mod)
    return FakeYOLO


def test_predict_local_accepts_frontend_file_field_and_returns_inference_contract(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    fake_yolo = install_fake_vision_stack(monkeypatch)
    model_dir = tmp_path / "models"
    model_dir.mkdir(parents=True)
    model_path = model_dir / "best.pt"
    model_path.write_bytes(b"model")

    response = app_mod.app.test_client().post(
        "/api/predict/local",
        data={
            "file": (BytesIO(b"image-bytes"), "part.jpg"),
            "model": str(model_path),
            "conf": "0.33",
            "iou": "0.55",
            "imgsz": "512",
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    data = response.get_json()
    assert data["status"] == "ok"
    assert data["count"] == 1
    assert data["model"] == str(model_path)
    assert data["parameters"] == {"conf": 0.33, "iou": 0.55, "imgsz": 512}
    assert data["detections"] == data["results"]
    assert data["results"][0]["class"] == "part_a"
    assert data["results"][0]["class_name"] == "part_a"
    assert fake_yolo.calls[0]["conf"] == 0.33
    assert fake_yolo.calls[0]["iou"] == 0.55
    assert fake_yolo.calls[0]["imgsz"] == 512


def test_inference_route_serves_spa_shell_for_direct_open(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)

    response = app_mod.app.test_client().get("/demo")

    assert response.status_code == 200
    assert b"Ai-JIN" in response.data
