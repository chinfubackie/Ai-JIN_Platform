# Group-Aware Train/Validation/Test Split Design

Date: 2026-07-22
Status: Approved interaction and data design
Target: Ai-JIN Platform Data Import workflow

## Context

The current dataset contains 1,249 images under `train`, 54 under `val`, and none under `test`. All 54 validation images have identical filenames and SHA-256 hashes in `train`, so the current validation set leaks training data and cannot provide an honest accuracy estimate.

The dataset contains five workpiece groups encoded in flat filenames such as:

```text
F-373130-K010_20260717_093756_826469.jpg
```

Existing APIs support manual movement between splits but do not build a deterministic, group-aware split. Some code assumes class subdirectories while the current dataset is flat, so the splitter must support both layouts.

## Goals

- Produce deterministic train/validation/test assignments targeting 80/10/10.
- Keep temporally adjacent capture frames in the same split.
- Preserve per-workpiece representation across all splits where the available groups allow it.
- Detect exact duplicate content across every existing split.
- Remove duplicate leakage without permanently deleting source files.
- Preview all planned changes and readiness warnings before applying them.
- Apply image and matching label moves transactionally.
- Record a manifest that supports audit and undo.
- Generate YOLO YAML containing train, validation, and test paths.

## Non-Goals

- Do not infer missing object annotations.
- Do not claim dataset readiness when label coverage is insufficient.
- Do not randomly split individual frames from the same capture burst.
- Do not permanently delete duplicates.
- Do not require class folders; flat and nested datasets remain supported.
- Do not alter annotation coordinates or class IDs.

## Dataset Inventory

Scan image files recursively below:

```text
auto_improve/images/train
auto_improve/images/val
auto_improve/images/test
```

For every image, record:

- Absolute and dataset-relative path.
- Current split.
- Relative path below the split.
- Mirrored label path below `auto_improve/labels/<split>`.
- File size, modification time, and SHA-256.
- Whether a label exists and whether it contains annotations.
- Workpiece key.
- Capture timestamp when it can be parsed.

The workpiece key is resolved in this order:

1. First directory below the split for nested layouts.
2. Filename prefix preceding `_YYYYMMDD_HHMMSS_<fraction>`.
3. `__unclassified__` when neither form is available.

This supports both the current flat files and future class-folder imports.

## Duplicate Policy

Group identical SHA-256 hashes before creating capture groups. Choose one canonical file using this priority:

1. A copy with a non-empty label.
2. A copy with an existing empty label.
3. The lexicographically smallest dataset-relative path.

The canonical file participates in split assignment. Other copies are marked as duplicates and excluded from counts.

On apply, move duplicate images and their matching labels to:

```text
auto_improve/split_quarantine/<manifest-id>/
```

The quarantine path mirrors the original dataset-relative path. No duplicate is deleted, and the manifest records every quarantine move.

## Capture Groups

Within each workpiece key, sort canonical images by capture timestamp. Images belong to the same capture group while the gap between consecutive timestamps is at most 30 seconds. A gap greater than 30 seconds starts a new group.

Images without a parseable timestamp are isolated groups unless they share an exact hash, which was already handled by duplicate grouping.

A capture group is indivisible. The assignment algorithm never places images from one group into multiple splits. Large groups remain intact even when that makes the final percentage differ from 80/10/10; honest separation is more important than an exact count.

The current data produces at least four 30-second capture groups for every detected workpiece key, so each class can be represented in train, validation, and test.

## Assignment Algorithm

The assignment is deterministic for the same inventory, ratios, session gap, and seed.

Inputs:

```json
{
  "train_ratio": 0.8,
  "val_ratio": 0.1,
  "test_ratio": 0.1,
  "session_gap_seconds": 30,
  "seed": 42
}
```

Validate that ratios are positive and sum to 1 within a small floating-point tolerance.

For each workpiece key:

1. Calculate target image counts for train, validation, and test.
2. Order groups by descending size, using a stable seed-derived hash of the group key for ties.
3. When at least three groups exist, seed each split with one group.
4. Assign each remaining group to the split that minimizes total weighted squared distance from all three target counts.
5. Run deterministic single-group moves and pairwise swaps until no operation improves the objective.
6. Report achieved counts, percentages, group counts, and deviations.

Classes with fewer than three capture groups receive an explicit warning because complete split representation is impossible without breaking leakage protection.

## Preview API

Add:

```text
POST /api/import/split/preview
```

The response contains:

- A persisted `plan_id`.
- Inventory fingerprint.
- Current and proposed totals per split.
- Current and proposed counts per workpiece.
- Capture group counts.
- Duplicate count and quarantine candidates.
- Label coverage per split and workpiece.
- Ratio deviations and warnings.
- Number of image moves and label moves.

