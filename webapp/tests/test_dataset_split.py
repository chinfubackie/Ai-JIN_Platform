from datetime import datetime, timedelta
from pathlib import Path
import shutil

import pytest
import db

from dataset_split import (
    CaptureGroup,
    ImageRecord,
    SplitApplyError,
    StalePlanError,
    apply_split_plan,
    assign_groups,
    build_capture_groups,
    choose_canonical_records,
    create_split_plan,
    parse_capture_identity,
    scan_dataset,
    undo_split_manifest,
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


def create_transaction_dataset(tmp_path, include_duplicate=False):
    root = tmp_path / "auto_improve"
    originals = []
    for index, minute in enumerate((0, 2, 4, 6)):
        image = (
            root
            / "images/train"
            / f"part_20260717_09{minute:02d}00_000001.jpg"
        )
        label = (
            root
            / "labels/train"
            / f"part_20260717_09{minute:02d}00_000001.txt"
        )
        image.parent.mkdir(parents=True, exist_ok=True)
        label.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(f"image-{index}".encode("utf-8"))
        label.write_text(f"0 0.5 0.5 0.{index + 1} 0.2\n", encoding="utf-8")
        originals.append(image)

    duplicate = None
    if include_duplicate:
        duplicate = root / "images/val" / originals[0].name
        duplicate.parent.mkdir(parents=True, exist_ok=True)
        duplicate.write_bytes(originals[0].read_bytes())
    return originals, duplicate


def test_create_split_plan_persists_preview_without_moving_files(tmp_path):
    originals, _ = create_transaction_dataset(tmp_path)

    plan = create_split_plan(
        tmp_path,
        {"train": 0.8, "val": 0.1, "test": 0.1},
        gap_seconds=30,
        seed=42,
        image_extensions={".jpg"},
    )

    assert plan["plan_id"]
    assert Path(plan["plan_path"]).exists()
    assert all(path.exists() for path in originals)
    assert plan["summary"]["current"]["train"] == 4
    assert sum(plan["summary"]["proposed"].values()) == 4


def test_apply_moves_images_labels_and_quarantines_duplicates(tmp_path):
    originals, duplicate = create_transaction_dataset(
        tmp_path,
        include_duplicate=True,
    )
    plan = create_split_plan(
        tmp_path,
        {"train": 0.8, "val": 0.1, "test": 0.1},
        gap_seconds=30,
        seed=42,
        image_extensions={".jpg"},
    )

    result = apply_split_plan(tmp_path, plan["plan_id"])

    assert result["ok"] is True
    assert result["quarantined_duplicates"] == 1
    assert not duplicate.exists()
    assert all(
        (tmp_path / item["destination"]).exists()
        for item in plan["items"]
    )
    assert all(
        (tmp_path / item["label_destination"]).exists()
        for item in plan["items"]
        if item["label_source"]
    )
    assert (tmp_path / result["manifest_path"]).exists()


def test_apply_rejects_stale_plan_before_any_move(tmp_path):
    originals, _ = create_transaction_dataset(tmp_path)
    plan = create_split_plan(
        tmp_path,
        {"train": 0.8, "val": 0.1, "test": 0.1},
        gap_seconds=30,
        seed=42,
        image_extensions={".jpg"},
    )
    originals[0].write_bytes(b"changed-after-preview")

    with pytest.raises(StalePlanError):
        apply_split_plan(tmp_path, plan["plan_id"])

    assert all(path.exists() for path in originals)
    assert not (tmp_path / "auto_improve/split_manifests").exists()


def test_apply_rejects_label_changed_after_preview(tmp_path):
    originals, _ = create_transaction_dataset(tmp_path)
    plan = create_split_plan(
        tmp_path,
        {"train": 0.8, "val": 0.1, "test": 0.1},
        gap_seconds=30,
        seed=42,
        image_extensions={".jpg"},
    )
    label = (
        tmp_path
        / "auto_improve/labels/train"
        / originals[0].with_suffix(".txt").name
    )
    label.write_text("0 0.4 0.4 0.1 0.1\n", encoding="utf-8")

    with pytest.raises(StalePlanError):
        apply_split_plan(tmp_path, plan["plan_id"])

    assert all(path.exists() for path in originals)


def test_apply_rolls_back_completed_moves_on_failure(tmp_path):
    originals, _ = create_transaction_dataset(tmp_path)
    plan = create_split_plan(
        tmp_path,
        {"train": 0.8, "val": 0.1, "test": 0.1},
        gap_seconds=30,
        seed=42,
        image_extensions={".jpg"},
    )
    calls = 0

    def fail_second_move(source, destination):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("injected move failure")
        return shutil.move(source, destination)

    with pytest.raises(SplitApplyError):
        apply_split_plan(
            tmp_path,
            plan["plan_id"],
            mover=fail_second_move,
        )

    assert all(path.exists() for path in originals)


def test_undo_restores_original_images_labels_and_duplicates(tmp_path):
    originals, duplicate = create_transaction_dataset(
        tmp_path,
        include_duplicate=True,
    )
    original_labels = [
        tmp_path
        / "auto_improve/labels/train"
        / path.with_suffix(".txt").name
        for path in originals
    ]
    plan = create_split_plan(
        tmp_path,
        {"train": 0.8, "val": 0.1, "test": 0.1},
        gap_seconds=30,
        seed=42,
        image_extensions={".jpg"},
    )
    applied = apply_split_plan(tmp_path, plan["plan_id"])

    result = undo_split_manifest(tmp_path, applied["manifest_id"])

    assert result["ok"] is True
    assert all(path.exists() for path in originals)
    assert all(path.exists() for path in original_labels)
    assert duplicate.exists()


def test_image_move_path_updates_registered_database_rows(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "aijin.db")
    db.init_db()
    project_id = db.project_create("split-test")
    old_path = "auto_improve/images/train/part.jpg"
    new_path = "auto_improve/images/val/part.jpg"
    db.image_upsert(project_id, old_path, "part.jpg", split="train")

    updated = db.image_move_path(old_path, new_path, "val")

    row = db.image_list(project_id)["images"][0]
    assert updated == 1
    assert row["path"] == new_path
    assert row["split"] == "val"
