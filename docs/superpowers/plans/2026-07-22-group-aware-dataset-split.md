# Group-Aware Dataset Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and apply deterministic, leakage-resistant 80/10/10 train/validation/test splits with preview, duplicate quarantine, rollback, undo, and a production UI.

**Architecture:** Put inventory, grouping, optimization, persisted plans, and filesystem transactions in a focused Python module independent of Flask. Expose thin Flask routes that bind the module to the runtime `DATASET`, then add a compact Data Import control surface. Use pytest-first development for pure behavior and API contracts; browser acceptance verifies the physical dataset and production frontend.

**Tech Stack:** Python 3, Flask, pathlib/shutil/hashlib, SQLite, pytest, React 19, Vite 8, lucide-react.

---

## File Structure

- Create `webapp/dataset_split.py`: inventory records, duplicate selection, temporal groups, deterministic assignment, plan persistence, apply/rollback, and undo.
- Create `webapp/tests/test_dataset_split.py`: pure and filesystem transaction tests.
- Create `webapp/tests/test_dataset_split_api.py`: Flask preview/apply/undo/stats/YAML API tests.
- Modify `webapp/app.py`: import the splitter, add three routes, extend split statistics, and include test in YAML.
- Modify `webapp/db.py`: best-effort path/split update helper for registered images.
- Modify `webapp/frontend/src/api/client.js`: split preview/apply/undo requests.
- Modify `webapp/frontend/src/pages/DataImport.jsx`: ratios, analysis, preview, warnings, apply, and undo flow.
- Modify `webapp/frontend/src/pages/DataImport.css`: responsive operational table and status styles.
- Rebuild `webapp/static/`: production bundle served by Flask.

### Task 0: Establish a Clean Baseline for Existing Label Save Work

**Files:**
- Existing modified: `webapp/app.py`
- Existing untracked: `webapp/tests/test_label_api.py`

- [ ] **Step 1: Inspect the existing label-path diff**

Run:

```powershell
git diff -- webapp/app.py
Get-Content webapp/tests/test_label_api.py
```

Confirm the only existing `app.py` changes are the mirrored `images/... -> labels/...` helper and label endpoint calls described by the completed save fix.

- [ ] **Step 2: Re-run the focused regression tests**

Run from `webapp`:

```powershell
python -m pytest tests/test_label_api.py -q --basetemp=.pytest_tmp_label_baseline
```

Expected: PASS.

- [ ] **Step 3: Commit only the completed baseline fix**

```powershell
git add webapp/app.py webapp/tests/test_label_api.py
git commit -m "fix: mirror annotation labels beside dataset splits"
```

Do not stage model binaries, `sam_b/`, or plan files from other features.

### Task 1: Inventory, Deduplication, Capture Groups, and Assignment

**Files:**
- Create: `webapp/tests/test_dataset_split.py`
- Create: `webapp/dataset_split.py`

- [ ] **Step 1: Write failing filename and inventory tests**

Add tests for the public API:

```python
from pathlib import Path
from dataset_split import (
    parse_capture_identity,
    scan_dataset,
    choose_canonical_records,
)


def test_parse_flat_capture_filename():
    identity = parse_capture_identity(
        Path("F-373130-K010_20260717_093756_826469.jpg"),
        Path("F-373130-K010_20260717_093756_826469.jpg"),
    )
    assert identity.workpiece == "F-373130-K010"
    assert identity.captured_at.isoformat() == "2026-07-17T09:37:56.826469"


def test_nested_folder_has_priority_for_workpiece():
    identity = parse_capture_identity(
        Path("part_a/frame_001.jpg"),
        Path("part_a/frame_001.jpg"),
    )
    assert identity.workpiece == "part_a"
    assert identity.captured_at is None


def test_canonical_duplicate_prefers_non_empty_label(tmp_path):
    root = tmp_path / "auto_improve"
    train_image = root / "images/train/part_20260717_090000_000001.jpg"
    val_image = root / "images/val/part_20260717_090000_000001.jpg"
    val_label = root / "labels/val/part_20260717_090000_000001.txt"
    train_image.parent.mkdir(parents=True)
    val_image.parent.mkdir(parents=True)
    val_label.parent.mkdir(parents=True)
    train_image.write_bytes(b"same-image")
    val_image.write_bytes(b"same-image")
    val_label.write_text("0 0.5 0.5 0.2 0.2\n", encoding="utf-8")

    records = scan_dataset(tmp_path, {".jpg"})
    canonical, duplicates = choose_canonical_records(records)

    assert [record.source for record in canonical] == [val_image]
    assert [record.source for record in duplicates] == [train_image]
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run from `webapp`:

```powershell
python -m pytest tests/test_dataset_split.py -q --basetemp=.pytest_tmp_split
```

Expected: collection FAIL because `dataset_split` does not exist.

- [ ] **Step 3: Implement inventory records and duplicate selection**

Create immutable dataclasses:

```python
@dataclass(frozen=True)
class CaptureIdentity:
    workpiece: str
    captured_at: datetime | None


