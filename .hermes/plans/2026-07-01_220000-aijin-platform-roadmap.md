# Ai-JIN Platform — แผนพัฒนาระยะต่อไป (Full Stack Roadmap)

> **เป้าหมาย:** ยกระดับจาก Web App สำหรับ Object Detection สู่ **AI Platform ระดับอุตสาหกรรม** ที่รองรับทั้งสายการผลิตจริง, Data Pipeline, และ Deployment
>
> **บริบท:** Platform นี้จะเชื่อมกับ [PERSON_NAME] Production System (WebReport) และ AI Counting Camera — เป็นศูนย์กลาง AI Inference + Training ของโรงงาน
>
> **Tech Stack (ปัจจุบัน):** Flask + React 19 + Vite 8 + SQLite + YOLO26 + SAM2/3 + Docker + PostgreSQL + Label Studio

---

## Phase 1: Foundation & Data Pipeline (1-2 สัปดาห์)

> ปูพื้นฐานให้ Platform ใช้ได้จริง — Dataset, Authentication, Production DB

### Task 1.1: Dataset Bootstrapping & Auto-Improve Pipeline

**Objective:** สร้าง Data Pipeline เต็มรูปแบบ — Import → Auto-label → Review → Improve Loop

**Files:**
- Modify: `webapp/app.py` (เพิ่ม routes สำหรับ auto-improve pipeline)
- Modify: `webapp/db.py` (เพิ่ม tables: data_sources, auto_label_queue, improvement_logs)
- Create: `webapp/data_pipeline.py` (core pipeline logic)
- Modify: `webapp/frontend/src/pages/DataImport.jsx`
- Create: `webapp/frontend/src/pages/Pipeline.jsx` + `.css`
- Modify: `webapp/frontend/src/App.jsx` (เพิ่ม route)

**Key Features:**
- Batch import จากโฟลเดอร์ (support ภาพถ่ายกล้องวงจรปิด, ภาพจากสายการผลิต)
- Auto-label with multiple backends: YOLO, SAM2 (auto mask)
- Active Learning loop — สุ่มภาพที่ Model ไม่มั่นใจ (low confidence) ให้标注ก่อน
- Human-in-the-loop review queue (Label Studio [ADDRESS])
- Dataset versioning (snapshot ก่อน/หลัง auto-improve)

### Task 1.2: PostgreSQL Migration & Connection Pool

**Objective:** ย้ายจาก SQLite → PostgreSQL จริง (มีแล้วใน Docker stack)

**Files:**
- Modify: `webapp/db.py` (เปลี่ยน engine เป็น psycopg2 + [PERSON_NAME])
- Modify: `webapp/app.py` (เพิ่ม connection pool)
- Modify: `.env` (เพิ่ม DATABASE_URL)
- Modify: `docker-compose.yml` (เช็คว่า webapp connect postgres)
- Modify: `webapp/requirements.txt` (เพิ่ม psycopg2-binary, [PERSON_NAME])

**Migration Strategy:**
1. สร้าง migration script `scripts/migrate_sqlite_to_postgres.py`
2. Export SQLite → JSON/CSV
3. Import ไป PostgreSQL
4. เปลี่ยน connection string
5. Retire SQLite

**Key:**
- ใช้ connection pool (SQLAlchemy pool or psycopg2 [PERSON_NAME])
- WAL mode ใน PostgreSQL
- migration ต้อง zero-downtime (dual write หรือ cut-over)

### Task 1.3: Authentication & RBAC

**Objective:** ปิด API ด้วย JWT Auth และเพิ่ม Role-based access

**Files:**
- Create: `webapp/auth.py` (JWT encode/decode, decorator)
- Modify: `webapp/app.py` (เพิ่ม login/register endpoints, protect routes)
- Create: `webapp/frontend/src/pages/Login.jsx` + `.css`
- Modify: `webapp/frontend/src/components/Layout.jsx` (auth guard)
- Create: `webapp/frontend/src/context/AuthContext.jsx`
- Modify: `webapp/frontend/src/api/client.js` (attach JWT header)

**Roles:**
- `admin` — full access, user management
- `operator` — inference only, view dashboards
- `annotator` — dataset + annotation only
- `engineer` — training + model management

**Endpoints:**
- `POST /api/auth/login` → JWT
- `POST /api/auth/register` (admin only)
- `GET /api/auth/me`
- `POST /api/auth/refresh`

### Task 1.4: Config Management Move to PostgreSQL

**Objective:** ย้าย runtime config จาก global dict (`_runtime_cfg`) ไป PostgreSQL

