"""
Ai-JIN V10.0 Webapp API Tests
==============================
Integration tests for the Flask webapp REST API.
Requires the webapp to be running at http://localhost:8501.

Run with:
    pytest docker/webapp/tests/test_webapp_api.py -v
"""

import pytest
import requests
import os
import io

BASE = os.environ.get("AIJIN_TEST_BASE_URL", "http://localhost:8501")


# ── Helpers ──────────────────────────────────────────────────────────

def get(path, **kwargs):
    return requests.get(f"{BASE}{path}", timeout=10, **kwargs)


def post(path, **kwargs):
    return requests.post(f"{BASE}{path}", timeout=30, **kwargs)


# ── Stats ────────────────────────────────────────────────────────────

class TestStats:
    def test_stats_returns_ok(self):
        r = get("/api/stats")
        assert r.status_code == 200
        d = r.json()
        assert "total_images" in d or "dataset" in d

    def test_stats_contains_dataset_section(self):
        r = get("/api/stats")
        d = r.json()
        assert "dataset" in d
        ds = d["dataset"]
        assert "total_images" in ds
        assert "total_labels" in ds
        assert "classes" in ds

    def test_stats_contains_training_section(self):
        r = get("/api/stats")
        d = r.json()
        assert "training" in d
        tr = d["training"]
        assert "runs" in tr
        assert "yolo_status" in tr

    def test_stats_contains_label_studio_section(self):
        r = get("/api/stats")
        d = r.json()
        assert "label_studio" in d


# ── Images ───────────────────────────────────────────────────────────

class TestImages:
    def test_list_images(self):
        r = get("/api/images", params={"dir": "auto_improve/images", "per_page": 5})
        assert r.status_code == 200
        d = r.json()
        assert "images" in d
        assert "total" in d
        assert "page" in d
        assert "pages" in d

    def test_list_images_pagination(self):
        r = get("/api/images", params={"dir": "auto_improve/images", "per_page": 2, "page": 1})
        assert r.status_code == 200
        d = r.json()
        assert d["page"] == 1
        assert isinstance(d["images"], list)

    def test_list_images_empty_dir(self):
        r = get("/api/images", params={"dir": "nonexistent_dir_12345", "per_page": 5})
        assert r.status_code == 200
        d = r.json()
        assert d["total"] == 0 or "images" in d


# ── Path Traversal Security ─────────────────────────────────────────

class TestPathTraversal:
    def test_image_traversal_blocked(self):
        r = get("/api/image/../../etc/passwd")
        assert r.status_code in (403, 404, 400)

    def test_label_traversal_blocked(self):
        r = get("/api/label/../../etc/passwd")
        assert r.status_code in (403, 404, 400)

    def test_image_traversal_dotdot_encoded(self):
        r = get("/api/image/%2e%2e/%2e%2e/etc/passwd")
        assert r.status_code in (403, 404, 400)

    def test_image_traversal_backslash(self):
        r = get("/api/image/..\\..\\etc\\passwd")
        assert r.status_code in (403, 404, 400)

    def test_folders_traversal_blocked(self):
        r = get("/api/images", params={"dir": "../../etc"})
        # Should either block or return empty, not leak system files
        if r.status_code == 200:
            d = r.json()
            assert d.get("total", 0) == 0 or "error" in d


# ── Folders ──────────────────────────────────────────────────────────

class TestFolders:
    def test_list_folders(self):
        r = get("/api/folders")
        assert r.status_code == 200
        d = r.json()
        assert "folders" in d
        assert isinstance(d["folders"], list)

    def test_folder_items_have_path_and_count(self):
        r = get("/api/folders")
        d = r.json()
        for folder in d.get("folders", []):
            assert "path" in folder
            assert "count" in folder


# ── Models ───────────────────────────────────────────────────────────

class TestModels:
    def test_list_models(self):
        r = get("/api/models")
        assert r.status_code == 200
        d = r.json()
        assert "active" in d
        assert "models" in d

    def test_models_active_has_fields(self):
        r = get("/api/models")
        d = r.json()
        active = d["active"]
        assert "active_model" in active

    def test_models_list_is_array(self):
        r = get("/api/models")
        d = r.json()
        assert isinstance(d["models"], list)


