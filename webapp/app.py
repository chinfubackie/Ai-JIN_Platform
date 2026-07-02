"""Ai-JIN Platform — Web Dashboard + Live Inference + Annotation
เชื่อม Label Studio + YOLO Training Server เป็น webapp เดียว
"""
from flask import Flask, render_template, jsonify, request, send_file, Response, abort, stream_with_context
import requests
import os
import json
import time
import base64
import csv
import shutil
import threading
import traceback
import urllib.parse
import urllib.request
import uuid
from dataclasses import asdict
from pathlib import Path
import db as _db

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024 * 1024  # 1GB upload limit (video files)

# ── Config ────────────────────────────────────────────────────────────
LS_URL = os.getenv("LABEL_STUDIO_URL", "http://localhost:8085")
LS_TOKEN = os.getenv("LABEL_STUDIO_TOKEN", "")
YOLO_URL = os.getenv("YOLO_TRAIN_URL", "http://localhost:8111")
DATASET = Path(os.getenv("DATASET_PATH", r"D:\Ai-JIN_V10.0_patch_output\dataset"))
RUNS = Path(os.getenv("RUNS_PATH", r"D:\Ai-JIN_V10.0_patch_output\runs"))
MODEL_DIR = Path(os.getenv("MODEL_PATH", r"D:\Ai-JIN_Platform\models"))
IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tiff"}
VIDEO_EXT = {".mp4", ".avi", ".mov", ".mkv", ".webm"}
MAX_IMPORT_BATCH = 1500
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://192.168.93:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llava")
# Optional dedicated port for camera SSE/video streaming, so a busy stream
# doesn't need to share the same listen socket as regular API traffic.
# Empty means "same origin/port as the rest of the app" (no change).
STREAM_PORT = os.getenv("STREAM_PORT", "")
SAM3_INSTALL_HINT = (
    "ultralytics>=8.4 already ships a native SAM3 implementation "
    "(ultralytics.models.sam.SAM3SemanticPredictor) — no separate package/repo "
    "install needed. What's actually missing is the checkpoint: request access "
    "to https://huggingface.co/facebook/sam3 (gated), authenticate "
    "(e.g. `hf auth login`), download sam3.pt, and place it at models/sam3.pt "
    "(or MODEL_PATH/sam3.pt)."
)

# Runtime-mutable config (can be updated via POST /api/config without restart)
_runtime_cfg = {}
_sam3_predictor_cache = {}
_local_train_lock = threading.Lock()
_local_train_state = {
    "status": "idle",
    "state": "idle",
    "runner": "local",
    "progress": 0,
    "log": "",
}

_video_label_lock = threading.Lock()
_video_label_state = {
    "status": "idle",
    "progress": 0,
    "log": "",
}


def _video_label_snapshot():
    with _video_label_lock:
        return dict(_video_label_state)


def _set_video_label_state(**updates):
    with _video_label_lock:
        _video_label_state.update(updates)
        return dict(_video_label_state)


def _safe_path(base, user_path):
    """Resolve *user_path* under *base* and ensure it stays within *base*.

    Prevents path-traversal attacks (e.g. ``../../etc/passwd``).
    """
    resolved = (base / user_path).resolve()
    if not str(resolved).startswith(str(base.resolve())):
        abort(403, "Access denied")
    return resolved


def _load_class_name_map():
    """Build a class_id -> real_name lookup from class_mapping.json.

    class_mapping.json has {"model_to_class_id": {"RealName": 0, ...}}.
    We invert it to {0: "RealName", 1: "OtherName", ...} so generic model
    names like "class_0" can be replaced with the actual part names.
    """
    cm_file = DATASET / "auto_improve" / "class_mapping.json"
    if not cm_file.exists():
        return {}
    try:
        cm = json.loads(cm_file.read_text(encoding="utf-8"))
        name_to_id = cm.get("model_to_class_id", {})
        return {v: k for k, v in name_to_id.items()}
    except Exception:
        return {}


def _remap_class_name(cls_id, model_name, id_to_name):
    """Return the real class name, falling back to whatever the model reports."""
    if id_to_name and cls_id in id_to_name:
        return id_to_name[cls_id]
    return model_name


def _labelstudio_image_name(image_ref, fallback_stem):
    parsed = urllib.parse.urlparse(image_ref or "")
    raw_name = Path(urllib.parse.unquote(parsed.path or image_ref or "")).name
    if not raw_name:
        raw_name = f"{fallback_stem}.jpg"
    if not Path(raw_name).suffix:
        raw_name = f"{raw_name}.jpg"
    return raw_name.replace(" ", "_")


def _copy_or_download_labelstudio_image(image_ref, dest_file):
    parsed = urllib.parse.urlparse(image_ref or "")
    if parsed.scheme in ("http", "https"):
        with urllib.request.urlopen(image_ref, timeout=30) as src, dest_file.open("wb") as dst:
            shutil.copyfileobj(src, dst)
        return

    candidates = []
    if parsed.scheme == "file":
        candidates.append(Path(urllib.request.url2pathname(parsed.path)))
    if image_ref:
        candidates.append(Path(image_ref))
        candidates.append(DATASET / image_ref.lstrip("/\\"))

    for candidate in candidates:
        try:
            if candidate.exists() and candidate.is_file():
                shutil.copy2(candidate, dest_file)
                return
        except OSError:
            continue

    raise FileNotFoundError(f"image not found: {image_ref}")


def ls_headers():
    return {"Authorization": f"Token {LS_TOKEN}"} if LS_TOKEN else {}


def ls_get(path, **kw):
    try:
        r = requests.get(f"{LS_URL}{path}", headers=ls_headers(), timeout=10, **kw)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        return {"error": str(e)}


def yolo_get(path="/"):
    try:
        r = requests.get(f"{YOLO_URL}{path}", timeout=5)
        return r.json()
    except Exception:
        return {"status": "offline"}


def yolo_post(body):
    try:
        r = requests.post(YOLO_URL, json=body, timeout=120)
        return r.json()
    except Exception as e:
        return {"error": str(e)}


def _find_training_run(run_name):
    if not run_name:
        return None
    candidates = [
        RUNS / run_name,
        RUNS / "train" / run_name,
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def _sam3_model_candidates():
    return [
        Path("sam3.pt"),
        Path("models") / "sam3.pt",
        MODEL_DIR / "sam3.pt",
    ]


def _find_sam3_model():
    candidates = _sam3_model_candidates()
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate.resolve(), True
    return candidates[-1].resolve(), False


def _sam3_import_error():
    try:
        from ultralytics.models.sam import SAM3SemanticPredictor  # noqa: F401
        return None
    except ImportError as e:
        return str(e)


def _resolve_image_path(image_path):
    if not image_path:
        return None
    candidate = Path(image_path)
    if candidate.is_absolute():
        return candidate if candidate.exists() and candidate.is_file() else None
    try:
        resolved = _safe_path(DATASET, image_path)
    except Exception:
        return None
    return resolved if resolved.exists() and resolved.is_file() else None


def _json_float_list(values):
    return [round(float(v), 5) for v in values]


def _normalize_sam3_bboxes(raw_bboxes):
    if not raw_bboxes:
        return []
    if isinstance(raw_bboxes, (list, tuple)) and len(raw_bboxes) == 4 and all(
        isinstance(v, (int, float)) for v in raw_bboxes
    ):
        raw_bboxes = [raw_bboxes]
    bboxes = []
    for bbox in raw_bboxes:
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        try:
            bboxes.append([float(v) for v in bbox])
        except (TypeError, ValueError):
            continue
    return bboxes


def _serialize_sam3_results(results, text_prompts):
    masks, boxes, labels = [], [], []
    for result in results or []:
        result_labels = []
        if getattr(result, "boxes", None) is not None:
            boxes_obj = result.boxes
            xyxy = getattr(boxes_obj, "xyxy", [])
            cls_values = getattr(boxes_obj, "cls", [])
            names = getattr(result, "names", {}) or {}
            for idx, box in enumerate(xyxy):
                vals = box.tolist() if hasattr(box, "tolist") else list(box)
                boxes.append(_json_float_list(vals[:4]))
                label = None
                try:
                    cls_id = int(cls_values[idx])
                    label = names.get(cls_id) or (
                        text_prompts[cls_id] if cls_id < len(text_prompts) else None
                    )
                except Exception:
                    pass
                result_labels.append(label or (text_prompts[idx] if idx < len(text_prompts) else "concept"))

        if getattr(result, "masks", None) is not None:
            for mask_xy in getattr(result.masks, "xy", []) or []:
                pts = mask_xy.tolist() if hasattr(mask_xy, "tolist") else mask_xy
                poly = [[round(float(p[0]), 5), round(float(p[1]), 5)] for p in pts]
                if len(poly) >= 3:
                    masks.append(poly)

        labels.extend(result_labels)

    if len(labels) < len(boxes):
        labels.extend(["concept"] * (len(boxes) - len(labels)))
    return masks, boxes, labels[:len(boxes)]


def _read_training_metrics(run_name):
    run_dir = _find_training_run(run_name)
    if not run_dir:
        return {}
    results_csv = run_dir / "results.csv"
    if not results_csv.exists():
        return {"run_name": run_name, "run_dir": str(run_dir)}
    try:
        with results_csv.open("r", encoding="utf-8", newline="") as fh:
            rows = list(csv.DictReader(fh))
        if not rows:
            return {"run_name": run_name, "run_dir": str(run_dir)}
        row = rows[-1]

        def pick(*needles):
            for key, value in row.items():
                normalized = key.strip().lower().replace(" ", "")
                if all(n in normalized for n in needles):
                    try:
                        return float(value)
                    except (TypeError, ValueError):
                        return value
            return None

        return {
            "run_name": run_name,
            "run_dir": str(run_dir),
            "epoch": int(float(row.get("epoch", len(rows) - 1))) + 1,
            "loss": pick("train/box_loss") or pick("box_loss"),
            "cls_loss": pick("train/cls_loss") or pick("cls_loss"),
            "dfl_loss": pick("train/dfl_loss") or pick("dfl_loss"),
            "mAP50": pick("map50", "b"),
            "mAP50_95": pick("map50-95", "b"),
        }
    except Exception as e:
        return {"run_name": run_name, "run_dir": str(run_dir), "metrics_error": str(e)}


def _local_train_snapshot(remote_status=None):
    with _local_train_lock:
        snapshot = dict(_local_train_state)
    snapshot["runner"] = "local"
    if remote_status:
        snapshot["remote_status"] = remote_status
    return snapshot


def _set_local_train_state(**updates):
    with _local_train_lock:
        _local_train_state.update(updates)
        _local_train_state["runner"] = "local"
        return dict(_local_train_state)


def _resolve_training_data_path(data_ref):
    data_ref = data_ref or "/dataset/auto_improve/data.yaml"
    normalized = str(data_ref).replace("\\", "/")
    if normalized.startswith("/dataset/"):
        candidate = DATASET / normalized[len("/dataset/"):]
    else:
        candidate = Path(data_ref)
        if not candidate.is_absolute():
            candidate = DATASET / candidate
    candidate = candidate.resolve()
    if not candidate.exists() or not candidate.is_file():
        raise FileNotFoundError(f"training data yaml not found: {candidate}")
    return candidate


def _resolve_training_model(model_ref):
    model_ref = model_ref or "yolov8n.pt"
    candidate = Path(str(model_ref))
    if candidate.is_absolute() and candidate.exists():
        return str(candidate)
    if candidate.exists():
        return str(candidate.resolve())
    model_candidate = MODEL_DIR / str(model_ref)
    if model_candidate.exists():
        return str(model_candidate.resolve())
    return str(model_ref)


def _training_metrics_payload(run_name, epochs=None):
    metrics = _read_training_metrics(run_name)
    payload = dict(metrics)
    if metrics:
        payload["metrics"] = {
            "loss": metrics.get("loss"),
            "mAP50": metrics.get("mAP50"),
            "mAP50_95": metrics.get("mAP50_95"),
        }
        if metrics.get("epoch") and epochs:
            payload["total_epochs"] = epochs
            payload["progress"] = min(100, int((metrics["epoch"] / epochs) * 100))
    return payload


def _start_local_training(config):
    with _local_train_lock:
        if _local_train_state.get("status") == "training":
            return {"ok": False, "runner": "local", "error": "training already running"}

    try:
        from ultralytics import YOLO
    except Exception as e:
        return {
            "ok": False,
            "runner": "local",
            "error": f"Ultralytics is not installed or cannot be imported: {e}",
        }

    try:
        model = _resolve_training_model(config.get("model", "yolov8n.pt"))
        data_yaml = _resolve_training_data_path(config.get("data"))
        epochs = int(config.get("epochs", 100))
        imgsz = int(config.get("imgsz", 640))
        batch = int(config.get("batch", 16))
        run_name = config.get("name") or f"train_{time.strftime('%Y%m%d_%H%M')}"
    except Exception as e:
        return {"ok": False, "runner": "local", "error": str(e)}

    try:
        import yaml as _yaml
        yaml_data = _yaml.safe_load(data_yaml.read_text(encoding="utf-8")) or {}
        if not yaml_data.get("names"):
            return {
                "ok": False, "runner": "local",
                "error": (
                    f"{data_yaml} ไม่มีคลาส (nc=0) — เทรนไม่ได้ "
                    "ตรวจสอบว่ามีภาพที่ label แล้วอยู่ใน images/train ของ dataset "
                    "(generate-yaml จะหาคลาสจากโฟลเดอร์ที่มีภาพใน images/train เท่านั้น)"
                ),
            }
    except (OSError, ValueError):
        pass  # let ultralytics surface its own error if the yaml can't be read/parsed here

    project_dir = RUNS / "train"
    run_dir = project_dir / run_name
    _set_local_train_state(
        status="training",
        state="training",
        progress=1,
        run_name=run_name,
        run_dir=str(run_dir),
        best_pt=None,
        error=None,
        started=time.time(),
        epoch=0,
        total_epochs=epochs,
        log=f"Starting local training: model={model}, data={data_yaml}",
    )

    def worker():
        try:
            project_dir.mkdir(parents=True, exist_ok=True)
            result = YOLO(model).train(
                data=str(data_yaml),
                epochs=epochs,
                imgsz=imgsz,
                batch=batch,
                project=str(project_dir),
                name=run_name,
                exist_ok=True,
            )
            save_dir = Path(getattr(result, "save_dir", run_dir) or run_dir)
            best_pt = save_dir / "weights" / "best.pt"
            if not best_pt.exists():
                best_pt = run_dir / "weights" / "best.pt"
            if not best_pt.exists():
                raise FileNotFoundError(f"best.pt not found under {save_dir}")

            MODEL_DIR.mkdir(parents=True, exist_ok=True)
            deployed = MODEL_DIR / "best.pt"
            shutil.copy2(best_pt, deployed)

            payload = _training_metrics_payload(run_name, epochs)
            payload.update({
                "status": "completed",
                "state": "completed",
                "progress": 100,
                "run_name": run_name,
                "run_dir": str(save_dir),
                "best_pt": str(best_pt),
                "deployed_model": str(deployed),
                "finished": time.time(),
                "log": f"Local training completed. Deployed {deployed}",
            })
            _set_local_train_state(**payload)
        except Exception as e:
            _set_local_train_state(
                status="error",
                state="error",
                progress=0,
                error=str(e),
                log=traceback.format_exc(),
                finished=time.time(),
            )

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True, "runner": "local", "status": "training", "run_name": run_name}


