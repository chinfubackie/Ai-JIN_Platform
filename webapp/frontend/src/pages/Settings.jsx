import { useState, useEffect } from 'react'
import { api } from '../api/client'
import { Save, RotateCcw, Server, Database, Cpu, FolderOpen } from 'lucide-react'
import './Settings.css'

const DEFAULT_SETTINGS = {
  ollama_url: 'http://192.168.93:11434',
  ollama_model: 'llava',
  sam_model: 'sam2_b.pt',
  dataset_path: '/dataset/auto_improve',
  model_dir: '/runs/models',
  yolo_url: 'http://yolo-train:8080',
}

const LS_KEY = 'aijin_settings'

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export default function Settings() {
  const [form, setForm] = useState(loadSettings)
  const [saved, setSaved] = useState(false)
  const [projects, setProjects] = useState([])
  const [selectedProject, setSelectedProject] = useState('')
  const [datasetDir, setDatasetDir] = useState('')
  const [syncMsg, setSyncMsg] = useState('')
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    api.projects().then(data => {
      setProjects(Array.isArray(data) ? data : [])
    }).catch(() => {})
  }, [])

  function set(key, val) {
    setForm(f => ({ ...f, [key]: val }))
    setSaved(false)
  }

  function save() {
    localStorage.setItem(LS_KEY, JSON.stringify(form))
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function reset() {
    setForm({ ...DEFAULT_SETTINGS })
    localStorage.removeItem(LS_KEY)
    setSaved(false)
  }

  async function syncProject() {
    if (!selectedProject) return
    setSyncing(true)
    setSyncMsg('')
    try {
      if (datasetDir) {
        await api.projectUpdate(parseInt(selectedProject), { dataset_dir: datasetDir })
      }
      const res = await api.projectSync(parseInt(selectedProject))
      setSyncMsg(`Sync สำเร็จ: ${res.synced ?? 0} ภาพ`)
    } catch {
      setSyncMsg('Sync ไม่สำเร็จ')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h1 className="page-title">ตั้งค่าระบบ</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline" onClick={reset} title="รีเซ็ตเป็นค่าเริ่มต้น">
            <RotateCcw size={15} /> รีเซ็ต
          </button>
          <button className={`btn ${saved ? 'btn-success' : 'btn-primary'}`} onClick={save}>
            <Save size={15} /> {saved ? 'บันทึกแล้ว ✓' : 'บันทึก'}
          </button>
        </div>
      </div>

      <div className="settings-grid">

        {/* Ollama / LM */}
        <section className="settings-card">
          <div className="settings-card-title"><Server size={16} /> Ollama LLM</div>
          <div className="settings-field">
            <label>URL</label>
            <input
              value={form.ollama_url}
              onChange={e => set('ollama_url', e.target.value)}
              placeholder="http://192.168.x.x:11434"
            />
          </div>
          <div className="settings-field">
            <label>Model</label>
            <input
              value={form.ollama_model}
              onChange={e => set('ollama_model', e.target.value)}
              placeholder="llava"
            />
          </div>
        </section>

        {/* SAM */}
        <section className="settings-card">
          <div className="settings-card-title"><Cpu size={16} /> SAM Model</div>
          <div className="settings-field">
            <label>Model</label>
            <select value={form.sam_model} onChange={e => set('sam_model', e.target.value)}>
              <option value="sam2_b.pt">SAM2 Base</option>
              <option value="sam2_s.pt">SAM2 Small</option>
              <option value="sam2_l.pt">SAM2 Large</option>
              <option value="sam_b.pt">SAM Base (v1)</option>
            </select>
          </div>
        </section>

        {/* Paths */}
        <section className="settings-card">
          <div className="settings-card-title"><FolderOpen size={16} /> Paths</div>
          <div className="settings-field">
            <label>Dataset Path</label>
            <input
              value={form.dataset_path}
              onChange={e => set('dataset_path', e.target.value)}
              placeholder="/dataset/auto_improve"
            />
          </div>
          <div className="settings-field">
            <label>Model Dir</label>
            <input
              value={form.model_dir}
              onChange={e => set('model_dir', e.target.value)}
              placeholder="/runs/models"
            />
          </div>
          <div className="settings-field">
            <label>YOLO Train URL</label>
            <input
              value={form.yolo_url}
              onChange={e => set('yolo_url', e.target.value)}
              placeholder="http://yolo-train:8080"
            />
          </div>
        </section>

        {/* Project Sync */}
        <section className="settings-card">
          <div className="settings-card-title"><Database size={16} /> Sync โปรเจกต์กับ Disk</div>
          <div className="settings-field">
            <label>เลือกโปรเจกต์</label>
            <select value={selectedProject} onChange={e => setSelectedProject(e.target.value)}>
              <option value="">-- เลือกโปรเจกต์ --</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="settings-field">
            <label>Dataset Dir (ถ้าต้องการเปลี่ยน)</label>
            <input
              value={datasetDir}
              onChange={e => setDatasetDir(e.target.value)}
              placeholder="เว้นว่างถ้าไม่ต้องการเปลี่ยน"
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={syncProject}
            disabled={!selectedProject || syncing}
            style={{ marginTop: 4 }}
          >
            {syncing ? 'กำลัง Sync...' : 'Sync ภาพจาก Disk → DB'}
          </button>
          {syncMsg && (
            <div className={`settings-sync-msg ${syncMsg.includes('ไม่') ? 'error' : 'success'}`}>
              {syncMsg}
            </div>
          )}
        </section>

      </div>
    </div>
  )
}
