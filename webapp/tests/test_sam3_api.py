import importlib
import sys
from pathlib import Path


def load_app(monkeypatch, tmp_path):
    monkeypatch.setenv("MODEL_PATH", str(tmp_path / "models"))
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