**Files:**
- Create: `webapp/config_store.py`
- Modify: `webapp/app.py` (load/save config from DB)
- Modify: `webapp/frontend/src/pages/Settings.jsx`

**Why:** เมื่อมี multi-user, config ต้อง persist และ audit-able

---

## Phase 2: Industrial Real-Time Inference (2-3 สัปดาห์)

> ต่อกล้องจริง, Real-time counting, Alert สายการผลิต

### Task 2.1: RTSP/USB Camera Integration

**Objective:** รองรับกล้อง IP (RTSP/ONVIF) และ USB Camera สำหรับ Inference แบบ Real-time

**Files:**
- Create: `webapp/camera_manager.py` (จัดการ camera connection pool)
- Create: `webapp/stream_handler.py` (FFmpeg/OpenCV stream reader)
- Create: `webapp/inference_engine.py` (dedicated inference loop)
- Modify: `webapp/app.py` (เพิ่ม WebSocket endpoint สำหรับ stream)
- Modify: `webapp/requirements.txt` (เพิ่ม opencv-python, aiortc)
- Create: `webapp/frontend/src/pages/LiveStream.jsx` + `.css`
- Modify: `webapp/frontend/src/App.jsx`
- Create: `webapp/frontend/src/components/VideoPlayer.jsx`

**Architecture:**
```
Camera (RTSP) → FFmpeg/OpenCV → Frame Queue → YOLO Inference → WebSocket → Frontend
                                  ↓
                            Counting Logic → DB + LINE Alert
```

**Key decisions:**
- ใช้ background thread ต่อ camera (ไม่ block API)
- Frame buffer มี max size (drop old frames)
- Auto-reconnect เมื่อ camera disconnect
- รองรับหลาย camera พร้อมกัน

### Task 2.2: AI Counting & Zone Detection

**Objective:** ดึง Logic จาก AI Counting Camera Project มาอยู่ใน Platform

**Files:**
- Create: `webapp/counting/` (package)
  - `__init__.py`
  - `zone_counter.py` (นับวัตถุใน zone)
  - `line_counter.py` (นับวัตถุข้าม line — counting line)
  - `tracking.py` (ByteTrack/BOT-SORT tracker)
- Create: `webapp/counting/models.py` (Pydantic models)
- Modify: `webapp/app.py` (เพิ่ม counting endpoints)
- Create: `webapp/frontend/src/pages/CountingDashboard.jsx` + `.css`
- Modify: `webapp/frontend/src/api/client.js`

**Counting Features:**
- Virtual Zone (polygon) — count objects entering/exiting
- Counting Line — count objects crossing a line
- Shift-based counter (เชื่อมกับ production_event_db ใน WebReport)
- Store count events ใน PostgreSQL (product_id, shift, count, timestamp)

### Task 2.3: LINE Alert & Notification System

**Objective:** แจ้งเตือนเมื่อถึง threshold หรือ training เสร็จ

**Files:**
- Create: `webapp/notifications.py` (LINE Notify + LINE Messaging API)
- Create: `webapp/alert_rules.py` (rule engine — ถ้า count > threshold → alert)
- Modify: `webapp/app.py` (เพิ่ม endpoints: /api/alerts, /api/notifications/settings)
- Create: `webapp/frontend/src/pages/Alerts.jsx` + `.css`
- Modify: `webapp/frontend/src/App.jsx`

**Support multiple channels:**
- LINE Notify (simple token)
- LINE Messaging API (rich messages)
- Webhook (สำหรับ WebReport integration)

**Alert Rules:**
- Production threshold exceeded
- Training complete
- Model accuracy dropped (drift detection)
- Camera disconnected
- Error rate spike

### Task 2.4: WebReport Integration Bridge

**Objective:** เชื่อม Ai-JIN Platform กับ [PERSON_NAME] Production System (WebReport)

**Files:**
- Create: `webapp/integrations/webreport.py`
- Create: `webapp/integrations/__init__.py`
- Modify: `webapp/app.py` (mount integration routes)

**Integration Points:**
1. **Inference results → production_event_db** — ส่ง counting results ไป WebReport MySQL โดยตรง
2. **Dashboard embed** — WebReport dashboard แสดง real-time stats จาก Ai-JIN API
3. **Defect detection** — เมื่อ detect defect ส่งไป production_event_db.production_log
4. **API key auth** — WebReport ใช้ API key ที่ Ai-JIN Platform ให้

---

## Phase 3: Platform Maturity & Developer Experience (2-3 สัปดาห์)

> ทำ Platform ให้ Production-ready, จัดการทีม, CI/CD

