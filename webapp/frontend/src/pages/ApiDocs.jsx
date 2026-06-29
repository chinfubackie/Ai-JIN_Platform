import { useState } from 'react'
import { BookOpen, Copy, Check, Code2 } from 'lucide-react'
import './ApiDocs.css'

const ENDPOINTS = [
  { method: 'GET',  path: '/api/stats',         desc: 'สถิติระบบ' },
  { method: 'POST', path: '/api/predict',        desc: 'ตรวจจับวัตถุ' },
  { method: 'POST', path: '/api/predict/local',  desc: 'ตรวจจับวัตถุจากไฟล์' },
  { method: 'GET',  path: '/api/models',         desc: 'รายการโมเดล' },
  { method: 'POST', path: '/api/models/deploy',  desc: 'ใช้งานโมเดล' },
  { method: 'POST', path: '/api/train/start',    desc: 'เริ่มเทรนโมเดล' },
  { method: 'GET',  path: '/api/train/status',   desc: 'สถานะการเทรน' },
  { method: 'GET',  path: '/api/folders',        desc: 'โฟลเดอร์ข้อมูล' },
  { method: 'GET',  path: '/api/images',         desc: 'รายการภาพ' },
]

const CODE_EXAMPLES = {
  Python: {
    '/api/stats': `import requests

# ดึงสถิติระบบ
response = requests.get("http://localhost:8000/api/stats")
data = response.json()
print(f"ภาพทั้งหมด: {data['total_images']}")
print(f"คลาส: {data['classes']}")`,

    '/api/predict': `import requests

# ตรวจจับวัตถุจาก URL
response = requests.post(
    "http://localhost:8000/api/predict",
    data={"url": "https://example.com/image.jpg"},
)
results = response.json()
for det in results.get("detections", []):
    print(f"{det['class']}: {det['confidence']:.2f}")`,

    '/api/predict/local': `import requests

# ตรวจจับวัตถุจากไฟล์
with open("image.jpg", "rb") as f:
    response = requests.post(
        "http://localhost:8000/api/predict/local",
        files={"file": f},
    )
results = response.json()
print(results)`,

    '/api/models': `import requests

# ดึงรายการโมเดล
response = requests.get("http://localhost:8000/api/models")
models = response.json()
for model in models:
    status = "ใช้งาน" if model["active"] else "พร้อม"
    print(f"{model['name']} - {status}")`,

    '/api/models/deploy': `import requests

# ติดตั้งโมเดล
response = requests.post(
    "http://localhost:8000/api/models/deploy",
    json={"model_path": "/models/best.pt"},
)
print(response.json())`,

    '/api/train/start': `import requests

# เริ่มเทรนโมเดล
config = {
    "epochs": 100,
    "batch_size": 16,
    "imgsz": 640,
}
response = requests.post(
    "http://localhost:8000/api/train/start",
    json={"config": config},
)
print(response.json())`,

    '/api/train/status': `import requests

# ตรวจสอบสถานะการเทรน
response = requests.get("http://localhost:8000/api/train/status")
status = response.json()
print(f"สถานะ: {status}")`,

    '/api/folders': `import requests

# ดึงรายการโฟลเดอร์
response = requests.get("http://localhost:8000/api/folders")
folders = response.json()
for folder in folders:
    print(folder)`,

    '/api/images': `import requests

# ดึงรายการภาพ
response = requests.get(
    "http://localhost:8000/api/images",
    params={"dir": "train/images", "page": 1, "per_page": 60},
)
data = response.json()
print(f"จำนวนภาพ: {len(data)}")`,
  },

  cURL: {
    '/api/stats': `# ดึงสถิติระบบ
curl -X GET http://localhost:8000/api/stats`,

    '/api/predict': `# ตรวจจับวัตถุจาก URL
curl -X POST http://localhost:8000/api/predict \\
  -F "url=https://example.com/image.jpg"`,

    '/api/predict/local': `# ตรวจจับวัตถุจากไฟล์
curl -X POST http://localhost:8000/api/predict/local \\
  -F "file=@image.jpg"`,

    '/api/models': `# ดึงรายการโมเดล
curl -X GET http://localhost:8000/api/models`,

    '/api/models/deploy': `# ติดตั้งโมเดล
curl -X POST http://localhost:8000/api/models/deploy \\
  -H "Content-Type: application/json" \\
  -d '{"model_path": "/models/best.pt"}'`,

    '/api/train/start': `# เริ่มเทรนโมเดล
curl -X POST http://localhost:8000/api/train/start \\
  -H "Content-Type: application/json" \\
  -d '{"config": {"epochs": 100, "batch_size": 16}}'`,

    '/api/train/status': `# ตรวจสอบสถานะการเทรน
curl -X GET http://localhost:8000/api/train/status`,

    '/api/folders': `# ดึงรายการโฟลเดอร์
curl -X GET http://localhost:8000/api/folders`,

    '/api/images': `# ดึงรายการภาพ
curl -X GET "http://localhost:8000/api/images?dir=train/images&page=1&per_page=60"`,
  },

  JavaScript: {
    '/api/stats': `// ดึงสถิติระบบ
const response = await fetch("/api/stats");
const data = await response.json();
console.log("ภาพทั้งหมด:", data.total_images);
console.log("คลาส:", data.classes);`,

    '/api/predict': `// ตรวจจับวัตถุจาก URL
const formData = new FormData();
formData.append("url", "https://example.com/image.jpg");

const response = await fetch("/api/predict", {
  method: "POST",
  body: formData,
});
const results = await response.json();
console.log(results);`,

    '/api/predict/local': `// ตรวจจับวัตถุจากไฟล์
const input = document.querySelector("input[type=file]");
const formData = new FormData();
formData.append("file", input.files[0]);

const response = await fetch("/api/predict/local", {
  method: "POST",
  body: formData,
});
const results = await response.json();
console.log(results);`,

    '/api/models': `// ดึงรายการโมเดล
const response = await fetch("/api/models");
const models = await response.json();
models.forEach(m => {
  console.log(m.name, m.active ? "(ใช้งาน)" : "(พร้อม)");
});`,

    '/api/models/deploy': `// ติดตั้งโมเดล
const response = await fetch("/api/models/deploy", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model_path: "/models/best.pt" }),
});
const result = await response.json();
console.log(result);`,

    '/api/train/start': `// เริ่มเทรนโมเดล
const config = {
  epochs: 100,
  batch_size: 16,
  imgsz: 640,
};
const response = await fetch("/api/train/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ config }),
});
console.log(await response.json());`,

    '/api/train/status': `// ตรวจสอบสถานะการเทรน
const response = await fetch("/api/train/status");
const status = await response.json();
console.log("สถานะ:", status);`,

    '/api/folders': `// ดึงรายการโฟลเดอร์
const response = await fetch("/api/folders");
const folders = await response.json();
console.log(folders);`,

    '/api/images': `// ดึงรายการภาพ
const params = new URLSearchParams({
  dir: "train/images",
  page: 1,
  per_page: 60,
});
const response = await fetch("/api/images?" + params);
const data = await response.json();
console.log(data);`,
  },
}