@dataclass(frozen=True)
class ImageRecord:
    source: Path
    relative_below_split: Path
    split: str
    label_source: Path
    sha256: str
    size: int
    mtime_ns: int
    workpiece: str
    captured_at: datetime | None
    label_state: str  # "non_empty", "empty", or "missing"
```

Implement `scan_dataset(dataset_root, image_extensions)` for all three split roots. Derive labels by replacing the `images` path component with `labels`. Hash files in chunks. Implement `choose_canonical_records(records)` by grouping SHA-256 and applying the approved label/path priority.

- [ ] **Step 4: Run inventory tests and verify GREEN**

Run the focused pytest command.

Expected: filename, flat/nested inventory, mirrored labels, and canonical duplicate tests PASS.

- [ ] **Step 5: Write failing capture-group and assignment tests**

Add concrete tests named:

- Keep timestamps exactly 30 seconds apart in one group.
- Start a new group at 31 seconds.
- Isolate files without timestamps.
- Produce identical plans for the same seed.
- Keep every group wholly within one split.
- Give each split one group when a workpiece has at least three groups.
- Prefer honest group boundaries when exact 80/10/10 is impossible.

Use an `ImageRecord` factory in the test module and assert the boundary directly:

```python
def test_capture_group_boundary_is_thirty_seconds(record_factory):
    records = [
        record_factory("part", "2026-07-17T09:00:00"),
        record_factory("part", "2026-07-17T09:00:30"),
        record_factory("part", "2026-07-17T09:01:01"),
    ]
    groups = build_capture_groups(records, gap_seconds=30)
    assert [len(group.records) for group in groups] == [2, 1]
```

Example assertion:

```python
assignments = assign_groups(groups, {"train": 0.8, "val": 0.1, "test": 0.1}, seed=42)
for group in groups:
    assert len({assignments[item.source] for item in group.records}) == 1
assert {assignments[group.records[0].source] for group in groups} == {"train", "val", "test"}
```

- [ ] **Step 6: Run grouping tests and verify RED**

Expected: FAIL because grouping and assignment functions are absent.

- [ ] **Step 7: Implement group-aware deterministic assignment**

Implement these exact public functions:

```python
build_capture_groups(records, gap_seconds=30) -> list[CaptureGroup]
assign_groups(groups, ratios, seed=42) -> dict[Path, str]
summarize_assignment(records, groups, assignments, duplicates) -> dict
```

Use descending group size plus a SHA-256-derived seed tie-breaker. Seed train/val/test when at least three groups exist, assign remaining groups by weighted squared target error, then perform deterministic improving moves and pairwise swaps.

- [ ] **Step 8: Run all Task 1 tests and commit**

Run:

```powershell
python -m pytest tests/test_dataset_split.py -q --basetemp=.pytest_tmp_split
```

Expected: PASS.

Commit:

```powershell
git add webapp/dataset_split.py webapp/tests/test_dataset_split.py
git commit -m "feat: plan leakage-resistant dataset splits"
```

### Task 2: Persisted Plan, Transactional Apply, and Undo

**Files:**
- Modify: `webapp/tests/test_dataset_split.py`
- Modify: `webapp/dataset_split.py`
- Modify: `webapp/db.py`

- [ ] **Step 1: Write failing plan/apply/undo tests**

Create temporary datasets that prove:

- `create_split_plan` writes JSON without changing images.
- `apply_split_plan` moves canonical images and mirrored labels.
- Exact duplicates move into manifest-scoped quarantine.
- A source hash mismatch raises `StalePlanError` before any move.
- An injected mover failure reverses completed moves.
- `undo_split_manifest` restores every original path.
- A destination conflict blocks undo before the first reverse move.

- [ ] **Step 2: Run transaction tests and verify RED**

Run the focused test module.

Expected: FAIL on missing transaction functions.

- [ ] **Step 3: Implement plan persistence and collision-safe operations**

Implement these exact public functions:

```python
create_split_plan(dataset_root, ratios, gap_seconds, seed, image_extensions) -> dict
load_split_plan(dataset_root, plan_id) -> dict
apply_split_plan(dataset_root, plan_id, on_path_changed=None, mover=shutil.move) -> dict
undo_split_manifest(dataset_root, manifest_id, on_path_changed=None, mover=shutil.move) -> dict
latest_split_manifest(dataset_root) -> dict | None
```

Store plans in `auto_improve/split_plans`, manifests in `auto_improve/split_manifests`, and duplicates in `auto_improve/split_quarantine/<manifest-id>`. Validate every source before changes. Preflight every destination and undo path. Record each successful move and reverse it on exceptions.

- [ ] **Step 4: Add the database path update helper**

Add to `db.py`:

```python
def image_move_path(old_path, new_path, new_split):
    with get_db() as con:
        con.execute(
            "UPDATE images SET path=?, filename=?, split=?, updated_at=? WHERE path=?",
            (new_path, Path(new_path).name, new_split, now_iso(), old_path),
        )
