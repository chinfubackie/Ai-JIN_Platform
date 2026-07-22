"""Deterministic, group-aware train/validation/test dataset splitting."""

from __future__ import annotations

import hashlib
import math
import re
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