# ── Pages ─────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return app.send_static_file("index.html")


SPA_ROUTES = {
    "dashboard", "demo", "dataset", "annotator", "import", "training",
    "models", "api-docs", "projects", "settings", "team", "cameras",
}


@app.route("/<path:spa_path>")
def spa_fallback(spa_path):
    """Serve the React shell for direct opens/refreshes of client routes."""
    if spa_path.split("/", 1)[0] in SPA_ROUTES:
        return app.send_static_file("index.html")
    abort(404)


@app.route("/healthz")
def healthz():
    return jsonify({"ok": True})


@app.route("/api/config", methods=["GET"])
def get_config():
    return jsonify({
        "ollama_url": _runtime_cfg.get("ollama_url", OLLAMA_URL),
        "ollama_model": _runtime_cfg.get("ollama_model", OLLAMA_MODEL),
        "sam_model": _runtime_cfg.get("sam_model", "sam2_b.pt"),
        "dataset_path": _runtime_cfg.get("dataset_path", str(DATASET)),
        "model_dir": _runtime_cfg.get("model_dir", str(MODEL_DIR)),
        "yolo_url": _runtime_cfg.get("yolo_url", YOLO_URL),
        "runs_path": str(RUNS),
        "stream_port": STREAM_PORT,
    })


@app.route("/api/config", methods=["POST"])
def set_config():
    global OLLAMA_URL, OLLAMA_MODEL, DATASET, MODEL_DIR, YOLO_URL
    data = request.json or {}
    if "ollama_url" in data:
        OLLAMA_URL = data["ollama_url"]
        _runtime_cfg["ollama_url"] = OLLAMA_URL
    if "ollama_model" in data:
        OLLAMA_MODEL = data["ollama_model"]
        _runtime_cfg["ollama_model"] = OLLAMA_MODEL
    if "sam_model" in data:
        _runtime_cfg["sam_model"] = data["sam_model"]
    if "dataset_path" in data and data["dataset_path"]:
        DATASET = Path(data["dataset_path"])
        _runtime_cfg["dataset_path"] = str(DATASET)
    if "model_dir" in data and data["model_dir"]:
        MODEL_DIR = Path(data["model_dir"])
        _runtime_cfg["model_dir"] = str(MODEL_DIR)
    if "yolo_url" in data:
        YOLO_URL = data["yolo_url"]
        _runtime_cfg["yolo_url"] = YOLO_URL
    return jsonify({"ok": True, "config": _runtime_cfg})



# ── API: Projects ─────────────────────────────────────────────────────
@app.route("/api/projects", methods=["GET"])
def api_projects_list():
    return jsonify(_db.project_list())


@app.route("/api/projects", methods=["POST"])
def api_projects_create():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "name required"}), 400
    try:
        pid = _db.project_create(
            name,
            description=data.get("description", ""),
            dataset_dir=data.get("dataset_dir", ""))
        return jsonify({"ok": True, "id": pid})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.route("/api/projects/<int:pid>", methods=["GET"])
def api_projects_get(pid):
    p = _db.project_get(pid)
    if not p:
        return jsonify({"error": "not found"}), 404
    p["classes"] = _db.class_list(pid)
    p["stats"] = _db.image_stats(pid)
    p["recent_runs"] = _db.run_list(project_id=pid, limit=5)
    return jsonify(p)


@app.route("/api/projects/<int:pid>", methods=["PATCH"])
def api_projects_update(pid):
    data = request.json or {}
    allowed = {"name", "description", "dataset_dir"}
    kwargs = {k: v for k, v in data.items() if k in allowed}
    _db.project_update(pid, **kwargs)
    return jsonify({"ok": True})


@app.route("/api/projects/<int:pid>", methods=["DELETE"])
def api_projects_delete(pid):
    _db.project_delete(pid)
    return jsonify({"ok": True})


@app.route("/api/projects/<int:pid>/sync", methods=["POST"])
def api_projects_sync(pid):
    """Scan dataset dir on disk and register images in DB."""
    p = _db.project_get(pid)
    if not p:
        return jsonify({"error": "not found"}), 404
    dataset_dir = p.get("dataset_dir") or ""
    if dataset_dir:
        added = _db.sync_images_from_disk(pid, dataset_dir)
    else:
        # Default: scan auto_improve under global DATASET
        added = _db.sync_images_from_disk(pid, str(DATASET / "auto_improve"))
    return jsonify({"ok": True, "synced": added})


# ── API: Classes ──────────────────────────────────────────────────────
@app.route("/api/projects/<int:pid>/classes", methods=["GET"])
def api_classes_list(pid):
    return jsonify(_db.class_list(pid))


@app.route("/api/projects/<int:pid>/classes", methods=["POST"])
def api_classes_create(pid):
    data = request.json or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "name required"}), 400
    cid = _db.class_upsert(pid, name, color=data.get("color"))
    return jsonify({"ok": True, "id": cid})


@app.route("/api/classes/<int:cid>", methods=["DELETE"])
def api_classes_delete(cid):
    _db.class_delete(cid)
    return jsonify({"ok": True})


# ── API: DB Stats ─────────────────────────────────────────────────────
@app.route("/api/db/stats")
def api_db_stats():
    stats = _db.db_stats()
    stats["activity"] = _db.activity_list(limit=10)
    stats["recent_runs"] = _db.run_list(limit=5)
    return jsonify(stats)


# ── API: Activity ─────────────────────────────────────────────────────
@app.route("/api/activity")
def api_activity():
    limit = int(request.args.get("limit", 20))
    project_id = request.args.get("project_id")
    pid = int(project_id) if project_id else None
    return jsonify(_db.activity_list(limit=limit, project_id=pid))


# ── API: Training Runs (DB) ───────────────────────────────────────────
@app.route("/api/runs")
def api_runs_list():
    project_id = request.args.get("project_id")
    pid = int(project_id) if project_id else None
    return jsonify(_db.run_list(project_id=pid))


@app.route("/api/runs/<int:rid>")
def api_runs_get(rid):
    r = _db.run_get(rid)
    return jsonify(r) if r else (jsonify({"error": "not found"}), 404)


# ── API: Models Registry (DB) ─────────────────────────────────────────
@app.route("/api/registry")
def api_registry_list():
    project_id = request.args.get("project_id")
    pid = int(project_id) if project_id else None
    return jsonify(_db.model_list(project_id=pid))


@app.route("/api/registry/<int:mid>/deploy", methods=["POST"])
def api_registry_deploy(mid):
    _db.model_deploy(mid)
    return jsonify({"ok": True})


