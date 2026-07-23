# Ai-JIN Platform

Web-based annotation + training dashboard สำหรับ YOLO object detection

## Structure

```
D:\Ai-JIN_Platform\
├── webapp/
│   ├── app.py          ← Flask API (port 8501)
│   └── frontend/       ← React + Vite (port 5173)
├── dataset/            ← auto_improve/images/train|val|test/
├── runs/               ← YOLO training outputs
├── models/             ← deployed model weights (.pt)
└── .claude/
    └── launch.json     ← dev server configs
```

## Start

```bash
# Terminal 1 — Flask API
cd D:\Ai-JIN_Platform
python webapp/app.py

# Terminal 2 — Frontend dev server
cd D:\Ai-JIN_Platform\webapp\frontend
npm run dev
```

Open http://localhost:5173

## Deploy บนเครื่อง server (Docker Compose)

โปรเจคนี้ deploy ผ่าน `docker-compose.yml` (Postgres + Label Studio + webapp) โดยรันคำสั่งทั้งหมดจาก root ของ repo บนเครื่อง Linux server

**Prerequisites**
- Docker Engine + Docker Compose plugin (`docker compose version`)
- (ถ้าเครื่องมี GPU และต้องการเทรน/inference ผ่าน GPU) NVIDIA driver + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)

**ขั้นตอน**

```bash
git clone <repo-url> aijin-platform
cd aijin-platform

# 1) ตั้งค่า environment
cp .env.example .env
# แก้ DATASET_PATH / RUNS_PATH / MODEL_PATH ให้เป็น absolute path บนเครื่อง server
# เช่น /srv/aijin/dataset, /srv/aijin/runs, /srv/aijin/models

# 2) build frontend (Docker build ของ webapp ไม่ build React ให้ ต้อง build ก่อนแล้ว commit/copy
#    webapp/static เข้าไปเอง — ดูหัวข้อ "Rebuild frontend" ด้านล่าง)
cd webapp/frontend
npm ci
npm run build
cd ../..

# 3) ขึ้น stack (ไม่มี GPU)
docker compose up -d --build

# ถ้าเครื่องมี GPU ให้ใช้ override นี้แทน:
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

**ตรวจสอบว่าขึ้นสำเร็จ**

```bash
curl http://localhost:8501/healthz        # webapp -> {"ok": true}
curl http://localhost:8085/health         # Label Studio
docker compose ps
docker compose logs -f webapp
```

เปิด `http://<server-ip>:8501` เพื่อใช้งาน UI จริง (Flask serve ทั้ง API และ SPA ที่ build แล้วจาก `webapp/static`)

**Rebuild frontend หลังแก้ UI**

`webapp/static/` ถูก commit เข้า git และเป็นสิ่งที่ Docker image ใช้ตรงๆ (ไม่มี Node build stage ใน Dockerfile) ดังนั้นทุกครั้งที่แก้โค้ด frontend ต้อง:

```bash
cd webapp/frontend && npm run build
```

แล้ว commit `webapp/static/` ก่อน deploy ใหม่ (หรือ build ทับบนเครื่อง server ก่อนสั่ง `docker compose up -d --build`)

**Volumes ที่ต้อง backup**

| Volume/Path | เก็บอะไร |
|---|---|
| `${DATASET_PATH}` | รูปภาพ + label (.txt) ของ dataset |
| `${RUNS_PATH}` | ผลลัพธ์การเทรน YOLO |
| `${MODEL_PATH}` | โมเดล `.pt` ที่ deploy แล้ว |
| docker volume `aijin_db_data` (`/data/aijin.db` ใน container, ควบคุมด้วย `AIJIN_DB_PATH`) | SQLite metadata (projects/classes/images/annotations/runs/models) |
| docker volume `postgres_data` | ฐานข้อมูล Label Studio |
| docker volume `label_studio_data` | ไฟล์แนบ/media ของ Label Studio |

Backup ตัวอย่าง: `docker run --rm -v aijin_db_data:/data -v $(pwd)/backup:/backup alpine cp /data/aijin.db /backup/`
