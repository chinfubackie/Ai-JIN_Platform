import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '../api/client'
import {
  FolderOpen,
  Image,
  ChevronLeft,
  ChevronRight,
  X,
  Loader2,
  Database,
  Tag,
} from 'lucide-react'
import './Dataset.css'

const PER_PAGE = 60

// Deterministic color for each class index
const BOX_COLORS = [
  '#22c55e', '#6366f1', '#ef4444', '#eab308', '#06b6d4',
  '#ec4899', '#f97316', '#8b5cf6', '#14b8a6', '#f43f5e',
]

export default function Dataset() {
  const [folders, setFolders] = useState([])
  const [activeFolder, setActiveFolder] = useState(null)
  const [images, setImages] = useState([])   // [{path, labeled, annotation_count}]
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [foldersLoading, setFoldersLoading] = useState(true)
  const [projects, setProjects] = useState([])
  const [activeProject, setActiveProject] = useState('')
  const [syncing, setSyncing] = useState(false)

  // Modal state
  const [modalImage, setModalImage] = useState(null)
  const [labelData, setLabelData] = useState(null)
  const [labelLoading, setLabelLoading] = useState(false)
  const canvasRef = useRef(null)
  const imgRef = useRef(null)

  // Load folders + projects on mount
  useEffect(() => {
    setFoldersLoading(true)
    api.folders()
      .then((data) => {
        const list = (data?.folders || data || []).map(f => typeof f === 'string' ? f : f.path)
        setFolders(list)
        if (list.length > 0) setActiveFolder(list[0])
      })
      .catch(console.error)
      .finally(() => setFoldersLoading(false))
    api.projects().then(d => setProjects(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  // Load images when folder or page changes — keep as objects {path,labeled,annotation_count}
  useEffect(() => {
    if (!activeFolder) return
    setLoading(true)
    api
      .images(activeFolder, page, PER_PAGE)
      .then((res) => {
        const imgs = (res.images || []).map(i =>
          typeof i === 'string' ? { path: i, labeled: 0, annotation_count: 0 } : i
        )
        setImages(imgs)
        setTotal(res.total || imgs.length)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [activeFolder, page])

  const handleSync = async () => {
    if (!activeProject) return
    setSyncing(true)
    try {
      const r = await api.projectSync(parseInt(activeProject))
      // Reload images after sync
      const res = await api.images(activeFolder, page, PER_PAGE)
      setImages((res.images || []).map(i =>
        typeof i === 'string' ? { path: i, labeled: 0, annotation_count: 0 } : i
      ))
      setTotal(res.total || 0)
    } catch { /* silent */ } finally { setSyncing(false) }
  }

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))

  const handleFolderClick = (folder) => {
    if (folder === activeFolder) return
    setActiveFolder(folder)
    setPage(1)
    setImages([])
    setTotal(0)
  }

  // openModal still receives the path string
  const getPath = (img) => (typeof img === 'string' ? img : img.path)

  // -- Modal --
  const openModal = (imgPath) => {
    setModalImage(imgPath)
    setLabelData(null)
    setLabelLoading(true)
    api
      .label(imgPath)
      .then(setLabelData)
      .catch(() => setLabelData(null))
      .finally(() => setLabelLoading(false))
  }

  const closeModal = () => {
    setModalImage(null)
    setLabelData(null)
  }

  // Close modal on Escape
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') closeModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Draw bounding boxes when label data or image loads
  const drawBoxes = useCallback(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img || !labelData) return

    const w = img.naturalWidth
    const h = img.naturalHeight
    const dispW = img.clientWidth
    const dispH = img.clientHeight

    canvas.width = dispW
    canvas.height = dispH

    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, dispW, dispH)

    const lines = (labelData.content || '').trim().split('\n').filter(Boolean)
    lines.forEach((line) => {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 5) return

      const classId = parseInt(parts[0], 10)
      const cx = parseFloat(parts[1]) * dispW
      const cy = parseFloat(parts[2]) * dispH
      const bw = parseFloat(parts[3]) * dispW
      const bh = parseFloat(parts[4]) * dispH

      const x = cx - bw / 2
      const y = cy - bh / 2

      const color = BOX_COLORS[classId % BOX_COLORS.length]
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.strokeRect(x, y, bw, bh)

      // Class label background
      const label = labelData.classes?.[classId] ?? `class ${classId}`
      ctx.font = 'bold 12px Inter, system-ui, sans-serif'
      const tm = ctx.measureText(label)
      const labelH = 18
      ctx.fillStyle = color
      ctx.fillRect(x, y - labelH, tm.width + 8, labelH)
      ctx.fillStyle = '#fff'
      ctx.fillText(label, x + 4, y - 5)
    })
  }, [labelData])

  const handleImgLoad = () => {
    drawBoxes()
  }

  useEffect(() => {
    drawBoxes()
  }, [drawBoxes])

  // Count boxes in label
  const boxCount = labelData
    ? (labelData.content || '').trim().split('\n').filter(Boolean).length
    : 0

  // Unique classes in this label
  const labelClasses = labelData
    ? [
        ...new Set(
          (labelData.content || '')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => {
              const id = parseInt(l.trim().split(/\s+/)[0], 10)
              return labelData.classes?.[id] ?? `class ${id}`
            })
        ),
      ]
    : []

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">ชุดข้อมูล</h1>
      </div>

      <div className="dataset-layout">
        {/* ---- Folder sidebar ---- */}
        <div className="dataset-sidebar">
          <div className="dataset-sidebar-header">
            <FolderOpen size={16} />
            โฟลเดอร์
          </div>
          <div className="dataset-folder-list">
            {foldersLoading && (
              <div className="dataset-loading" style={{ padding: 20 }}>
                <Loader2 size={16} className="spin" />
                กำลังโหลด...
              </div>
            )}
            {!foldersLoading && folders.length === 0 && (
              <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>
                ไม่พบโฟลเดอร์
              </div>
            )}
            {folders.map((f) => (
              <button
                key={f}
                className={`dataset-folder-item${f === activeFolder ? ' active' : ''}`}
                onClick={() => handleFolderClick(f)}
              >
                <FolderOpen size={15} className="folder-icon" />
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* ---- Image grid area ---- */}
        <div className="dataset-main">
          {/* Project selector bar */}
          {projects.length > 0 && (
            <div className="dataset-project-bar">
              <Tag size={14} />
              <span>โปรเจกต์:</span>
              <select
                value={activeProject}
                onChange={e => setActiveProject(e.target.value)}
                className="dataset-project-select"
              >
                <option value="">-- ไม่ระบุ --</option>
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {activeProject && (
                <button
                  className="btn btn-outline"
                  onClick={handleSync}
                  disabled={syncing}
                  style={{ padding: '3px 10px', fontSize: 12 }}
                >
                  {syncing ? 'Syncing...' : 'Sync → DB'}
                </button>
              )}
            </div>
          )}

          {activeFolder ? (
            <>
              <div className="dataset-toolbar">
                <div className="dataset-info">
                  <span className="folder-label">
                    <Database size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
                    {activeFolder}
                  </span>
                  <span className="image-count">{total} ภาพ</span>
                </div>
              </div>

              {loading ? (
                <div className="dataset-loading">
                  <Loader2 size={18} />
                  กำลังโหลดรูปภาพ...
                </div>
              ) : images.length === 0 ? (
                <div className="dataset-empty">
                  <Image size={48} />
                  <span>ไม่พบรูปภาพในโฟลเดอร์นี้</span>
                </div>
              ) : (
                <>
                  <div className="dataset-grid-wrap">
                    <div className="dataset-grid">
                      {images.map((img) => {
                        const imgPath = getPath(img)
                        const name = imgPath.split('/').pop()
                        const labeled = img.labeled === 1 || img.labeled === true
                        const annCount = img.annotation_count || 0
                        return (
                          <div
                            key={imgPath}
                            className="dataset-thumb"
                            onClick={() => openModal(imgPath)}
                            title={name}
                          >
                            <img src={api.image(imgPath)} alt={name} loading="lazy" />
                            <div className="dataset-thumb-footer">
                              <span className="dataset-thumb-name">{name}</span>
                              <span className={`ds-labeled-badge ${labeled ? 'labeled' : 'unlabeled'}`}>
                                {labeled ? `✓ ${annCount}` : 'unlabeled'}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  <div className="dataset-pagination">
                    <button
                      className="btn btn-outline"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      <ChevronLeft size={16} />
                      ก่อนหน้า
                    </button>
                    <span className="page-info">
                      หน้า {page} / {totalPages}
                    </span>
                    <button
                      className="btn btn-outline"
                      disabled={page >= totalPages}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    >
                      ถัดไป
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="dataset-empty">
              <FolderOpen size={48} />
              <span>เลือกโฟลเดอร์เพื่อดูรูปภาพ</span>
            </div>
          )}
        </div>
      </div>

      {/* ---- Image detail modal ---- */}
      {modalImage && (
        <div className="dataset-modal-overlay" onClick={closeModal}>
          <div className="dataset-modal" onClick={(e) => e.stopPropagation()}>
            <div className="dataset-modal-header">
              <h3>{modalImage.split('/').pop()}</h3>
              <button className="dataset-modal-close" onClick={closeModal}>
                <X size={18} />
              </button>
            </div>

            <div className="dataset-modal-body">
              {labelLoading ? (
                <div className="dataset-loading">
                  <Loader2 size={18} />
                  กำลังโหลด Label...
                </div>
              ) : (
                <div className="dataset-modal-canvas-wrap">
                  <img
                    ref={imgRef}
                    src={api.image(modalImage)}
                    alt={modalImage}
                    onLoad={handleImgLoad}
                    style={{ maxWidth: '100%', maxHeight: '70vh' }}
                  />
                  <canvas ref={canvasRef} />
                </div>
              )}
            </div>

            <div className="dataset-modal-footer">
              <div className="label-stat">
                <Tag size={13} />
                Bounding boxes: <strong>{boxCount}</strong>
              </div>
              {labelClasses.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {labelClasses.map((cls) => (
                    <span key={cls} className="badge badge-green">
                      {cls}
                    </span>
                  ))}
                </div>
              )}
              {labelData === null && !labelLoading && (
                <span className="label-stat">ไม่พบข้อมูล Label</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