const TABS = ['Python', 'cURL', 'JavaScript']

export default function ApiDocs() {
  const [activeTab, setActiveTab] = useState('Python')
  const [selectedEndpoint, setSelectedEndpoint] = useState(ENDPOINTS[0].path)
  const [copied, setCopied] = useState(false)

  const currentEndpoint = ENDPOINTS.find(e => e.path === selectedEndpoint)
  const code = CODE_EXAMPLES[activeTab]?.[selectedEndpoint] || '// ไม่มีตัวอย่าง'

  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">เอกสาร API</h1>
      </div>

      {/* Endpoint list */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-title">
          <BookOpen size={18} /> รายการ Endpoint ทั้งหมด
        </div>
        <div className="endpoint-list">
          {ENDPOINTS.map(ep => (
            <div
              key={ep.path}
              className={`endpoint-item${selectedEndpoint === ep.path ? ' selected' : ''}`}
              onClick={() => setSelectedEndpoint(ep.path)}
            >
              <span className={`method-badge method-${ep.method.toLowerCase()}`}>
                {ep.method}
              </span>
              <span className="endpoint-path">{ep.path}</span>
              <span className="endpoint-desc">{ep.desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Code examples */}
      <div className="card">
        <div className="card-title">
          <Code2 size={18} /> ตัวอย่างโค้ด — {currentEndpoint?.desc}
        </div>

        <div className="api-tabs">
          {TABS.map(tab => (
            <button
              key={tab}
              className={`api-tab${activeTab === tab ? ' active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="endpoint-detail">
          <div className="endpoint-detail-header">
            <span className={`method-badge method-${currentEndpoint?.method.toLowerCase()}`}>
              {currentEndpoint?.method}
            </span>
            <h3>{currentEndpoint?.path}</h3>
            <span style={{ color: 'var(--text-secondary)', fontSize: 14, marginLeft: 'auto' }}>
              {currentEndpoint?.desc}
            </span>
          </div>

          <div className="code-block">
            <div className="code-block-header">
              <span>{activeTab}</span>
              <button className="copy-btn" onClick={handleCopy}>
                {copied ? <><Check size={12} /> คัดลอกแล้ว</> : <><Copy size={12} /> คัดลอก</>}
              </button>
            </div>
            <pre><code>{code}</code></pre>
          </div>
        </div>
      </div>
    </div>
  )
}
