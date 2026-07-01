# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ai-JIN Platform is a single web app for the full YOLO object-detection lifecycle: data import, annotation, auto-labeling, training, model registry/deployment, and live inference. A Flask API (`webapp/app.py`) backs a React + Vite SPA (`webapp/frontend/`). It orchestrates two external services — **Label Studio** (annotation) and an optional **YOLO training server** — and falls back to running Ultralytics YOLO in-process when they are absent. Much of the UI text is Thai.

## Commands

Backend (from repo root):
```bash
python webapp/app.py                          # dev server on :8501 (Flask, debug off)
gunicorn --bind 0.0.0.0:8501 app:app          # prod (run from webapp/); how Docker starts it
```

Frontend (from `webapp/frontend/`):
```bash
npm run dev        # Vite dev server on :5173, proxies /api/* -> :8501
npm run build      # builds into ../static (served by Flask in prod)
npm run lint       # oxlint
```

Tests (from `webapp/`):
```bash
pytest tests/                                  # all
pytest tests/test_inference_api.py -v          # one file
pytest tests/test_inference_api.py::test_predict_local_accepts_frontend_file_field_and_returns_inference_contract
```
Two distinct test styles live side by side:
- **Unit tests** (`test_inference_api.py`, `test_local_training_api.py`, `test_data_export_api.py`, `test_sam3_api.py`) run standalone. They `importlib.reload` the `app` module under `monkeypatch.setenv` for paths and stub heavy deps (`ultralytics`, `cv2`) via `monkeypatch.setitem(sys.modules, ...)`. No running server needed.
- **Integration tests** (`test_webapp_api.py`) hit a live server at `AIJIN_TEST_BASE_URL` (default `http://localhost:8501`) — start the backend first.

Docker (full stack: Postgres + Label Studio + webapp):
```bash
docker compose up -d
```

## Architecture

**Serving model.** Flask serves both the JSON API and the built SPA. `/` and known client routes (see `SPA_ROUTES` in `app.py`) return `static/index.html`; everything under `/api/*` is the backend. The frontend always calls `/api` (see `webapp/frontend/src/api/client.js`) — in dev, Vite proxies that to `:8501`; in prod it's same-origin. Vite `base` is `/static/` and it builds to `webapp/static/`, so **rebuild the frontend after UI changes** or prod serves stale assets. The `api` object in `client.js` is the single source of truth for every endpoint the UI uses — keep it in sync with `app.py` routes.

**Remote-with-local-fallback pattern (central design idea).** Compute-heavy operations try an external service and degrade gracefully:
- *Inference:* `/api/predict` proxies to the YOLO server (`yolo_post`); `/api/predict/local` runs Ultralytics in-process. The frontend chooses.
- *Training:* `/api/train/start` health-checks the YOLO server; if offline it calls `_start_local_training`, which runs `YOLO(...).train(...)` on a background `threading.Thread` and copies the resulting `best.pt` into `MODEL_DIR`. Progress is polled via `/api/train/status` / streamed via `/api/train/stream`.
- Ultralytics/cv2 are imported lazily inside route handlers so the app boots (and unit tests run) without them installed.

**Long-running jobs** use module-level state dicts guarded by locks and mutated from daemon threads: `_local_train_state`/`_local_train_lock` (training) and `_video_label_state`/`_video_label_lock` (video auto-label). Status endpoints return snapshots. There is no job queue — a given job type runs one at a time, enforced by a status check under the lock.

**Persistence.** `webapp/db.py` is a thin SQLite layer (`aijin.db`, WAL mode, no ORM) accessed through the `get_db()` context manager. Tables: projects, classes, images, annotations, runs, models (registry), activity. `_db.init_db()` runs at import time so it works under both `python app.py` and gunicorn. Business logic lives in `app.py`; `db.py` is CRUD helpers only. Label data is stored **both** in SQLite and as YOLO-format `.txt` files on disk (dataset dir) — writes must keep the two consistent.

**Configuration** is env-var driven with Windows-style default paths (`D:\...`); override via `.env` (`DATASET_PATH`, `RUNS_PATH`, `MODEL_PATH`) and service vars (`LABEL_STUDIO_URL`, `LABEL_STUDIO_TOKEN`, `YOLO_TRAIN_URL`, `OLLAMA_URL`, `OLLAMA_MODEL`). Several settings are **runtime-mutable without restart** via `POST /api/config`, which rebinds module globals (`DATASET`, `MODEL_DIR`, `YOLO_URL`, `OLLAMA_*`) and caches overrides in `_runtime_cfg`. Because paths are mutable globals, read them through the module-level names rather than capturing copies.

**Path safety.** Any endpoint resolving a user-supplied path must go through `_safe_path(base, user_path)`, which resolves under `base` and `abort(403)`s on traversal. Follow this for new file-serving/label routes.

**Class-name remapping.** Models emit generic labels (`class_0`, …). `_load_class_name_map()` reads `<DATASET>/auto_improve/class_mapping.json` (`model_to_class_id`) and `_remap_class_name()` swaps in real part names in both inference paths. Apply the same remap when adding detection outputs.

**Segmentation / assistants.** SAM2/SAM3 endpoints (`/api/sam/predict`, `/api/sam3/predict`) provide point/box-prompted masks with a predictor cache; SAM3 needs a special install (see `SAM3_INSTALL_HINT`). `/api/lm/*` proxies an Ollama LLM (chat + SSE streaming) for the in-UI assistant.

**Frontend layout.** `App.jsx` defines routes; each page in `src/pages/` maps to one workflow (Dashboard, LiveDemo, Dataset, Annotator, DataImport, Training, ModelManagement, Projects, Settings, ApiDocs) with a co-located `.css`. `components/Layout.jsx` is the nav shell; `components/LMAssistant.jsx` is the LLM widget.

## Gotchas

- The committed `models/` weights, `sam_b.pt`, and `webapp/sam2_*.pt` are large binaries; `.gitignore` excludes `*.pt` generally, so weights are usually untracked.
- `webapp/static/assets/` holds built JS/CSS with content-hashed names — these change on every `npm run build`; don't hand-edit them.
- Default paths are Windows (`D:\`); on Linux/Docker they're remapped via env (`/dataset`, `/runs`, `/models`).