# ── API: Stats ────────────────────────────────────────────────────────
@app.route("/api/stats")
def api_stats():
    ds_images = list(f for f in DATASET.rglob("*") if f.suffix.lower() in IMG_EXT)
    ds_labels = list(DATASET.rglob("*.txt"))

    ai_dir = DATASET / "auto_improve"
    ai_images = sum(1 for f in ai_dir.rglob("*") if f.suffix.lower() in IMG_EXT) if ai_dir.exists() else 0
    ai_labels = sum(1 for _ in (ai_dir / "labels").rglob("*.txt")) if (ai_dir / "labels").exists() else 0

    class_map = {}
    cm_file = ai_dir / "class_mapping.json"
    if cm_file.exists():
        class_map = json.loads(cm_file.read_text(encoding="utf-8"))

    train_dir = RUNS / "train"
    runs = sorted(train_dir.iterdir(), reverse=True) if train_dir.exists() else []
    run_info = []
    for r in runs[:10]:
        info = {"name": r.name, "path": str(r)}
        results_csv = r / "results.csv"
        if results_csv.exists():
            lines = results_csv.read_text().strip().split("\n")
            if len(lines) > 1:
                info["epochs"] = len(lines) - 1
                last = lines[-1].split(",")
                info["last_line"] = last
        best_pt = r / "weights" / "best.pt"
        info["has_best"] = best_pt.exists()
        info["best_size_mb"] = round(best_pt.stat().st_size / 1e6, 1) if best_pt.exists() else 0
        run_info.append(info)

    ls_data = ls_get("/api/projects")
    ls_projects = []
    if isinstance(ls_data, dict) and "results" in ls_data:
        ls_projects = ls_data["results"]
    elif isinstance(ls_data, list):
        ls_projects = ls_data

    yolo = yolo_get()

    return jsonify({
        "dataset": {
            "total_images": len(ds_images),
            "total_labels": len(ds_labels),
            "auto_improve_images": ai_images,
            "auto_improve_labels": ai_labels,
            "classes": class_map.get("model_to_class_id", {}),
        },
        "training": {"runs": run_info, "yolo_status": yolo},
        "label_studio": {
            "projects": [{
                "id": p.get("id"), "title": p.get("title"),
                "task_count": p.get("task_number", 0),
                "completed": p.get("num_tasks_with_annotations", 0),
            } for p in ls_projects],
        },
    })


# ── API: Dataset Images ──────────────────────────────────────────────
@app.route("/api/images")
def api_images():
    subdir = request.args.get("dir", "auto_improve/images")
    page = int(request.args.get("page", 1))
    per_page = int(request.args.get("per_page", 50))
    target = DATASET / subdir
    if not target.exists():
        return jsonify({"images": [], "total": 0})
    all_imgs = sorted(
        [f for f in target.iterdir() if f.suffix.lower() in IMG_EXT],
        key=lambda f: f.name)
    total = len(all_imgs)
    start = (page - 1) * per_page
    page_imgs = all_imgs[start:start + per_page]
    return jsonify({
        "images": [{"name": f.name, "path": f"{subdir}/{f.name}"} for f in page_imgs],
        "total": total, "page": page,
        "pages": (total + per_page - 1) // per_page,
    })


@app.route("/api/image/<path:filepath>")
def api_image(filepath):
    full = _safe_path(DATASET, filepath)
    if not full.exists() or full.suffix.lower() not in IMG_EXT:
        return "Not found", 404
    return send_file(str(full))


# ── API: Labels ──────────────────────────────────────────────────────
@app.route("/api/label/<path:filepath>")
def api_label(filepath):
    img_path = _safe_path(DATASET, filepath)
    label_dir = img_path.parent.parent / "labels"
    label_file = label_dir / f"{img_path.stem}.txt"
    if not label_file.exists():
        return jsonify({"labels": [], "exists": False})
    lines = label_file.read_text().strip().split("\n")
    labels = []
    for line in lines:
        parts = line.strip().split()
        if len(parts) >= 5:
            labels.append({
                "class_id": int(parts[0]),
                "cx": float(parts[1]), "cy": float(parts[2]),
                "w": float(parts[3]), "h": float(parts[4]),
            })
    return jsonify({"labels": labels, "exists": True})


@app.route("/api/label/save", methods=["POST"])
def api_label_save():
    """Save YOLO-format labels for an image"""
    data = request.json or {}
    img_rel = data.get("image_path", "")
    labels = data.get("labels", [])
    img_path = _safe_path(DATASET, img_rel)
    if not img_path.exists():
        return jsonify({"ok": False, "error": "Image not found"}), 404
    label_dir = img_path.parent.parent / "labels"
    label_dir.mkdir(parents=True, exist_ok=True)
    label_file = label_dir / f"{img_path.stem}.txt"
    lines = []
    for lb in labels:
        lines.append(f"{lb['class_id']} {lb['cx']:.6f} {lb['cy']:.6f} {lb['w']:.6f} {lb['h']:.6f}")
    label_file.write_text("\n".join(lines) + "\n" if lines else "")
    return jsonify({"ok": True, "saved": str(label_file), "count": len(lines)})


# ── API: Predict (proxy to YOLO server) ──────────────────────────────
@app.route("/api/predict", methods=["POST"])
def api_predict():
    """Run inference — accepts uploaded file or base64 image"""
    body = {}
    if request.content_type and "multipart" in request.content_type:
        f = request.files.get("image")
        if f:
            raw = f.read()
            body["image"] = base64.b64encode(raw).decode()
        body["conf"] = request.form.get("conf", "0.25")
        body["iou"] = request.form.get("iou", "0.45")
        body["imgsz"] = request.form.get("imgsz", "640")
        body["model"] = request.form.get("model", "/app-models/best.pt")
    else:
        body = request.json or {}

    body["command"] = "predict"
    result = yolo_post(body)

    # Remap generic class names (class_0, class_1, ...) to real part names
    if isinstance(result, dict) and "detections" in result:
        id_to_name = _load_class_name_map()
        if id_to_name:
            for det in result["detections"]:
                cls_id = det.get("class_id")
                if cls_id is not None and cls_id in id_to_name:
                    det["class_name"] = id_to_name[cls_id]

    return jsonify(result)


@app.route("/api/predict/local", methods=["POST"])
def api_predict_local():
    """Run inference locally (if ultralytics installed on this machine)"""
    try:
        from ultralytics import YOLO
    except ImportError:
        return jsonify({"error": "ultralytics not installed on webapp server"})

    f = request.files.get("image") or request.files.get("file")
    if not f:
        return jsonify({"error": "No image uploaded"})
    try:
        conf = float(request.form.get("conf", "0.25"))
    except (TypeError, ValueError):
        conf = 0.25
    try:
        iou = float(request.form.get("iou", "0.45"))
    except (TypeError, ValueError):
        iou = 0.45
    try:
        imgsz = int(request.form.get("imgsz", "640"))
    except (TypeError, ValueError):
        imgsz = 640
    model_path = request.form.get("model", str(MODEL_DIR / "best.pt"))

    import tempfile, cv2, numpy as np
    raw = f.read()
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return jsonify({"error": "Cannot decode image"})

    model = YOLO(model_path)
    results = model.predict(source=img, conf=conf, iou=iou, imgsz=imgsz, verbose=False)
    id_to_name = _load_class_name_map()
    detections = []
    h, w = 0, 0
    for r in results:
        h, w = r.orig_shape
        for box in r.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            cls_id = int(box.cls[0])
            raw_name = r.names.get(cls_id, str(cls_id))
            class_name = _remap_class_name(cls_id, raw_name, id_to_name)
            detections.append({
                "class_id": cls_id,
                "class": class_name,
                "class_name": class_name,
                "confidence": round(float(box.conf[0]), 4),
                "bbox": [round(x1), round(y1), round(x2), round(y2)],
            })
    return jsonify({
        "status": "ok", "image_width": w, "image_height": h,
        "detections": detections, "results": detections, "count": len(detections),
        "model": model_path,
        "parameters": {"conf": conf, "iou": iou, "imgsz": imgsz},
    })


