"""Deterministic, group-aware train/validation/test dataset splitting."""

from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


SPLITS = ("train", "val", "test")
_CAPTURE_RE = re.compile(
    r"^(?P<workpiece>.+)_(?P<date>\d{8})_(?P<time>\d{6})_(?P<fraction>\d+)$"
)
_LABEL_PRIORITY = {"non_empty": 0, "empty": 1, "missing": 2}


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
    label_state: str


@dataclass(frozen=True)
class CaptureGroup:
    key: str
    workpiece: str
    records: tuple[ImageRecord, ...]


class SplitPlanError(RuntimeError):
    """Base error for persisted dataset split operations."""


class StalePlanError(SplitPlanError):
    """Raised when files changed after a split preview was created."""


class SplitApplyError(SplitPlanError):
    """Raised when a split transaction fails and is rolled back."""


class SplitConflictError(SplitPlanError):
    """Raised when apply or undo would overwrite an unrelated file."""


def parse_capture_identity(
    relative_path: Path,
    filename: Path | None = None,
) -> CaptureIdentity:
    relative_path = Path(relative_path)
    filename = Path(filename or relative_path.name)
    nested_workpiece = (
        relative_path.parts[0] if len(relative_path.parts) > 1 else None
    )
    match = _CAPTURE_RE.match(filename.stem)
    captured_at = None
    filename_workpiece = None
    if match:
        filename_workpiece = match.group("workpiece")
        fraction = match.group("fraction")[:6].ljust(6, "0")
        captured_at = datetime.strptime(
            f"{match.group('date')}{match.group('time')}{fraction}",
            "%Y%m%d%H%M%S%f",
        )
    return CaptureIdentity(
        workpiece=nested_workpiece or filename_workpiece or "__unclassified__",
        captured_at=captured_at,
    )


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _label_state(path: Path) -> str:
    if not path.exists():
        return "missing"
    return "non_empty" if path.read_text(encoding="utf-8").strip() else "empty"


def scan_dataset(
    dataset_root: Path,
    image_extensions: set[str],
) -> list[ImageRecord]:
    dataset_root = Path(dataset_root)
    auto_root = dataset_root / "auto_improve"
    extensions = {extension.lower() for extension in image_extensions}
    records = []
    for split in SPLITS:
        image_root = auto_root / "images" / split
        if not image_root.exists():
            continue
        for source in sorted(
            path
            for path in image_root.rglob("*")
            if path.is_file() and path.suffix.lower() in extensions
        ):
            relative = source.relative_to(image_root)
            label_source = auto_root / "labels" / split / relative.with_suffix(".txt")
            identity = parse_capture_identity(relative, source.name)
            stat = source.stat()
            records.append(
                ImageRecord(
                    source=source,
                    relative_below_split=relative,
                    split=split,
                    label_source=label_source,
                    sha256=_hash_file(source),
                    size=stat.st_size,
                    mtime_ns=stat.st_mtime_ns,
                    workpiece=identity.workpiece,
                    captured_at=identity.captured_at,
                    label_state=_label_state(label_source),
                )
            )
    return records


def choose_canonical_records(
    records: list[ImageRecord],
) -> tuple[list[ImageRecord], list[ImageRecord]]:
    by_hash: dict[str, list[ImageRecord]] = {}
    for record in records:
        by_hash.setdefault(record.sha256, []).append(record)

    canonical = []
    duplicates = []
    for candidates in by_hash.values():
        ordered = sorted(
            candidates,
            key=lambda record: (
                _LABEL_PRIORITY[record.label_state],
                record.source.as_posix().lower(),
            ),
        )
        canonical.append(ordered[0])
        duplicates.extend(ordered[1:])
    canonical.sort(key=lambda record: record.source.as_posix().lower())
    duplicates.sort(key=lambda record: record.source.as_posix().lower())
    return canonical, duplicates


