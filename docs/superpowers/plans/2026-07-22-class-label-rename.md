# Synchronized Class Label Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one safe class-label rename workflow that preserves YOLO class IDs while synchronizing SQLite, dataset metadata, class directories, Projects, Annotator, built assets, and Thai operator documentation.

**Architecture:** Put validation, metadata transformation, directory moves, atomic writes, and rollback in a focused Python module. Expose it through one locked Flask `PATCH /api/classes/<cid>` route that resolves the current project and runtime dataset root, then call that route from both React surfaces. Keep project class order authoritative in Annotator and cover state transformations with a small pure JavaScript helper.

**Tech Stack:** Python 3, Flask, SQLite, PyYAML, pathlib/shutil, pytest, React 19, Vite 8, oxlint, Node `node:test`, browser verification.

---

## File Structure

- Create `webapp/class_label_sync.py` — pure rename coordinator, validation, YAML/JSON updates, filesystem journal, rollback.
- Create `webapp/tests/test_class_label_rename_api.py` — isolated SQLite and temporary-dataset API coverage.
- Modify `webapp/db.py` — fetch a class with its owning project and return the renamed row.
- Modify `webapp/app.py` — lock, dataset-root resolution, error mapping, and `PATCH /api/classes/<cid>`.
- Create `webapp/frontend/src/pages/classLabelState.js` — deterministic class ordering and in-place name replacement helpers.
- Create `webapp/frontend/src/pages/classLabelState.test.js` — Node tests for frontend state contracts.
- Modify `webapp/frontend/package.json` — add focused frontend test command.
- Modify `webapp/frontend/src/api/client.js` — add `classRename` API call.
- Modify `webapp/frontend/src/pages/Projects.jsx` and `Projects.css` — inline edit interaction.
- Modify `webapp/frontend/src/pages/Annotator.jsx` and `Annotator.css` — synchronized edit interaction and authoritative project ordering.
- Create `docs/manual/Ai-JIN-Platform-Class-Label-Rename-Guide-TH.md` — Thai operator guide.
- Create `docs/manual/Ai-JIN-Platform-Class-Label-Rename-Guide-TH.html` — styled printable/browser guide.
- Create browser captures under `docs/manual/images/` — Projects edit, Annotator edit, and successful synchronization evidence.
- Rebuild `webapp/static/` — production-served React assets.

### Task 1: Build the Synchronization Core with Rollback

**Files:**
- Create: `webapp/class_label_sync.py`
- Create: `webapp/tests/test_class_label_rename_api.py`

- [ ] **Step 1: Add the isolated test loader and successful-rename fixture**

Create `webapp/tests/test_class_label_rename_api.py` with a loader that never touches the repository database:

```python
import importlib
import json
import sys
from pathlib import Path

import pytest
import yaml


def load_app(monkeypatch, tmp_path):
    monkeypatch.setenv("DATASET_PATH", str(tmp_path / "dataset"))
    monkeypatch.setenv("MODEL_PATH", str(tmp_path / "models"))
    monkeypatch.setenv("RUNS_PATH", str(tmp_path / "runs"))
    webapp_dir = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(webapp_dir))
    try:
        import app
        app_mod = importlib.reload(app)
        monkeypatch.setattr(app_mod._db, "DB_PATH", tmp_path / "aijin.db")
        app_mod._db.init_db()
        return app_mod
    finally:
        sys.path.remove(str(webapp_dir))


def seed_project(app_mod, name="Part A", class_idx=0, dataset_dir=""):
    pid = app_mod._db.project_create("rename-test", dataset_dir=dataset_dir)
    cid = app_mod._db.class_upsert(pid, name, class_idx=class_idx)
    return pid, cid


def seed_dataset(app_mod, old_name="Part A", class_idx=0):
    root = Path(app_mod.DATASET) / "auto_improve"
    for split in ("train", "val", "test"):
        image_dir = root / "images" / split / old_name
        label_dir = root / "labels" / split / old_name
        image_dir.mkdir(parents=True)
        label_dir.mkdir(parents=True)
        (image_dir / f"{split}.jpg").write_bytes(b"image")
        (label_dir / f"{split}.txt").write_text(
            f"{class_idx} 0.5 0.5 0.2 0.2\n", encoding="utf-8"
        )
    (root / "class_mapping.json").write_text(
        json.dumps({"model_to_class_id": {old_name: class_idx}, "version": 7}),
        encoding="utf-8",
    )
    (root / "data.yaml").write_text(
        yaml.safe_dump({
            "path": ".",
            "train": "images/train",
            "val": "images/val",
            "test": "images/test",
            "nc": 1,
            "names": [old_name],
        }, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    return root


def test_class_rename_synchronizes_metadata_directories_and_preserves_ids(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    pid, cid = seed_project(app_mod)
    root = seed_dataset(app_mod)

    response = app_mod.app.test_client().patch(
        f"/api/classes/{cid}", json={"name": "ชิ้นงาน A"}
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["class"]["project_id"] == pid
    assert payload["class"]["class_idx"] == 0
    assert payload["class"]["name"] == "ชิ้นงาน A"
    assert payload["moved_directories"] == 6
    assert app_mod._db.class_get(cid)["name"] == "ชิ้นงาน A"

    mapping = json.loads((root / "class_mapping.json").read_text(encoding="utf-8"))
    assert mapping == {"model_to_class_id": {"ชิ้นงาน A": 0}, "version": 7}
    data = yaml.safe_load((root / "data.yaml").read_text(encoding="utf-8"))
    assert data["names"] == ["ชิ้นงาน A"]
    assert data["nc"] == 1
    for split in ("train", "val", "test"):
        assert not (root / "images" / split / "Part A").exists()
        assert not (root / "labels" / split / "Part A").exists()
        assert (root / "images" / split / "ชิ้นงาน A").is_dir()
        label = root / "labels" / split / "ชิ้นงาน A" / f"{split}.txt"
        assert label.read_text(encoding="utf-8").startswith("0 ")
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from `webapp/`:

```powershell
pytest tests/test_class_label_rename_api.py::test_class_rename_synchronizes_metadata_directories_and_preserves_ids -v --basetemp=.pytest_tmp_class_rename
```

Expected: FAIL because `PATCH /api/classes/<cid>` and `class_get()` do not exist.

- [ ] **Step 3: Add transformation, journal, and error types**

Create `webapp/class_label_sync.py` with the following public interface and helpers:

```python
import json
import os
import shutil
import uuid
from pathlib import Path