### Task 3.1: CI/CD Pipeline

**Objective:** GitHub Actions สำหรับ test, lint, build, deploy

**Files:**
- Create: `.github/workflows/test.yml` — pytest + lint (oxlint)
- Create: `.github/workflows/build.yml` — frontend build + Docker image
- Create: `.github/workflows/deploy.yml` — deploy to production server

**Test Strategy:**
- Unit tests — pytest (ทุก PR)
- Integration tests — start Flask, test API (ทุก merge to master)
- E2E tests — Playwright (nightly)

### Task 3.2: Experiment Tracking (MLflow)

**Objective:** ติดตาม training runs, hyperparameters, metrics

**Files:**
- Create: `webapp/experiment_tracker.py`
- Modify: `webapp/app.py` (integrate training endpoint กับ MLflow)
- Create: `webapp/frontend/src/pages/Experiments.jsx` + `.css`
- Modify: `webapp/requirements.txt` (เพิ่ม mlflow)
- Modify: `docker-compose.yml` (เพิ่ม MLflow service + artifact store)

**Features:**
- Log params, metrics, artifacts (model weights, confusion matrix)
- Compare runs side-by-side
- Model registry (promote best run → staging → production)
- [PERSON_NAME] dashboard หรือใน UI ของ Platform เลย

### Task 3.3: [PERSON NAME] Data Export & Model Deployment Pipeline

**Objective:** Export โมเดลเป็น ONNX/TensorRT พร้อม deploy script

**Files:**
- Create: `webapp/exporter.py`
- Create: `scripts/export_onnx.sh`
- Create: `scripts/export_tensorrt.sh`
- Create: `scripts/deploy_edge.sh`
- Create: `webapp/frontend/src/pages/Deployment.jsx` + `.css`
- Modify: `webapp/app.py` (เพิ่ม export/deploy endpoints)

**Export Formats:**
- ONNX (CPU/GPU agnostic)
- TensorRT (NVIDIA GPU optimization)
- OpenVINO (Intel)
- [PERSON NAME] (Jetson, edge devices)
- CoreML (Apple)

**Deployment Targets:**
- Local Docker container
- Edge device (Jetson Nano, Raspberry Pi)
- REST API endpoint
- TensorRT Serving

### Task 3.4: WebSocket Realtime Updates

**Objective:** เปลี่ยนจาก HTTP polling เป็น WebSocket สำหรับ real-time data

**Files:**
- Create: `webapp/ws_handler.py` (Socket.IO or plain WebSocket)
- Modify: `webapp/app.py` (mount WebSocket)
- Modify: `webapp/frontend/src/api/client.js` (WebSocket client)
- Modify: `webapp/frontend/src/context/WebSocketContext.jsx`

**Replace polling with push for:**
- Training status / stream
- Inference results
- Camera status
- Alert notifications

---

## Phase 4: Advanced & Edge AI (3-4 สัปดาห์)

> Performance Optimization, AutoML, Edge Deployment

### Task 4.1: Model Quantization & Optimization

**Objective:** ทำโมเดลให้เล็ก เร็ว ใช้ GPU น้อยลง

**Files:**
- Create: `webapp/optimizer.py`
- Create: `webapp/quantizer.py`
- Modify: `webapp/frontend/src/pages/ModelManagement.jsx`

**Techniques:**
- FP16 quantization
- INT8 quantization (Post-Training Quantization)
- Pruning (remove unimportant weights)
- Knowledge Distillation (teacher YOLO26l → student YOLO26n)
- Layer fusion (TensorRT)

### Task 4.2: Active Learning & AutoML

**Objective:** ระบบที่เลือกเองว่าควรเพิ่ม data จุดไหน ทำ fine-tune เอง

**Files:**
- Create: `webapp/active_learning.py`
- Create: `webapp/automl.py`
- Modify: `webapp/frontend/src/pages/Training.jsx`

**Active Learning Strategies:**
- Uncertainty sampling (low confidence → high priority)
- [PERSON NAME] sampling (cluster embeddings → sample diverse)
- Expected Model Change

**AutoML:**
- [PERSON NAME] (hyperparameter tuning)
- Architecture search (YOLO26n vs YOLO26m vs YOLO26l)
- Auto augment strategies
- Learning rate finder

### Task 4.3: Distributed Training & Multi-GPU

**Objective:** รองรับ training ข้าม GPU หลายใบ

**Files:**
- Create: `webapp/distributed_trainer.py`
- Modify: `webapp/app.py` (add distributed training endpoint)
- Modify: `webapp/frontend/src/pages/Training.jsx`

