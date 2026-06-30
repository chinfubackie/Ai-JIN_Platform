import importlib
import json
import sys
from pathlib import Path


def load_app(monkeypatch, tmp_path):
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


def test_export_ndjson_writes_dataset_snapshot(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    dataset = Path(app_mod.DATASET)
    image_dir = dataset / "auto_improve" / "images" / "train" / "part_a"
    label_dir = dataset / "auto_improve" / "labels" / "train" / "part_a"
    image_dir.mkdir(parents=True)
    label_dir.mkdir(parents=True)
    (image_dir / "sample.jpg").write_bytes(b"not-a-real-image")
    (label_dir / "sample.txt").write_text("0 0.5 0.5 0.25 0.25\n", encoding="utf-8")

    response = app_mod.app.test_client().post("/api/import/export-ndjson")

    assert response.status_code == 200
    data = response.get_json()
    assert data["ok"] is True
    assert data["images"] == 1
    assert data["annotations"] == 1

    lines = Path(data["path"]).read_text(encoding="utf-8").splitlines()
    assert json.loads(lines[0])["type"] == "dataset"
    record = json.loads(lines[1])
    assert record["type"] == "image"
    assert record["split"] == "train"
    assert record["annotations"][0]["bbox"] == [0.5, 0.5, 0.25, 0.25]