import yaml


SPLITS = ("train", "val", "test")
INVALID_FILENAME_CHARS = set('<>:"/\\|?*')


class ClassLabelSyncError(Exception):
    def __init__(self, message, status=400, details=None):
        super().__init__(message)
        self.status = status
        self.details = details or {}


def validate_class_name(value):
    name = str(value or "").strip()
    if not name:
        raise ClassLabelSyncError("กรุณาระบุชื่อ Class label", 400)
    if name in {".", ".."} or name.endswith((" ", ".")):
        raise ClassLabelSyncError("ชื่อ Class label ไม่สามารถใช้เป็นชื่อโฟลเดอร์ได้", 400)
    if any(ch in INVALID_FILENAME_CHARS or ord(ch) < 32 for ch in name):
        raise ClassLabelSyncError("ชื่อ Class label มีอักขระที่ไม่อนุญาต", 400)
    return name


def _read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ClassLabelSyncError(f"อ่าน class_mapping.json ไม่สำเร็จ: {exc}", 409) from exc


def _read_yaml(path):
    try:
        value = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        raise ClassLabelSyncError(f"อ่าน data.yaml ไม่สำเร็จ: {exc}", 409) from exc
    if not isinstance(value, dict):
        raise ClassLabelSyncError("data.yaml ต้องเป็น mapping", 409)
    return value


def _updated_mapping(document, old_name, new_name, class_idx):
    updated = dict(document)
    mapping = dict(updated.get("model_to_class_id") or {})
    for label, value in mapping.items():
        try:
            mapped_id = int(value)
        except (TypeError, ValueError) as exc:
            raise ClassLabelSyncError(f"Class ID ของ {label} ไม่ถูกต้อง", 409) from exc
        if label.casefold() == new_name.casefold() and label != old_name:
            raise ClassLabelSyncError(f'Class label "{new_name}" มีอยู่แล้ว', 409)
        if mapped_id == class_idx and label != old_name:
            raise ClassLabelSyncError(
                f"Class ID {class_idx} ถูกใช้โดย {label} ใน class_mapping.json", 409
            )
    if old_name in mapping and int(mapping[old_name]) != class_idx:
        raise ClassLabelSyncError("Class ID ใน class_mapping.json ไม่ตรงกับ Project", 409)
    mapping.pop(old_name, None)
    mapping[new_name] = class_idx
    updated["model_to_class_id"] = mapping
    return updated


def _updated_yaml(document, old_name, new_name, class_idx):
    updated = dict(document)
    names = updated.get("names")
    if isinstance(names, list):
        values = list(names)
        if class_idx > len(values):
            raise ClassLabelSyncError("ลำดับ Class ID ใน data.yaml ไม่ต่อเนื่อง", 409)
        if class_idx == len(values):
            values.append(new_name)
        elif str(values[class_idx]) not in {old_name, new_name}:
            raise ClassLabelSyncError("Class ID ใน data.yaml ไม่ตรงกับ Project", 409)
        else:
            values[class_idx] = new_name
        updated["names"] = values
        updated["nc"] = len(values)
        return updated
    if isinstance(names, dict):
        values = dict(names)
        key = class_idx if class_idx in values else str(class_idx)
        current = values.get(key)
        if current is not None and str(current) not in {old_name, new_name}:
            raise ClassLabelSyncError("Class ID ใน data.yaml ไม่ตรงกับ Project", 409)
        values[key] = new_name
        updated["names"] = values
        numeric_ids = [int(item) for item in values]
        updated["nc"] = max(numeric_ids, default=-1) + 1
        return updated
    raise ClassLabelSyncError("data.yaml ไม่มี names ที่รองรับ", 409)


def _atomic_write(path, content):
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temp.write_bytes(content)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def _move_directory(source, destination):
    if source.name.casefold() == destination.name.casefold():
        temp = source.with_name(f".__class_rename_{uuid.uuid4().hex}")
        shutil.move(str(source), str(temp))
        try:
            shutil.move(str(temp), str(destination))
        except Exception:
            if temp.exists() and not source.exists():
                shutil.move(str(temp), str(source))
            raise
    else:
        shutil.move(str(source), str(destination))


