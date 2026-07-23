# Class Label Rename and Synchronization Design

**Date:** 2026-07-22  
**Status:** Approved for specification  
**System:** Ai-JIN Platform

## Problem

Class labels are represented in several places that can drift apart:

- the `classes` table in SQLite, ordered by `class_idx`;
- the Annotator class list cached in browser `localStorage`;
- `auto_improve/class_mapping.json`, whose `model_to_class_id` object maps names to numeric IDs;
- `auto_improve/data.yaml`, whose `names` sequence or mapping defines the training class order;
- optional class-named directories below `auto_improve/images/<split>` and `auto_improve/labels/<split>`.

The Projects UI can create and delete classes but cannot invoke the existing database rename helper. The Annotator can add local names but cannot safely rename one across the platform. Renaming only one representation can display stale labels or, if ordering is regenerated, associate existing YOLO annotations with the wrong class.

## Goals

- Let an operator rename a class from Projects or Annotator through one authoritative backend operation.
- Preserve the existing numeric YOLO class ID and SQLite `class_idx`.
- Synchronize SQLite, `class_mapping.json`, `data.yaml`, class-named image directories, class-named label directories, and Annotator state.
- Apply directory changes to `train`, `val`, and `test` splits.
- Reject unsafe or ambiguous changes before modifying data.
- Roll back completed changes if a later step fails.
- Provide a Thai operator guide in Markdown and HTML, supported by screenshots of the verified browser workflow.

## Non-Goals

- Do not reorder classes.
- Do not rewrite class ID numbers in existing YOLO `.txt` annotation files.
- Do not merge two existing classes or combine colliding directories.
- Do not rename model weight files or retrain existing models.
- Do not rename classes outside the selected project's dataset root.
- Do not turn project-less Annotator labels into globally synchronized labels.

## Recommended Architecture

The backend owns the complete rename operation. Both frontend surfaces call the same endpoint:

```text
PATCH /api/classes/<class_id>
Content-Type: application/json

{ "name": "New label" }
```

The backend resolves the class and its project from SQLite. The project dataset root is its configured `dataset_dir` when present; otherwise it is the active module-level `DATASET / "auto_improve"`. Runtime-mutable module globals must be read when the request runs.

The endpoint delegates to one focused synchronization helper. The helper performs validation and preflight first, records the original file contents and planned directory moves, applies the changes, and restores the originals if any write or move fails. The API returns the renamed class, its unchanged `class_idx`, the files updated, and the directories moved so the UI can report what happened.

The operation is serialized with a module-level lock because the filesystem and SQLite cannot participate in one native transaction. Concurrent rename requests must not interleave.

## Dataset Root and Path Safety

The helper accepts a resolved project dataset root, not a path supplied directly by the request body. The default root is `<DATASET>/auto_improve`.

If a project has `dataset_dir`, the implementation resolves the stored value using the existing project configuration rules and confines every descendant lookup to that resolved root. Every class-directory target is constructed through the existing `_safe_path(base, user_path)` protection. The endpoint never accepts an arbitrary dataset path.

A valid class name:

- is non-empty after trimming;
- is not `.` or `..`;
- contains no `/`, `\\`, control characters, or Windows-invalid filename characters `< > : " | ? *`;
- does not end in a space or period;
- does not duplicate another class name in the same project using case-insensitive comparison.

Thai text, spaces inside the name, hyphens, and underscores remain allowed.

## Class Identity Contract

The SQLite class row ID identifies the rename target. Its `class_idx` is the canonical numeric YOLO class ID and must remain unchanged.

For example:

```text
Before: class_idx=2, name=York
After:  class_idx=2, name=Yoke
```

Every existing annotation row starting with `2` remains unchanged. Only the human-readable name associated with ID `2` changes.

## Preflight

Before making any change, the backend:

1. loads the class and owning project or returns `404`;
2. validates and normalizes the proposed name;
3. treats an exact unchanged name as a successful no-op;
4. rejects a case-insensitive duplicate class name with `409`;
5. loads and validates `class_mapping.json` when it exists;
6. loads and validates `data.yaml` when it exists;
7. identifies source and destination image/label directories for each split;
8. rejects any destination collision instead of merging data;
9. prepares a case-only rename through a temporary sibling name on case-insensitive filesystems;
10. snapshots the original metadata file bytes for rollback.

Missing optional metadata files or missing source directories are not errors. The helper updates the representations that exist and reports skipped items.

If the mapping contains the old name with an ID that conflicts with `class_idx`, or `data.yaml` associates the old name with a different ID, the endpoint returns `409` without changing anything. This prevents a rename from hiding an existing ID mismatch.

## Apply Order and Rollback

After preflight succeeds, the helper applies changes in this order:

1. move class directories for `images` and `labels` in `train`, `val`, and `test`;
2. atomically replace `class_mapping.json` with the renamed key and unchanged ID;
3. atomically replace `data.yaml` with the name changed at the unchanged ID;
4. rename the SQLite class row inside a database transaction.