def _yolo_txt_lines(results):
    """Convert ultralytics results to YOLO-format label lines."""
    lines = []
    for r in results:
        h, w = r.orig_shape
        for box in r.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            cls_id = int(box.cls[0])
            cx, cy = (x1 + x2) / (2 * w), (y1 + y2) / (2 * h)
            bw, bh = (x2 - x1) / w, (y2 - y1) / h
            lines.append(f"{cls_id} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
    return lines
    
    
# ── API: Predict (proxy to YOLO server) ──────────────────────────────
# ── API: Batch auto-label (run YOLO across a whole folder) ───────────
@app.route("/api/autolabel/batch", methods=["POST"])
def api_autolabel_batch():
    """Run YOLO detection on every image in a dataset folder and write YOLO-format labels."""
    try:
        from ultralytics import YOLO
    except ImportError:
        return jsonify({"ok": False, "error": "ultralytics not installed on webapp server"}), 500

    data = request.get_json(silent=True) or {}
    folder = (data.get("folder") or "").strip()
    if not folder:
        return jsonify({"ok": False, "error": "folder required"}), 400
    try:
        conf = float(data.get("conf", 0.25))
        iou = float(data.get("iou", 0.45))
    except (TypeError, ValueError):
        conf, iou = 0.25, 0.45
    overwrite = bool(data.get("overwrite", False))
    model_path = _resolve_training_model(data.get("model") or "best.pt")

    target = _safe_path(DATASET, folder)
    if not target.exists() or not target.is_dir():
        return jsonify({"ok": False, "error": f"folder not found: {folder}"}), 404

    images = sorted(f for f in target.iterdir() if f.suffix.lower() in IMG_EXT)
    if not images:
        return jsonify({"ok": True, "labeled": 0, "skipped": 0, "total": 0, "detections": 0})

    # Mirror the images/... path under labels/ — matches ultralytics'
    # img2label_paths() lookup convention. A sibling "<folder>/labels" (the
    # old behavior here) is never found by training.
    try:
        rel = target.relative_to(DATASET / "auto_improve" / "images")
        label_dir = DATASET / "auto_improve" / "labels" / rel
    except ValueError:
        label_dir = target.parent / "labels"
    label_dir.mkdir(parents=True, exist_ok=True)

    try:
        model = YOLO(model_path)
    except Exception as e:
        return jsonify({"ok": False, "error": f"failed to load model: {e}"}), 500

    labeled = skipped = detection_total = 0
    for img_path in images:
        label_file = label_dir / f"{img_path.stem}.txt"
        if label_file.exists() and not overwrite:
            skipped += 1
            continue
        try:
            results = model.predict(source=str(img_path), conf=conf, iou=iou, verbose=False)
        except Exception:
            skipped += 1
            continue
        lines = _yolo_txt_lines(results)
        label_file.write_text("\n".join(lines) + ("\n" if lines else ""))
        detection_total += len(lines)
        labeled += 1

    return jsonify({
        "ok": True, "labeled": labeled, "skipped": skipped,
        "total": len(images), "detections": detection_total, "model": model_path,
    })


# ── API: Auto-detect from video (extract frames + auto-label) ────────
@app.route("/api/video/autolabel/start", methods=["POST"])
def api_video_autolabel_start():
    """Upload a video, run YOLO every N frames, save detected frames + YOLO labels."""
    try:
        from ultralytics import YOLO
        import cv2
    except ImportError as e:
        return jsonify({"ok": False, "error": f"missing dependency: {e}"}), 500

    with _video_label_lock:
        if _video_label_state.get("status") == "running":
            return jsonify({"ok": False, "error": "a video auto-label job is already running"}), 409

    f = request.files.get("video")
    if not f or not f.filename:
        return jsonify({"ok": False, "error": "video file required"}), 400
    ext = Path(f.filename).suffix.lower()
    if ext not in VIDEO_EXT:
        return jsonify({"ok": False, "error": f"unsupported video type: {ext}"}), 400

    class_name = (request.form.get("class_name") or "object").strip() or "object"
    split = request.form.get("split", "train")
    if split not in ("train", "val", "test"):
        split = "train"
    try:
        conf = float(request.form.get("conf", 0.25))
        iou = float(request.form.get("iou", 0.45))
        every_n = max(1, int(request.form.get("every_n_frames", 10)))
        max_frames = int(request.form.get("max_frames", 0)) or None
    except (TypeError, ValueError):
        conf, iou, every_n, max_frames = 0.25, 0.45, 10, None
    save_empty = str(request.form.get("save_empty", "")).lower() in ("1", "true", "on")
    model_path = _resolve_training_model(request.form.get("model") or "best.pt")

    upload_dir = DATASET / "_uploads" / "videos"
    upload_dir.mkdir(parents=True, exist_ok=True)
    safe_name = f"{int(time.time())}_{Path(f.filename).name.replace(' ', '_')}"
    video_path = upload_dir / safe_name
    f.save(str(video_path))

    img_dest = _safe_path(DATASET, f"auto_improve/images/{split}/{class_name}")
    # Mirror the images/<split>/<class> path under labels/ — matches
    # ultralytics.data.utils.img2label_paths()'s lookup convention. A sibling
    # "images/<split>/labels" folder (the old behavior here) is never found.
    label_dest = _safe_path(DATASET, f"auto_improve/labels/{split}/{class_name}")
    img_dest.mkdir(parents=True, exist_ok=True)
    label_dest.mkdir(parents=True, exist_ok=True)

    _set_video_label_state(
        status="running", progress=0, frame_index=0, total_frames=0,
        frames_saved=0, detections=0, error=None, cancel=False,
        video=f.filename, started=time.time(), finished=None,
        log=f"Loading model {model_path}",
    )

    def worker():
        cap = None
        try:
            model = YOLO(model_path)
            cap = cv2.VideoCapture(str(video_path))
            if not cap.isOpened():
                raise RuntimeError("cannot open uploaded video")
            total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
            _set_video_label_state(total_frames=total, log="Processing frames...")

            frame_idx = 0
            saved = 0
            detections_total = 0
            stem_prefix = Path(f.filename).stem

            while True:
                if _video_label_snapshot().get("cancel"):
                    _set_video_label_state(status="cancelled", finished=time.time(), log="Cancelled by user")
                    return
                ok, frame = cap.read()
                if not ok:
                    break
                if frame_idx % every_n == 0:
                    results = model.predict(source=frame, conf=conf, iou=iou, verbose=False)
                    lines = _yolo_txt_lines(results)
                    if lines or save_empty:
                        frame_name = f"{stem_prefix}_f{frame_idx:06d}.jpg"
                        cv2.imwrite(str(img_dest / frame_name), frame)
                        (label_dest / f"{Path(frame_name).stem}.txt").write_text(
                            "\n".join(lines) + ("\n" if lines else ""))
                        saved += 1
                        detections_total += len(lines)
                frame_idx += 1
                if max_frames and frame_idx >= max_frames:
                    break
                if frame_idx % 5 == 0:
                    progress = min(99, int(frame_idx / total * 100)) if total else 0
                    _set_video_label_state(
                        frame_index=frame_idx, frames_saved=saved,
                        detections=detections_total, progress=progress,
                    )

            _set_video_label_state(
                status="completed", progress=100, frame_index=frame_idx,
                frames_saved=saved, detections=detections_total,
                finished=time.time(),
                log=f"Done: {saved} frames saved with {detections_total} detections",
                dest=str(img_dest.relative_to(DATASET)).replace("\\", "/"),
            )
        except Exception as e:
            _set_video_label_state(
                status="error", error=str(e), finished=time.time(),
                log=traceback.format_exc(),
            )
        finally:
            if cap is not None:
                cap.release()
            try:
                video_path.unlink(missing_ok=True)
            except Exception:
                pass

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({"ok": True, "status": "running"})


@app.route("/api/video/autolabel/status")
def api_video_autolabel_status():
    return jsonify(_video_label_snapshot())


@app.route("/api/video/autolabel/cancel", methods=["POST"])
def api_video_autolabel_cancel():
    _set_video_label_state(cancel=True)
    return jsonify({"ok": True})


# ── API: Label Studio Proxy ──────────────────────────────────────────
@app.route("/api/ls/projects")
def api_ls_projects():
    return jsonify(ls_get("/api/projects"))


@app.route("/api/ls/project/<int:pid>")
def api_ls_project(pid):
    return jsonify(ls_get(f"/api/projects/{pid}"))


@app.route("/api/ls/export/<int:pid>")
def api_ls_export(pid):
    fmt = request.args.get("format", "YOLO")
    try:
        r = requests.get(
            f"{LS_URL}/api/projects/{pid}/export?exportType={fmt}",
            headers=ls_headers(), timeout=120)
        return Response(r.content,
                        content_type=r.headers.get("Content-Type", "application/octet-stream"),
                        headers={"Content-Disposition": f"attachment; filename=export_{pid}.zip"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/ls/token", methods=["POST"])
def api_ls_token():
    data = request.json
    email, password = data.get("email", ""), data.get("password", "")
    try:
        session = requests.Session()
        r = session.post(f"{LS_URL}/user/login",
                         data={"email": email, "password": password},
                         allow_redirects=False, timeout=10)
        if r.status_code in (200, 302):
            r2 = session.get(f"{LS_URL}/api/current-user/token", timeout=10)
            if r2.status_code == 200:
                token = r2.json().get("token", "")
                global LS_TOKEN
                LS_TOKEN = token
                return jsonify({"token": token, "ok": True})
        return jsonify({"ok": False, "error": "Login failed"})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


# ── API: Training ────────────────────────────────────────────────────
@app.route("/api/train/status")
def api_train_status():
    health = yolo_get("/health")
    remote_status = health.get("status") if isinstance(health, dict) else "offline"
    if remote_status == "offline":
        return jsonify(_local_train_snapshot(remote_status="offline"))
    if isinstance(health, dict):
        health.setdefault("runner", "remote")
    return jsonify(health)


@app.route("/api/train/stream")
def api_train_stream():
    """Stream live YOLO training status and latest results.csv metrics."""
    requested_run = request.args.get("run", "")

    @stream_with_context
    def events():
        last_payload = None
        idle_seen = 0
        while True:
            health = yolo_get("/health")
            training = health.get("training") if isinstance(health, dict) else {}
            if not isinstance(training, dict):
                training = {}
            if not training:
                status_result = yolo_post({"command": "status"})
                if isinstance(status_result, dict) and isinstance(status_result.get("training"), dict):
                    training = status_result["training"]
            run_name = training.get("run_name") or requested_run
            metrics = _read_training_metrics(run_name)
            state = training.get("state") or health.get("status", "offline")
            payload = {
                "status": health.get("status", "offline") if isinstance(health, dict) else "offline",
                "state": state,
                "gpu": health.get("gpu") if isinstance(health, dict) else None,
                "run_name": run_name,
                "started": training.get("started", 0),
                **metrics,
            }
            encoded = json.dumps(payload, ensure_ascii=False)
            if encoded != last_payload:
                yield f"data: {encoded}\n\n"
                last_payload = encoded
            terminal_states = {"idle", "completed", "done", "error", "offline"}
            if state == "ready" and not run_name:
                terminal_states.add("ready")
            if state in terminal_states:
                idle_seen += 1
                if idle_seen >= 2:
                    done_payload = dict(payload)
                    done_payload["done"] = True
                    yield f"event: done\ndata: {json.dumps(done_payload, ensure_ascii=False)}\n\n"
                    break
            else:
                idle_seen = 0
            time.sleep(2)

    return Response(events(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/api/train/start", methods=["POST"])
def api_train_start():
    config = request.json or {}
    model = config.get("model", "yolo11n.pt")
    run_name = config.get("name", f"train_{time.strftime('%Y%m%d_%H%M')}")
    body = {
        "command": "train",
        "model": model,
        "config": {
            "model": model,
            "data": config.get("data", "/dataset/auto_improve/data.yaml"),
            "epochs": int(config.get("epochs", 100)),
            "imgsz": int(config.get("imgsz", 640)),
            "batch": int(config.get("batch", 16)),
            "name": run_name,
        },
    }
    health = yolo_get("/health")
    remote_status = health.get("status") if isinstance(health, dict) else "offline"
    if remote_status == "offline":
        result = _start_local_training(body["config"])
    else:
        result = yolo_post(body)
        if isinstance(result, dict):
            result.setdefault("runner", "remote")
    # Record in DB
    if not isinstance(result, dict) or not result.get("error"):
        try:
            pid = config.get("project_id")
            _db.run_create(
                run_name,
                project_id=int(pid) if pid else None,
                model_base=model,
                epochs=int(config.get("epochs", 100)),
                batch=int(config.get("batch", 16)),
                imgsz=int(config.get("imgsz", 640)),
            )
        except Exception:
            pass
    return jsonify(result)


@app.route("/api/train/export", methods=["POST"])
def api_train_export():
    data = request.json or {}
    return jsonify(yolo_post({
        "command": "export",
        "model": data.get("model", ""),
        "format": data.get("format", "onnx"),
    }))


@app.route("/api/train/val", methods=["POST"])
def api_train_val():
    data = request.json or {}
    return jsonify(yolo_post({
        "command": "val",
        "model": data.get("model", "/app-models/best.pt"),
        "data": data.get("data", "/dataset/auto_improve/data.yaml"),
    }))


# ── API: Models ──────────────────────────────────────────────────────
@app.route("/api/models")
def api_models():
    models = []
    seen_paths = set()

    # 1. Scan RUNS/train for training outputs
    train_dir = RUNS / "train"
    if train_dir.exists():
        for run in sorted(train_dir.iterdir(), reverse=True):
            best = run / "weights" / "best.pt"
            if not best.exists():
                continue
            seen_paths.add(str(best))
            info = {
                "run": run.name,
                "best_pt": str(best),
                "best_size_mb": round(best.stat().st_size / 1e6, 1),
            }
            results_csv = run / "results.csv"
            if results_csv.exists():
                lines = results_csv.read_text().strip().split("\n")
                if len(lines) > 1:
                    headers = [h.strip() for h in lines[0].split(",")]
                    values = [v.strip() for v in lines[-1].split(",")]
                    info["epochs"] = len(lines) - 1
                    for h, v in zip(headers, values):
                        try:
                            if "mAP50" in h and "mAP50-95" not in h:
                                info["mAP50"] = round(float(v), 4)
                            if "mAP50-95" in h:
                                info["mAP50_95"] = round(float(v), 4)
                        except ValueError:
                            pass
            models.append(info)

    # 2. Scan MODEL_DIR for .pt files (user's model folder)
    _NON_MODEL = {"botsort.yaml", "byetrack.yaml", "bytetrack.yaml"}
    if MODEL_DIR.exists():
        for pt in sorted(MODEL_DIR.glob("*.pt")):
            if str(pt) in seen_paths:
                continue
            seen_paths.add(str(pt))
            name = pt.stem
            models.append({
                "run": name,
                "name": name,
                "best_pt": str(pt),
                "path": str(pt),
                "best_size_mb": round(pt.stat().st_size / 1e6, 1),
                "source": "model_dir",
            })

    active_best = MODEL_DIR / "best.pt"

    # Sync discovered models into DB
    try:
        existing_paths = {m["path"] for m in _db.model_list()}
        for m in models:
            if m.get("best_pt") and m["best_pt"] not in existing_paths:
                _db.model_register(
                    name=m.get("run", "model"),
                    path=m["best_pt"],
                    fmt="pt",
                    size_bytes=int((m.get("best_size_mb", 0)) * 1e6),
                    map50=m.get("mAP50", 0) or 0,
                    map50_95=m.get("mAP50_95", 0) or 0,
                )
    except Exception:
        pass

    return jsonify({
        "models": models,
        "registry": _db.model_list(),
        "active": {
            "active_model": str(active_best) if active_best.exists() else None,
            "active_size_mb": round(active_best.stat().st_size / 1e6, 1) if active_best.exists() else 0,
        },
    })


@app.route("/api/models/deploy", methods=["POST"])
def api_deploy_model():
    import shutil
    data = request.json or {}
    src = data.get("source", "")
    if not src or not Path(src).exists():
        return jsonify({"ok": False, "error": "Model file not found"}), 404
    dst = MODEL_DIR / "best.pt"
    backup = MODEL_DIR / f"best_backup_{time.strftime('%Y%m%d_%H%M%S')}.pt"
    if dst.exists():
        shutil.copy2(dst, backup)
    shutil.copy2(src, dst)
    return jsonify({"ok": True, "deployed": str(dst), "backup": str(backup)})


# ── API: Folders ─────────────────────────────────────────────────────
@app.route("/api/folders")
def api_folders():
    folders = []
    for d in sorted(DATASET.rglob("*")):
        if d.is_dir():
            imgs = [f for f in d.iterdir() if f.suffix.lower() in IMG_EXT]
            if imgs:
                rel = str(d.relative_to(DATASET)).replace("\\", "/")
                folders.append({"path": rel, "count": len(imgs)})
    return jsonify({"folders": folders})


@app.route("/api/folders/create", methods=["POST"])
def api_folders_create():
    """Create a new dataset folder (auto_improve/images/{split}/{class_name})"""
    data = request.get_json(silent=True) or {}
    class_name = (data.get("class_name") or "").strip()
    split = data.get("split", "train")
    if not class_name:
        return jsonify({"ok": False, "error": "class_name required"}), 400
    if split not in ("train", "val", "test"):
        split = "train"
    dest = _safe_path(DATASET, f"auto_improve/images/{split}/{class_name}")
    dest.mkdir(parents=True, exist_ok=True)
    label_dest = _safe_path(DATASET, f"auto_improve/labels/{split}/{class_name}")
    label_dest.mkdir(parents=True, exist_ok=True)
    rel = str(dest.relative_to(DATASET)).replace("\\", "/")
    return jsonify({"ok": True, "path": rel})


# ── API: Data Import ────────────────────────────────────────────────
@app.route("/api/import/upload", methods=["POST"])
def api_import_upload():
    """Upload images and YOLO label files to a dataset folder."""
    target_class = request.form.get("class_name", "uncategorized")
    split = request.form.get("split", "train")
    dest = _safe_path(DATASET, f"auto_improve/images/{split}/{target_class}")
    label_dest = _safe_path(DATASET, f"auto_improve/labels/{split}/{target_class}")
    dest.mkdir(parents=True, exist_ok=True)
    label_dest.mkdir(parents=True, exist_ok=True)
    files = request.files.getlist("images") or request.files.getlist("files")
    image_count = sum(1 for f in files if f.filename and Path(f.filename).suffix.lower() in IMG_EXT)
    if image_count > MAX_IMPORT_BATCH:
        return jsonify({
            "ok": False,
            "error": f"นำเข้าได้ไม่เกิน {MAX_IMPORT_BATCH} ภาพต่อครั้ง (ส่งมา {image_count} ภาพ)",
        }), 400
    saved = []
    skipped = []
    for f in files:
        if not f.filename:
            continue
        ext = Path(f.filename).suffix.lower()
        if ext not in IMG_EXT and ext != ".txt":
            skipped.append(f.filename)
            continue
        safe_name = Path(f.filename).name.replace(" ", "_")
        out = (label_dest if ext == ".txt" else dest) / safe_name
        if out.exists():
            skipped.append(f.filename)
            continue
        f.save(str(out))
        saved.append(safe_name)
    return jsonify({
        "ok": True, "saved": len(saved), "skipped": len(skipped),
        "dest": str(dest.relative_to(DATASET)).replace("\\", "/"),
        "files": saved,
    })


@app.route("/api/import/labelstudio", methods=["POST"])
def api_import_labelstudio():
    """Import a Label Studio JSON export into YOLO image/label folders."""
    upload = request.files.get("file")
    if not upload or not upload.filename:
        return jsonify({"imported": 0, "skipped": 0, "classes": [], "errors": ["file required"]}), 400

    try:
        payload = json.load(upload.stream)
    except Exception as exc:
        return jsonify({"imported": 0, "skipped": 0, "classes": [], "errors": [f"invalid json: {exc}"]}), 400

    tasks = payload.get("tasks") if isinstance(payload, dict) else payload
    if not isinstance(tasks, list):
        return jsonify({"imported": 0, "skipped": 0, "classes": [], "errors": ["expected a list of tasks"]}), 400

    def task_label_results(task):
        annotations = task.get("annotations") or []
        if not annotations:
            return []
        results = annotations[0].get("result") or []
        return results if isinstance(results, list) else []

    def result_label(result):
        value = result.get("value") or {}
        if result.get("type") == "rectanglelabels":
            labels = value.get("rectanglelabels") or []
        elif result.get("type") == "polygonlabels":
            labels = value.get("polygonlabels") or []
        else:
            labels = []
        return labels[0] if labels else ""

    classes = []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        for result in task_label_results(task):
            label = result_label(result)
            if label and label not in classes:
                classes.append(label)

    class_to_id = {name: idx for idx, name in enumerate(classes)}

    def safe_class_dir(label):
        cleaned = "".join(ch if ch not in '<>:"/\\|?*' else "_" for ch in label).strip(" .")
        return cleaned or "unlabeled"

    imported = 0
    skipped = 0
    errors = []

    for idx, task in enumerate(tasks):
        if not isinstance(task, dict):
            skipped += 1
            errors.append(f"task {idx}: invalid task object")
            continue

        results = task_label_results(task)
        rows = []
        primary_class = ""

        for result in results:
            label = result_label(result)
            if not label:
                continue
            if not primary_class:
                primary_class = label
            cid = class_to_id[label]
            value = result.get("value") or {}

            try:
                if result.get("type") == "rectanglelabels":
                    x = float(value.get("x", 0))
                    y = float(value.get("y", 0))
                    w = float(value.get("width", 0))
                    h = float(value.get("height", 0))
                    cx = (x + w / 2) / 100
                    cy = (y + h / 2) / 100
                    rows.append(f"{cid} {cx:.6f} {cy:.6f} {w / 100:.6f} {h / 100:.6f}")
                elif result.get("type") == "polygonlabels":
                    points = value.get("points") or []
                    if len(points) < 3:
                        continue
                    coords = []
                    for point in points:
                        coords.extend([float(point[0]) / 100, float(point[1]) / 100])
                    flat = " ".join(f"{coord:.6f}" for coord in coords)
                    rows.append(f"{cid} {flat}")
            except (TypeError, ValueError, IndexError) as exc:
                errors.append(f"task {task.get('id', idx)}: invalid annotation: {exc}")

        image_ref = (task.get("data") or {}).get("image", "")
        if not image_ref or not rows or not primary_class:
            skipped += 1
            errors.append(f"task {task.get('id', idx)}: missing image or annotations")
            continue

        class_dir = safe_class_dir(primary_class)
        image_dir = _safe_path(DATASET, f"auto_improve/images/train/{class_dir}")
        label_dir = _safe_path(DATASET, f"auto_improve/labels/train/{class_dir}")
        image_dir.mkdir(parents=True, exist_ok=True)
        label_dir.mkdir(parents=True, exist_ok=True)

        image_name = _labelstudio_image_name(image_ref, f"labelstudio_{idx}")
        dest_image = image_dir / image_name
        if dest_image.exists():
            stem = dest_image.stem
            suffix = dest_image.suffix or ".jpg"
            dest_image = image_dir / f"{stem}_{idx}{suffix}"
        label_file = label_dir / f"{dest_image.stem}.txt"

        try:
            _copy_or_download_labelstudio_image(image_ref, dest_image)
            label_file.write_text("\n".join(rows) + "\n", encoding="utf-8")
            imported += 1
        except Exception as exc:
            skipped += 1
            errors.append(f"task {task.get('id', idx)}: {exc}")
            if dest_image.exists():
                try:
                    dest_image.unlink()
                except OSError:
                    pass

    return jsonify({
        "imported": imported,
        "skipped": skipped,
        "classes": classes,
        "errors": errors,
    })


@app.route("/api/import/classes")
def api_import_classes():
    """List existing classes from dataset structure"""
    classes = set()
    for split in ("train", "val"):
        d = DATASET / "auto_improve" / "images" / split
        if d.exists():
            for sub in d.iterdir():
                if sub.is_dir():
                    count = sum(1 for f in sub.iterdir()
                                if f.suffix.lower() in IMG_EXT)
                    if count > 0:
                        classes.add(sub.name)
    cm_file = DATASET / "auto_improve" / "class_mapping.json"
    class_map = {}
    if cm_file.exists():
        class_map = json.loads(cm_file.read_text(encoding="utf-8"))
    return jsonify({
        "classes": sorted(classes),
        "class_mapping": class_map.get("model_to_class_id", {}),
    })


@app.route("/api/import/split-info")
def api_import_split_info():
    """Get train/val split statistics"""
    info = {}
    for split in ("train", "val"):
        d = DATASET / "auto_improve" / "images" / split
        classes = {}
        total = 0
        if d.exists():
            for sub in d.iterdir():
                if sub.is_dir():
                    count = sum(1 for f in sub.iterdir()
                                if f.suffix.lower() in IMG_EXT)
                    if count:
                        classes[sub.name] = count
                        total += count
        info[split] = {"total": total, "classes": classes}
    labels_dir = DATASET / "auto_improve" / "labels"
    label_count = {"train": 0, "val": 0}
    for split in ("train", "val"):
        ld = labels_dir / split
        if ld.exists():
            for sub in ld.rglob("*.txt"):
                label_count[split] += 1
    info["train"]["labels"] = label_count["train"]
    info["val"]["labels"] = label_count["val"]
    return jsonify(info)


@app.route("/api/dataset/folder-stats")
def api_dataset_folder_stats():
    """Per-folder breakdown: total images, how many have a non-empty label
    (ภาพเทรน — contain at least one box) vs an empty/missing one
    (ภาพสิ่งแวดล้อม — background/negative, no objects)."""
    folder = (request.args.get("folder") or "").strip()
    if not folder:
        return jsonify({"error": "folder required"}), 400
    target = _safe_path(DATASET, folder)
    if not target.exists() or not target.is_dir():
        return jsonify({"error": f"folder not found: {folder}"}), 404

    try:
        rel = target.relative_to(DATASET / "auto_improve" / "images")
        label_dir = DATASET / "auto_improve" / "labels" / rel
    except ValueError:
        label_dir = target.parent / "labels"

    images = [f for f in target.iterdir() if f.suffix.lower() in IMG_EXT]
    labeled = 0
    for img in images:
        label_file = label_dir / f"{img.stem}.txt"
        if label_file.exists() and label_file.read_text(encoding="utf-8").strip():
            labeled += 1
    return jsonify({
        "folder": folder,
        "total": len(images),
        "labeled": labeled,
        "environment": len(images) - labeled,
    })


@app.route("/api/import/delete", methods=["POST"])
def api_import_delete():
    """Delete images from dataset"""
    data = request.json or {}
    paths = data.get("paths") or data.get("files") or []
    deleted = 0
    for p in paths:
        full = _safe_path(DATASET, p)
        if full.exists() and full.suffix.lower() in IMG_EXT:
            try:
                rel = full.relative_to(DATASET / "auto_improve" / "images")
                label_file = DATASET / "auto_improve" / "labels" / rel.with_suffix(".txt")
            except ValueError:
                label_file = full.parent.parent / "labels" / f"{full.stem}.txt"
            full.unlink()
            if label_file.exists():
                label_file.unlink()
            deleted += 1
    return jsonify({"ok": True, "deleted": deleted})


@app.route("/api/import/move", methods=["POST"])
def api_import_move():
    """Move images between train/val splits"""
    import shutil
    data = request.json or {}
    paths = data.get("paths") or data.get("files") or []
    target_split = data.get("target_split", "val")
    moved = 0
    for p in paths:
        full = _safe_path(DATASET, p)
        if not full.exists():
            continue
        try:
            rel = full.relative_to(DATASET / "auto_improve" / "images")
            parts = rel.parts
            source_split = parts[0] if len(parts) >= 3 else full.parent.parent.name
            class_name = parts[1] if len(parts) >= 3 else full.parent.name
            label_src = DATASET / "auto_improve" / "labels" / source_split / class_name / f"{full.stem}.txt"
        except ValueError:
            class_name = full.parent.name
            label_src = full.parent.parent / "labels" / f"{full.stem}.txt"
        dest_dir = DATASET / "auto_improve" / "images" / target_split / class_name
        dest_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(str(full), str(dest_dir / full.name))
        if label_src.exists():
            label_dest = DATASET / "auto_improve" / "labels" / target_split / class_name
            label_dest.mkdir(parents=True, exist_ok=True)
            shutil.move(str(label_src), str(label_dest / f"{full.stem}.txt"))
        moved += 1
    return jsonify({"ok": True, "moved": moved})


@app.route("/api/import/generate-yaml", methods=["POST"])
def api_generate_yaml():
    """Generate data.yaml for YOLO training"""
    data = request.json or {}
    classes = data.get("classes", [])
    if not classes:
        cls_d = DATASET / "auto_improve" / "images" / "train"
        if cls_d.exists():
            classes = sorted(
                d.name for d in cls_d.iterdir()
                if d.is_dir() and any(
                    f.suffix.lower() in IMG_EXT for f in d.iterdir()))
    yaml_content = (
        f"path: {str(DATASET / 'auto_improve').replace(chr(92), '/')}\n"
        f"train: images/train\n"
        f"val: images/val\n\n"
        f"nc: {len(classes)}\n"
        f"names: {classes}\n"
    )
    yaml_path = DATASET / "auto_improve" / "data.yaml"
    yaml_path.write_text(yaml_content, encoding="utf-8")
    cm_path = DATASET / "auto_improve" / "class_mapping.json"
    cm = {"model_to_class_id": {name: i for i, name in enumerate(classes)}}
    cm_path.write_text(json.dumps(cm, ensure_ascii=False, indent=2),
                       encoding="utf-8")
    return jsonify({
        "ok": True, "path": str(yaml_path),
        "nc": len(classes), "names": classes,
        "yaml": yaml_content,
    })


@app.route("/api/import/export-ndjson", methods=["POST"])
def api_export_ndjson():
    """Create a local NDJSON snapshot from auto_improve YOLO folders."""
    image_root = DATASET / "auto_improve" / "images"
    label_root = DATASET / "auto_improve" / "labels"
    export_dir = DATASET / "auto_improve" / "exports"
    export_dir.mkdir(parents=True, exist_ok=True)

    classes = set()
    if image_root.exists():
        for split in ("train", "val", "test"):
            split_dir = image_root / split
            if not split_dir.exists():
                continue
            classes.update(p.name for p in split_dir.iterdir() if p.is_dir())
    classes = sorted(classes)
    class_to_id = {name: idx for idx, name in enumerate(classes)}
    export_file = export_dir / f"dataset_{time.strftime('%Y%m%d_%H%M%S')}.ndjson"

    image_count = 0
    annotation_count = 0
    with export_file.open("w", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "type": "dataset",
            "name": "Ai-JIN auto_improve",
            "task": "detect",
            "classes": classes,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }, ensure_ascii=False) + "\n")

        for split in ("train", "val", "test"):
            split_dir = image_root / split
            if not split_dir.exists():
                continue
            for img_path in sorted(p for p in split_dir.rglob("*") if p.suffix.lower() in IMG_EXT):
                rel_image = img_path.relative_to(DATASET).as_posix()
                class_name = img_path.parent.name
                label_file = label_root / split / class_name / f"{img_path.stem}.txt"
                annotations = []
                if label_file.exists():
                    for line in label_file.read_text(encoding="utf-8").splitlines():
                        parts = line.strip().split()
                        if len(parts) < 5:
                            continue
                        try:
                            cls_id = int(float(parts[0]))
                            coords = [float(x) for x in parts[1:]]
                        except ValueError:
                            continue
                        if len(coords) == 4:
                            annotations.append({"class_id": cls_id, "bbox": coords})
                        elif len(coords) >= 6 and len(coords) % 2 == 0:
                            pts = [[coords[i], coords[i + 1]] for i in range(0, len(coords), 2)]
                            annotations.append({"class_id": cls_id, "polygon": pts})
                annotation_count += len(annotations)
                image_count += 1
                fh.write(json.dumps({
                    "type": "image",
                    "split": split,
                    "path": rel_image,
                    "class_name": class_name,
                    "class_id": class_to_id.get(class_name),
                    "annotations": annotations,
                }, ensure_ascii=False) + "\n")

    return jsonify({
        "ok": True,
        "path": str(export_file),
        "images": image_count,
        "annotations": annotation_count,
        "classes": classes,
    })


# ── API: SAM Segmentation ─────────────────────────────────────────────
@app.route("/api/sam3/status", methods=["GET"])
def api_sam3_status():
    model_path, model_exists = _find_sam3_model()
    import_error = _sam3_import_error()
    available = bool(model_exists and not import_error)
    extra = {}
    if import_error:
        extra = {"error": import_error, "hint": SAM3_INSTALL_HINT}
    elif not model_exists:
        extra = {"error": f"sam3.pt not found at {model_path}", "hint": SAM3_INSTALL_HINT}
    return jsonify({
        "available": available,
        "model_exists": model_exists,
        "model_path": str(model_path),
        **extra,
    })


@app.route("/api/sam3/predict", methods=["POST"])
def api_sam3_predict():
    data = request.json or {}
    image_path = data.get("image_path", "")
    text_prompts = data.get("text") or []
    if isinstance(text_prompts, str):
        text_prompts = [text_prompts]
    text_prompts = [str(t).strip() for t in text_prompts if str(t).strip()]
    bboxes = _normalize_sam3_bboxes(data.get("bboxes") or data.get("bbox"))
    if not text_prompts and not bboxes:
        return jsonify({"error": "text prompts or bboxes required"}), 400

    try:
        conf = float(data.get("conf", 0.25))
    except (TypeError, ValueError):
        conf = 0.25

    sam3_path, model_exists = _find_sam3_model()
    if not model_exists:
        return jsonify({
            "error": "sam3.pt not found",
            "hint": "Download from https://huggingface.co/facebook/sam3",
        })

    try:
        from ultralytics.models.sam import SAM3SemanticPredictor
    except ImportError:
        return jsonify({
            "error": f"SAM3 not available. {SAM3_INSTALL_HINT}",
        })

    resolved_image = _resolve_image_path(image_path)
    if not resolved_image:
        return jsonify({"error": "image_path not found"}), 404

    cache_key = str(resolved_image.resolve())
    cached = _sam3_predictor_cache.get(cache_key)
    if cached and cached.get("model_path") == str(sam3_path):
        predictor = cached["predictor"]
    else:
        overrides = dict(
            conf=conf,
            task="segment",
            mode="predict",
            model=str(sam3_path),
            quantize=16,
            verbose=False,
        )
        try:
            predictor = SAM3SemanticPredictor(overrides=overrides)
            predictor.set_image(str(resolved_image))
        except Exception as e:
            return jsonify({"error": f"SAM3: {e}"}), 500
        _sam3_predictor_cache.clear()
        _sam3_predictor_cache[cache_key] = {
            "model_path": str(sam3_path),
            "predictor": predictor,
        }

    try:
        if hasattr(predictor, "args"):
            predictor.args.conf = conf
        if text_prompts:
            results = predictor(text=text_prompts)
        else:
            results = predictor(bboxes=bboxes)
    except Exception as e:
        return jsonify({"error": f"SAM3: {e}"}), 500

    masks, boxes, labels = _serialize_sam3_results(results, text_prompts)
    return jsonify({
        "masks": masks,
        "boxes": boxes,
        "labels": labels,
        "count": len(boxes),
    })


@app.route("/api/sam/predict", methods=["POST"])
def api_sam_predict():
    try:
        from ultralytics import SAM
        import cv2, numpy as np
    except ImportError:
        return jsonify({"error": "ultralytics/cv2 not installed"}), 500

    img_file = request.files.get("image")
    if not img_file:
        return jsonify({"error": "No image"}), 400

    points_raw = request.form.get("points", "[]")
    bbox_raw   = request.form.get("bbox", "[]")
    sam_model  = request.form.get("model", "sam2_b.pt")

    try:
        points = json.loads(points_raw)
        bbox   = json.loads(bbox_raw)
    except Exception:
        points, bbox = [], []

    raw = img_file.read()
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return jsonify({"error": "Cannot decode image"}), 400
    h, w = img.shape[:2]

    model_path = str(MODEL_DIR / sam_model)
    if not Path(model_path).exists():
        model_path = sam_model  # let ultralytics download

    try:
        model = SAM(model_path)
        if bbox and len(bbox) == 4:
            results = model(img, bboxes=[bbox], verbose=False)
        elif points:
            pts = [[p[0], p[1]] for p in points]
            results = model(img, points=pts, labels=[1] * len(pts), verbose=False)
        else:
            results = model(img, verbose=False)
    except Exception as e:
        return jsonify({"error": f"SAM: {e}"}), 500

    polygons_out = []
    for r in results:
        if r.masks is None:
            continue
        for mask_xy in r.masks.xy:
            step = max(1, len(mask_xy) // 64)  # keep ≤64 points per polygon
            poly = [[round(float(p[0]) / w, 5), round(float(p[1]) / h, 5)]
                    for p in mask_xy[::step]]
            if len(poly) >= 3:
                polygons_out.append(poly)

    return jsonify({"ok": True, "polygons": polygons_out,
                    "image_width": w, "image_height": h})


# ── API: Extended label (boxes + polygons) ───────────────────────────
@app.route("/api/label/ext/<path:filepath>")
def api_label_ext(filepath):
    """Load labels in extended format: boxes and polygons."""
    img_path  = _safe_path(DATASET, filepath)
    label_dir = img_path.parent.parent / "labels"
    label_file = label_dir / f"{img_path.stem}.txt"
    if not label_file.exists():
        return jsonify({"boxes": [], "polygons": [], "exists": False})

    boxes, polygons = [], []
    for line in label_file.read_text().strip().splitlines():
        parts = line.strip().split()
        if len(parts) < 5:
            continue
        cls = int(parts[0])
        coords = [float(x) for x in parts[1:]]
        if len(coords) == 4:
            boxes.append([cls, *coords])
        elif len(coords) >= 6:
            pts = [[coords[i], coords[i + 1]] for i in range(0, len(coords), 2)]
            polygons.append({"class_id": cls, "pts": pts})

    return jsonify({"boxes": boxes, "polygons": polygons, "exists": True})


@app.route("/api/label/ext/save", methods=["POST"])
def api_label_ext_save():
    """Save boxes and polygons in YOLO format (file) + DB."""
    data     = request.json or {}
    img_rel  = data.get("image_path", "")
    boxes    = data.get("boxes", [])    # [[cid, cx, cy, w, h], ...]
    polygons = data.get("polygons", []) # [{class_id, pts:[[nx,ny],...]}]
    project_id = data.get("project_id")  # optional — sync to DB if provided
    classes    = data.get("classes", []) # list of class names

    img_path = _safe_path(DATASET, img_rel)
    if not img_path.exists():
        return jsonify({"ok": False, "error": "Image not found"}), 404

    label_dir = img_path.parent.parent / "labels"
    label_dir.mkdir(parents=True, exist_ok=True)
    label_file = label_dir / f"{img_path.stem}.txt"

    lines = []
    for b in boxes:
        lines.append(f"{b[0]} {b[1]:.6f} {b[2]:.6f} {b[3]:.6f} {b[4]:.6f}")
    for p in polygons:
        flat = " ".join(f"{pt[0]:.5f} {pt[1]:.5f}" for pt in p["pts"])
        lines.append(f"{p['class_id']} {flat}")

    label_file.write_text("\n".join(lines) + "\n" if lines else "")

    # ── Write to DB if project_id supplied ──
    if project_id:
        try:
            pid = int(project_id)
            # Ensure classes exist
            for i, cname in enumerate(classes):
                _db.class_upsert(pid, cname, class_idx=i)
            # Upsert image record
            img_id = _db.image_upsert(pid, img_rel, img_path.name)
            # Build ann list
            ann_list = []
            for b in boxes:
                ann_list.append({
                    "class_id": b[0], "type": "box",
                    "data": {"cx": b[1], "cy": b[2], "w": b[3], "h": b[4]},
                })
            for p in polygons:
                ann_list.append({
                    "class_id": p["class_id"], "type": "polygon",
                    "data": {"pts": p["pts"]},
                })
            _db.annotation_save(img_id, ann_list)
        except Exception as exc:
            # DB write failure is non-fatal
            return jsonify({"ok": True, "boxes": len(boxes), "polygons": len(polygons),
                            "db_warning": str(exc)})

    return jsonify({"ok": True, "boxes": len(boxes), "polygons": len(polygons)})


# ── API: LM Assistant (Ollama) ────────────────────────────────────────
@app.route("/api/lm/models")
def api_lm_models():
    """List available Ollama models."""
    try:
        r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=5)
        r.raise_for_status()
        models = [m["name"] for m in r.json().get("models", [])]
        return jsonify({"ok": True, "models": models, "current": OLLAMA_MODEL})
    except Exception as e:
        return jsonify({"ok": False, "models": [], "error": str(e)})


@app.route("/api/lm/chat", methods=["POST"])
def api_lm_chat():
    """Send a message to Ollama with optional image context."""
    data = request.json or {}
    message = data.get("message", "").strip()
    history = data.get("history", [])          # [{role, content}, ...]
    image_b64 = data.get("image_base64", "")   # base64 jpeg (no prefix)
    boxes = data.get("boxes", [])              # [[cid,cx,cy,w,h], ...]
    classes = data.get("classes", [])
    model = data.get("model", OLLAMA_MODEL)

    if not message:
        return jsonify({"ok": False, "error": "message is required"}), 400

    classes_str = ", ".join(classes) if classes else "ยังไม่มีคลาส"
    anno_lines = []
    for box in boxes:
        cid = int(box[0])
        cls_name = classes[cid] if cid < len(classes) else f"class_{cid}"
        anno_lines.append(
            f"  - {cls_name}: cx={box[1]:.3f} cy={box[2]:.3f} w={box[3]:.3f} h={box[4]:.3f}"
        )
    anno_str = "\n".join(anno_lines) if anno_lines else "  (ยังไม่มี annotation)"

    system_prompt = f"""คุณคือผู้ช่วย AI ในแพลตฟอร์ม AI-JIN สำหรับงาน annotation ภาพ Computer Vision
คุณช่วยผู้ใช้ annotate ภาพด้วย bounding box และ class labels

สถานะ annotation ปัจจุบัน:
- คลาสที่กำหนดไว้: {classes_str}
- Annotation ที่มีแล้ว:
{anno_str}

เมื่อแนะนำ bounding box ใหม่ ให้แนบ JSON block นี้ต่อท้ายคำตอบ (อย่าลืม triple backtick):
```json
{{"suggestions":[{{"class":"ชื่อคลาส","x1":0.1,"y1":0.1,"x2":0.5,"y2":0.6,"conf":0.9,"note":"คำอธิบาย"}}]}}
```
พิกัดเป็นสัดส่วน 0-1 ของขนาดภาพ (x1,y1=มุมซ้ายบน x2,y2=มุมขวาล่าง)

ตอบเป็นภาษาไทย กระชับ และเป็นประโยชน์"""

    # Build Ollama messages (OpenAI-compatible format)
    messages = [{"role": "system", "content": system_prompt}]

    for h in history[-8:]:
        role = h.get("role", "user")
        content = h.get("content", "")
        if role in ("user", "assistant"):
            messages.append({"role": role, "content": content})

    # Current user turn — attach image if provided
    if image_b64:
        user_content = [
            {"type": "text", "text": message},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
        ]
    else:
        user_content = message

    messages.append({"role": "user", "content": user_content})

    try:
        r = requests.post(
            f"{OLLAMA_URL}/v1/chat/completions",
            json={"model": model, "messages": messages, "stream": False},
            timeout=120,
        )
        r.raise_for_status()
        result = r.json()
        reply = result["choices"][0]["message"]["content"]
        return jsonify({"ok": True, "response": reply, "model": model})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/lm/chat/stream", methods=["POST"])
def api_lm_chat_stream():
    """Streaming version — returns SSE."""
    data = request.json or {}
    message = data.get("message", "").strip()
    history = data.get("history", [])
    image_b64 = data.get("image_base64", "")
    boxes = data.get("boxes", [])
    classes = data.get("classes", [])
    model = data.get("model", OLLAMA_MODEL)

    classes_str = ", ".join(classes) if classes else "ยังไม่มีคลาส"
    anno_lines = []
    for box in boxes:
        cid = int(box[0])
        cls_name = classes[cid] if cid < len(classes) else f"class_{cid}"
        anno_lines.append(f"  - {cls_name}: cx={box[1]:.3f} cy={box[2]:.3f} w={box[3]:.3f} h={box[4]:.3f}")
    anno_str = "\n".join(anno_lines) if anno_lines else "  (ยังไม่มี annotation)"

    system_prompt = f"""คุณคือผู้ช่วย AI ในแพลตฟอร์ม AI-JIN สำหรับงาน annotation ภาพ Computer Vision

สถานะ annotation ปัจจุบัน:
- คลาส: {classes_str}
- Annotations:\n{anno_str}

เมื่อแนะนำ bounding box ให้แนบ JSON block:
```json
{{"suggestions":[{{"class":"name","x1":0.1,"y1":0.1,"x2":0.5,"y2":0.6,"conf":0.9,"note":"คำอธิบาย"}}]}}
```
ตอบเป็นภาษาไทย กระชับ"""

    messages = [{"role": "system", "content": system_prompt}]
    for h in history[-8:]:
        if h.get("role") in ("user", "assistant"):
            messages.append({"role": h["role"], "content": h["content"]})

    if image_b64:
        user_content = [
            {"type": "text", "text": message},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
        ]
    else:
        user_content = message
    messages.append({"role": "user", "content": user_content})

    @stream_with_context
    def generate():
        try:
            with requests.post(
                f"{OLLAMA_URL}/v1/chat/completions",
                json={"model": model, "messages": messages, "stream": True},
                stream=True,
                timeout=120,
            ) as r:
                r.raise_for_status()
                for line in r.iter_lines():
                    if not line:
                        continue
                    text = line.decode("utf-8")
                    if text.startswith("data: "):
                        text = text[6:]
                    if text == "[DONE]":
                        yield "data: [DONE]\n\n"
                        break
                    try:
                        chunk = json.loads(text)
                        delta = chunk["choices"][0]["delta"].get("content", "")
                        if delta:
                            yield f"data: {json.dumps({'token': delta})}\n\n"
                    except Exception:
                        pass
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── API: Camera & Counting ───────────────────────────────────────────
def _camera_available():
    try:
        import cv2  # noqa: F401
        from camera_manager import camera_manager
        return True
    except Exception:
        return False


def _get_camera_manager():
    from camera_manager import camera_manager
    return camera_manager


@app.route("/api/cameras")
def api_cameras():
    if not _camera_available():
        return jsonify({"cameras": []})
    cm = _get_camera_manager()
    return jsonify({"cameras": cm.list_cameras()})


@app.route("/api/cameras", methods=["POST"])
def api_camera_add():
    if not _camera_available():
        return jsonify({"ok": False, "error": "opencv-python not installed"}), 501
    data = request.json or {}
    source = data.get("source", "").strip()
    if not source:
        return jsonify({"ok": False, "error": "source is required"}), 400
    from camera_manager import CameraConfig
    config = CameraConfig(
        source=source,
        name=data.get("name", source),
        fps_target=int(data.get("fps_target", 15)),
        conf_threshold=float(data.get("conf_threshold", 0.25)),
        iou_threshold=float(data.get("iou_threshold", 0.45)),
    )
    cm = _get_camera_manager()
    cam_id = cm.add_camera(config)
    return jsonify({"ok": True, "id": cam_id})


@app.route("/api/cameras/browser", methods=["POST"])
def api_camera_add_browser():
    """สร้าง 'กล้อง' ที่รับเฟรมจากเบราว์เซอร์ของผู้ใช้เอง (getUserMedia)
    แทนกล้องที่ต่อกับเซิร์ฟเวอร์ — เฟรมจะถูก push เข้ามาทาง
    /api/cameras/browser/<id>/frame แทนที่จะให้เซิร์ฟเวอร์เปิดกล้องเอง."""
    if not _camera_available():
        return jsonify({"ok": False, "error": "opencv-python not installed"}), 501
    data = request.json or {}
    cm = _get_camera_manager()
    cam_id = cm.add_browser_session(
        name=data.get("name", "").strip(),
        conf_threshold=float(data.get("conf_threshold", 0.25)),
        iou_threshold=float(data.get("iou_threshold", 0.45)),
        model_path=data.get("model_path", ""),
        imgsz=int(data.get("imgsz", 640)),
        enable_counting=bool(data.get("enable_counting", True)),
    )
    return jsonify({"ok": True, "id": cam_id})


@app.route("/api/cameras/browser/<int:cam_id>/frame", methods=["POST"])
def api_camera_browser_frame(cam_id):
    """รับเฟรมเดี่ยว (JPEG) จากเบราว์เซอร์ที่เปิดกล้องของเครื่องตัวเอง,
    รัน inference + counting แล้วคืนผลลัพธ์กลับไปทันที (ไม่ผ่าน SSE)
    เพื่อให้แท็บที่ถ่ายภาพวาด overlay ของตัวเองได้แบบ real-time; ผู้ชมคนอื่น
    ที่เปิดดูกล้องนี้ยังคงได้ภาพผ่าน SSE stream ตามปกติ."""
    if not _camera_available():
        return jsonify({"ok": False, "error": "opencv-python not installed"}), 501
    cm = _get_camera_manager()
    cam = cm.get_camera(cam_id)
    if not cam or not hasattr(cam, "process_frame"):
        return jsonify({"ok": False, "error": "browser camera not found"}), 404
    frame_file = request.files.get("frame")
    if not frame_file:
        return jsonify({"ok": False, "error": "ต้องแนบไฟล์ภาพในฟิลด์ 'frame'"}), 400
    try:
        result = cam.process_frame(frame_file.read(), _resolve_training_model)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    return jsonify({"ok": True, **result})


@app.route("/api/cameras/<int:camera_id>")
def api_camera_status(camera_id):
    if not _camera_available():
        return jsonify({"error": "opencv-python not installed"}), 501
    cm = _get_camera_manager()
    cam = cm.get_camera(camera_id)
    if not cam:
        return jsonify({"error": "camera not found"}), 404
    return jsonify(cam.get_status())


@app.route("/api/cameras/<int:camera_id>", methods=["DELETE"])
def api_camera_remove(camera_id):
    if not _camera_available():
        return jsonify({"ok": False, "error": "opencv-python not installed"}), 501
    cm = _get_camera_manager()
    cm.remove_camera(camera_id)
    return jsonify({"ok": True})


@app.route("/api/cameras/<int:camera_id>/start", methods=["POST"])
def api_camera_start(camera_id):
    """CameraThread auto-starts on creation. If it's already running this is
    a no-op; if it has stopped or errored out, spin up a fresh thread with
    the same config so the camera can be restarted from the UI."""
    if not _camera_available():
        return jsonify({"ok": False, "error": "opencv-python not installed"}), 501
    cm = _get_camera_manager()
    cam = cm.get_camera(camera_id)
    if not cam:
        return jsonify({"ok": False, "error": "camera not found"}), 404
    if cam.state.status in ("streaming", "connecting"):
        return jsonify({"ok": True, "status": cam.state.status})
    if hasattr(cam, "process_frame"):
        # Browser-camera session: there's no server-side thread to restart —
        # the browser resumes pushing frames on its own; just mark it ready.
        cam.state.status = "streaming"
        cam.state.error = ""
        return jsonify({"ok": True, "status": cam.state.status})
    cm.restart_camera(camera_id)
    cam = cm.get_camera(camera_id)
    return jsonify({"ok": True, "status": cam.state.status})


@app.route("/api/cameras/<int:camera_id>/stop", methods=["POST"])
def api_camera_stop(camera_id):
    if not _camera_available():
        return jsonify({"ok": False, "error": "opencv-python not installed"}), 501
    cm = _get_camera_manager()
    cam = cm.get_camera(camera_id)
    if not cam:
        return jsonify({"ok": False, "error": "camera not found"}), 404
    cam.stop()
    return jsonify({"ok": True})


@app.route("/api/cameras/<int:camera_id>/stream")
def api_camera_stream(camera_id):
    if not _camera_available():
        return jsonify({"error": "opencv-python not installed"}), 501
    cm = _get_camera_manager()
    cam = cm.get_camera(camera_id)
    if not cam:
        return jsonify({"error": "camera not found"}), 404
    from stream_handler import camera_sse_stream
    return camera_sse_stream(cam)


@app.route("/api/counting/<int:cam_id>")
def api_counting_stats(cam_id):
    if not _camera_available():
        return jsonify({"error": "opencv-python not installed"}), 501
    cm = _get_camera_manager()
    cam = cm.get_camera(cam_id)
    if not cam:
        return jsonify({"error": "camera not found"}), 404
    engine = cam.get_counting_engine()
    if not engine:
        return jsonify({"error": "counting engine not ready"}), 503
    return jsonify(engine.get_stats())


@app.route("/api/counting/<int:cam_id>/reset", methods=["POST"])
def api_counting_reset(cam_id):
    if not _camera_available():
        return jsonify({"ok": False, "error": "opencv-python not installed"}), 501
    cm = _get_camera_manager()
    cam = cm.get_camera(cam_id)
    if not cam:
        return jsonify({"ok": False, "error": "camera not found"}), 404
    engine = cam.get_counting_engine()
    if engine:
        engine.reset_counts()
    return jsonify({"ok": True})


def _get_counting_engine_or_none(cam_id):
    cm = _get_camera_manager()
    cam = cm.get_camera(cam_id)
    if not cam:
        return None, jsonify({"ok": False, "error": "camera not found"}), 404
    engine = cam.get_counting_engine()
    if not engine:
        return None, jsonify({"ok": False, "error": "counting engine not ready"}), 503
    return engine, None, None


@app.route("/api/counting/<int:cam_id>/config")
def api_counting_config(cam_id):
    if not _camera_available():
        return jsonify({"error": "opencv-python not installed"}), 501
    engine, err, code = _get_counting_engine_or_none(cam_id)
    if engine is None:
        return err, code
    return jsonify({"zones": engine.list_zones(), "lines": engine.list_lines()})


@app.route("/api/counting/<int:cam_id>/zones", methods=["POST"])
def api_counting_add_zone(cam_id):
    if not _camera_available():
        return jsonify({"ok": False, "error": "opencv-python not installed"}), 501
    engine, err, code = _get_counting_engine_or_none(cam_id)
    if engine is None:
        return err, code
    data = request.json or {}
    points = data.get("points") or []
    if len(points) < 3:
        return jsonify({"ok": False, "error": "โซนต้องมีอย่างน้อย 3 จุด"}), 400
    from counting import Zone
    zone = Zone(
        id=uuid.uuid4().hex[:8],
        name=data.get("name", ""),
        points=points,
        label=data.get("label", ""),
    )
    engine.add_zone(zone)
    return jsonify({"ok": True, "zone": asdict(zone)})


@app.route("/api/counting/<int:cam_id>/zones/<zone_id>", methods=["DELETE"])
def api_counting_remove_zone(cam_id, zone_id):
    if not _camera_available():
        return jsonify({"ok": False, "error": "opencv-python not installed"}), 501
    engine, err, code = _get_counting_engine_or_none(cam_id)
    if engine is None:
        return err, code
    engine.remove_zone(zone_id)
    return jsonify({"ok": True})


@app.route("/api/counting/<int:cam_id>/lines", methods=["POST"])
def api_counting_add_line(cam_id):
    if not _camera_available():
        return jsonify({"ok": False, "error": "opencv-python not installed"}), 501
    engine, err, code = _get_counting_engine_or_none(cam_id)
    if engine is None:
        return err, code
    data = request.json or {}
    required = ("x1", "y1", "x2", "y2")
    if not all(k in data for k in required):
        return jsonify({"ok": False, "error": "ต้องระบุจุดเริ่มต้นและจุดสิ้นสุดของเส้น"}), 400
    from counting import CountingLine
    line = CountingLine(
        id=uuid.uuid4().hex[:8],
        name=data.get("name", ""),
        x1=float(data["x1"]),
        y1=float(data["y1"]),
        x2=float(data["x2"]),
        y2=float(data["y2"]),
        direction=data.get("direction", "both"),
    )
    engine.add_line(line)
    return jsonify({"ok": True, "line": asdict(line)})


@app.route("/api/counting/<int:cam_id>/lines/<line_id>", methods=["DELETE"])
def api_counting_remove_line(cam_id, line_id):
    if not _camera_available():
        return jsonify({"ok": False, "error": "opencv-python not installed"}), 501
    engine, err, code = _get_counting_engine_or_none(cam_id)
    if engine is None:
        return err, code
    engine.remove_line(line_id)
    return jsonify({"ok": True})


# ── Run ──────────────────────────────────────────────────────────────
# Initialise database on import (works for both __main__ and gunicorn)
_db.init_db()

if __name__ == "__main__":
    print("=" * 50)
    print("  Ai-JIN Platform Dashboard")
    print(f"  http://localhost:8501")
    print(f"  Label Studio: {LS_URL}")
    print(f"  YOLO Train:   {YOLO_URL}")
    print(f"  Dataset:      {DATASET}")
    print(f"  Database:     {_db.DB_PATH}")
    print("=" * 50)
    app.run(host="0.0.0.0", port=8501, debug=False)
