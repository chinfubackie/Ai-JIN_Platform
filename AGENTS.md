## Imported Claude Cowork project instructions

Refer to `CLAUDE.md` for architecture, commands, and gotchas. Below are OpenCode-specific additions and corrections.

## Commands (quick reference)

| Where | What |
|---|---|
| repo root | `python webapp/app.py` — Flask dev on `:8501` |
| `webapp/frontend/` | `npm run dev` — Vite on `:5173`, proxies `/api/*` → `:8501` |
| `webapp/frontend/` | `npm run build` — builds into `webapp/static/` (served by Flask in prod) |
| `webapp/frontend/` | `npm run lint` — oxlint (only frontend linter) |
| `webapp/` | `pytest tests/` — all tests |
| `webapp/` | `pytest tests/test_inference_api.py::test_something -v` — single test |

## Tests — two styles coexist

- **Unit tests** (`test_inference_api.py`, `test_local_training_api.py`, `test_data_export_api.py`, `test_sam3_api.py`): run standalone via `importlib.reload` + `monkeypatch.setenv` for paths, stub heavy deps (`ultralytics`, `cv2`) with `monkeypatch.setitem(sys.modules, ...)`. No server running.
- **Integration tests** (`test_webapp_api.py`): hit `AIJIN_TEST_BASE_URL` (default `http://localhost:8501`). Start the backend first.

## Architecture essentials

- **No backend lint or typecheck.** Only oxlint for frontend. No `pyproject.toml`, `ruff.toml`, or `Makefile`.
- **SQLite + YOLO labels must stay consistent.** Business data in `aijin.db` (via `db.py` CRUD), YOLO-format `.txt` files on disk — writes touch both.
- **Path safety.** Any endpoint resolving a user-supplied path must use `_safe_path(base, user_path)` (traversal → `abort(403)`). Class-name remapping uses `_remap_class_name()` — apply to both inference paths when adding detection output.
- **Config is runtime-mutable.** `POST /api/config` rebinds module globals (`DATASET`, `MODEL_DIR`, `YOLO_URL`, `OLLAMA_*`) without restart. Read them through module-level names, not captured copies.
- **Default paths are Windows (`D:\...`).** On Linux/Docker, override via `.env` (`DATASET_PATH`, `RUNS_PATH`, `MODEL_PATH`).
- **Rebuild frontend after UI changes** (`npm run build` from `webapp/frontend/`). Prod serves from `webapp/static/` — stale otherwise.
- **Docker gotcha:** PyTorch training in container needs `shm_size: 2gb` (set in `docker-compose.yml`). Without it, `No space left on device` on `/dev/shm`.
- **Ultralytics/cv2 imported lazily** inside route handlers — app boots without them installed.
- **No CI/CD yet.** Roadmap has it planned, not implemented.