Metadata writes use a temporary file in the same directory followed by replacement. Directory moves and original file bytes are recorded in a rollback journal held for the request. If any step fails, rollback restores the SQLite name if necessary, restores original metadata bytes, and reverses completed directory moves in reverse order.

If rollback itself is incomplete, the API returns `500` with a clear recovery report listing the paths that require manual attention. The endpoint must not claim success when any synchronization target failed.

## Metadata Behavior

### `class_mapping.json`

The helper renames the key in `model_to_class_id` and preserves its numeric value and all unrelated top-level fields. If the old key is absent, it inserts the new key with the class's canonical `class_idx` only when doing so does not create an ID collision.

### `data.yaml`

Both supported Ultralytics forms are handled:

```yaml
names: [York, Other]
```

```yaml
names:
  0: York
  1: Other
```

The helper changes only the entry at `class_idx`, verifies that it is either the old name or an unambiguous missing entry, preserves other dataset configuration values, and keeps `nc` consistent with the resulting class collection. YAML is written using the existing PyYAML dependency.

### Directories

The helper checks these optional pairs:

```text
images/train/<old>   labels/train/<old>
images/val/<old>     labels/val/<old>
images/test/<old>    labels/test/<old>
```

Flat datasets without class subdirectories remain valid; only metadata and SQLite are updated in that case. A destination directory that already exists causes preflight failure rather than an implicit merge.

## Frontend Interaction

### Projects

Each class row gains an edit control next to delete. Selecting edit replaces the name with an inline input and Save/Cancel actions. Enter saves and Escape cancels. While saving, controls for that row are disabled.

On success, the detail panel reloads from the API and shows a Thai confirmation containing the old name, new name, unchanged class ID, and the number of moved directories. Backend validation or collision messages are shown in the existing toast surface.

### Annotator

When a project is selected, each class row gains the same edit action and calls the same API. The feature is disabled when no project is selected, with a hint to select a project first.

Project classes become authoritative in Annotator. Loading a project replaces the cached class-name array in `class_idx` order instead of merging it with stale names. After a successful rename, the name at that exact array index is replaced, active selection is preserved, and the updated list is written to the current folder's `localStorage` cache. Box and polygon class IDs are untouched.

Local-only class creation remains available when no project is selected, but local-only names cannot invoke the synchronized rename operation.

## API Responses

Successful response:

```json
{
  "ok": true,
  "class": { "id": 17, "project_id": 3, "class_idx": 2, "name": "Yoke" },
  "old_name": "York",
  "updated_files": ["class_mapping.json", "data.yaml"],
  "moved_directories": 6,
  "skipped": []
}
```

Expected failures:

- `400` for an invalid or empty name;
- `404` when the class or owning project does not exist;
- `409` for duplicate names, destination collisions, or inconsistent class IDs;
- `500` for an apply failure, including rollback status and safe recovery details.

Error responses never expose unrestricted host filesystem paths beyond paths already within the configured project dataset.

## Testing and Verification

Backend unit tests use temporary dataset roots and the existing standalone Flask test style. Coverage includes:

- successful rename with an unchanged class ID;
- synchronized list-form and mapping-form `data.yaml`;
- synchronized `class_mapping.json` with unrelated fields preserved;
- all existing `train`, `val`, and `test` directory pairs moved;
- flat dataset behavior;
- exact no-op and case-only rename;
- invalid names, duplicate names, destination collisions, and ID mismatches;
- injected mid-operation failure with successful rollback;
- `_safe_path` confinement and no annotation `.txt` content changes.

Frontend verification covers API client wiring, inline editing state, project-required behavior in Annotator, exact class-list replacement by `class_idx`, Thai success/errors, and preservation of selected annotations.

Completion checks:

1. run focused backend tests with a repository-local `--basetemp` if Windows temp permissions require it;
2. run existing related backend tests;
3. run `npm run lint`;
4. run `npm run build` so Flask serves fresh static assets;
5. start the real backend and verify both Projects and Annotator in the browser;
6. confirm final URLs, browser console state, database row, metadata files, moved directories, and unchanged YOLO IDs.

## Documentation Deliverables

Implementation is not complete until these operator materials exist and match the verified UI:

- `docs/manual/Ai-JIN-Platform-Class-Label-Rename-Guide-TH.md`
- `docs/manual/Ai-JIN-Platform-Class-Label-Rename-Guide-TH.html`
- browser screenshots under `docs/manual/images/`

The guide explains prerequisites, renaming from Projects, renaming from Annotator, what is synchronized, why class IDs do not change, collision/error recovery, verification before training, and a concise troubleshooting section.

## Acceptance Criteria

- An operator can rename a project class from Projects and Annotator.
- Both surfaces use the same backend synchronization operation.
- SQLite, mapping, YAML, and existing class directories show the new name.
- `class_idx` and every existing YOLO annotation ID remain unchanged.
- A collision or inconsistent mapping causes no partial changes.
- An injected write/move failure is rolled back in tests.
- Annotator does not reintroduce the old name from `localStorage` after reload.
- Frontend static assets are rebuilt and the real browser workflow is verified without console errors.
- The Thai Markdown and HTML manuals include current screenshots and troubleshooting guidance.
