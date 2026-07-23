"""
db.py — SQLite database layer for AI-JIN Platform
Uses Python built-in sqlite3, no ORM required.
"""
import sqlite3
import json
import time
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime

DB_PATH = Path(__file__).parent / "aijin.db"


@contextmanager
def get_db():
    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def now_iso():
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def init_db():
    """Create all tables if they don't exist."""
    with get_db() as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS projects (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL UNIQUE,
            description TEXT    DEFAULT '',
            dataset_dir TEXT    DEFAULT '',
            created_at  TEXT    NOT NULL,
            updated_at  TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS classes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name       TEXT    NOT NULL,
            color      TEXT    DEFAULT '#6366f1',
            class_idx  INTEGER DEFAULT 0,
            created_at TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS images (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            path           TEXT    NOT NULL,
            filename       TEXT    NOT NULL,
            split          TEXT    DEFAULT 'train',
            width          INTEGER DEFAULT 0,
            height         INTEGER DEFAULT 0,
            labeled        INTEGER DEFAULT 0,
            annotation_count INTEGER DEFAULT 0,
            created_at     TEXT    NOT NULL,
            updated_at     TEXT    NOT NULL,
            UNIQUE(project_id, path)
        );

        CREATE TABLE IF NOT EXISTS annotations (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            image_id   INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
            class_id   INTEGER NOT NULL,
            ann_type   TEXT    NOT NULL DEFAULT 'box',
            data       TEXT    NOT NULL DEFAULT '{}',
            created_at TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS training_runs (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
            run_name     TEXT    NOT NULL,
            model_base   TEXT    DEFAULT 'yolov8n.pt',
            epochs       INTEGER DEFAULT 100,
            batch        INTEGER DEFAULT 16,
            imgsz        INTEGER DEFAULT 640,
            status       TEXT    DEFAULT 'idle',
            progress     REAL    DEFAULT 0,
            epoch_cur    INTEGER DEFAULT 0,
            metrics      TEXT    DEFAULT '{}',
            log          TEXT    DEFAULT '',
            started_at   TEXT,
            finished_at  TEXT,
            created_at   TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS models_registry (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
            run_id       INTEGER REFERENCES training_runs(id) ON DELETE SET NULL,
            name         TEXT    NOT NULL,
            path         TEXT    NOT NULL,
            fmt          TEXT    DEFAULT 'pt',
            size_bytes   INTEGER DEFAULT 0,
            map50        REAL    DEFAULT 0,
            map50_95     REAL    DEFAULT 0,
            deployed     INTEGER DEFAULT 0,
            created_at   TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS activity_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT    NOT NULL,
            title      TEXT    NOT NULL,
            detail     TEXT    DEFAULT '',
            project_id INTEGER,
            created_at TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cam_zones (
            id          TEXT PRIMARY KEY,
            cam_key     TEXT NOT NULL,
            name        TEXT DEFAULT '',
            label       TEXT DEFAULT '',
            points_json TEXT NOT NULL,
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cam_lines (
            id          TEXT PRIMARY KEY,
            cam_key     TEXT NOT NULL,
            name        TEXT DEFAULT '',
            x1          REAL NOT NULL,
            y1          REAL NOT NULL,
            x2          REAL NOT NULL,
            y2          REAL NOT NULL,
            direction   TEXT DEFAULT 'both',
            created_at  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_images_project ON images(project_id);
        CREATE INDEX IF NOT EXISTS idx_annotations_image ON annotations(image_id);
        CREATE INDEX IF NOT EXISTS idx_training_runs_project ON training_runs(project_id);
        CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_cam_zones_key ON cam_zones(cam_key);
        CREATE INDEX IF NOT EXISTS idx_cam_lines_key ON cam_lines(cam_key);
        """)


# ── Projects ──────────────────────────────────────────────────────────

def project_list():
    with get_db() as con:
        rows = con.execute("""
            SELECT p.*,
                   COUNT(DISTINCT i.id) as image_count,
                   SUM(i.labeled) as labeled_count,
                   COUNT(DISTINCT c.id) as class_count,
                   COUNT(DISTINCT tr.id) as run_count
            FROM projects p
            LEFT JOIN images i ON i.project_id = p.id
            LEFT JOIN classes c ON c.project_id = p.id
            LEFT JOIN training_runs tr ON tr.project_id = p.id
            GROUP BY p.id
            ORDER BY p.updated_at DESC
        """).fetchall()
        return [dict(r) for r in rows]


def project_get(pid):
    with get_db() as con:
        row = con.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
        return dict(row) if row else None


def project_create(name, description="", dataset_dir=""):
    t = now_iso()
    with get_db() as con:
        cur = con.execute(
            "INSERT INTO projects(name,description,dataset_dir,created_at,updated_at) VALUES(?,?,?,?,?)",
            (name, description, dataset_dir, t, t))
        pid = cur.lastrowid
        activity_add("project_create", f"สร้างโปรเจกต์ {name}", project_id=pid, con=con)
        return pid


def project_update(pid, **kwargs):
    kwargs["updated_at"] = now_iso()
    sets = ", ".join(f"{k}=?" for k in kwargs)
    vals = list(kwargs.values()) + [pid]
    with get_db() as con:
        con.execute(f"UPDATE projects SET {sets} WHERE id=?", vals)


def project_delete(pid):
    with get_db() as con:
        con.execute("DELETE FROM projects WHERE id=?", (pid,))


# ── Classes ───────────────────────────────────────────────────────────

SWATCH_COLORS = [
    '#6366f1','#22c55e','#ef4444','#eab308','#06b6d4',
    '#f97316','#a855f7','#ec4899','#14b8a6','#84cc16',
]

def class_list(project_id):
    with get_db() as con:
        rows = con.execute(
            "SELECT * FROM classes WHERE project_id=? ORDER BY class_idx",
            (project_id,)).fetchall()
        return [dict(r) for r in rows]


def class_upsert(project_id, name, color=None, class_idx=None):
    with get_db() as con:
        row = con.execute(
            "SELECT id FROM classes WHERE project_id=? AND name=?",
            (project_id, name)).fetchone()
        if row:
            return row["id"]
        if class_idx is None:
            row2 = con.execute(
                "SELECT COALESCE(MAX(class_idx)+1,0) as nxt FROM classes WHERE project_id=?",
                (project_id,)).fetchone()
            class_idx = row2["nxt"]
        if color is None:
            color = SWATCH_COLORS[class_idx % len(SWATCH_COLORS)]
        cur = con.execute(
            "INSERT INTO classes(project_id,name,color,class_idx,created_at) VALUES(?,?,?,?,?)",
            (project_id, name, color, class_idx, now_iso()))
        return cur.lastrowid


def class_delete(cls_id):
    with get_db() as con:
        con.execute("DELETE FROM classes WHERE id=?", (cls_id,))


def class_rename(cls_id, new_name):
    with get_db() as con:
        con.execute("UPDATE classes SET name=? WHERE id=?", (new_name, cls_id))


# ── Images ────────────────────────────────────────────────────────────

def image_upsert(project_id, path, filename, split="train", width=0, height=0):
    t = now_iso()
    with get_db() as con:
        con.execute("""
            INSERT INTO images(project_id,path,filename,split,width,height,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(project_id,path) DO UPDATE SET
                filename=excluded.filename, split=excluded.split,
                updated_at=excluded.updated_at
        """, (project_id, path, filename, split, width, height, t, t))
        row = con.execute(
            "SELECT id FROM images WHERE project_id=? AND path=?",
            (project_id, path)).fetchone()
        return row["id"]


def image_set_labeled(image_id, labeled, ann_count=0):
    with get_db() as con:
        con.execute(
            "UPDATE images SET labeled=?, annotation_count=?, updated_at=? WHERE id=?",
            (1 if labeled else 0, ann_count, now_iso(), image_id))


def image_list(project_id, split=None, page=1, per_page=60):
    with get_db() as con:
        where = "WHERE project_id=?"
        params = [project_id]
        if split:
            where += " AND split=?"
            params.append(split)
        total = con.execute(
            f"SELECT COUNT(*) as n FROM images {where}", params).fetchone()["n"]
        offset = (page - 1) * per_page
        rows = con.execute(
            f"SELECT * FROM images {where} ORDER BY filename LIMIT ? OFFSET ?",
            params + [per_page, offset]).fetchall()
        return {"total": total, "images": [dict(r) for r in rows]}


def image_stats(project_id):
    with get_db() as con:
        row = con.execute("""
            SELECT COUNT(*) as total,
                   SUM(labeled) as labeled,
                   SUM(annotation_count) as annotations
            FROM images WHERE project_id=?
        """, (project_id,)).fetchone()
        return dict(row)


# ── Annotations ───────────────────────────────────────────────────────

def annotation_save(image_id, anns):
    """Replace all annotations for an image. anns = list of dicts."""
    t = now_iso()
    with get_db() as con:
        con.execute("DELETE FROM annotations WHERE image_id=?", (image_id,))
        for a in anns:
            con.execute(
                "INSERT INTO annotations(image_id,class_id,ann_type,data,created_at) VALUES(?,?,?,?,?)",
                (image_id, a["class_id"], a.get("type","box"),
                 json.dumps(a.get("data", {})), t))
        # Update image labeled status
        con.execute(
            "UPDATE images SET labeled=?, annotation_count=?, updated_at=? WHERE id=?",
            (1 if anns else 0, len(anns), t, image_id))


def annotation_load(image_id):
    with get_db() as con:
        rows = con.execute(
            "SELECT * FROM annotations WHERE image_id=? ORDER BY id",
            (image_id,)).fetchall()
        return [dict(r) for r in rows]


# ── Training Runs ─────────────────────────────────────────────────────

def run_create(run_name, project_id=None, model_base="yolov8n.pt",
               epochs=100, batch=16, imgsz=640):
    t = now_iso()
    with get_db() as con:
        cur = con.execute("""
            INSERT INTO training_runs
            (project_id,run_name,model_base,epochs,batch,imgsz,status,started_at,created_at)
            VALUES(?,?,?,?,?,?,'training',?,?)
        """, (project_id, run_name, model_base, epochs, batch, imgsz, t, t))
        rid = cur.lastrowid
        activity_add("train_start", f"เริ่มเทรน {run_name}", project_id=project_id, con=con)
        return rid


def run_update(run_id, **kwargs):
    if "metrics" in kwargs and isinstance(kwargs["metrics"], dict):
        kwargs["metrics"] = json.dumps(kwargs["metrics"])
    sets = ", ".join(f"{k}=?" for k in kwargs)
    vals = list(kwargs.values()) + [run_id]
    with get_db() as con:
        con.execute(f"UPDATE training_runs SET {sets} WHERE id=?", vals)


def run_finish(run_id, status="completed", metrics=None):
    t = now_iso()
    m = json.dumps(metrics or {})
    with get_db() as con:
        con.execute(
            "UPDATE training_runs SET status=?,metrics=?,finished_at=?,progress=100 WHERE id=?",
            (status, m, t, run_id))
        row = con.execute("SELECT run_name,project_id FROM training_runs WHERE id=?",
                          (run_id,)).fetchone()
        if row:
            label = "เทรนเสร็จ" if status == "completed" else "เทรนผิดพลาด"
            activity_add(f"train_{status}", f"{label}: {row['run_name']}",
                         project_id=row["project_id"], con=con)


def run_list(project_id=None, limit=50):
    with get_db() as con:
        if project_id:
            rows = con.execute(
                "SELECT * FROM training_runs WHERE project_id=? ORDER BY created_at DESC LIMIT ?",
                (project_id, limit)).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM training_runs ORDER BY created_at DESC LIMIT ?",
                (limit,)).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            if d.get("metrics"):
                try:
                    d["metrics"] = json.loads(d["metrics"])
                except Exception:
                    pass
            result.append(d)
        return result


def run_get(run_id):
    with get_db() as con:
        row = con.execute("SELECT * FROM training_runs WHERE id=?", (run_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        if d.get("metrics"):
            try:
                d["metrics"] = json.loads(d["metrics"])
            except Exception:
                pass
        return d


# ── Models Registry ───────────────────────────────────────────────────

def model_register(name, path, run_id=None, project_id=None,
                   fmt="pt", size_bytes=0, map50=0, map50_95=0):
    t = now_iso()
    with get_db() as con:
        cur = con.execute("""
            INSERT INTO models_registry
            (project_id,run_id,name,path,fmt,size_bytes,map50,map50_95,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)
        """, (project_id, run_id, name, path, fmt, size_bytes, map50, map50_95, t))
        activity_add("model_saved", f"บันทึกโมเดล {name}", project_id=project_id, con=con)
        return cur.lastrowid


def model_deploy(model_id):
    with get_db() as con:
        con.execute("UPDATE models_registry SET deployed=0")
        con.execute("UPDATE models_registry SET deployed=1 WHERE id=?", (model_id,))
        row = con.execute("SELECT name,project_id FROM models_registry WHERE id=?",
                          (model_id,)).fetchone()
        if row:
            activity_add("model_deploy", f"Deploy โมเดล {row['name']}",
                         project_id=row["project_id"], con=con)


def model_list(project_id=None):
    with get_db() as con:
        if project_id:
            rows = con.execute(
                "SELECT * FROM models_registry WHERE project_id=? ORDER BY created_at DESC",
                (project_id,)).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM models_registry ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]


def model_delete(model_id):
    with get_db() as con:
        con.execute("DELETE FROM models_registry WHERE id=?", (model_id,))


# ── Activity Log ──────────────────────────────────────────────────────

def activity_add(event_type, title, detail="", project_id=None, con=None):
    """Log an activity entry. Pass an existing *con* when calling from inside
    another function's own `with get_db()` block — opening a second connection
    there would try to write while the first's transaction is still open,
    deadlocking both until the busy timeout trips ("database is locked")."""
    if con is not None:
        con.execute(
            "INSERT INTO activity_log(event_type,title,detail,project_id,created_at) VALUES(?,?,?,?,?)",
            (event_type, title, detail, project_id, now_iso()))
        return
    with get_db() as con:
        con.execute(
            "INSERT INTO activity_log(event_type,title,detail,project_id,created_at) VALUES(?,?,?,?,?)",
            (event_type, title, detail, project_id, now_iso()))


def activity_list(limit=20, project_id=None):
    with get_db() as con:
        if project_id:
            rows = con.execute(
                "SELECT * FROM activity_log WHERE project_id=? ORDER BY created_at DESC LIMIT ?",
                (project_id, limit)).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?",
                (limit,)).fetchall()
        return [dict(r) for r in rows]


# ── Dashboard Stats ───────────────────────────────────────────────────

def db_stats():
    with get_db() as con:
        total_images = con.execute("SELECT COUNT(*) as n FROM images").fetchone()["n"]
        labeled_images = con.execute("SELECT SUM(labeled) as n FROM images").fetchone()["n"] or 0
        total_anns = con.execute("SELECT COUNT(*) as n FROM annotations").fetchone()["n"]
        total_projects = con.execute("SELECT COUNT(*) as n FROM projects").fetchone()["n"]
        total_classes = con.execute("SELECT COUNT(*) as n FROM classes").fetchone()["n"]
        total_runs = con.execute("SELECT COUNT(*) as n FROM training_runs").fetchone()["n"]
        total_models = con.execute("SELECT COUNT(*) as n FROM models_registry").fetchone()["n"]
        deployed = con.execute(
            "SELECT COUNT(*) as n FROM models_registry WHERE deployed=1").fetchone()["n"]
        active_run = con.execute(
            "SELECT * FROM training_runs WHERE status='training' ORDER BY started_at DESC LIMIT 1"
        ).fetchone()
        return {
            "total_images": total_images,
            "labeled_images": int(labeled_images),
            "unlabeled_images": total_images - int(labeled_images),
            "label_rate": round(labeled_images / total_images * 100, 1) if total_images else 0,
            "total_annotations": total_anns,
            "total_projects": total_projects,
            "total_classes": total_classes,
            "total_training_runs": total_runs,
            "total_models": total_models,
            "deployed_models": deployed,
            "active_training": dict(active_run) if active_run else None,
        }


# ── Sync helper (disk → DB) ───────────────────────────────────────────

def sync_images_from_disk(project_id, dataset_dir, img_ext=None):
    """Scan dataset_dir and register all images in DB. Returns count added."""
    if img_ext is None:
        img_ext = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tiff"}
    dataset_dir = Path(dataset_dir)
    if not dataset_dir.exists():
        return 0
    added = 0
    for split in ("train", "val", "test"):
        img_dir = dataset_dir / "images" / split
        if not img_dir.exists():
            continue
        for f in img_dir.rglob("*"):
            if f.suffix.lower() not in img_ext:
                continue
            rel = str(f.relative_to(dataset_dir.parent)).replace("\\", "/")
            label_path = dataset_dir / "labels" / split / f"{f.stem}.txt"
            labeled = 1 if label_path.exists() else 0
            ann_count = 0
            if labeled:
                try:
                    lines = [l for l in label_path.read_text().splitlines() if l.strip()]
                    ann_count = len(lines)
                except Exception:
                    pass
            t = now_iso()
            with get_db() as con:
                con.execute("""
                    INSERT INTO images(project_id,path,filename,split,labeled,annotation_count,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?)
                    ON CONFLICT(project_id,path) DO UPDATE SET
                        labeled=excluded.labeled,
                        annotation_count=excluded.annotation_count,
                        updated_at=excluded.updated_at
                """, (project_id, rel, f.name, split, labeled, ann_count, t, t))
            added += 1
    return added


# ── Camera zone/line persistence ──────────────────────────────────────

def save_cam_zone(cam_key: str, zone: dict):
    """Upsert a zone for a camera (keyed by source)."""
    with get_db() as con:
        con.execute("""
            INSERT INTO cam_zones(id, cam_key, name, label, points_json, created_at)
            VALUES(?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, label=excluded.label, points_json=excluded.points_json
        """, (zone["id"], cam_key, zone.get("name", ""), zone.get("label", ""),
              json.dumps(zone.get("points", [])), now_iso()))


def delete_cam_zone(zone_id: str):
    with get_db() as con:
        con.execute("DELETE FROM cam_zones WHERE id=?", (zone_id,))


def load_cam_zones(cam_key: str) -> list:
    with get_db() as con:
        rows = con.execute("SELECT * FROM cam_zones WHERE cam_key=? ORDER BY created_at", (cam_key,)).fetchall()
    return [{"id": r["id"], "name": r["name"], "label": r["label"],
             "points": json.loads(r["points_json"])} for r in rows]


def save_cam_line(cam_key: str, line: dict):
    """Upsert a counting line for a camera."""
    with get_db() as con:
        con.execute("""
            INSERT INTO cam_lines(id, cam_key, name, x1, y1, x2, y2, direction, created_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, x1=excluded.x1, y1=excluded.y1,
                x2=excluded.x2, y2=excluded.y2, direction=excluded.direction
        """, (line["id"], cam_key, line.get("name", ""),
              line["x1"], line["y1"], line["x2"], line["y2"],
              line.get("direction", "both"), now_iso()))


def delete_cam_line(line_id: str):
    with get_db() as con:
        con.execute("DELETE FROM cam_lines WHERE id=?", (line_id,))


def load_cam_lines(cam_key: str) -> list:
    with get_db() as con:
        rows = con.execute("SELECT * FROM cam_lines WHERE cam_key=? ORDER BY created_at", (cam_key,)).fetchall()
    return [{"id": r["id"], "name": r["name"], "x1": r["x1"], "y1": r["y1"],
             "x2": r["x2"], "y2": r["y2"], "direction": r["direction"]} for r in rows]
