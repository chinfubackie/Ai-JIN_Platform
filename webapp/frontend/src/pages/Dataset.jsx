import { useEffect, useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import {
  FolderOpen, Image, ChevronLeft, ChevronRight,
  X, Loader2, Tag, Pencil, LayoutGrid, Trash2,
} from 'lucide-react'
import './Dataset.css'

const PER_PAGE = 60

const BOX_COLORS = [
  '#6366f1','#22c55e','#ef4444','#eab308','#06b6d4',
  '#f97316','#a855f7','#ec4899','#14b8a6','#84cc16',
]

// Detect split from folder path
function detectSplit(path) {
  if (/\/train\/|\\train\\|^train\//i.test(path)) return 'train'
  if (/\/val\/|\\val\\|^val\//i.test(path))       return 'val'
  if (/\/test\/|\\test\\|^test\//i.test(path))     return 'test'
  return 'other'
}

export default function Dataset() {
  const navigate = useNavigate()

  const [folders, setFolders]   = useState([])
  const [activeFolder, setActiveFolder] = useState(null)
  const [images, setImages]     = useState([])
  const [total, setTotal]       = useState(0)
  const [page, setPage]         = useState(1)
  const [loading, setLoading]   = useState(false)
  const [foldersLoading, setFoldersLoading] = useState(true)
  const [activeSplit, setActiveSplit] = useState('all')

  // Modal / lightbox
  const [lightbox, setLightbox] = useState(null)  // { imgPath, imgIdx }
  const [labelData, setLabelData] = useState(null)
  const [labelLoading, setLabelLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const canvasRef = useRef(null)
  const imgRef    = useRef(null)

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
  }, [])

  useEffect(() => {
    if (!activeFolder) return
    setLoading(true)
    api.images(activeFolder, page, PER_PAGE)
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

  // Compute split counts from folder list
  const splitCounts = folders.reduce((acc, f) => {
    const s = detectSplit(f)
    acc[s] = (acc[s] || 0) + 1
    return acc
  }, {})

  // Filtered folders by split tab
  const visibleFolders = activeSplit === 'all'
    ? folders
    : folders.filter(f => detectSplit(f) === activeSplit)

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))

  // Stats from loaded images
  const labeledCount = images.filter(i => i.labeled === 1 || i.labeled === true).length
  const totalAnn = images.reduce((s, i) => s + (i.annotation_count || 0), 0)

  // ---- Lightbox ----
  const openLightbox = (imgPath, imgIdx) => {
    setLightbox({ imgPath, imgIdx })
    setLabelData(null)
    setLabelLoading(true)
    api.label(imgPath)
      .then(setLabelData)
      .catch(() => setLabelData(null))
      .finally(() => setLabelLoading(false))
  }

  const closeLightbox = () => { setLightbox(null); setLabelData(null) }

  const goToImage = (idx) => {
    if (idx < 0 || idx >= images.length) return
    const img = images[idx]
    openLightbox(typeof img === 'string' ? img : img.path, idx)
  }

  useEffect(() => {
    const onKey = (e) => {
      if (!lightbox) return
      if (e.key === 'Escape') closeLightbox()
      if (e.key === 'ArrowLeft') goToImage(lightbox.imgIdx - 1)
      if (e.key === 'ArrowRight') goToImage(lightbox.imgIdx + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox, images])

  const drawBoxes = useCallback(() => {
    const canvas = canvasRef.current
    const img    = imgRef.current
    if (!canvas || !img || !labelData) return

    const W = img.clientWidth
    const H = img.clientHeight
    canvas.width  = W
    canvas.height = H

    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, W, H)

    ;(labelData.labels || []).forEach((lb) => {
      const cid  = Number(lb.class_id ?? 0)
      const cx   = Number(lb.cx ?? 0) * W
      const cy   = Number(lb.cy ?? 0) * H
      const bw   = Number(lb.w  ?? 0) * W
      const bh   = Number(lb.h  ?? 0) * H
      const x = cx - bw / 2
      const y = cy - bh / 2

      const col = BOX_COLORS[cid % BOX_COLORS.length]
      ctx.strokeStyle = col
      ctx.lineWidth   = 2
      ctx.strokeRect(x, y, bw, bh)

      const lbl = labelData.classes?.[cid] ?? `class ${cid}`
      ctx.font = 'bold 12px Inter, system-ui, sans-serif'
      const tm = ctx.measureText(lbl)
      ctx.fillStyle = col
      ctx.fillRect(x, y - 18, tm.width + 8, 18)
      ctx.fillStyle = '#fff'
      ctx.fillText(lbl, x + 4, y - 5)
    })
  }, [labelData])

  useEffect(() => { drawBoxes() }, [drawBoxes])

  const openInAnnotator = () => {
    if (!lightbox || !activeFolder) return
    localStorage.setItem('ann_last_folder', activeFolder)
    localStorage.setItem(`ann_idx_${activeFolder}`, String(lightbox.imgIdx))
    navigate('/annotator')
  }

  const deleteCurrentImage = async () => {
    if (!lightbox || deleting) return
    const name = lightbox.imgPath.split('/').pop().split('\\').pop()
    if (!confirm(`ลบภาพ "${name}" ใช่ไหม? (label ที่ผูกอยู่จะถูกลบไปด้วย)`)) return
    setDeleting(true)
    try {
      await api.importDelete([lightbox.imgPath])
      const removedIdx = lightbox.imgIdx
      setImages(prev => prev.filter((_, i) => i !== removedIdx))
      setTotal(t => Math.max(0, t - 1))
      closeLightbox()
    } catch {
      alert('ลบไม่สำเร็จ')
    } finally {
      setDeleting(false)
    }
  }

  const boxCount    = (labelData?.labels || []).length
  const labelClasses = labelData
    ? [...new Set((labelData.labels || []).map(lb => {
        const id = Number(lb.class_id ?? 0)
        return labelData.classes?.[id] ?? `class ${id}`
      }))]
    : []

  const SPLITS = [
    { key: 'all',   label: 'ทั้งหมด', count: folders.length },
    { key: 'train', label: 'Train',   count: splitCounts.train || 0 },
    { key: 'val',   label: 'Val',     count: splitCounts.val   || 0 },
    { key: 'test',  label: 'Test',    count: splitCounts.test  || 0 },
  ]

  return (
    <div className="ds-page">
      {/* ── Header ── */}
      <div className="ds-header">
        <h1 className="page-title">ชุดข้อมูล</h1>
        <div className="ds-stats-row">
          <span className="ds-stat"><LayoutGrid size={13} /> {total} ภาพ</span>
          <span className="ds-stat ds-stat-green">{labeledCount} labeled</span>
          <span className="ds-stat ds-stat-purple">{totalAnn} annotations</span>
        </div>
      </div>

      {/* ── Split tabs ── */}
      <div className="ds-split-tabs">
        {SPLITS.map(s => (
          <button
            key={s.key}
            className={`ds-tab ${activeSplit === s.key ? 'active' : ''}`}
            onClick={() => { setActiveSplit(s.key); setActiveFolder(null); setImages([]); setPage(1) }}
          >
            {s.label}
            {s.count > 0 && <span className="ds-tab-badge">{s.count}</span>}
          </button>
        ))}
      </div>

      <div className="ds-layout">
        {/* ── Folder sidebar ── */}
        <div className="ds-sidebar">
          <div className="ds-sidebar-hd">
            <FolderOpen size={14} /> โฟลเดอร์
          </div>
          <div className="ds-folder-list">
            {foldersLoading && (
              <div className="ds-state"><Loader2 size={14} className="spin" /> กำลังโหลด...</div>
            )}
            {!foldersLoading && visibleFolders.length === 0 && (
              <div className="ds-state" style={{ color: 'var(--text-muted)' }}>ไม่พบโฟลเดอร์</div>
            )}
            {visibleFolders.map((f) => {
              const split = detectSplit(f)
              return (
                <button
                  key={f}
                  className={`ds-folder-item ${f === activeFolder ? 'active' : ''}`}
                  onClick={() => { if (f !== activeFolder) { setActiveFolder(f); setPage(1); setImages([]) } }}
                >
                  <FolderOpen size={13} className={`ds-fi-icon split-${split}`} />
                  <span className="ds-fi-label">{f}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* ── Image grid ── */}
        <div className="ds-main">
          {activeFolder ? (
            <>
              <div className="ds-toolbar">
                <span className="ds-folder-name">
                  <FolderOpen size={14} /> {activeFolder}
                </span>
                <span className="ds-count">{total} ภาพ · หน้า {page}/{totalPages}</span>
              </div>

              {loading ? (
                <div className="ds-state ds-state-full"><Loader2 size={18} className="spin" /> กำลังโหลด...</div>
              ) : images.length === 0 ? (
                <div className="ds-state ds-state-full"><Image size={40} style={{ opacity: 0.3 }} /> ไม่พบรูปภาพ</div>
              ) : (
                <>
                  <div className="ds-grid-wrap">
                    <div className="ds-grid">
                      {images.map((img, idx) => {
                        const imgPath = typeof img === 'string' ? img : img.path
                        const name    = imgPath.split('/').pop().split('\\').pop()
                        const labeled = img.labeled === 1 || img.labeled === true
                        const ann     = img.annotation_count || 0
                        return (
                          <div
                            key={imgPath}
                            className="ds-thumb"
                            onClick={() => openLightbox(imgPath, idx)}
                            title={name}
                          >
                            <img src={api.image(imgPath)} alt={name} loading="lazy" />
                            {ann > 0 && <span className="ds-ann-badge">{ann}</span>}
                            <div className="ds-thumb-footer">
                              <span className="ds-thumb-name">{name}</span>
                              <span className={`ds-label-dot ${labeled ? 'labeled' : 'unlabeled'}`}>
                                {labeled ? 'labeled' : 'unlabeled'}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  <div className="ds-pagination">
                    <button className="btn btn-outline" disabled={page <= 1}
                      onClick={() => setPage(p => Math.max(1, p - 1))}>
                      <ChevronLeft size={15} /> ก่อนหน้า
                    </button>
                    <span className="ds-page-info">หน้า {page} / {totalPages}</span>
                    <button className="btn btn-outline" disabled={page >= totalPages}
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}>
                      ถัดไป <ChevronRight size={15} />
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="ds-state ds-state-full">
              <FolderOpen size={40} style={{ opacity: 0.3 }} />
              เลือกโฟลเดอร์เพื่อดูรูปภาพ
            </div>
          )}
        </div>
      </div>

      {/* ── Full-screen lightbox ── */}
      {lightbox && (
        <div className="ds-lb-overlay" onClick={closeLightbox}>
          <div className="ds-lb" onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="ds-lb-header">
              <span className="ds-lb-title">
                {lightbox.imgPath.split('/').pop().split('\\').pop()}
                <span className="ds-lb-pos">{lightbox.imgIdx + 1} / {images.length}</span>
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" onClick={openInAnnotator}>
                  <Pencil size={14} /> เปิดใน Annotator
                </button>
                <button className="btn btn-outline ds-lb-delete" onClick={deleteCurrentImage} disabled={deleting}>
                  <Trash2 size={14} /> {deleting ? 'กำลังลบ...' : 'ลบภาพ'}
                </button>
                <button className="ds-lb-close" onClick={closeLightbox}><X size={18} /></button>
              </div>
            </div>

            {/* Image canvas */}
            <div className="ds-lb-body">
              <button
                className="ds-lb-nav ds-lb-nav-prev"
                onClick={() => goToImage(lightbox.imgIdx - 1)}
                disabled={lightbox.imgIdx <= 0}
                title="ภาพก่อนหน้า (←)"
              >
                <ChevronLeft size={22} />
              </button>
              {labelLoading ? (
                <div className="ds-state"><Loader2 size={18} className="spin" /> กำลังโหลด...</div>
              ) : (
                <div className="ds-lb-canvas-wrap">
                  <img
                    ref={imgRef}
                    src={api.image(lightbox.imgPath)}
                    alt={lightbox.imgPath}
                    onLoad={drawBoxes}
                  />
                  <canvas ref={canvasRef} />
                </div>
              )}
              <button
                className="ds-lb-nav ds-lb-nav-next"
                onClick={() => goToImage(lightbox.imgIdx + 1)}
                disabled={lightbox.imgIdx >= images.length - 1}
                title="ภาพถัดไป (→)"
              >
                <ChevronRight size={22} />
              </button>
            </div>

            {/* Footer */}
            <div className="ds-lb-footer">
              <div className="ds-lb-info">
                <Tag size={13} />
                <strong>{boxCount}</strong> bounding box{boxCount !== 1 ? 'es' : ''}
              </div>
              <div className="ds-lb-classes">
                {labelClasses.map((cls, i) => (
                  <span key={cls} className="badge" style={{ background: BOX_COLORS[i % BOX_COLORS.length] + '33', color: BOX_COLORS[i % BOX_COLORS.length] }}>
                    {cls}
                  </span>
                ))}
                {labelData === null && !labelLoading && (
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>ไม่มี label</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
