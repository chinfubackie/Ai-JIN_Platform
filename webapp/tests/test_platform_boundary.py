from pathlib import Path


PLATFORM_ROOT = Path(__file__).resolve().parents[2]


def test_webapp_runtime_defaults_stay_inside_platform_workspace():
    source = (PLATFORM_ROOT / "webapp" / "app.py").read_text(encoding="utf-8")

    assert "Ai-JIN_V10.0_patch_output" not in source
    assert 'PLATFORM_ROOT / "dataset"' in source
    assert 'PLATFORM_ROOT / "runs"' in source
    assert 'PLATFORM_ROOT / "models"' in source


def test_platform_compose_keeps_label_studio_batch_limit():
    source = (PLATFORM_ROOT / "docker-compose.yml").read_text(encoding="utf-8")

    assert "label-studio:" in source
    assert '"8085:8080"' in source
    assert "DATA_UPLOAD_MAX_NUMBER_FILES: 2000" in source
