from datetime import datetime, timedelta
from pathlib import Path

from dataset_split import (
    CaptureGroup,
    ImageRecord,
    assign_groups,
    build_capture_groups,
    choose_canonical_records,
    parse_capture_identity,
    scan_dataset,
)


def make_record(tmp_path, name, workpiece, captured_at, size=1):
    source = tmp_path / name
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(name.encode("utf-8"))
    return ImageRecord(
        source=source,
        relative_below_split=Path(name),
        split="train",
        label_source=tmp_path / "labels" / Path(name).with_suffix(".txt"),
        sha256=f"hash-{name}",
        size=size,
        mtime_ns=1,
        workpiece=workpiece,
        captured_at=captured_at,
        label_state="missing",
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


def test_scan_dataset_mirrors_flat_and_nested_labels(tmp_path):
    root = tmp_path / "auto_improve"
    flat = root / "images/train/part_20260717_090000_000001.jpg"
    nested = root / "images/val/part_b/frame.jpg"
    flat_label = root / "labels/train/part_20260717_090000_000001.txt"
    nested_label = root / "labels/val/part_b/frame.txt"
    for path in (flat, nested):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(path.name.encode("utf-8"))
    flat_label.parent.mkdir(parents=True, exist_ok=True)
    flat_label.write_text("0 0.5 0.5 0.2 0.2\n", encoding="utf-8")

    records = scan_dataset(tmp_path, {".jpg"})
    by_source = {record.source: record for record in records}

    assert by_source[flat].label_source == flat_label
    assert by_source[flat].label_state == "non_empty"
    assert by_source[nested].label_source == nested_label
    assert by_source[nested].workpiece == "part_b"


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


def test_capture_group_boundary_is_thirty_seconds(tmp_path):
    start = datetime(2026, 7, 17, 9, 0, 0)
    records = [
        make_record(tmp_path, "one.jpg", "part", start),
        make_record(tmp_path, "two.jpg", "part", start + timedelta(seconds=30)),
        make_record(tmp_path, "three.jpg", "part", start + timedelta(seconds=61)),
    ]

    groups = build_capture_groups(records, gap_seconds=30)

    assert [len(group.records) for group in groups] == [2, 1]


def test_assignment_is_deterministic_and_keeps_groups_whole(tmp_path):
    start = datetime(2026, 7, 17, 9, 0, 0)
    groups = []
    for index, size in enumerate((8, 5, 3, 2, 1)):
        records = tuple(
            make_record(
                tmp_path,
                f"group-{index}-{item}.jpg",
                "part",
                start + timedelta(minutes=index, seconds=item),
            )
            for item in range(size)
        )
        groups.append(CaptureGroup(f"part:{index}", "part", records))

    first = assign_groups(
        groups,
        {"train": 0.8, "val": 0.1, "test": 0.1},
        seed=42,
    )
    second = assign_groups(
        groups,
        {"train": 0.8, "val": 0.1, "test": 0.1},
        seed=42,
    )

    assert first == second
    assert set(first.values()) == {"train", "val", "test"}
    for group in groups:
        assert len({first[record.source] for record in group.records}) == 1