Persist the preview plan below `auto_improve/split_plans`. The plan stores exact source/destination paths and hashes, allowing apply to use the reviewed assignment rather than recalculating it.

## Apply and Undo APIs

Add:

```text
POST /api/import/split/apply
POST /api/import/split/undo
```

`apply` accepts a `plan_id`. Before changing files it revalidates every planned source path and SHA-256 against the preview fingerprint. A stale plan returns HTTP 409 and does not move any file.

For each canonical image:

- Preserve its relative subpath below the split.
- Move the image to the planned split using a collision-safe destination.
- Move its mirrored label when present.
- Update matching image database rows when they exist.

If a different-content file already owns the destination name, append a short content-hash suffix to the image and label stem. Record the final path.

Write a manifest progressively. If any move fails, reverse all completed moves in reverse order and return an error. A successful manifest is immutable and contains the complete before/after mapping, inputs, inventory fingerprint, counts, and timestamp.

`undo` accepts the latest applicable `manifest_id`, validates that destination files still match the manifest hashes, and reverses image, label, and quarantine moves. Conflicts stop the undo before any file is changed.

## User Interface

Extend the Data Import analysis area with a `Train / Val / Test Split` section containing:

- Ratio inputs defaulting to 80, 10, and 10 percent.
- Session gap input defaulting to 30 seconds.
- Seed input defaulting to 42.
- `Analyze Split` action.
- Preview totals for all three splits.
- Per-workpiece table showing image counts, group counts, and achieved percentages.
- Duplicate leakage, label coverage, and insufficient-group warnings.
- `Apply Split` action enabled only for a current preview.
- `Undo Last Split` action when a valid manifest exists.

Applying requires a confirmation dialog that states the number of image moves, label moves, and quarantined duplicates. The UI reloads folders, split statistics, and preview state after apply or undo.

## Split Statistics and Training YAML

Update `GET /api/import/split-info` to return train, validation, and test statistics. Include image count, label-file count, non-empty label count, and annotation coverage.

Update generated YAML to include:

```yaml
train: images/train
val: images/val
test: images/test
```

The split operation may proceed with missing labels, but the preview must warn that model training accuracy cannot be evaluated reliably until label coverage is adequate.

## Error Handling

- Invalid ratios: HTTP 400 without a plan.
- Empty dataset: return a preview with a blocking warning.
- Unreadable image or hash failure: list the path and block apply.
- Stale preview: HTTP 409 without moving files.
- Destination collision: use the content-hash suffix rule.
- Apply failure: roll back completed operations.
- Undo conflict: report the conflicting paths and leave all files unchanged.
- Concurrent apply: serialize split mutations with a process-level lock.

## Verification

### Unit Tests

- Parse workpiece keys and timestamps from flat filenames.
- Resolve workpiece keys from nested folders.
- Group adjacent frames at the 30-second boundary.
- Produce deterministic assignments for seed 42.
- Keep every capture group in exactly one split.
- Represent each workpiece in all splits when at least three groups exist.
- Prefer labeled canonical copies during hash deduplication.
- Keep ratio deviation minimal without breaking groups.

### API Tests

- Preview reports duplicate leakage without changing disk contents.
- Apply moves images and mirrored labels to planned destinations.
- Apply quarantines duplicate copies and keeps canonical labeled copies.
- Stale plans return 409 without partial changes.
- Injected move failure rolls back all prior moves.
- Undo restores the original image, label, and duplicate locations.
- Split statistics include test.
- Generated YAML includes the test path.

### Browser Acceptance

- Analyze the current dataset from the Data Import page.
- Confirm preview totals and all five workpiece keys.
- Confirm 54 current train/validation duplicate hashes are reported.
- Apply the reviewed plan and verify no hash appears in more than one split.
- Verify each capture group belongs to exactly one split.
- Verify all three split cards and per-workpiece counts.
- Generate YAML and confirm train, validation, and test paths.
- Reload the page and confirm the applied manifest remains visible.
- Verify the browser console has no new errors.

## Considered Alternatives

### Random Per-Image Split

This reaches the requested percentages closely but places neighboring frames from the same capture sequence in different splits, inflating validation and test accuracy.

### Class-Stratified Per-Image Split

This preserves class ratios but still leaks temporal neighbors and near-identical production scenes across splits.

### Group-Aware Stratified Split

This preserves capture boundaries and class representation while approaching the target ratios. Percentage deviation is expected when a capture group is large, but evaluation quality is more trustworthy.
