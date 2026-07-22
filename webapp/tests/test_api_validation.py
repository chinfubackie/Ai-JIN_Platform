import importlib
import sys
from pathlib import Path


def load_app(monkeypatch, tmp_path):
    monkeypatch.setenv("DATASET_PATH", str(tmp_path / "dataset"))
    monkeypatch.setenv("MODEL_PATH", str(tmp_path / "models"))
    monkeypatch.setenv("RUNS_PATH", str(tmp_path / "runs"))
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    try:
        import app

        return importlib.reload(app)
    finally:
        try:
            sys.path.remove(str(Path(__file__).resolve().parents[1]))
        except ValueError:
            pass


def test_predict_rejects_missing_image_without_proxy_call(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    proxy_calls = []
    monkeypatch.setattr(
        app_mod,
        "yolo_post",
        lambda body: proxy_calls.append(body) or {"detections": []},
    )

    response = app_mod.app.test_client().post("/api/predict")

    assert response.status_code == 400
    assert response.get_json() == {"error": "No image provided"}
    assert proxy_calls == []


def test_label_save_rejects_missing_image_path_without_writing(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)

    response = app_mod.app.test_client().post("/api/label/save", json={})

    assert response.status_code == 400
    assert response.get_json() == {
        "ok": False,
        "error": "image_path is required",
    }
    assert not (tmp_path / "labels").exists()


def test_deploy_rejects_missing_source_as_bad_request(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)

    response = app_mod.app.test_client().post("/api/models/deploy", json={})

    assert response.status_code == 400
    assert response.get_json() == {
        "ok": False,
        "error": "source is required",
    }


def test_images_missing_directory_keeps_pagination_schema(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)

    response = app_mod.app.test_client().get(
        "/api/images?dir=auto_improve/images&page=2&per_page=5"
    )

    assert response.status_code == 200
    assert response.get_json() == {
        "images": [],
        "total": 0,
        "page": 2,
        "pages": 0,
    }


def test_generate_yaml_creates_empty_dataset_root(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)

    response = app_mod.app.test_client().post(
        "/api/import/generate-yaml",
        json={},
    )

    assert response.status_code == 200
    data = response.get_json()
    assert data["ok"] is True
    assert Path(data["path"]).exists()
