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

        app_mod = importlib.reload(app)
        monkeypatch.setattr(
            app_mod._db,
            "image_move_path",
            lambda old_path, new_path, split: 0,
        )
        return app_mod
    finally:
        try:
            sys.path.remove(str(Path(__file__).resolve().parents[1]))
        except ValueError:
            pass


def create_split_images(dataset_root, include_duplicate=False):
    auto_root = dataset_root / "auto_improve"
    originals = []
    for index, minute in enumerate((0, 2, 4, 6)):
        name = f"part_20260717_09{minute:02d}00_000001.jpg"
        image = auto_root / "images/train" / name
        label = auto_root / "labels/train" / Path(name).with_suffix(".txt")
        image.parent.mkdir(parents=True, exist_ok=True)
        label.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(f"image-{index}".encode("utf-8"))
        label.write_text("0 0.5 0.5 0.2 0.2\n", encoding="utf-8")
        originals.append(image)
    if include_duplicate:
        duplicate = auto_root / "images/val" / originals[0].name
        duplicate.parent.mkdir(parents=True, exist_ok=True)
        duplicate.write_bytes(originals[0].read_bytes())
    return originals


def preview(client, **overrides):
    body = {
        "train_ratio": 0.8,
        "val_ratio": 0.1,
        "test_ratio": 0.1,
        "session_gap_seconds": 30,
        "seed": 42,
    }
    body.update(overrides)
    return client.post("/api/import/split/preview", json=body)


def test_split_preview_returns_persisted_plan(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    create_split_images(Path(app_mod.DATASET), include_duplicate=True)

    response = preview(app_mod.app.test_client())

    assert response.status_code == 200
    data = response.get_json()
    assert data["plan_id"]
    assert data["summary"]["duplicates"] == 1
    assert set(data["summary"]["proposed"]) == {"train", "val", "test"}
    assert Path(data["plan_path"]).exists()


def test_split_preview_rejects_invalid_ratios(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)

    response = preview(app_mod.app.test_client(), train_ratio=0.9)

    assert response.status_code == 400
    assert "sum to 1" in response.get_json()["error"]


def test_split_apply_uses_persisted_plan(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    create_split_images(Path(app_mod.DATASET), include_duplicate=True)
    client = app_mod.app.test_client()
    plan_id = preview(client).get_json()["plan_id"]

    response = client.post(
        "/api/import/split/apply",
        json={"plan_id": plan_id},
    )

    assert response.status_code == 200
    data = response.get_json()
    assert data["ok"] is True
    assert data["manifest_id"] == plan_id
    assert data["quarantined_duplicates"] == 1


def test_split_apply_rejects_stale_plan(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    originals = create_split_images(Path(app_mod.DATASET))
    client = app_mod.app.test_client()
    plan_id = preview(client).get_json()["plan_id"]
    originals[0].write_bytes(b"changed")

    response = client.post(
        "/api/import/split/apply",
        json={"plan_id": plan_id},
    )

    assert response.status_code == 409
    assert "changed after preview" in response.get_json()["error"]


def test_split_apply_reports_transaction_failure_as_server_error(
    monkeypatch,
    tmp_path,
):
    app_mod = load_app(monkeypatch, tmp_path)

    def fail_apply(*args, **kwargs):
        raise app_mod._dataset_split.SplitApplyError("move failed")

    monkeypatch.setattr(
        app_mod._dataset_split,
        "apply_split_plan",
        fail_apply,
    )

    response = app_mod.app.test_client().post(
        "/api/import/split/apply",
        json={"plan_id": "plan-1"},
    )

    assert response.status_code == 500
    assert response.get_json()["error"] == "move failed"


def test_split_undo_restores_sources(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    originals = create_split_images(Path(app_mod.DATASET))
    client = app_mod.app.test_client()
    plan_id = preview(client).get_json()["plan_id"]
    applied = client.post(
        "/api/import/split/apply",
        json={"plan_id": plan_id},
    ).get_json()

    response = client.post(
        "/api/import/split/undo",
        json={"manifest_id": applied["manifest_id"]},
    )

    assert response.status_code == 200
    assert response.get_json()["ok"] is True
    assert all(path.exists() for path in originals)


def test_split_info_includes_test_and_coverage(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    auto_root = Path(app_mod.DATASET) / "auto_improve"
    for split in ("train", "test"):
        image = auto_root / "images" / split / f"{split}.jpg"
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(split.encode("utf-8"))
    label = auto_root / "labels/train/train.txt"
    label.parent.mkdir(parents=True, exist_ok=True)
    label.write_text("0 0.5 0.5 0.2 0.2\n", encoding="utf-8")

    response = app_mod.app.test_client().get("/api/import/split-info")

    assert response.status_code == 200
    data = response.get_json()
    assert set(data) == {"train", "val", "test"}
    assert data["train"]["non_empty_labels"] == 1
    assert data["train"]["label_coverage"] == 100.0
    assert data["test"]["total"] == 1
    assert data["test"]["label_coverage"] == 0.0


def test_generated_yaml_includes_test_path(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)

    response = app_mod.app.test_client().post(
        "/api/import/generate-yaml",
        json={"classes": ["part"]},
    )

    assert response.status_code == 200
    assert "test: images/test\n" in response.get_json()["yaml"]
