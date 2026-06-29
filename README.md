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
