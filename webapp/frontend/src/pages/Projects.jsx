import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { Plus, Trash2, RefreshCw, FolderOpen, Tag, Image, Brain, ChevronRight } from 'lucide-react'
import './Projects.css'

const SWATCH = [
  '#6366f1','#22c55e','#ef4444','#eab308','#06b6d4',
  '#f97316','#a855f7','#ec4899','#14b8a6','#84cc16',
]

function Toast({ toast }) {
  if (!toast) return null
  return (
    <div className={`proj-toast ${toast.type}`}>{toast.msg}</div>
  )
}

export default function Projects() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)  // selected project detail
  const [detail, setDetail] = useState(null)
  const [toast, setToast] = useState(null)

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', dataset_dir: '' })
  const [creating, setCreating] = useState(false)

  // Class add
  const [newClass, setNewClass] = useState('')
  const [addingClass, setAddingClass] = useState(false)

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 2500)
  }

  const loadProjects = () => {
    setLoading(true)
    api.projects().then(data => {
      setProjects(Array.isArray(data) ? data : [])
    }).catch(() => showToast('โหลดโปรเจกต์ไม่สำเร็จ', 'error'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadProjects() }, [])

  async function loadDetail(pid) {
    try {
      const d = await api.projectGet(pid)
      setDetail(d)
    } catch { setDetail(null) }
  }

  function selectProject(p) {
    setSelected(p.id)
    loadDetail(p.id)
  }

  async function createProject() {
    const name = form.name.trim()
    if (!name) return
    setCreating(true)
    try {
      await api.projectCreate(form)
      showToast(`สร้างโปรเจกต์ "${name}" สำเร็จ`)
      setForm({ name: '', description: '', dataset_dir: '' })
      setShowCreate(false)
      loadProjects()
    } catch (e) {
      showToast(e.message || 'สร้างไม่สำเร็จ', 'error')
    } finally {
      setCreating(false)
    }
  }

  async function deleteProject(pid, name) {
    if (!confirm(`ลบโปรเจกต์ "${name}" ใช่ไหม? ข้อมูลใน DB จะถูกลบด้วย`)) return
    try {
      await api.projectDelete(pid)
      if (selected === pid) { setSelected(null); setDetail(null) }
      showToast(`ลบ "${name}" สำเร็จ`)
      loadProjects()
    } catch {
      showToast('ลบไม่สำเร็จ', 'error')
    }
  }

  async function addClass() {
    const name = newClass.trim()
    if (!name || !selected) return
    setAddingClass(true)
    try {
      await api.projectClassCreate(selected, { name })
      setNewClass('')
      loadDetail(selected)
    } catch { showToast('เพิ่ม class ไม่สำเร็จ', 'error') }
      finally { setAddingClass(false) }
  }

  async function deleteClass(cid) {
    try {
      await api.classDelete(cid)
      loadDetail(selected)
    } catch { showToast('ลบ class ไม่สำเร็จ', 'error') }
  }

  async function syncProject() {
    if (!selected) return
    try {
      const res = await api.projectSync(selected)
      showToast(`Sync สำเร็จ: ${res.synced ?? 0} ภาพ`)
      loadDetail(selected)
      loadProjects()
    } catch { showToast('Sync ไม่สำเร็จ', 'error') }
  }

  return (
    <div className="proj-page">
      <Toast toast={toast} />

      <div className="proj-header">
        <h1 className="page-title">โปรเจกต์</h1>
        <button className="btn btn-primary" onClick={() => setShowCreate(v => !v)}>
          <Plus size={15} /> สร้างโปรเจกต์ใหม่
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="proj-create-card">
          <div className="proj-create-title">โปรเจกต์ใหม่</div>
          <div className="proj-create-row">
            <input
              placeholder="ชื่อโปรเจกต์ *"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && createProject()}
              autoFocus
            />
            <input
              placeholder="คำอธิบาย (ไม่บังคับ)"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            />
            <input
              placeholder="Dataset dir เช่น /dataset/project1"
              value={form.dataset_dir}
              onChange={e => setForm(f => ({ ...f, dataset_dir: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={createProject} disabled={creating || !form.name.trim()}>
              {creating ? 'กำลังสร้าง...' : 'สร้าง'}
            </button>
            <button className="btn btn-outline" onClick={() => setShowCreate(false)}>ยกเลิก</button>
          </div>
        </div>
      )}

      <div className="proj-layout">
        {/* Project list */}
        <div className="proj-list">
          {loading && <div className="proj-empty">กำลังโหลด...</div>}
          {!loading && projects.length === 0 && (
            <div className="proj-empty">ยังไม่มีโปรเจกต์ — กด "สร้างโปรเจกต์ใหม่"</div>
          )}
          {projects.map(p => (
            <div
              key={p.id}
              className={`proj-item ${selected === p.id ? 'active' : ''}`}
              onClick={() => selectProject(p)}
            >
              <div className="proj-item-icon">
                <FolderOpen size={18} color="var(--accent)" />
              </div>
              <div className="proj-item-body">
                <div className="proj-item-name">{p.name}</div>
                <div className="proj-item-meta">
                  <span><Image size={11} /> {p.image_count ?? 0}</span>
                  <span><Tag size={11} /> {p.class_count ?? 0} classes</span>
                  <span><Brain size={11} /> {p.run_count ?? 0} runs</span>
                </div>
              </div>
              <ChevronRight size={14} color="var(--text-muted)" />
            </div>
          ))}
        </div>

        {/* Detail panel */}
        {detail ? (
          <div className="proj-detail">
            <div className="proj-detail-header">
              <div>
                <div className="proj-detail-name">{detail.name}</div>
                <div className="proj-detail-desc">{detail.description || 'ไม่มีคำอธิบาย'}</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-outline" onClick={syncProject}>
                  <RefreshCw size={14} /> Sync
                </button>
                <button
                  className="btn btn-outline btn-danger"
                  onClick={() => deleteProject(detail.id, detail.name)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {/* Stats */}
            <div className="proj-stats-row">
              {[
                { label: 'ภาพทั้งหมด', value: detail.stats?.total ?? 0, color: 'var(--cyan)' },
                { label: 'Labeled', value: detail.stats?.labeled ?? 0, color: 'var(--green)' },
                { label: 'Annotations', value: detail.stats?.annotations ?? 0, color: 'var(--accent)' },
                { label: 'Training Runs', value: detail.recent_runs?.length ?? 0, color: 'var(--yellow)' },
              ].map(s => (
                <div key={s.label} className="proj-stat">
                  <div className="proj-stat-val" style={{ color: s.color }}>{s.value}</div>
                  <div className="proj-stat-label">{s.label}</div>
                </div>
              ))}
            </div>

            {/* Dataset dir */}
            {detail.dataset_dir && (
              <div className="proj-dir">
                <FolderOpen size={13} /> {detail.dataset_dir}
              </div>
            )}

            {/* Classes */}
            <div className="proj-section-title">Classes</div>
            <div className="proj-class-list">
              {(detail.classes || []).map((c, i) => (
                <div key={c.id} className="proj-class-item">
                  <span className="proj-class-swatch" style={{ background: c.color || SWATCH[i % SWATCH.length] }} />
                  <span className="proj-class-name">{c.name}</span>
                  <button className="proj-class-del" onClick={() => deleteClass(c.id)} title="ลบ">
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
              {(detail.classes || []).length === 0 && (
                <div className="proj-empty-sm">ยังไม่มี class</div>
              )}
            </div>
            <div className="proj-add-class">
              <input
                placeholder="ชื่อ class ใหม่"
                value={newClass}
                onChange={e => setNewClass(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addClass()}
              />
              <button className="btn btn-primary" onClick={addClass} disabled={addingClass || !newClass.trim()}>
                <Plus size={14} />
              </button>
            </div>

            {/* Recent runs */}
            {detail.recent_runs?.length > 0 && (
              <>
                <div className="proj-section-title" style={{ marginTop: 16 }}>Training Runs ล่าสุด</div>
                <div className="proj-runs">
                  {detail.recent_runs.map(r => (
                    <div key={r.id} className="proj-run-item">
                      <span className={`proj-run-status ${r.status}`}>{r.status}</span>
                      <span className="proj-run-name">{r.run_name}</span>
                      <span className="proj-run-model">{r.model_base}</span>
                      <span className="proj-run-prog">{Math.round(r.progress ?? 0)}%</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="proj-detail proj-detail-empty">
            <FolderOpen size={36} color="var(--text-muted)" />
            <span>เลือกโปรเจกต์เพื่อดูรายละเอียด</span>
          </div>
        )}
      </div>
    </div>
  )
}