def build_capture_groups(
    records: list[ImageRecord],
    gap_seconds: int = 30,
) -> list[CaptureGroup]:
    if gap_seconds < 0:
        raise ValueError("gap_seconds must be non-negative")
    by_workpiece: dict[str, list[ImageRecord]] = {}
    for record in records:
        by_workpiece.setdefault(record.workpiece, []).append(record)

    groups = []
    for workpiece in sorted(by_workpiece):
        timed = sorted(
            (record for record in by_workpiece[workpiece] if record.captured_at),
            key=lambda record: (
                record.captured_at,
                record.source.as_posix().lower(),
            ),
        )
        current = []
        group_index = 0
        for record in timed:
            if (
                current
                and (record.captured_at - current[-1].captured_at).total_seconds()
                > gap_seconds
            ):
                groups.append(
                    CaptureGroup(
                        f"{workpiece}:{group_index}",
                        workpiece,
                        tuple(current),
                    )
                )
                group_index += 1
                current = []
            current.append(record)
        if current:
            groups.append(
                CaptureGroup(
                    f"{workpiece}:{group_index}",
                    workpiece,
                    tuple(current),
                )
            )
            group_index += 1

        untimed = sorted(
            (record for record in by_workpiece[workpiece] if not record.captured_at),
            key=lambda record: record.source.as_posix().lower(),
        )
        for record in untimed:
            groups.append(
                CaptureGroup(
                    f"{workpiece}:untimed:{group_index}",
                    workpiece,
                    (record,),
                )
            )
            group_index += 1
    return groups


def _stable_group_rank(group: CaptureGroup, seed: int) -> str:
    return hashlib.sha256(f"{seed}:{group.key}".encode("utf-8")).hexdigest()


def _assignment_score(counts: dict[str, int], targets: dict[str, float]) -> float:
    return sum(
        ((counts[split] - targets[split]) / max(targets[split], 1.0)) ** 2
        for split in SPLITS
    )


def _assign_workpiece_groups(
    groups: list[CaptureGroup],
    ratios: dict[str, float],
    seed: int,
) -> dict[str, str]:
    total = sum(len(group.records) for group in groups)
    targets = {split: total * ratios[split] for split in SPLITS}
    counts = {split: 0 for split in SPLITS}
    group_counts = {split: 0 for split in SPLITS}
    assignments = {}
    ordered = sorted(
        groups,
        key=lambda group: (
            -len(group.records),
            _stable_group_rank(group, seed),
        ),
    )

    if len(ordered) >= len(SPLITS):
        seed_order = sorted(SPLITS, key=lambda split: (-ratios[split], split))
        for group, split in zip(ordered[: len(SPLITS)], seed_order):
            assignments[group.key] = split
            counts[split] += len(group.records)
            group_counts[split] += 1
        remaining = ordered[len(SPLITS) :]
    else:
        remaining = ordered

    for group in remaining:
        size = len(group.records)
        candidates = []
        for split in SPLITS:
            proposed = dict(counts)
            proposed[split] += size
            candidates.append(
                (_assignment_score(proposed, targets), SPLITS.index(split), split)
            )
        split = min(candidates)[2]
        assignments[group.key] = split
        counts[split] += size
        group_counts[split] += 1

    while True:
        baseline = _assignment_score(counts, targets)
        best = None
        for group in ordered:
            source_split = assignments[group.key]
            if len(ordered) >= len(SPLITS) and group_counts[source_split] <= 1:
                continue
            size = len(group.records)
            for target_split in SPLITS:
                if target_split == source_split:
                    continue
                proposed = dict(counts)
                proposed[source_split] -= size
                proposed[target_split] += size
                score = _assignment_score(proposed, targets)
                candidate = (
                    score,
                    _stable_group_rank(group, seed),
                    group,
                    source_split,
                    target_split,
                    proposed,
                )
                if score + 1e-12 < baseline and (best is None or candidate[:2] < best[:2]):
                    best = candidate
        if best is None:
            break
        _, _, group, source_split, target_split, counts = best
        assignments[group.key] = target_split
        group_counts[source_split] -= 1
        group_counts[target_split] += 1
    return assignments