```

The Flask adapter passes this as a best-effort callback. Filesystem rollback remains authoritative if callbacks fail.

- [ ] **Step 5: Run transaction tests and commit**

Expected: all `test_dataset_split.py` tests PASS.

Commit:

```powershell
git add webapp/dataset_split.py webapp/db.py webapp/tests/test_dataset_split.py
git commit -m "feat: apply and undo dataset split plans"
```

### Task 3: Flask Split APIs, Statistics, and YAML

**Files:**
- Create: `webapp/tests/test_dataset_split_api.py`
- Modify: `webapp/app.py`

- [ ] **Step 1: Write failing API contract tests**

Use the existing `importlib.reload(app)` pattern with `DATASET_PATH` set to `tmp_path / "dataset"`. Test:

```python
response = client.post("/api/import/split/preview", json={
    "train_ratio": 0.8,
    "val_ratio": 0.1,
    "test_ratio": 0.1,
    "session_gap_seconds": 30,
    "seed": 42,
})
assert response.status_code == 200
assert response.get_json()["plan_id"]
```

Add separate tests named `test_split_preview_rejects_invalid_ratios`, `test_split_apply_uses_persisted_plan`, `test_split_apply_rejects_stale_plan`, `test_split_undo_restores_sources`, `test_split_info_includes_test_and_coverage`, and `test_generated_yaml_includes_test_path`.

- [ ] **Step 2: Run API tests and verify RED**

Run:

```powershell
python -m pytest tests/test_dataset_split_api.py -q --basetemp=.pytest_tmp_split_api
```

Expected: route tests FAIL with 404 or missing response fields.

- [ ] **Step 3: Add thin Flask routes and a process lock**

Import the splitter module and create `_dataset_split_lock = threading.Lock()`. Add:

```text
POST /api/import/split/preview
POST /api/import/split/apply
POST /api/import/split/undo
```

Validate numeric input in the route, bind `DATASET`, map domain exceptions to 400/404/409/500 responses, and serialize apply/undo with the lock.

- [ ] **Step 4: Extend split statistics**

Return `train`, `val`, and `test` with:

```json
{
  "total": 100,
  "labels": 90,
  "non_empty_labels": 85,
  "label_coverage": 90.0
}
```

Scan both flat and nested files.

- [ ] **Step 5: Include test in generated YAML**

Add:

```yaml
test: images/test
```

Keep train-derived class discovery behavior unless explicit classes are supplied.

- [ ] **Step 6: Run backend regression tests and commit**

Run:

```powershell
python -m pytest tests/test_dataset_split.py tests/test_dataset_split_api.py tests/test_label_api.py tests/test_data_export_api.py -q --basetemp=.pytest_tmp_split_all
```

Expected: PASS.

Commit:

```powershell
git add webapp/app.py webapp/tests/test_dataset_split_api.py
git commit -m "feat: expose dataset split workflow APIs"
```

### Task 4: Data Import Split UI

**Files:**
- Modify: `webapp/frontend/src/api/client.js`
- Modify: `webapp/frontend/src/pages/DataImport.jsx`
- Modify: `webapp/frontend/src/pages/DataImport.css`

- [ ] **Step 1: Add API client methods**

Add:

```js
importSplitPreview: (data) =>
  fetchJSON('/import/split/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }),
importSplitApply: (planId) =>
  fetchJSON('/import/split/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: planId }),
  }),