def synchronize_class_label(
    *, dataset_root, class_row, project_classes, new_name, safe_path, rename_class
):
    old_name = class_row["name"]
    class_idx = int(class_row["class_idx"])
    new_name = validate_class_name(new_name)
    if new_name == old_name:
        return {
            "class": dict(class_row), "old_name": old_name,
            "updated_files": [], "moved_directories": 0, "skipped": ["no-op"],
        }
    for row in project_classes:
        if row["id"] != class_row["id"] and row["name"].casefold() == new_name.casefold():
            raise ClassLabelSyncError(f'Class label "{new_name}" มีอยู่แล้ว', 409)

    root = Path(dataset_root).resolve()
    mapping_path = safe_path(root, "class_mapping.json")
    yaml_path = safe_path(root, "data.yaml")
    originals = {}
    replacements = {}
    skipped = []
    if mapping_path.exists():
        originals[mapping_path] = mapping_path.read_bytes()
        replacements[mapping_path] = json.dumps(
            _updated_mapping(_read_json(mapping_path), old_name, new_name, class_idx),
            ensure_ascii=False, indent=2,
        ).encode("utf-8")
    else:
        skipped.append("class_mapping.json")
    if yaml_path.exists():
        originals[yaml_path] = yaml_path.read_bytes()
        replacements[yaml_path] = yaml.safe_dump(
            _updated_yaml(_read_yaml(yaml_path), old_name, new_name, class_idx),
            sort_keys=False, allow_unicode=True,
        ).encode("utf-8")
    else:
        skipped.append("data.yaml")

    moves = []
    case_only = old_name.casefold() == new_name.casefold()
    for kind in ("images", "labels"):
        for split in SPLITS:
            source = safe_path(root, f"{kind}/{split}/{old_name}")
            destination = safe_path(root, f"{kind}/{split}/{new_name}")
            if not source.exists():
                skipped.append(f"{kind}/{split}/{old_name}")
                continue
            if destination.exists() and not case_only:
                raise ClassLabelSyncError(
                    f"โฟลเดอร์ปลายทางมีอยู่แล้ว: {kind}/{split}/{new_name}", 409
                )
            moves.append((source, destination))

    completed_moves = []
    written = []
    try:
        for source, destination in moves:
            _move_directory(source, destination)
            completed_moves.append((source, destination))
        for path, content in replacements.items():
            _atomic_write(path, content)
            written.append(path)
        renamed = rename_class(class_row["id"], new_name)
    except Exception as exc:
        rollback_errors = []
        for path in reversed(written):
            try:
                _atomic_write(path, originals[path])
            except Exception as rollback_exc:
                rollback_errors.append(str(rollback_exc))
        for source, destination in reversed(completed_moves):
            try:
                case_only_move = source.name.casefold() == destination.name.casefold()
                if destination.exists() and (case_only_move or not source.exists()):
                    _move_directory(destination, source)
            except Exception as rollback_exc:
                rollback_errors.append(str(rollback_exc))
        if isinstance(exc, ClassLabelSyncError):
            raise
        raise ClassLabelSyncError(
            f"เปลี่ยนชื่อ Class label ไม่สำเร็จ: {exc}", 500,
            {"rollback_ok": not rollback_errors, "rollback_errors": rollback_errors},
        ) from exc

    return {
        "class": renamed,
        "old_name": old_name,
        "updated_files": [path.name for path in replacements],
        "moved_directories": len(completed_moves),
        "skipped": skipped,
    }
```

- [ ] **Step 4: Add direct unit tests for validation and metadata forms**

Append tests that call module helpers through the API-visible behavior:

```python
@pytest.mark.parametrize("name", ["", "   ", ".", "..", "bad/name", "bad\\name", "bad:name", "bad."])
def test_class_rename_rejects_unsafe_names(monkeypatch, tmp_path, name):
    app_mod = load_app(monkeypatch, tmp_path)
    _, cid = seed_project(app_mod)
    response = app_mod.app.test_client().patch(f"/api/classes/{cid}", json={"name": name})
    assert response.status_code == 400