def assign_groups(
    groups: list[CaptureGroup],
    ratios: dict[str, float],
    seed: int = 42,
) -> dict[Path, str]:
    if set(ratios) != set(SPLITS):
        raise ValueError("ratios must define train, val, and test")
    if any(not math.isfinite(value) or value <= 0 for value in ratios.values()):
        raise ValueError("ratios must be positive finite numbers")
    if not math.isclose(sum(ratios.values()), 1.0, abs_tol=1e-9):
        raise ValueError("ratios must sum to 1")

    by_workpiece: dict[str, list[CaptureGroup]] = {}
    for group in groups:
        by_workpiece.setdefault(group.workpiece, []).append(group)

    assignments = {}
    for workpiece in sorted(by_workpiece):
        group_assignments = _assign_workpiece_groups(
            by_workpiece[workpiece],
            ratios,
            seed,
        )
        for group in by_workpiece[workpiece]:
            split = group_assignments[group.key]
            for record in group.records:
                assignments[record.source] = split
    return assignments


def _as_relative(dataset_root: Path, path: Path) -> str:
    return path.resolve().relative_to(dataset_root.resolve()).as_posix()


def _from_relative(dataset_root: Path, value: str) -> Path:
    resolved = (dataset_root / value).resolve()
    if dataset_root.resolve() not in (resolved, *resolved.parents):
        raise SplitPlanError(f"Path escapes dataset root: {value}")
    return resolved


def _fingerprint(records: list[ImageRecord]) -> str:
    digest = hashlib.sha256()
    for record in sorted(records, key=lambda item: item.source.as_posix().lower()):
        digest.update(
            (
                f"{record.source.as_posix()}|{record.sha256}|"
                f"{record.size}|{record.mtime_ns}\n"
            ).encode("utf-8")
        )
    return digest.hexdigest()


def _collision_safe_destination(
    desired: Path,
    source: Path,
    record_hash: str,
    duplicate_sources: set[Path],
    claimed: set[str],
) -> Path:
    candidate = desired
    key = candidate.as_posix().lower()
    desired_is_vacated_duplicate = desired.resolve() in duplicate_sources
    if (
        key not in claimed
        and (
            not desired.exists()
            or desired.resolve() == source.resolve()
            or desired_is_vacated_duplicate
        )
    ):
        claimed.add(key)
        return candidate

    suffix = record_hash[:8]
    counter = 0
    while True:
        extra = f"__{suffix}" if counter == 0 else f"__{suffix}_{counter}"
        candidate = desired.with_name(f"{desired.stem}{extra}{desired.suffix}")
        key = candidate.as_posix().lower()
        if key not in claimed and not candidate.exists():
            claimed.add(key)
            return candidate
        counter += 1


def _plan_summary(
    records: list[ImageRecord],
    canonical: list[ImageRecord],
    groups: list[CaptureGroup],
    assignments: dict[Path, str],
    duplicates: list[ImageRecord],
) -> dict:
    current = {split: 0 for split in SPLITS}
    proposed = {split: 0 for split in SPLITS}
    per_workpiece = {}
    for record in records:
        current[record.split] += 1
    groups_by_workpiece = {}
    for group in groups:
        groups_by_workpiece.setdefault(group.workpiece, []).append(group)
    for record in canonical:
        split = assignments[record.source]
        proposed[split] += 1
        row = per_workpiece.setdefault(
            record.workpiece,
            {
                "total": 0,
                "groups": len(groups_by_workpiece.get(record.workpiece, [])),
                "train": 0,
                "val": 0,
                "test": 0,
                "labels": 0,
            },
        )
        row["total"] += 1
        row[split] += 1
        if record.label_state != "missing":
            row["labels"] += 1

    warnings = []
    for workpiece, workpiece_groups in sorted(groups_by_workpiece.items()):
        if len(workpiece_groups) < len(SPLITS):
            warnings.append(
                f"{workpiece}: only {len(workpiece_groups)} capture groups; "
                "cannot represent it in every split"
            )
    label_count = sum(record.label_state != "missing" for record in canonical)
    if label_count < len(canonical):
        warnings.append(
            f"Only {label_count}/{len(canonical)} canonical images have label files"
        )
    if duplicates:
        warnings.append(
            f"{len(duplicates)} exact duplicate images will be quarantined"
        )
    return {
        "current": current,
        "proposed": proposed,
        "per_workpiece": per_workpiece,
        "capture_groups": len(groups),
        "duplicates": len(duplicates),
        "canonical_images": len(canonical),
        "label_files": label_count,
        "warnings": warnings,
    }