importSplitUndo: (manifestId) =>
  fetchJSON('/import/split/undo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest_id: manifestId }),
  }),
```

- [ ] **Step 2: Add split form and operation state**

In `DataImport.jsx`, add state for ratios `80/10/10`, gap `30`, seed `42`, preview, loading, applying, undoing, and latest manifest.

Implement these event handlers:

```js
handleAnalyzeSplit()
handleApplySplit()
handleUndoSplit()
```

Validate that percentages total 100 before requesting preview. Require `window.confirm` before apply with move and quarantine counts. Clear stale preview whenever split inputs change.

- [ ] **Step 3: Render operational preview**

Add a full-width `Train / Val / Test Split` section after current split statistics:

- Numeric ratio inputs with stable widths.
- Session gap and seed inputs.
- Analyze action using `BarChart3`.
- Proposed train/val/test totals.
- Per-workpiece rows for image count, capture groups, and proposed counts.
- Warning list for duplicates, missing labels, ratio deviations, and insufficient groups.
- Apply and Undo commands using `Check` and `RefreshCw`.

Keep the existing page structure and avoid nested cards.

- [ ] **Step 4: Add responsive CSS**

Use a restrained grid/table layout consistent with existing controls. At narrow widths, allow the preview table to scroll horizontally and stack the controls. Keep cards at the existing radius.

- [ ] **Step 5: Build and commit**

Run:

```powershell
cd D:\Ai-JIN_Platform\webapp\frontend
npm run lint
npm run build
```

Expected: no new lint errors and successful Vite build.

Commit:

```powershell
git add webapp/frontend/src/api/client.js webapp/frontend/src/pages/DataImport.jsx webapp/frontend/src/pages/DataImport.css webapp/static
git commit -m "feat: manage dataset splits from Data Import"
```

### Task 5: Apply to the Current Dataset and Browser Acceptance

**Files:**
- Runtime data: `dataset/auto_improve/images/**`
- Runtime data: `dataset/auto_improve/labels/**`
- Runtime records: `dataset/auto_improve/split_plans/**`
- Runtime records: `dataset/auto_improve/split_manifests/**`
- Runtime quarantine: `dataset/auto_improve/split_quarantine/**`

- [ ] **Step 1: Generate a current preview**

Call the preview API with 80/10/10, 30 seconds, and seed 42. Record proposed split totals, per-workpiece group counts, 54 duplicate hashes, missing-label warnings, and movement totals.

- [ ] **Step 2: Validate the plan independently**

Confirm:

- Every canonical SHA-256 appears once.
- Every capture group has one proposed split.
- Each of the five workpiece keys appears in all three splits.
- No unreadable files or blocking warnings exist.

- [ ] **Step 3: Apply the reviewed plan**

Call apply with the returned `plan_id`. Preserve the returned `manifest_id`.

- [ ] **Step 4: Verify disk state**

Rescan all three splits and assert:

- No SHA-256 exists across multiple splits.
- Counts match the manifest.
- Matching labels moved with their images.
- The 54 redundant copies are in manifest quarantine.
- No source file is missing from both active splits and quarantine.

- [ ] **Step 5: Run browser acceptance**

Open `http://localhost:8501/import` or the current Data Import route. Confirm ratios, split cards, per-workpiece preview, apply/undo state, YAML generation, and no console errors. Reload and verify manifest state remains visible.

- [ ] **Step 6: Run final verification**

```powershell
cd D:\Ai-JIN_Platform\webapp
python -m pytest tests/test_dataset_split.py tests/test_dataset_split_api.py tests/test_label_api.py tests/test_data_export_api.py -q --basetemp=.pytest_tmp_split_final
cd D:\Ai-JIN_Platform\webapp\frontend
npm run lint
npm run build
```

Inspect `git status --short` and confirm unrelated model files and the separate SAM box plan remain untouched.
