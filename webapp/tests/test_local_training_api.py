import importlib
import sys
import types
from pathlib import Path


def load_app(monkeypatch, tmp_path):
    monkeypatch.setenv("MODEL_PATH", str(tmp_path / "models"))
    monkeypatch.setenv("DATASET_PATH", str(tmp_path / "dataset"))
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


class ImmediateThread:
    def __init__(self, target, daemon=None):
        self.target = target
        self.daemon = daemon

    def start(self):
        self.target()


def install_fake_yolo(monkeypatch):
    class FakeYOLO:
        calls = []

        def __init__(self, model):
            self.model = model

        def train(self, **kwargs):
            FakeYOLO.calls.append({"model": self.model, **kwargs})
            run_dir = Path(kwargs["project"]) / kwargs["name"]
            weights = run_dir / "weights"
            weights.mkdir(parents=True)
            (weights / "best.pt").write_bytes(b"best")
            (run_dir / "results.csv").write_text(
                "epoch,train/box_loss,metrics/mAP50(B),metrics/mAP50-95(B)\n"
                "0,0.2,0.8,0.6\n",
                encoding="utf-8",
            )
            return types.SimpleNamespace(save_dir=str(run_dir))

    ultralytics_mod = types.ModuleType("ultralytics")
    ultralytics_mod.YOLO = FakeYOLO
    monkeypatch.setitem(sys.modules, "ultralytics", ultralytics_mod)
    return FakeYOLO


def make_training_files(tmp_path):
    dataset = tmp_path / "dataset" / "auto_improve"
    dataset.mkdir(parents=True)
    (dataset / "data.yaml").write_text(
        "path: .\ntrain: images/train\nval: images/val\nnames: ['part']\n",
        encoding="utf-8",
    )
    model_dir = tmp_path / "models"
    model_dir.mkdir()
    model_path = model_dir / "best.pt"
    model_path.write_bytes(b"model")
    train_images = dataset / "images" / "train"
    train_labels = dataset / "labels" / "train"
    train_images.mkdir(parents=True)
    train_labels.mkdir(parents=True)
    (train_images / "labeled.jpg").write_bytes(b"image")
    (train_labels / "labeled.txt").write_text("0 0.5 0.5 0.2 0.2\n", encoding="utf-8")
    return model_path


def test_training_readiness_falls_back_from_missing_absolute_yaml_root(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    make_training_files(tmp_path)
    data_yaml = tmp_path / "dataset" / "auto_improve" / "data.yaml"
    readiness = app_mod._training_label_readiness(
        data_yaml,
        {"path": "Z:/not-mounted/auto_improve", "train": "images/train"},
    )

    assert readiness == {"total": 1, "labeled": 1}


def test_train_status_uses_local_state_when_remote_server_is_offline(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    monkeypatch.setattr(app_mod, "yolo_get", lambda path="/": {"status": "offline"})

    response = app_mod.app.test_client().get("/api/train/status")

    assert response.status_code == 200
    data = response.get_json()
    assert data["status"] == "idle"
    assert data["runner"] == "local"
    assert data["remote_status"] == "offline"


def test_train_start_runs_local_fallback_when_remote_server_is_offline(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    fake_yolo = install_fake_yolo(monkeypatch)
    model_path = make_training_files(tmp_path)
    monkeypatch.setattr(app_mod, "yolo_get", lambda path="/": {"status": "offline"})
    monkeypatch.setattr(app_mod.threading, "Thread", ImmediateThread)

    response = app_mod.app.test_client().post(
        "/api/train/start",
        json={
            "model": str(model_path),
            "data": "/dataset/auto_improve/data.yaml",
            "epochs": 1,
            "batch": 2,
            "imgsz": 64,
            "name": "smoke_train",
        },
    )

    assert response.status_code == 200
    data = response.get_json()
    assert data["ok"] is True
    assert data["runner"] == "local"
    status = app_mod.app.test_client().get("/api/train/status").get_json()
    assert status["status"] == "completed"
    assert status["run_name"] == "smoke_train"
    assert Path(status["best_pt"]).exists()
    assert fake_yolo.calls[0]["model"] == str(model_path)
    assert fake_yolo.calls[0]["data"].endswith("auto_improve\\data.yaml") or fake_yolo.calls[0]["data"].endswith("auto_improve/data.yaml")


def test_train_start_blocks_dataset_without_labeled_train_images(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    fake_yolo = install_fake_yolo(monkeypatch)
    model_path = make_training_files(tmp_path)
    train_dir = tmp_path / "dataset" / "auto_improve" / "images" / "train"
    train_dir.mkdir(parents=True, exist_ok=True)
    (train_dir / "unlabeled.jpg").write_bytes(b"image")
    (tmp_path / "dataset" / "auto_improve" / "labels" / "train" / "labeled.txt").unlink()
    monkeypatch.setattr(app_mod, "yolo_get", lambda path="/": {"status": "offline"})
    monkeypatch.setattr(app_mod.threading, "Thread", ImmediateThread)

    response = app_mod.app.test_client().post(
        "/api/train/start",
        json={
            "model": str(model_path),
            "data": "/dataset/auto_improve/data.yaml",
            "epochs": 1,
            "name": "must_not_start",
        },
    )

    assert response.status_code == 400
    data = response.get_json()
    assert data["ok"] is False
    assert "label" in data["error"].lower()
    assert fake_yolo.calls == []


def test_train_start_blocks_unlabeled_dataset_before_remote_runner(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    model_path = make_training_files(tmp_path)
    (tmp_path / "dataset" / "auto_improve" / "labels" / "train" / "labeled.txt").unlink()
    remote_calls = []
    monkeypatch.setattr(app_mod, "yolo_get", lambda path="/": {"status": "ok"})
    monkeypatch.setattr(app_mod, "yolo_post", lambda payload: remote_calls.append(payload) or {"ok": True})

    response = app_mod.app.test_client().post(
        "/api/train/start",
        json={
            "model": str(model_path),
            "data": "/dataset/auto_improve/data.yaml",
            "epochs": 1,
            "name": "remote_must_not_start",
        },
    )

    assert response.status_code == 400
    data = response.get_json()
    assert data["ok"] is False
    assert data["readiness"] == {"total": 1, "labeled": 0}
    assert remote_calls == []