def create_split_plan(
    dataset_root: Path,
    ratios: dict[str, float],
    gap_seconds: int,
    seed: int,
    image_extensions: set[str],
) -> dict:
    dataset_root = Path(dataset_root).resolve()
    records = scan_dataset(dataset_root, image_extensions)
    canonical, duplicates = choose_canonical_records(records)
    groups = build_capture_groups(canonical, gap_seconds=gap_seconds)
    assignments = assign_groups(groups, ratios, seed=seed)
    plan_id = (
        time.strftime("%Y%m%d_%H%M%S")
        + "_"
        + uuid.uuid4().hex[:8]
    )
    auto_root = dataset_root / "auto_improve"
    duplicate_sources = {record.source.resolve() for record in duplicates}
    claimed = set()

    duplicate_items = []
    for record in duplicates:
        destination = (
            auto_root
            / "split_quarantine"
            / plan_id
            / record.source.relative_to(dataset_root)
        )
        label_destination = (
            auto_root
            / "split_quarantine"
            / plan_id
            / record.label_source.relative_to(dataset_root)
            if record.label_source.exists()
            else None
        )
        duplicate_items.append(
            {
                "source": _as_relative(dataset_root, record.source),
                "destination": _as_relative(dataset_root, destination),
                "label_source": (
                    _as_relative(dataset_root, record.label_source)
                    if record.label_source.exists()
                    else None
                ),
                "label_destination": (
                    _as_relative(dataset_root, label_destination)
                    if label_destination
                    else None
                ),
                "label_sha256": (
                    _hash_file(record.label_source)
                    if record.label_source.exists()
                    else None
                ),
                "sha256": record.sha256,
                "workpiece": record.workpiece,
            }
        )

    items = []
    for record in canonical:
        target_split = assignments[record.source]
        desired = (
            auto_root
            / "images"
            / target_split
            / record.relative_below_split
        )
        destination = _collision_safe_destination(
            desired,
            record.source,
            record.sha256,
            duplicate_sources,
            claimed,
        )
        label_destination = (
            auto_root
            / "labels"
            / target_split
            / destination.relative_to(auto_root / "images" / target_split)
        ).with_suffix(".txt")
        items.append(
            {
                "source": _as_relative(dataset_root, record.source),
                "destination": _as_relative(dataset_root, destination),
                "label_source": (
                    _as_relative(dataset_root, record.label_source)
                    if record.label_source.exists()
                    else None
                ),
                "label_destination": (
                    _as_relative(dataset_root, label_destination)
                    if record.label_source.exists()
                    else None
                ),
                "label_sha256": (
                    _hash_file(record.label_source)
                    if record.label_source.exists()
                    else None
                ),
                "sha256": record.sha256,
                "source_split": record.split,
                "target_split": target_split,
                "workpiece": record.workpiece,
                "group_key": next(
                    group.key for group in groups if record in group.records
                ),
            }
        )

    summary = _plan_summary(
        records,
        canonical,
        groups,
        assignments,
        duplicates,
    )
    summary["image_moves"] = sum(
        item["source"] != item["destination"] for item in items
    )
    summary["label_moves"] = sum(
        bool(item["label_source"])
        and item["label_source"] != item["label_destination"]
        for item in items
    )
    plan = {
        "plan_id": plan_id,
        "created_at": datetime.now().astimezone().isoformat(),
        "inventory_fingerprint": _fingerprint(records),
        "ratios": ratios,
        "session_gap_seconds": gap_seconds,
        "seed": seed,
        "items": items,
        "duplicates": duplicate_items,
        "summary": summary,
    }
    plan_dir = auto_root / "split_plans"
    plan_dir.mkdir(parents=True, exist_ok=True)
    plan_path = plan_dir / f"{plan_id}.json"
    plan["plan_path"] = str(plan_path)
    plan_path.write_text(
        json.dumps(plan, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return plan


def load_split_plan(dataset_root: Path, plan_id: str) -> dict:
    path = (
        Path(dataset_root).resolve()
        / "auto_improve"
        / "split_plans"
        / f"{plan_id}.json"
    )
    if not path.exists():
        raise SplitPlanError(f"Split plan not found: {plan_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def _preflight_source(dataset_root: Path, item: dict) -> None:
    source = _from_relative(dataset_root, item["source"])
    if not source.exists() or _hash_file(source) != item["sha256"]:
        raise StalePlanError(f"Source changed after preview: {item['source']}")
    if item.get("label_source"):
        label_source = _from_relative(dataset_root, item["label_source"])
        if (
            not label_source.exists()
            or _hash_file(label_source) != item["label_sha256"]
        ):
            raise StalePlanError(
                f"Label changed after preview: {item['label_source']}"
            )


def _preflight_destinations(dataset_root: Path, operations: list[dict]) -> None:
    moving_sources = {
        _from_relative(dataset_root, operation["source"]).resolve()
        for operation in operations
        if operation["source"] != operation["destination"]
    }
    for operation in operations:
        source = _from_relative(dataset_root, operation["source"])
        destination = _from_relative(dataset_root, operation["destination"])
        if source == destination:
            continue
        if destination.exists() and destination.resolve() not in moving_sources:
            raise SplitConflictError(
                f"Destination already exists: {operation['destination']}"
            )


def _operation(
    source: str,
    destination: str,
    sha256: str,
    kind: str,
    target_split: str | None = None,
) -> dict:
    return {
        "source": source,
        "destination": destination,
        "sha256": sha256,
        "kind": kind,
        "target_split": target_split,
    }


def _plan_operations(dataset_root: Path, plan: dict) -> list[dict]:
    operations = []
    for item in plan["duplicates"]:
        operations.append(
            _operation(
                item["source"],
                item["destination"],
                item["sha256"],
                "duplicate_image",
            )
        )
        if item["label_source"]:
            operations.append(
                _operation(
                    item["label_source"],
                    item["label_destination"],
                    item["label_sha256"],
                    "duplicate_label",
                )
            )
    for item in plan["items"]:
        operations.append(
            _operation(
                item["source"],
                item["destination"],
                item["sha256"],
                "image",
                item["target_split"],
            )
        )
        if item["label_source"]:
            operations.append(
                _operation(
                    item["label_source"],
                    item["label_destination"],
                    item["label_sha256"],
                    "label",
                    item["target_split"],
                )
            )
    return operations


def _move_operation(
    dataset_root: Path,
    operation: dict,
    mover,
) -> None:
    source = _from_relative(dataset_root, operation["source"])
    destination = _from_relative(dataset_root, operation["destination"])
    if source == destination:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    mover(str(source), str(destination))


def apply_split_plan(
    dataset_root: Path,
    plan_id: str,
    on_path_changed=None,
    mover=shutil.move,
) -> dict:
    dataset_root = Path(dataset_root).resolve()
    plan = load_split_plan(dataset_root, plan_id)
    for item in (*plan["duplicates"], *plan["items"]):
        _preflight_source(dataset_root, item)
    operations = _plan_operations(dataset_root, plan)
    _preflight_destinations(dataset_root, operations)

    performed = []
    try:
        for operation in operations:
            if operation["source"] == operation["destination"]:
                continue
            _move_operation(dataset_root, operation, mover)
            performed.append(operation)
    except Exception as exc:
        rollback_errors = []
        for operation in reversed(performed):
            reverse = {
                **operation,
                "source": operation["destination"],
                "destination": operation["source"],
            }
            try:
                _move_operation(dataset_root, reverse, shutil.move)
            except Exception as rollback_exc:
                rollback_errors.append(str(rollback_exc))
        detail = f"Split apply failed: {exc}"
        if rollback_errors:
            detail += f"; rollback errors: {rollback_errors}"
        raise SplitApplyError(detail) from exc

    manifest_id = plan_id
    manifest = {
        "manifest_id": manifest_id,
        "plan_id": plan_id,
        "status": "applied",
        "applied_at": datetime.now().astimezone().isoformat(),
        "operations": performed,
        "summary": plan["summary"],
    }
    manifest_dir = dataset_root / "auto_improve" / "split_manifests"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = manifest_dir / f"{manifest_id}.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    if on_path_changed:
        for operation in performed:
            if operation["kind"] != "image":
                continue
            try:
                on_path_changed(
                    operation["source"],
                    operation["destination"],
                    operation["target_split"],
                )
            except Exception:
                pass

    return {
        "ok": True,
        "manifest_id": manifest_id,
        "manifest_path": str(manifest_path),
        "moved_images": sum(
            operation["kind"] == "image" for operation in performed
        ),
        "moved_labels": sum(
            operation["kind"] == "label" for operation in performed
        ),
        "quarantined_duplicates": len(plan["duplicates"]),
        "summary": plan["summary"],
    }


def _load_manifest(dataset_root: Path, manifest_id: str) -> tuple[Path, dict]:
    path = (
        Path(dataset_root).resolve()
        / "auto_improve"
        / "split_manifests"
        / f"{manifest_id}.json"
    )
    if not path.exists():
        raise SplitPlanError(f"Split manifest not found: {manifest_id}")
    return path, json.loads(path.read_text(encoding="utf-8"))


def undo_split_manifest(
    dataset_root: Path,
    manifest_id: str,
    on_path_changed=None,
    mover=shutil.move,
) -> dict:
    dataset_root = Path(dataset_root).resolve()
    manifest_path, manifest = _load_manifest(dataset_root, manifest_id)
    if manifest.get("status") != "applied":
        raise SplitConflictError(f"Manifest is not applied: {manifest_id}")

    operations = manifest["operations"]
    for operation in operations:
        destination = _from_relative(dataset_root, operation["destination"])
        source = _from_relative(dataset_root, operation["source"])
        if not destination.exists() or _hash_file(destination) != operation["sha256"]:
            raise SplitConflictError(
                f"Applied file changed: {operation['destination']}"
            )
        if source.exists():
            raise SplitConflictError(
                f"Original path is occupied: {operation['source']}"
            )

    reversed_operations = []
    try:
        for operation in reversed(operations):
            reverse = {
                **operation,
                "source": operation["destination"],
                "destination": operation["source"],
            }
            _move_operation(dataset_root, reverse, mover)
            reversed_operations.append(reverse)
    except Exception as exc:
        for reverse in reversed(reversed_operations):
            restore = {
                **reverse,
                "source": reverse["destination"],
                "destination": reverse["source"],
            }
            _move_operation(dataset_root, restore, shutil.move)
        raise SplitApplyError(f"Split undo failed: {exc}") from exc

    manifest["status"] = "undone"
    manifest["undone_at"] = datetime.now().astimezone().isoformat()
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if on_path_changed:
        for operation in reversed(operations):
            if operation["kind"] != "image":
                continue
            source_parts = Path(operation["source"]).parts
            try:
                split = source_parts[source_parts.index("images") + 1]
            except (ValueError, IndexError):
                split = "train"
            try:
                on_path_changed(
                    operation["destination"],
                    operation["source"],
                    split,
                )
            except Exception:
                pass
    return {
        "ok": True,
        "manifest_id": manifest_id,
        "restored": len(reversed_operations),
    }


def latest_split_manifest(dataset_root: Path) -> dict | None:
    manifest_dir = (
        Path(dataset_root).resolve() / "auto_improve" / "split_manifests"
    )
    if not manifest_dir.exists():
        return None
    manifests = sorted(
        manifest_dir.glob("*.json"),
        key=lambda path: path.stat().st_mtime_ns,
        reverse=True,
    )
    for path in manifests:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        if manifest.get("status") == "applied":
            return manifest
    return None