**Approach:**
- DDP (DistributedDataParallel) สำหรับ multi-GPU
- Gradient accumulation สำหรับ large batch
- Mixed precision training (AMP) auto-enabled
- Horovod หรือ PyTorch DDP

### Task 4.4: [PERSON NAME] Dashboard & On-Device Inference

**Objective:** สร้าง Grafana Dashboard + เชื่อม Edge device

**Files:**
- Create: `docker/grafana/` (dashboard JSON, datasource config)
- Create: `docker/grafana/dashboards/inference-monitoring.json`
- Create: `webapp/edge_agent.py` (agent สำหรับส่ง data กลับ)
- Create: `scripts/deploy_jetpack.sh` (Jetson deployment script)

**Key:**
- ดึง metrics จาก PostgreSQL → Grafana
- [PERSON NAME] monitoring (inference latency, throughput, accuracy drift)
- Edge agent ส่ง heartbeat + metrics
- OTA update (push new model version to edge)

---

## Gantt Chart (ภาพรวม)

```
Week 1-2     ██ Phase 1: Foundation — Dataset, PostgreSQL, Auth
Week 3-5     ███ Phase 2: Industrial — Camera, Counting, LINE Alert
Week 6-8     ███ Phase 3: Maturity — CI/CD, MLflow, Export, WebSocket
Week 9-12    ████ Phase 4: Advanced — Quantization, AutoML, Distributed, Edge
```

## Architecture Evolution

**ปัจจุบัน:**
```
Browser → Flask API → SQLite / YOLO
                     → Label Studio (external)
                     → Docker (Postgres, LS, Webapp)
```

**หลัง Phase 2:**
```
Camera (RTSP) ─→ Inference Engine ─→ WebSocket ─→ Browser
                                      ↓
Browser ─→ Flask API ─→ PostgreSQL ←─→ WebReport (MySQL)
                     → YOLO Training (local/remote)
                     → LINE Notify
                     → Label Studio
                     → Ollama LLM
```

**หลัง Phase 4 (เต็มรูปแบบ):**
```
Camera ─→ Edge Device (TensorRT) ─→ MQTT ─→ Platform ─→ Grafana
                                              ↓
Browser ─→ Flask API ─→ PostgreSQL
                      → MLflow (experiment tracking)
                      → Model Registry (ONNX/TensorRT)
                      → Edge Agent (OTA update)
                      → LINE Alert
                      → WebReport Integration
```

## Key Metrics วัดผล

| Metric | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|---|---|---|---|---|
| Dataset size | ≥10K images | ≥50K images | ≥100K images | ≥500K images |
| Inference latency | <100ms | <50ms (GPU) | <30ms (TensorRT) | <10ms (Edge) |
| Concurrent cameras | 1 | 4 | 8 | 16+ |
| Multi-user | 1 | 5 | 20 | Unlimited (RBAC) |
| Training speed | 1 GPU | 1 GPU | 2-4 GPU (DDP) | 8+ GPU |
| Model size | ~44MB (FP16) | ~44MB | ~22MB (INT8) | ~11MB (pruned) |
| Alert latency | - | <5 sec | <2 sec | <1 sec |

---

## ความเสี่ยง & แนวทางลด

| ความเสี่ยง | ผลกระทบ | แนวทางลด |
|---|---|---|
| Dataset ไม่พอ/คุณภาพต่ำ | Model accuracy ต่ำ | ใช้ Auto-label + Active Learning ตั้งแต่ Phase 1 |
| Camera Protocol ไม่ Support | ไม่สามารถ connect ได้ | รองรับทั้ง RTSP, ONVIF, HTTP Stream, USB |
| GPU ไม่พอ (Production) | Inference latency สูง | TensorRT optimization + Edge device offload |
| PostgreSQL migration data loss | สูญเสียประวัติ training | ทดสอบ migration ใน dev ก่อน, backup SQLite |
| Multi-user complexity | Dev time เพิ่มขึ้น | ทำ Auth ครบใน Phase 1 เลย |

---

## เริ่มต้นที่ Task ไหนก่อน?

แนะนำเริ่มที่:
1. **Phase 1 Task 1.3 (Auth)** — เป็น Base ของทุกอย่างที่ต้องแยก user
2. **Phase 2 Task 2.1 (Camera)** — ถ้าต้องการใช้งานจริงกับสายผลิต
3. **หรือทำพร้อมกัน** — แยก branch: `feature/auth` + `feature/camera-stream`

คุณอาร์มอยากให้เริ่ม Phase 1 เลย หรือมี Feature ไหนที่อยาก Prioritize เป็นพิเศษ?