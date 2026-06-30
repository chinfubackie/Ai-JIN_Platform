import importlib
import sys
import types
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


def test_sam3_status_reports_missing_model(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)

    client = app_mod.app.test_client()
    response = client.get("/api/sam3/status")

    assert response.status_code == 200
    data = response.get_json()
    assert data["model_exists"] is False
    assert data["model_path"].endswith("sam3.pt")
    assert data["available"] is False


def test_sam3_predict_returns_missing_model_hint(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)

    client = app_mod.app.test_client()
    response = client.post(
        "/api/sam3/predict",
        json={"image_path": "image.jpg", "text": ["person"], "conf": 0.25},
    )

    assert response.status_code == 200
    data = response.get_json()
    assert data["error"] == "sam3.pt not found"
    assert "huggingface.co/facebook/sam3" in data["hint"]


def install_fake_sam3(monkeypatch):
    class FakeSAM3SemanticPredictor:
        instances = []

        def __init__(self, overrides):
            self.overrides = overrides
            self.image_path = None
            self.calls = []
            self.args = types.SimpleNamespace(conf=overrides.get("conf"))
            FakeSAM3SemanticPredictor.instances.append(self)

        def set_image(self, image_path):
            self.image_path = image_path

        def __call__(self, **kwargs):
            self.calls.append(kwargs)
            return []

    ultralytics_mod = types.ModuleType("ultralytics")
    models_mod = types.ModuleType("ultralytics.models")
    sam_mod = types.ModuleType("ultralytics.models.sam")
    sam_mod.SAM3SemanticPredictor = FakeSAM3SemanticPredictor
    monkeypatch.setitem(sys.modules, "ultralytics", ultralytics_mod)
    monkeypatch.setitem(sys.modules, "ultralytics.models", models_mod)
    monkeypatch.setitem(sys.modules, "ultralytics.models.sam", sam_mod)
    return FakeSAM3SemanticPredictor


def test_sam3_predict_accepts_bbox_exemplars(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    fake_predictor = install_fake_sam3(monkeypatch)
    model_dir = tmp_path / "models"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "sam3.pt").write_bytes(b"model")
    image_dir = tmp_path / "dataset" / "auto_improve" / "images" / "train" / "part_a"
    image_dir.mkdir(parents=True, exist_ok=True)
    (image_dir / "sample.jpg").write_bytes(b"image")

    response = app_mod.app.test_client().post(
        "/api/sam3/predict",
        json={
            "image_path": "auto_improve/images/train/part_a/sample.jpg",
            "bboxes": [[480.0, 290.0, 590.0, 650.0]],
            "conf": 0.35,
        },
    )

    assert response.status_code == 200
    data = response.get_json()
    assert data == {"masks": [], "boxes": [], "labels": [], "count": 0}
    predictor = fake_predictor.instances[0]
    assert predictor.overrides["conf"] == 0.35
    assert predictor.overrides["quantize"] == 16
    assert predictor.calls == [{"bboxes": [[480.0, 290.0, 590.0, 650.0]]}]