# ── Import ───────────────────────────────────────────────────────────

class TestImport:
    def test_list_classes(self):
        r = get("/api/import/classes")
        assert r.status_code == 200
        d = r.json()
        assert "classes" in d
        assert isinstance(d["classes"], list)

    def test_split_info(self):
        r = get("/api/import/split-info")
        assert r.status_code == 200
        d = r.json()
        assert "train" in d
        assert "val" in d

    def test_split_info_has_totals(self):
        r = get("/api/import/split-info")
        d = r.json()
        assert "total" in d["train"]
        assert "total" in d["val"]

    def test_generate_yaml(self):
        r = post("/api/import/generate-yaml",
                 json={},
                 headers={"Content-Type": "application/json"})
        assert r.status_code == 200
        d = r.json()
        # Should either succeed or report an error gracefully
        assert "ok" in d or "error" in d or "yaml" in d


# ── Predict ──────────────────────────────────────────────────────────

class TestPredict:
    def test_predict_no_image(self):
        r = post("/api/predict/local")
        assert r.status_code == 200
        d = r.json()
        assert "error" in d

    def test_predict_post_method(self):
        r = post("/api/predict")
        # Without an image, should return error or 400
        assert r.status_code in (200, 400)
        d = r.json()
        if r.status_code == 200:
            assert "error" in d or "detections" in d

    def test_predict_with_invalid_conf(self):
        """Predict with out-of-range confidence should handle gracefully."""
        form = {"conf": "2.0", "iou": "0.45", "imgsz": "640"}
        r = post("/api/predict/local", data=form)
        assert r.status_code in (200, 400)


# ── Labels ───────────────────────────────────────────────────────────

class TestLabels:
    def test_label_nonexistent_image(self):
        r = get("/api/label/nonexistent_image_xyz.jpg")
        assert r.status_code == 200
        d = r.json()
        # Should indicate no labels exist
        assert d.get("exists") is False or "labels" in d

    def test_save_label_missing_data(self):
        r = post("/api/label/save",
                 json={},
                 headers={"Content-Type": "application/json"})
        # Should return error for missing required fields
        assert r.status_code in (200, 400)
        d = r.json()
        if r.status_code == 200:
            assert "error" in d or "ok" in d


# ── Train Status ─────────────────────────────────────────────────────

class TestTrainStatus:
    def test_train_status(self):
        r = get("/api/train/status")
        assert r.status_code == 200
        d = r.json()
        assert "status" in d


# ── Deploy ───────────────────────────────────────────────────────────

class TestDeploy:
    def test_deploy_missing_source(self):
        r = post("/api/models/deploy",
                 json={},
                 headers={"Content-Type": "application/json"})
        assert r.status_code in (200, 400)
        d = r.json()
        assert "error" in d or "ok" in d

    def test_deploy_nonexistent_model(self):
        r = post("/api/models/deploy",
                 json={"source": "/nonexistent/model.pt"},
                 headers={"Content-Type": "application/json"})
        assert r.status_code in (200, 400, 404)
        d = r.json()
        assert "error" in d


# ── Export ───────────────────────────────────────────────────────────

class TestExport:
    def test_export_missing_model(self):
        r = post("/api/train/export",
                 json={"format": "onnx"},
                 headers={"Content-Type": "application/json"})
        assert r.status_code in (200, 400)
        d = r.json()
        assert "error" in d or "status" in d


# ── HTML Pages ───────────────────────────────────────────────────────

class TestHTMLPages:
    def test_index_page_loads(self):
        r = get("/")
        assert r.status_code == 200
        assert "Ai-JIN" in r.text

    def test_index_contains_thai_text(self):
        r = get("/")
        assert r.status_code == 200
        assert "แดชบอร์ด" in r.text

    def test_index_content_type(self):
        r = get("/")
        assert "text/html" in r.headers.get("Content-Type", "")
