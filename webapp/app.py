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
from pathlib import Path
import db as _db

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB upload limit

# ── Config ────────────────────────────────────────────────────────────
LS_URL = os.getenv("LABEL_STUDIO_URL", "http://localhost:8085")
LS_TOKEN = os.getenv("LABEL_STUDIO_TOKEN", "")
YOLO_URL = os.getenv("YOLO_TRAIN_URL", "http://localhost:8111")
DATASET = Path(os.getenv("DATASET_PATH", r"D:\Ai-JIN_V10.0_patch_output\dataset"))
RUNS = Path(os.getenv("RUNS_PATH", r"D:\Ai-JIN_V10.0_patch_output\runs"))
MODEL_DIR = Path(os.getenv("MODEL_PATH", r"D:\Ai-JIN_V10.0_patch_output\app"))
IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tiff"}
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://192.168.93:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llava")


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


# ── Pages ─────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html", ls_url=LS_URL, yolo_url=YOLO_URL)


@app.route("/healthz")
def healthz():
    return jsonify({"ok": True})


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

    f = request.files.get("image")
    if not f:
        return jsonify({"error": "No image uploaded"})
    conf = float(request.form.get("conf", "0.25"))
    model_path = request.form.get("model", str(MODEL_DIR / "best.pt"))

    import tempfile, cv2, numpy as np
    raw = f.read()
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return jsonify({"error": "Cannot decode image"})

    model = YOLO(model_path)
    results = model.predict(source=img, conf=conf, verbose=False)
    id_to_name = _load_class_name_map()
    detections = []
    for r in results:
        h, w = r.orig_shape
        for box in r.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            cls_id = int(box.cls[0])
            raw_name = r.names.get(cls_id, str(cls_id))
            detections.append({
                "class_id": cls_id,
                "class_name": _remap_class_name(cls_id, raw_name, id_to_name),
                "confidence": round(float(box.conf[0]), 4),
                "bbox": [round(x1), round(y1), round(x2), round(y2)],
            })
    return jsonify({
        "status": "ok", "image_width": w, "image_height": h,
        "detections": detections, "count": len(detections),
    })


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
    return jsonify(yolo_get("/health"))


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
    result = yolo_post(body)
    # Record in DB
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
    train_dir = RUNS / "train"
    if train_dir.exists():
        for run in sorted(train_dir.iterdir(), reverse=True):
            best = run / "weights" / "best.pt"
            if not best.exists():
                continue
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
    """Upload images to a dataset folder"""
    target_class = request.form.get("class_name", "uncategorized")
    split = request.form.get("split", "train")
    dest = _safe_path(DATASET, f"auto_improve/images/{split}/{target_class}")
    dest.mkdir(parents=True, exist_ok=True)
    files = request.files.getlist("images")
    saved = []
    skipped = []
    for f in files:
        if not f.filename:
            continue
        ext = Path(f.filename).suffix.lower()
        if ext not in IMG_EXT:
            skipped.append(f.filename)
            continue
        safe_name = Path(f.filename).name.replace(" ", "_")
        out = dest / safe_name
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


@app.route("/api/import/delete", methods=["POST"])
def api_import_delete():
    """Delete images from dataset"""
    data = request.json or {}
    paths = data.get("paths", [])
    deleted = 0
    for p in paths:
        full = _safe_path(DATASET, p)
        if full.exists() and full.suffix.lower() in IMG_EXT:
            label_dir = full.parent.parent / "labels"
            label_file = label_dir / f"{full.stem}.txt"
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
    paths = data.get("paths", [])
    target_split = data.get("target_split", "val")
    moved = 0
    for p in paths:
        full = _safe_path(DATASET, p)
        if not full.exists():
            continue
        class_name = full.parent.name
        dest_dir = DATASET / "auto_improve" / "images" / target_split / class_name
        dest_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(str(full), str(dest_dir / full.name))
        label_src = full.parent.parent.parent / "labels" / full.parent.parent.name / class_name / f"{full.stem}.txt"
        if not label_src.exists():
            label_src = full.parent.parent / "labels" / f"{full.stem}.txt"
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


# ── API: SAM Segmentation ─────────────────────────────────────────────
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