def test_class_rename_supports_mapping_form_yaml(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    _, cid = seed_project(app_mod, class_idx=2)
    root = Path(app_mod.DATASET) / "auto_improve"
    root.mkdir(parents=True)
    (root / "class_mapping.json").write_text(
        json.dumps({"model_to_class_id": {"Zero": 0, "One": 1, "Part A": 2}}),
        encoding="utf-8",
    )
    (root / "data.yaml").write_text(
        yaml.safe_dump({"nc": 3, "names": {0: "Zero", 1: "One", 2: "Part A"}}),
        encoding="utf-8",
    )
    response = app_mod.app.test_client().patch(f"/api/classes/{cid}", json={"name": "Part Z"})
    assert response.status_code == 200
    data = yaml.safe_load((root / "data.yaml").read_text(encoding="utf-8"))
    assert data["names"][2] == "Part Z"
    assert data["nc"] == 3


def test_class_rename_flat_dataset_updates_metadata_without_moving_dirs(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    _, cid = seed_project(app_mod)
    root = Path(app_mod.DATASET) / "auto_improve"
    root.mkdir(parents=True)
    (root / "class_mapping.json").write_text(
        json.dumps({"model_to_class_id": {"Part A": 0}}), encoding="utf-8"
    )
    (root / "data.yaml").write_text("nc: 1\nnames: ['Part A']\n", encoding="utf-8")
    response = app_mod.app.test_client().patch(f"/api/classes/{cid}", json={"name": "Part B"})
    assert response.status_code == 200
    assert response.get_json()["moved_directories"] == 0
```

- [ ] **Step 5: Add collision, ID mismatch, case-only, no-op, and rollback tests**

Append:

```python
def test_class_rename_rejects_duplicate_without_changes(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    pid, cid = seed_project(app_mod)
    app_mod._db.class_upsert(pid, "Part B", class_idx=1)
    response = app_mod.app.test_client().patch(f"/api/classes/{cid}", json={"name": "part b"})
    assert response.status_code == 409
    assert app_mod._db.class_get(cid)["name"] == "Part A"


def test_class_rename_rejects_destination_directory_collision(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    _, cid = seed_project(app_mod)
    root = seed_dataset(app_mod)
    (root / "images" / "train" / "Part B").mkdir()
    response = app_mod.app.test_client().patch(f"/api/classes/{cid}", json={"name": "Part B"})
    assert response.status_code == 409
    assert (root / "images" / "train" / "Part A").is_dir()


def test_class_rename_rejects_mapping_id_mismatch(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    _, cid = seed_project(app_mod)
    root = seed_dataset(app_mod)
    (root / "class_mapping.json").write_text(
        json.dumps({"model_to_class_id": {"Part A": 4}}), encoding="utf-8"
    )
    response = app_mod.app.test_client().patch(f"/api/classes/{cid}", json={"name": "Part B"})
    assert response.status_code == 409
    assert app_mod._db.class_get(cid)["name"] == "Part A"


def test_class_rename_exact_name_is_noop(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    _, cid = seed_project(app_mod)
    response = app_mod.app.test_client().patch(f"/api/classes/{cid}", json={"name": "Part A"})
    assert response.status_code == 200
    assert response.get_json()["skipped"] == ["no-op"]


def test_class_rename_supports_case_only_directory_move(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    _, cid = seed_project(app_mod, name="part a")
    root = seed_dataset(app_mod, old_name="part a")
    response = app_mod.app.test_client().patch(f"/api/classes/{cid}", json={"name": "Part A"})
    assert response.status_code == 200
    assert (root / "images" / "train" / "Part A").is_dir()


def test_class_rename_rolls_back_files_and_directories_when_db_write_fails(monkeypatch, tmp_path):
    app_mod = load_app(monkeypatch, tmp_path)
    _, cid = seed_project(app_mod)
    root = seed_dataset(app_mod)
    mapping_before = (root / "class_mapping.json").read_bytes()
    yaml_before = (root / "data.yaml").read_bytes()
    monkeypatch.setattr(app_mod._db, "class_rename", lambda *_: (_ for _ in ()).throw(RuntimeError("db down")))

    response = app_mod.app.test_client().patch(f"/api/classes/{cid}", json={"name": "Part B"})

    assert response.status_code == 500
    assert response.get_json()["details"]["rollback_ok"] is True
    assert (root / "class_mapping.json").read_bytes() == mapping_before
    assert (root / "data.yaml").read_bytes() == yaml_before
    assert (root / "images" / "train" / "Part A").is_dir()
    assert not (root / "images" / "train" / "Part B").exists()
```

- [ ] **Step 6: Commit the synchronization core and RED tests together only after the API task turns them GREEN**

Do not commit a knowingly broken intermediate branch. Keep these files staged locally until Task 2 completes the route, then use the Task 2 commit.

### Task 2: Add Database Access and the Locked Flask Endpoint

**Files:**
- Modify: `webapp/db.py:186-222`
- Modify: `webapp/app.py:50-80`
- Modify: `webapp/app.py:708-728`
- Test: `webapp/tests/test_class_label_rename_api.py`

- [ ] **Step 1: Add class lookup and a returning rename operation**

Add to the Classes section in `webapp/db.py`:

```python
def class_get(cls_id):
    with get_db() as con:
        row = con.execute(
            """
            SELECT c.*, p.dataset_dir, p.name AS project_name
            FROM classes c
            JOIN projects p ON p.id = c.project_id
            WHERE c.id=?
            """,
            (cls_id,),
        ).fetchone()
        return dict(row) if row else None


def class_rename(cls_id, new_name):
    with get_db() as con:
        con.execute("UPDATE classes SET name=? WHERE id=?", (new_name, cls_id))
        row = con.execute("SELECT * FROM classes WHERE id=?", (cls_id,)).fetchone()
        if not row:
            raise LookupError(f"class {cls_id} not found")
        return dict(row)
```

Replace the existing non-returning `class_rename` definition instead of keeping two functions with the same name.

- [ ] **Step 2: Add import, lock, and project dataset resolver**

In `webapp/app.py`, import the new core:

```python
from class_label_sync import ClassLabelSyncError, synchronize_class_label
```

Create the lock next to `_dataset_split_lock`:

```python
_class_label_rename_lock = threading.Lock()
```

Add the resolver near `_safe_path`:

```python
def _project_dataset_root(class_row):
    configured = str(class_row.get("dataset_dir") or "").strip()
    if not configured:
        return (DATASET / "auto_improve").resolve()
    candidate = Path(configured)
    if not candidate.is_absolute():
        candidate = _safe_path(DATASET, configured)
    return candidate.resolve()
```

- [ ] **Step 3: Add the PATCH route without altering DELETE behavior**

Insert before the existing DELETE route:

```python
@app.route("/api/classes/<int:cid>", methods=["PATCH"])
def api_classes_rename(cid):
    data = request.get_json(silent=True) or {}
    class_row = _db.class_get(cid)
    if not class_row:
        return jsonify({"ok": False, "error": "ไม่พบ Class label"}), 404
    project = _db.project_get(class_row["project_id"])
    if not project:
        return jsonify({"ok": False, "error": "ไม่พบ Project ของ Class label"}), 404
    class_row = {**class_row, "dataset_dir": project.get("dataset_dir", "")}
    try:
        with _class_label_rename_lock:
            result = synchronize_class_label(
                dataset_root=_project_dataset_root(class_row),
                class_row=class_row,
                project_classes=_db.class_list(class_row["project_id"]),
                new_name=data.get("name"),
                safe_path=_safe_path,
                rename_class=_db.class_rename,
            )
    except ClassLabelSyncError as exc:
        return jsonify({
            "ok": False,
            "error": str(exc),
            "details": exc.details,
        }), exc.status
    return jsonify({"ok": True, **result})
```

- [ ] **Step 4: Run all class rename tests and verify GREEN**

Run from `webapp/`:

```powershell
pytest tests/test_class_label_rename_api.py -v --basetemp=.pytest_tmp_class_rename
```

Expected: every class-rename test PASS. If the platform rejects a case-only rename because the test filesystem is case-sensitive, assert the two-hop move result and preserve the implementation; do not remove the case-only path.

- [ ] **Step 5: Run adjacent label and data-export tests**

```powershell
pytest tests/test_label_api.py tests/test_data_export_api.py -v --basetemp=.pytest_tmp_class_adjacent
```

Expected: all tests PASS and existing YOLO label path behavior remains unchanged.

- [ ] **Step 6: Commit backend synchronization**

```powershell
git add webapp/class_label_sync.py webapp/db.py webapp/app.py webapp/tests/test_class_label_rename_api.py
git commit -m "feat: synchronize class label renames"
```

### Task 3: Add Frontend State Contracts and API Wiring

**Files:**
- Create: `webapp/frontend/src/pages/classLabelState.js`
- Create: `webapp/frontend/src/pages/classLabelState.test.js`
- Modify: `webapp/frontend/package.json`
- Modify: `webapp/frontend/src/api/client.js:203-212`

- [ ] **Step 1: Write failing state-helper tests**

Create `webapp/frontend/src/pages/classLabelState.test.js`:

```javascript
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  orderedProjectClassNames,
  replaceClassNameAtId,
  classRenameSuccessMessage,
} from './classLabelState.js'

test('project class names are ordered by stable class_idx', () => {
  assert.deepEqual(orderedProjectClassNames([
    { id: 8, class_idx: 2, name: 'Two' },
    { id: 4, class_idx: 0, name: 'Zero' },
    { id: 6, class_idx: 1, name: 'One' },
  ]), ['Zero', 'One', 'Two'])
})

test('rename replaces one name without reordering class IDs', () => {
  assert.deepEqual(
    replaceClassNameAtId(['Zero', 'Old', 'Two'], 1, 'New'),
    ['Zero', 'New', 'Two'],
  )
})

test('rename result creates a useful Thai confirmation', () => {
  assert.equal(classRenameSuccessMessage({
    old_name: 'Old',
    class: { name: 'New', class_idx: 1 },
    moved_directories: 4,
  }), 'เปลี่ยน Old → New สำเร็จ (Class ID 1, ย้าย 4 โฟลเดอร์)')
})
```

- [ ] **Step 2: Add the test command and verify RED**

Add to `scripts` in `webapp/frontend/package.json`:

```json
"test:class-label-ui": "node --test src/pages/classLabelState.test.js"
```

Run:

```powershell
npm run test:class-label-ui
```

Expected: FAIL because `classLabelState.js` does not exist.

- [ ] **Step 3: Implement the pure state helper**

Create `webapp/frontend/src/pages/classLabelState.js`:

```javascript
export function orderedProjectClassNames(rows) {
  return [...rows]
    .sort((a, b) => Number(a.class_idx) - Number(b.class_idx))
    .map(row => row.name)
}

export function replaceClassNameAtId(classes, classIdx, newName) {
  return classes.map((name, idx) => idx === Number(classIdx) ? newName : name)
}

export function classRenameSuccessMessage(result) {
  return `เปลี่ยน ${result.old_name} → ${result.class.name} สำเร็จ `
    + `(Class ID ${result.class.class_idx}, ย้าย ${result.moved_directories} โฟลเดอร์)`
}
```

- [ ] **Step 4: Wire the API client**

Add beside `classDelete` in `webapp/frontend/src/api/client.js`:

```javascript
classRename: (cid, name) =>
  fetchJSON(`/classes/${cid}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }),
```

- [ ] **Step 5: Run the focused frontend test and lint**

```powershell
npm run test:class-label-ui
npm run lint
```

Expected: 3 tests PASS and oxlint reports no errors.

- [ ] **Step 6: Commit state contracts and API client**

```powershell
git add webapp/frontend/package.json webapp/frontend/src/api/client.js webapp/frontend/src/pages/classLabelState.js webapp/frontend/src/pages/classLabelState.test.js
git commit -m "feat: add class rename frontend contract"
```

### Task 4: Add Inline Rename to Projects

**Files:**
- Modify: `webapp/frontend/src/pages/Projects.jsx:1-125`
- Modify: `webapp/frontend/src/pages/Projects.jsx:220-255`
- Modify: `webapp/frontend/src/pages/Projects.css:135-180`

- [ ] **Step 1: Add edit imports and component state**

Update imports in `Projects.jsx`:

```javascript
import { Plus, Trash2, RefreshCw, FolderOpen, Tag, Image, Brain, ChevronRight, Pencil, Check, X } from 'lucide-react'
import { classRenameSuccessMessage } from './classLabelState'
```

Add state next to the class-add state:

```javascript
const [editingClassId, setEditingClassId] = useState(null)
const [editingClassName, setEditingClassName] = useState('')
const [renamingClass, setRenamingClass] = useState(false)
```

- [ ] **Step 2: Add start, cancel, and save handlers**

Add after `addClass()`:

```javascript
function startRenameClass(cls) {
  setEditingClassId(cls.id)
  setEditingClassName(cls.name)
}

function cancelRenameClass() {
  setEditingClassId(null)
  setEditingClassName('')
}

async function renameClass(cls) {
  const name = editingClassName.trim()
  if (!name || name === cls.name || renamingClass) {
    if (name === cls.name) cancelRenameClass()
    return
  }
  setRenamingClass(true)
  try {
    const result = await api.classRename(cls.id, name)
    showToast(classRenameSuccessMessage(result))
    cancelRenameClass()
    await loadDetail(selected)
  } catch (error) {
    showToast(error.message || 'เปลี่ยนชื่อ Class label ไม่สำเร็จ', 'error')
  } finally {
    setRenamingClass(false)
  }
}
```

- [ ] **Step 3: Replace each class row with inline edit controls**

Replace the body of the `(detail.classes || []).map(...)` row with:

```jsx
<div key={c.id} className="proj-class-item">
  <span className="proj-class-swatch" style={{ background: c.color || SWATCH[i % SWATCH.length] }} />
  {editingClassId === c.id ? (
    <input
      className="proj-class-edit-input"
      value={editingClassName}
      onChange={event => setEditingClassName(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter') renameClass(c)
        if (event.key === 'Escape') cancelRenameClass()
      }}
      disabled={renamingClass}
      autoFocus
    />
  ) : (
    <span className="proj-class-name">{c.name}</span>
  )}
  {editingClassId === c.id ? (
    <>
      <button className="proj-class-action save" onClick={() => renameClass(c)} disabled={renamingClass || !editingClassName.trim()} title="บันทึกชื่อ">
        <Check size={12} />
      </button>
      <button className="proj-class-action" onClick={cancelRenameClass} disabled={renamingClass} title="ยกเลิก">
        <X size={12} />
      </button>
    </>
  ) : (
    <>
      <button className="proj-class-action" onClick={() => startRenameClass(c)} title="แก้ชื่อ Class label">
        <Pencil size={11} />
      </button>
      <button className="proj-class-del" onClick={() => deleteClass(c.id)} title="ลบ">
        <Trash2 size={11} />
      </button>
    </>
  )}
</div>
```

- [ ] **Step 4: Style accessible inline editing**

Add to `Projects.css` near existing class styles:

```css
.proj-class-edit-input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid var(--accent);
  border-radius: 5px;
  outline: none;
}
.proj-class-action {
  display: flex;
  padding: 3px;
  color: var(--text-muted);
  background: none;
  border: 0;
  border-radius: 3px;
  cursor: pointer;
}
.proj-class-action:hover { color: var(--accent); background: var(--bg-hover); }
.proj-class-action.save { color: var(--green); }
.proj-class-action:disabled { opacity: 0.45; cursor: not-allowed; }
```

- [ ] **Step 5: Run frontend tests, lint, and build**

```powershell
npm run test:class-label-ui
npm run lint
npm run build
```

Expected: tests PASS, oxlint has no errors, Vite builds into `webapp/static/`.

- [ ] **Step 6: Commit Projects rename UI and built assets**

```powershell
git add webapp/frontend/src/pages/Projects.jsx webapp/frontend/src/pages/Projects.css webapp/static
git commit -m "feat: edit class labels from projects"
```

### Task 5: Synchronize and Rename Classes in Annotator

**Files:**
- Modify: `webapp/frontend/src/pages/Annotator.jsx:1-190`
- Modify: `webapp/frontend/src/pages/Annotator.jsx:874-888`
- Modify: `webapp/frontend/src/pages/Annotator.jsx:1060-1100`
- Modify: `webapp/frontend/src/pages/Annotator.css`

- [ ] **Step 1: Add imports and rename state**

Extend icon imports with `Pencil`, `Check`, and `X`, and import helpers:

```javascript
import {
  orderedProjectClassNames,
  replaceClassNameAtId,
  classRenameSuccessMessage,
} from './classLabelState'
```

Add state:

```javascript
const [projectClassRows, setProjectClassRows] = useState([])
const [editingClassId, setEditingClassId] = useState(null)
const [editingClassName, setEditingClassName] = useState('')
const [renamingClass, setRenamingClass] = useState(false)
```

- [ ] **Step 2: Make selected-project classes authoritative**

Replace the project-class loading effect with:

```javascript
useEffect(() => {
  if (!projectId) {
    setProjectClassRows([])
    return
  }
  api.projectClasses(Number(projectId)).then(data => {
    if (!Array.isArray(data)) return
    const ordered = [...data].sort((a, b) => Number(a.class_idx) - Number(b.class_idx))
    setProjectClassRows(ordered)
    setClasses(orderedProjectClassNames(ordered))
    setActiveClass(current => Math.min(current, Math.max(ordered.length - 1, 0)))
  }).catch(error => showToast(error.message || 'โหลด Class labels ไม่สำเร็จ', 'error'))
}, [projectId])
```

Retain folder `localStorage` restoration only for project-less mode. Change its class restoration condition to:

```javascript
if (!savedProject && savedClasses) {
  try { setClasses(JSON.parse(savedClasses)) } catch {}
}
```

This prevents stale cached names from being merged back after a synchronized rename.

Also change the `data.classes` merge inside the current-image label-loading effect so file metadata cannot reintroduce stale project names:

```javascript
if (!projectId && data.classes?.length) {
  setClasses(previous => {
    const merged = [...previous]
    data.classes.forEach(name => { if (!merged.includes(name)) merged.push(name) })
    return merged
  })
}
```

- [ ] **Step 3: Add the synchronized Annotator rename handler**

Add after `addClass()`:

```javascript
function startRenameClass(row) {
  if (!projectId) {
    showToast('กรุณาเลือก Project ก่อนแก้ชื่อ Class label', 'error')
    return
  }
  setEditingClassId(row.id)
  setEditingClassName(row.name)
}

function cancelRenameClass() {
  setEditingClassId(null)
  setEditingClassName('')
}

async function renameProjectClass(row) {
  const name = editingClassName.trim()
  if (!name || name === row.name || renamingClass) {
    if (name === row.name) cancelRenameClass()
    return
  }
  setRenamingClass(true)
  try {
    const result = await api.classRename(row.id, name)
    setProjectClassRows(previous => previous.map(item => item.id === row.id ? result.class : item))
    setClasses(previous => replaceClassNameAtId(previous, result.class.class_idx, result.class.name))
    showToast(classRenameSuccessMessage(result))
    cancelRenameClass()
  } catch (error) {
    showToast(error.message || 'เปลี่ยนชื่อ Class label ไม่สำเร็จ', 'error')
  } finally {
    setRenamingClass(false)
  }
}
```

- [ ] **Step 4: Render edit controls only for project-backed rows**

In each `classes.map`, find its backing row using `projectClassRows.find(row => Number(row.class_idx) === i)`. Keep clicking the row responsible for selecting/changing an annotation, but stop propagation from buttons:

```jsx
{classes.map((cls, i) => {
  const row = projectClassRows.find(item => Number(item.class_idx) === i)
  return (
    <div key={row?.id ?? i}
      className={`ann-class-item${activeClass === i ? ' active' : ''}`}
      onClick={() => { setActiveClass(i); if (selected) changeSelectedClass(i) }}>
      <div className="ann-class-swatch" style={{ background: color(i) }} />
      {editingClassId === row?.id ? (
        <input
          className="ann-class-edit-input"
          value={editingClassName}
          onChange={event => setEditingClassName(event.target.value)}
          onClick={event => event.stopPropagation()}
          onKeyDown={event => {
            event.stopPropagation()
            if (event.key === 'Enter') renameProjectClass(row)
            if (event.key === 'Escape') cancelRenameClass()
          }}
          disabled={renamingClass}
          autoFocus
        />
      ) : <span className="ann-class-name">{cls}</span>}
      <span className="ann-class-count">
        {boxes.filter(box => box[0] === i).length + polygons.filter(poly => poly.class_id === i).length}
      </span>
      {row && (editingClassId === row.id ? (
        <span className="ann-class-edit-actions">
          <button onClick={event => { event.stopPropagation(); renameProjectClass(row) }} disabled={renamingClass || !editingClassName.trim()} title="บันทึก"><Check size={11} /></button>
          <button onClick={event => { event.stopPropagation(); cancelRenameClass() }} disabled={renamingClass} title="ยกเลิก"><X size={11} /></button>
        </span>
      ) : (
        <button className="ann-class-edit-btn" onClick={event => { event.stopPropagation(); startRenameClass(row) }} title="แก้ชื่อ Class label"><Pencil size={11} /></button>
      ))}
    </div>
  )
})}
```

Below the class list, show this hint when no project is selected:

```jsx
{!projectId && (
  <div className="ann-class-sync-hint">เลือก Project เพื่อแก้ชื่อและซิงก์ Class label ทั้งระบบ</div>
)}
```

- [ ] **Step 5: Add compact Annotator edit styles**

Add to `Annotator.css` beside `.ann-class-*` rules:

```css
.ann-class-edit-input {
  flex: 1;
  min-width: 0;
  padding: 3px 5px;
  color: var(--text-primary);
  background: var(--bg-dark);
  border: 1px solid var(--accent);
  border-radius: 4px;
  outline: none;
}
.ann-class-edit-btn,
.ann-class-edit-actions button {
  display: flex;
  padding: 3px;
  color: var(--text-muted);
  background: transparent;
  border: 0;
  border-radius: 3px;
  cursor: pointer;
}
.ann-class-edit-btn:hover,
.ann-class-edit-actions button:hover { color: var(--accent); background: var(--bg-hover); }
.ann-class-edit-actions { display: flex; gap: 2px; }
.ann-class-sync-hint { padding: 6px 10px; color: var(--text-muted); font-size: 10px; line-height: 1.4; }
```

- [ ] **Step 6: Run state tests, existing Annotator tests, lint, and build**

```powershell
npm run test:class-label-ui
npm run test:annotator-ui
npm run lint
npm run build
```

Expected: all Node tests PASS, oxlint reports no errors, and Vite emits fresh hashed assets.

- [ ] **Step 7: Commit Annotator synchronization and rebuilt assets**

```powershell
git add webapp/frontend/src/pages/Annotator.jsx webapp/frontend/src/pages/Annotator.css webapp/static
git commit -m "feat: synchronize annotator class renames"
```

### Task 6: Verify the Real Browser Workflow

**Files:**
- Create: `docs/manual/images/class-rename-01-projects.png`
- Create: `docs/manual/images/class-rename-02-annotator.png`
- Create: `docs/manual/images/class-rename-03-success.png`

- [ ] **Step 1: Run focused and adjacent automated tests**

From `webapp/`:

```powershell
pytest tests/test_class_label_rename_api.py tests/test_label_api.py tests/test_data_export_api.py -v --basetemp=.pytest_tmp_class_final
```

Expected: all selected tests PASS.

From `webapp/frontend/`:

```powershell
npm run test:class-label-ui
npm run test:annotator-ui
npm run lint
npm run build
```

Expected: all tests PASS, no lint errors, build succeeds.

- [ ] **Step 2: Start the backend against a controlled disposable verification dataset**

Create the disposable Project and dataset through a short checked test fixture or API calls under `dataset/class-rename-verification/`; do not rename a production class for the first browser proof. Start the backend from the repository root:

```powershell
python webapp/app.py
```

Expected: Flask listens on `http://127.0.0.1:8501` and serves the newly built SPA.

- [ ] **Step 3: Verify Projects in the in-app browser**

Open `http://127.0.0.1:8501/projects`, select the verification project, edit `Part A` to `ชิ้นงาน A`, and confirm:

- inline edit accepts Enter and Cancel accepts Escape;
- success toast shows old/new names, Class ID, and moved-directory count;
- the class row immediately shows the new name;
- final URL remains `/projects`;
- browser console contains no errors or warnings attributable to the workflow.

Capture `docs/manual/images/class-rename-01-projects.png` and `class-rename-03-success.png`.

- [ ] **Step 4: Verify Annotator and persistence**

Open `http://127.0.0.1:8501/annotator`, select the same project and a dataset folder, and confirm:

- the renamed class is loaded at its original numeric position;
- no stale `Part A` value is merged from `localStorage`;
- editing again uses the same synchronized route;
- active annotation selection and box/polygon IDs do not change;
- reloading the page preserves the new name;
- final URL is `/annotator` and console has no errors.

Capture `docs/manual/images/class-rename-02-annotator.png`.

- [ ] **Step 5: Verify persistence outside the browser**

Inspect the controlled dataset and database:

```powershell
Get-Content dataset/auto_improve/class_mapping.json
Get-Content dataset/auto_improve/data.yaml
```

Use a read-only SQLite query to confirm `classes.name` changed while `class_idx` did not. Inspect one moved YOLO `.txt` label and confirm its leading numeric ID is unchanged.

Expected: every surface agrees on the new name and the original numeric class ID.

### Task 7: Produce the Thai Operator Manual

**Files:**
- Create: `docs/manual/Ai-JIN-Platform-Class-Label-Rename-Guide-TH.md`
- Create: `docs/manual/Ai-JIN-Platform-Class-Label-Rename-Guide-TH.html`
- Use: `docs/manual/manual.css`
- Use: `docs/manual/images/class-rename-01-projects.png`
- Use: `docs/manual/images/class-rename-02-annotator.png`
- Use: `docs/manual/images/class-rename-03-success.png`

- [ ] **Step 1: Write the Markdown guide from verified behavior**

Create the Markdown guide with these exact sections and verified screenshots:

```markdown
# คู่มือการแก้ไขและซิงก์ Class Label

**ระบบ:** Ai-JIN Platform  
**หน้าจอ:** `/projects` และ `/annotator`  
**ฉบับ:** 1.0 - 22 กรกฎาคม 2026

## 1. สิ่งที่ระบบจะเปลี่ยน

อธิบาย SQLite, class_mapping.json, data.yaml และโฟลเดอร์ images/labels ทุก split พร้อมย้ำว่า Class ID ในไฟล์ YOLO ไม่เปลี่ยน

## 2. ข้อควรตรวจสอบก่อนแก้ชื่อ

อธิบายการเลือก Project, สิทธิ์เขียน dataset, ชื่อซ้ำ, อักขระต้องห้าม และการสำรองข้อมูลก่อนทำกับ production dataset

## 3. แก้ชื่อจากหน้า Projects

ใส่ขั้นตอนเลือก Project กดดินสอ พิมพ์ชื่อ กดบันทึก และตรวจ toast พร้อมภาพ class-rename-01-projects.png และ class-rename-03-success.png

## 4. แก้ชื่อจากหน้า Annotator

ใส่ขั้นตอนเลือก Project ก่อน กดดินสอ และยืนยันว่ากรอบ/Polygon ยังใช้ Class ID เดิม พร้อมภาพ class-rename-02-annotator.png

## 5. ตรวจสอบหลังแก้ชื่อ

ให้ตรวจ UI ทั้งสองหน้า, mapping, YAML, โฟลเดอร์ train/val/test และเลขนำหน้าในไฟล์ label

## 6. ข้อผิดพลาดและการแก้ไข

อธิบายชื่อไม่ถูกต้อง, ชื่อซ้ำ, โฟลเดอร์ปลายทางชนกัน, mapping ID ไม่ตรง และข้อความ rollback

## 7. Checklist ก่อน Train

ให้ยืนยัน names/nc, label coverage, โครงสร้าง images/labels และ Class ID ก่อนเริ่ม training
```

Replace every explanatory sentence in the outline with the actual verified Thai instructions and observed screenshots; do not retain outline wording as meta-instructions.

- [ ] **Step 2: Build the HTML guide using the existing manual style**

Create a standalone UTF-8 HTML document that links `manual.css`, uses semantic headings/tables/callouts, embeds the three relative images, and contains the same operational content as the Markdown guide. Include a synchronization table with columns `รายการ`, `ก่อน`, `หลัง`, and `Class ID`.

- [ ] **Step 3: Open and visually verify the HTML manual**

Open the local HTML guide in the in-app browser and verify:

- Thai text renders correctly;
- images resolve without broken links;
- no horizontal overflow at desktop and mobile widths;
- printed pages do not cut headings from the following instructions;
- paths and UI labels match the real verified application.

- [ ] **Step 4: Commit screenshots and both manual formats**

```powershell
git add docs/manual/Ai-JIN-Platform-Class-Label-Rename-Guide-TH.md docs/manual/Ai-JIN-Platform-Class-Label-Rename-Guide-TH.html docs/manual/images/class-rename-01-projects.png docs/manual/images/class-rename-02-annotator.png docs/manual/images/class-rename-03-success.png
git commit -m "docs: add Thai class label rename guide"
```

### Task 8: Final Regression and Delivery Check

**Files:**
- Verify all files listed above
- Verify `webapp/static/`

- [ ] **Step 1: Run the complete backend unit suite**

From `webapp/`:

```powershell
pytest tests/ -v --basetemp=.pytest_tmp_class_delivery
```

Expected: all unit tests PASS. Integration tests that require an externally running server must be reported separately if the suite includes them.

- [ ] **Step 2: Run every frontend check relevant to the changed surfaces**

From `webapp/frontend/`:

```powershell
npm run test:class-label-ui
npm run test:annotator-ui
npm run test:split-ui
npm run test:training-ui
npm run lint
npm run build
```

Expected: all Node tests PASS, oxlint reports no errors, and the production build succeeds.

- [ ] **Step 3: Re-run the browser success path after the final build**

Reload `/projects` and `/annotator` from Flask, not Vite. Confirm final URLs, no stale hashed assets, no console errors, synchronized name, and unchanged class ID.

- [ ] **Step 4: Check the final diff and repository state**

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors. Any unrelated pre-existing untracked files remain untouched and are listed separately in the handoff.

- [ ] **Step 5: Deliver the result**

Report the API contract, UI entry points, tests and browser evidence, manual paths, commit hashes, and any environment-specific limitation. Do not claim rollback, browser behavior, or full-suite success without the corresponding command output.
