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


def test_extended_label_save_mirrors_flat_images_path(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    dataset = Path(app_mod.DATASET)
    image_path = dataset / "auto_improve" / "images" / "train" / "sample.jpg"
    image_path.parent.mkdir(parents=True)
    image_path.write_bytes(b"image")

    response = app_mod.app.test_client().post(
        "/api/label/ext/save",
        json={
            "image_path": "auto_improve/images/train/sample.jpg",
            "boxes": [[1, 0.5, 0.4, 0.2, 0.1]],
            "polygons": [],
            "classes": ["York", "Slip"],
        },
    )

    assert response.status_code == 200
    canonical_label = dataset / "auto_improve" / "labels" / "train" / "sample.txt"
    assert canonical_label.read_text(encoding="utf-8") == "1 0.500000 0.400000 0.200000 0.100000\n"
    assert not (dataset / "auto_improve" / "images" / "labels" / "sample.txt").exists()

    loaded = app_mod.app.test_client().get(
        "/api/label/ext/auto_improve/images/train/sample.jpg"
    )
    assert loaded.status_code == 200
    assert loaded.get_json()["boxes"] == [[1, 0.5, 0.4, 0.2, 0.1]]


def test_label_path_preserves_nested_class_directories(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    dataset = Path(app_mod.DATASET)
    image_path = (
        dataset
        / "auto_improve"
        / "images"
        / "val"
        / "York"
        / "nested.jpg"
    )

    assert app_mod._label_path_for_image(image_path) == (
        dataset
        / "auto_improve"
        / "labels"
        / "val"
        / "York"
        / "nested.txt"
    )
