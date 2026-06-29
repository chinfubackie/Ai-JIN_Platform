import { useEffect, useState } from 'react'
import { api } from '../api/client'
import {
  PieChart, Pie, Cell, ResponsiveContainer,
} from 'recharts'
import {
  FolderOpen, Image, Tag, Box, Download, MoreHorizontal,
  Plus, Clock, Zap, CheckCircle, AlertTriangle, XCircle,
  Activity, Cpu, Settings,
} from 'lucide-react'
import './Dashboard.css'

function timeAgo(date) {
  if (!date) return ''
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'เมื่อสักครู่'
  if (mins < 60) return `${mins} นาทีที่แล้ว`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} ชม.ที่แล้ว`
  const days = Math.floor(hrs / 24)
  return `${days} วันที่แล้ว`
}

const HEALTH_COLORS = ['var(--green)', 'var(--yellow)', 'var(--red)']

export default function Dashboard() {
  const [stats, setStats] = useState(null)
  const [dbStats, setDbStats] = useState(null)
  const [folders, setFolders] = useState([])
  const [projects, setProjects] = useState([])

  useEffect(() => {
    api.stats().then(setStats).catch(console.error)
    api.dbStats().then(setDbStats).catch(() => {})
    api.folders().then(data => {
      setFolders(Array.isArray(data) ? data : data?.folders || [])
    }).catch(() => setFolders([]))
    api.projects().then(data => {
      setProjects(Array.isArray(data) ? data : [])
    }).catch(() => {})
  }, [])

  if (!stats) {
    return (
      <div className="dash-loading">
        <div className="dash-loading-spinner" />
        <span>กำลังโหลดแดชบอร์ด...</span>
      </div>
    )
  }

  const ds = stats.dataset || {}
  const trainingRuns = stats.training?.runs || []
  // Prefer DB stats when available
  const totalImages   = dbStats?.total_images   ?? ds.total_images   ?? 0
  const totalAnnotations = dbStats?.total_annotations ?? ds.total_labels ?? 0
  const totalModels   = dbStats?.total_models   ?? trainingRuns.length
  const totalClasses  = dbStats?.total_classes  ?? Object.keys(ds.classes || {}).length
  const labelRate     = dbStats?.label_rate     ?? 0
  const totalProjects = dbStats?.total_projects ?? projects.length
  const totalExports  = stats.recent_exports?.length ?? 0

  const labeledImages = dbStats?.labeled_images ?? 0

  const healthValid    = labelRate
  const healthWarnings = Math.max(0, 100 - labelRate - 1)
  const healthErrors   = Math.min(1, 100 - labelRate)
  const healthData = [
    { name: 'Labeled', value: healthValid },
    { name: 'Unlabeled', value: healthWarnings },
    { name: 'Error', value: healthErrors },
  ]

  // Activity feed from DB
  const activities = (dbStats?.activity || []).map(a => ({
    icon: a.event_type,
    text: a.title,
    time: timeAgo(a.created_at),
  }))

  const quickStats = [
    { label: 'โปรเจกต์', value: totalProjects, icon: FolderOpen, color: 'var(--accent)', sub: `${projects.length} active` },
    { label: 'รูปภาพ', value: totalImages, icon: Image, color: 'var(--cyan)', sub: `${labeledImages} labeled` },
    { label: 'Annotations', value: totalAnnotations, icon: Tag, color: 'var(--green)', sub: `${labelRate}% rate` },
    { label: 'Classes', value: totalClasses, icon: Box, color: 'var(--yellow)', sub: 'ทั้งหมด' },
    { label: 'โมเดล', value: totalModels, icon: Download, color: 'var(--red)', sub: `${dbStats?.deployed_models ?? 0} deployed` },
  ]

  const displayFolders = folders.slice(0, 6)

  // Recent projects from DB
  const recentProjects = projects.slice(0, 3).map((p, i) => ({
    name: p.name,
    type: 'Object Detection',
    progress: p.image_count > 0 ? Math.round((p.labeled_count || 0) / p.image_count * 100) : 0,
    updated: timeAgo(p.updated_at),
    initial: (p.name || 'P')[0].toUpperCase(),
    color: ['var(--accent)', 'var(--cyan)', 'var(--green)'][i % 3],
    classes: p.class_count || 0,
    images: p.image_count || 0,
  }))

  return (
    <div className="dash">
      {/* Welcome Section */}
      <section className="dash-welcome">
        <div className="dash-welcome-text">
          <h1 className="dash-welcome-title">
            ยินดีต้อนรับกลับมา, otter-phoenix
            <span className="dash-wave">&#128075;</span>
          </h1>
          <p className="dash-welcome-sub">
            จัดการข้อมูล annotate ด้วย AI และสร้างโมเดลที่ดีขึ้น
          </p>
        </div>
        <div className="dash-welcome-art" aria-hidden="true">
          <svg viewBox="0 0 200 160" fill="none" xmlns="http://www.w3.org/2000/svg" className="dash-welcome-svg">
            <defs>
              <linearGradient id="gearGrad" x1="0" y1="0" x2="200" y2="160" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#7c5cfc" stopOpacity="0.7" />
                <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.5" />
              </linearGradient>
            </defs>
            <rect rx="20" width="200" height="160" fill="url(#gearGrad)" opacity="0.15" />
            {/* Gear 1 */}
            <g transform="translate(70,80)">
              <circle r="28" stroke="#7c5cfc" strokeWidth="2" fill="none" opacity="0.5" />
              <circle r="18" stroke="#7c5cfc" strokeWidth="1.5" fill="none" opacity="0.3" />
              <circle r="6" fill="#7c5cfc" opacity="0.6" />
              {[0, 45, 90, 135, 180, 225, 270, 315].map(angle => (
                <line
                  key={angle}
                  x1={Math.cos(angle * Math.PI / 180) * 20}
                  y1={Math.sin(angle * Math.PI / 180) * 20}
                  x2={Math.cos(angle * Math.PI / 180) * 30}
                  y2={Math.sin(angle * Math.PI / 180) * 30}
                  stroke="#7c5cfc"
                  strokeWidth="3"
                  strokeLinecap="round"
                  opacity="0.4"
                />
              ))}
            </g>
            {/* Gear 2 */}
            <g transform="translate(130,55)">
              <circle r="20" stroke="#06b6d4" strokeWidth="2" fill="none" opacity="0.5" />
              <circle r="12" stroke="#06b6d4" strokeWidth="1.5" fill="none" opacity="0.3" />
              <circle r="4" fill="#06b6d4" opacity="0.6" />
              {[0, 60, 120, 180, 240, 300].map(angle => (
                <line
                  key={angle}
                  x1={Math.cos(angle * Math.PI / 180) * 14}
                  y1={Math.sin(angle * Math.PI / 180) * 14}
                  x2={Math.cos(angle * Math.PI / 180) * 22}
                  y2={Math.sin(angle * Math.PI / 180) * 22}
                  stroke="#06b6d4"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  opacity="0.4"
                />
              ))}
            </g>
            {/* AI spark */}
            <text x="140" y="115" fontSize="10" fill="#9b82fc" fontWeight="700" opacity="0.6">AI</text>
            <path d="M150 100 l4-10 l4 10 l-4 3z" fill="#9b82fc" opacity="0.4" />
          </svg>
        </div>
      </section>

      {/* Quick Stats */}
      <section className="dash-stats">
        {quickStats.map((s) => {
          const Icon = s.icon
          return (
            <div className="dash-stat-card" key={s.label}>
              <div className="dash-stat-icon" style={{ background: `${s.color}18` }}>
                <Icon size={20} color={s.color} />
              </div>
              <div className="dash-stat-number">{s.value.toLocaleString()}</div>
              <div className="dash-stat-label">{s.label}</div>
              <div className="dash-stat-growth">{s.sub}</div>
            </div>
          )
        })}
      </section>

      {/* My Datasets */}
      <section className="dash-section">
        <div className="dash-section-header">
          <h2 className="dash-section-title">ชุดข้อมูลของฉัน</h2>
          <button className="dash-view-all">ดูทั้งหมด</button>
        </div>
        <div className="dash-datasets-grid">
          {displayFolders.map((folder, idx) => {
            const path = typeof folder === 'string' ? folder : folder.path || ''
            const name = path.split('/').pop() || `Dataset ${idx + 1}`
            const imgCount = folder.count || folder.image_count || 0
            const isPrivate = idx % 2 === 0
            return (
              <div className="dash-dataset-card" key={path || idx}>
                <div className="dash-dataset-thumb">
                  <div className="dash-dataset-thumb-placeholder">
                    <FolderOpen size={32} color="var(--text-muted)" />
                  </div>
                  <span className={`dash-dataset-badge ${isPrivate ? 'private' : 'public'}`}>
                    {isPrivate ? 'Private' : 'Public'}
                  </span>
                  <button className="dash-dataset-menu" aria-label="เมนู">
                    <MoreHorizontal size={16} />
                  </button>
                </div>
                <div className="dash-dataset-info">
                  <div className="dash-dataset-name">{name}</div>
                  <div className="dash-dataset-meta">
                    {imgCount} ภาพ
                  </div>
                </div>
              </div>
            )
          })}
          {displayFolders.length === 0 && (
            <div className="dash-dataset-card dash-dataset-empty">
              <Plus size={32} color="var(--text-muted)" />
              <span>เพิ่มชุดข้อมูลแรก</span>
            </div>
          )}
        </div>
      </section>

      {/* Recent Projects */}
      <section className="dash-section">
        <div className="dash-section-header">
          <h2 className="dash-section-title">โปรเจกต์ล่าสุด</h2>
          <button className="dash-view-all">ดูทั้งหมด</button>
        </div>
        <div className="dash-projects-row">
          {recentProjects.map((proj, i) => (
            <div className="dash-project-card" key={i}>
              <div className="dash-project-icon" style={{ background: proj.color }}>
                {proj.initial}
              </div>
              <div className="dash-project-body">
                <div className="dash-project-name">{proj.name}</div>
                <span className="dash-project-type">{proj.type}</span>
                <div className="dash-project-progress">
                  <div className="dash-progress-bar">
                    <div
                      className="dash-progress-fill"
                      style={{ width: `${proj.progress}%`, background: proj.color }}
                    />
                  </div>
                  <span className="dash-progress-pct">{proj.progress}%</span>
                </div>
                <div className="dash-project-updated">
                  <Clock size={12} /> อัปเดต {proj.updated}
                </div>
              </div>
            </div>
          ))}
          <div className="dash-project-card dash-project-new">
            <Plus size={28} color="var(--text-muted)" />
            <span>โปรเจกต์ใหม่</span>
          </div>
        </div>
      </section>

      {/* Training & Exports */}
      <section className="dash-twin">
        {/* Training */}
        <div className="dash-twin-card">
          <div className="dash-section-header">
            <h2 className="dash-section-title">
              <Cpu size={18} /> การเทรนโมเดล ({trainingRuns.length})
            </h2>
          </div>
          <div className="dash-train-list">
            {trainingRuns.length > 0 ? trainingRuns.slice(0, 4).map((run, i) => {
              const progress = run.has_best ? 100 : 65
              const status = run.has_best ? 'เสร็จสิ้น' : 'Queued'
              const eta = run.has_best ? '' : ''
              return (
                <div className="dash-train-item" key={i}>
                  <div className="dash-train-top">
                    <span className="dash-train-name">{run.name || `Run ${i + 1}`}</span>
                    <span className="badge badge-accent">YOLOv8x</span>
                    <span className={`dash-train-status ${progress >= 100 ? 'done' : 'running'}`}>
                      {status}
                    </span>
                  </div>
                  <div className="dash-progress-bar wide">
                    <div
                      className="dash-progress-fill"
                      style={{
                        width: `${Math.min(progress, 100)}%`,
                        background: progress >= 100 ? 'var(--green)' : 'var(--accent)',
                      }}
                    />
                  </div>
                  {eta && <div className="dash-train-eta">{eta}</div>}
                </div>
              )
            }) : (
              <div className="dash-empty-state">
                <Settings size={24} color="var(--text-muted)" />
                <span>ยังไม่มีการเทรน</span>
              </div>
            )}
          </div>
        </div>

        {/* Exports */}
        <div className="dash-twin-card">
          <div className="dash-section-header">
            <h2 className="dash-section-title">
              <Download size={18} /> การส่งออกล่าสุด ({totalExports})
            </h2>
          </div>
          <div className="dash-export-list">
            {(stats.recent_exports || []).length > 0 ? stats.recent_exports.slice(0, 4).map((exp, i) => (
              <div className="dash-export-item" key={i}>
                <CheckCircle size={16} color="var(--green)" />
                <span className="dash-export-name">{exp.name || `Export ${i + 1}`}</span>
                <span className="badge badge-accent">{exp.format || 'ONNX'}</span>
                <span className="dash-export-time">{timeAgo(exp.date)}</span>
              </div>
            )) : (
              <div className="dash-empty-state">
                <Download size={24} color="var(--text-muted)" />
                <span>ยังไม่มีการส่งออก</span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Health + Activity bottom row */}
      <section className="dash-twin">
        {/* Dataset Health */}
        <div className="dash-twin-card">
          <h2 className="dash-section-title">สุขภาพชุดข้อมูล</h2>
          <div className="dash-health">
            <div className="dash-health-chart">
              <ResponsiveContainer width={160} height={160}>
                <PieChart>
                  <Pie
                    data={healthData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={70}
                    paddingAngle={2}
                    dataKey="value"
                    stroke="none"
                  >
                    {healthData.map((_, i) => (
                      <Cell key={i} fill={HEALTH_COLORS[i]} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="dash-health-center">
                <span className="dash-health-pct">{healthValid}%</span>
                <span className="dash-health-label">ปกติ</span>
              </div>
            </div>
            <div className="dash-health-legend">
              <div className="dash-health-row">
                <CheckCircle size={14} color="var(--green)" />
                <span>ถูกต้อง</span>
                <strong>{healthValid}%</strong>
              </div>
              <div className="dash-health-row">
                <AlertTriangle size={14} color="var(--yellow)" />
                <span>คำเตือน</span>
                <strong>{healthWarnings}%</strong>
              </div>
              <div className="dash-health-row">
                <XCircle size={14} color="var(--red)" />
                <span>ข้อผิดพลาด</span>
                <strong>{healthErrors}%</strong>
              </div>
            </div>
          </div>
        </div>

        {/* Activity Feed */}
        <div className="dash-twin-card">
          <h2 className="dash-section-title">
            <Activity size={18} /> กิจกรรมล่าสุด
          </h2>
          <div className="dash-activity-list">
            {activities.map((a, i) => (
              <div className="dash-activity-item" key={i}>
                <div className="dash-activity-icon">
                  {a.icon === 'ai' ? <Zap size={14} color="var(--accent)" /> :
                   a.icon === 'train' ? <Cpu size={14} color="var(--cyan)" /> :
                   a.icon === 'export' ? <Download size={14} color="var(--green)" /> :
                   <Tag size={14} color="var(--yellow)" />}
                </div>
                <span className="dash-activity-text">{a.text}</span>
                <span className="dash-activity-time">{a.time}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
