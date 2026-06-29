import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '../api/client'
import {
  ChevronLeft, ChevronRight, Undo2, Redo2, Trash2, XCircle,
  ZoomIn, ZoomOut, Save, Sparkles, Plus, MousePointer2,
  Square, Pentagon, Wand2, Cpu,
} from 'lucide-react'
import LMAssistant from '../components/LMAssistant'
import './Annotator.css'

const CLASS_COLORS = [
  '#6366f1','#22c55e','#ef4444','#eab308','#06b6d4',
  '#f97316','#a855f7','#ec4899','#14b8a6','#84cc16',
  '#f43f5e','#8b5cf6','#0ea5e9','#d946ef','#10b981',
]
const color = (idx) => CLASS_COLORS[idx % CLASS_COLORS.length]

const TOOL = { SELECT: 'select', BOX: 'box', POLYGON: 'polygon', SAM: 'sam' }

export default function Annotator() {
  /* ── data ── */
  const [folders, setFolders]     = useState([])
  const [folder, setFolder]       = useState('')
  const [imageList, setImageList] = useState([])
  const [imgIdx, setImgIdx]       = useState(0)

  const [classes, setClasses]         = useState([])
  const [activeClass, setActiveClass] = useState(0)
  const [newClassName, setNewClassName] = useState('')

  const [boxes, setBoxes]       = useState([])     // [[cid,cx,cy,w,h],...]
  const [polygons, setPolygons] = useState([])     // [{class_id, pts:[[nx,ny],...]}]
  const [selected, setSelected] = useState(null)   // {type:'box'|'poly', idx}

  const [history, setHistory] = useState([])       // [{boxes,polygons}]
  const [future, setFuture]   = useState([])

  /* ── tools ── */
  const [tool, setTool]           = useState(TOOL.BOX)
  const [polyDraft, setPolyDraft] = useState([])   // [[cx,cy]...] canvas px during draw
  const [hoverPt, setHoverPt]     = useState(null) // canvas px mouse pos

  /* ── SAM ── */
  const [samLoading, setSamLoading]   = useState(false)
  const [samModel, setSamModel]       = useState('sam2_b.pt')
  const [samPreview, setSamPreview]   = useState(null) // polygon pts (norm)

  /* ── smart YOLO suggestions ── */
  const [suggestions, setSuggestions] = useState([])
  const suggCacheRef = useRef({ img: null, dets: [] })

  /* ── LM ── */
  const [lmVisible, setLmVisible] = useState(false)

  /* ── UI ── */
  const [zoom, setZoom]     = useState(1)
  const [toast, setToast]   = useState(null)
  const [loading, setLoading] = useState(false)

  /* ── refs ── */
  const canvasRef  = useRef(null)
  const wrapRef    = useRef(null)
  const imgRef     = useRef(null)
  const imgNat     = useRef({ w: 1, h: 1 })
  const renderRect = useRef({ w: 1, h: 1, ox: 0, oy: 0 })

  /* ── helpers ── */
  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 2500)
  }

  function pushHistory(prevBoxes, prevPolys) {
    setHistory(h => [...h, { boxes: prevBoxes, polygons: prevPolys }])
    setFuture([])
  }
  function undo() {
    setHistory(h => {
      if (!h.length) return h
      const prev = h[h.length - 1]
      setFuture(f => [...f, { boxes, polygons }])
      setBoxes(prev.boxes)
      setPolygons(prev.polygons)
      setSelected(null)
      return h.slice(0, -1)
    })
  }
  function redo() {
    setFuture(f => {
      if (!f.length) return f
      const next = f[f.length - 1]
      setHistory(h => [...h, { boxes, polygons }])
      setBoxes(next.boxes)
      setPolygons(next.polygons)
      setSelected(null)
      return f.slice(0, -1)
    })
  }

  /* ── keyboard ── */
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT') return
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo() }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo() }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save() }
      if (e.key === 'Escape') { setPolyDraft([]); setSamPreview(null) }
      if (e.key === 'Enter' && tool === TOOL.POLYGON && polyDraft.length >= 3) closePolygon()
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) deleteSelected()
      if (!e.ctrlKey && !e.metaKey) {
        if (e.key === 'v' || e.key === 'V') setTool(TOOL.SELECT)
        if (e.key === 'b' || e.key === 'B') setTool(TOOL.BOX)
        if (e.key === 'p' || e.key === 'P') { setTool(TOOL.POLYGON); setPolyDraft([]) }
        if (e.key === 's' || e.key === 'S') setTool(TOOL.SAM)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /* ── load folders ── */
  useEffect(() => {
    api.folders().then(d => {
      const list = (d?.folders || []).map(f => (typeof f === 'string' ? f : f.path))
      setFolders(list)
      if (list.length) setFolder(list[0])
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!folder) return
    api.images(folder, 1, 9999).then(r => {
      setImageList((r.images || []).map(i => (typeof i === 'string' ? i : i.path)))
      setImgIdx(0)
    }).catch(() => setImageList([]))
  }, [folder])

  const currentImage = imageList[imgIdx] || null

  useEffect(() => {
    setSuggestions([])
    suggCacheRef.current = { img: null, dets: [] }
    setSamPreview(null)
    setPolyDraft([])
  }, [currentImage])

  useEffect(() => {
    if (tool !== TOOL.SAM) setSamPreview(null)
  }, [tool])

  /* ── load image + labels ── */
  useEffect(() => {
    if (!currentImage) return
    setBoxes([]); setPolygons([])
    setHistory([]); setFuture([])
    setSelected(null)

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      imgRef.current = img
      imgNat.current = { w: img.naturalWidth, h: img.naturalHeight }
      requestAnimationFrame(draw)
    }
    img.src = api.image(currentImage)

    api.labelExt(currentImage).then(data => {
      if (data.boxes?.length)    setBoxes(data.boxes.map(b => [...b]))
      if (data.polygons?.length) setPolygons(data.polygons)
      if (data.classes?.length) {
        setClasses(prev => {
          const merged = [...prev]
          data.classes.forEach(c => { if (!merged.includes(c)) merged.push(c) })
          return merged
        })
      }
    }).catch(() => {})
  }, [currentImage])

  /* ── render rect ── */
  function computeRect() {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap || !imgRef.current) return null
    const cw = wrap.clientWidth, ch = wrap.clientHeight
    canvas.width = cw; canvas.height = ch
    const { w: iw, h: ih } = imgNat.current
    const scale = Math.min(cw / iw, ch / ih) * zoom
    const rw = iw * scale, rh = ih * scale
    const ox = (cw - rw) / 2, oy = (ch - rh) / 2
    renderRect.current = { w: rw, h: rh, ox, oy }
    return { rw, rh, ox, oy, cw, ch }
  }

  /* ── draw ── */
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const r = computeRect()
    if (!r) return
    ctx.clearRect(0, 0, r.cw, r.ch)
    if (imgRef.current) ctx.drawImage(imgRef.current, r.ox, r.oy, r.rw, r.rh)

    // Draw polygons
    polygons.forEach((poly, i) => {
      const c = color(poly.class_id)
      const isSel = selected?.type === 'poly' && selected.idx === i
      drawPoly(ctx, poly.pts, r, c, isSel)
    })

    // Draw boxes
    boxes.forEach((box, i) => {
      const [cid, cx, cy, bw, bh] = box
      const c = color(cid)
      const isSel = selected?.type === 'box' && selected.idx === i
      const x = r.ox + (cx - bw / 2) * r.rw
      const y = r.oy + (cy - bh / 2) * r.rh
      const w = bw * r.rw, h = bh * r.rh
      ctx.strokeStyle = c; ctx.lineWidth = isSel ? 3 : 2
      ctx.strokeRect(x, y, w, h)
      ctx.fillStyle = c + (isSel ? '30' : '18')
      ctx.fillRect(x, y, w, h)
      const label = classes[cid] || `class_${cid}`
      drawLabel(ctx, label, x, y, c)
      if (isSel) drawHandles(ctx, [[x,y],[x+w,y],[x,y+h],[x+w,y+h]], c)
    })

    // SAM preview
    if (samPreview) {
      ctx.save()
      ctx.setLineDash([6, 3])
      ctx.strokeStyle = '#a855f7'; ctx.lineWidth = 2
      ctx.fillStyle = 'rgba(168,85,247,0.15)'
      ctx.beginPath()
      samPreview.forEach(([nx, ny], i) => {
        const px = r.ox + nx * r.rw, py = r.oy + ny * r.rh
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
      })
      ctx.closePath(); ctx.fill(); ctx.stroke()
      ctx.restore()
    }

    // YOLO smart suggestions ghost boxes
    if (tool === TOOL.SAM && suggestions.length) {
      const iw = imgNat.current.w, ih = imgNat.current.h
      ctx.setLineDash([5, 4])
      suggestions.forEach(det => {
        const [x1, y1, x2, y2] = det.bbox
        const gx = r.ox + (x1 / iw) * r.rw, gy = r.oy + (y1 / ih) * r.rh
        const gw = ((x2 - x1) / iw) * r.rw, gh = ((y2 - y1) / ih) * r.rh
        ctx.strokeStyle = 'rgba(139,92,246,0.8)'; ctx.lineWidth = 1.5
        ctx.strokeRect(gx, gy, gw, gh)
      })
      ctx.setLineDash([])
    }

    // Box being drawn (drag preview)
    if (tool === TOOL.BOX && boxDrawRef.current && hoverPt) {
      const { sx, sy } = boxDrawRef.current
      const [ex, ey] = hoverPt
      const c = color(activeClass)
      ctx.save()
      ctx.setLineDash([6, 3])
      ctx.strokeStyle = c; ctx.lineWidth = 2
      ctx.fillStyle = c + '20'
      const bx = Math.min(sx, ex), by = Math.min(sy, ey)
      const bw = Math.abs(ex - sx), bh = Math.abs(ey - sy)
      ctx.fillRect(bx, by, bw, bh)
      ctx.strokeRect(bx, by, bw, bh)
      ctx.restore()
    }

    // Polygon in progress
    if (tool === TOOL.POLYGON && polyDraft.length) {
      const c = color(activeClass)
      ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.fillStyle = c + '20'
      ctx.beginPath()
      polyDraft.forEach(([px, py], i) => i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py))
      if (hoverPt) ctx.lineTo(hoverPt[0], hoverPt[1])
      ctx.stroke()
      polyDraft.forEach(([px, py], i) => {
        ctx.beginPath(); ctx.arc(px, py, i === 0 ? 6 : 4, 0, Math.PI * 2)
        ctx.fillStyle = i === 0 ? c : '#fff'; ctx.fill()
        ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke()
      })
    }
  }, [boxes, polygons, selected, zoom, tool, polyDraft, hoverPt, activeClass, classes, suggestions, samPreview])

  function drawPoly(ctx, pts, r, c, isSel) {
    if (!pts?.length) return
    ctx.beginPath()
    pts.forEach(([nx, ny], i) => {
      const px = r.ox + nx * r.rw, py = r.oy + ny * r.rh
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
    })
    ctx.closePath()
    ctx.fillStyle = c + (isSel ? '40' : '25')
    ctx.fill()
    ctx.strokeStyle = c; ctx.lineWidth = isSel ? 3 : 2; ctx.stroke()
    if (isSel) {
      pts.forEach(([nx, ny]) => {
        const px = r.ox + nx * r.rw, py = r.oy + ny * r.rh
        ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2)
        ctx.fillStyle = '#fff'; ctx.fill()
        ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke()
      })
    }
  }

  function drawLabel(ctx, text, x, y, c) {
    ctx.font = '12px Inter,system-ui,sans-serif'
    const tw = ctx.measureText(text).width
    ctx.fillStyle = c; ctx.fillRect(x, y - 18, tw + 10, 18)
    ctx.fillStyle = '#fff'; ctx.fillText(text, x + 5, y - 5)
  }

  function drawHandles(ctx, corners, c) {
    corners.forEach(([hx, hy]) => {
      ctx.fillStyle = '#fff'; ctx.fillRect(hx - 3, hy - 3, 6, 6)
      ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.strokeRect(hx - 3, hy - 3, 6, 6)
    })
  }

  useEffect(() => { draw() }, [draw])

  useEffect(() => {
    const wrap = wrapRef.current; if (!wrap) return
    const ro = new ResizeObserver(() => requestAnimationFrame(draw))
    ro.observe(wrap); return () => ro.disconnect()
  }, [draw])

  /* ── coord helpers ── */
  function canvasPos(e) {
    const rect = canvasRef.current.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }
  function normPos(cx, cy) {
    const { w, h, ox, oy } = renderRect.current
    return [(cx - ox) / w, (cy - oy) / h]
  }
  function clamp01(v) { return Math.max(0, Math.min(1, v)) }

  /* ── drawing state for BOX ── */
  const boxDrawRef = useRef(null)

  function onMouseDown(e) {
    if (e.button !== 0) return
    const [cx, cy] = canvasPos(e)

    if (tool === TOOL.SELECT) {
      hitTest(cx, cy)
      return
    }

    if (tool === TOOL.BOX) {
      boxDrawRef.current = { sx: cx, sy: cy }
      return
    }

    if (tool === TOOL.POLYGON) {
      // check close to first point
      if (polyDraft.length >= 3) {
        const [fx, fy] = polyDraft[0]
        if (Math.hypot(cx - fx, cy - fy) < 10) { closePolygon(); return }
      }
      setPolyDraft(prev => [...prev, [cx, cy]])
      return
    }

    if (tool === TOOL.SAM) {
      handleSamClick(cx, cy)
    }
  }

  function onMouseMove(e) {
    const [cx, cy] = canvasPos(e)
    setHoverPt([cx, cy])

    if (tool === TOOL.BOX && boxDrawRef.current) {
      // draw preview via requestAnimationFrame
      requestAnimationFrame(draw)
    }
  }

  function onMouseUp(e) {
    if (tool === TOOL.BOX && boxDrawRef.current) {
      const [cx, cy] = canvasPos(e)
      const { sx, sy } = boxDrawRef.current
      boxDrawRef.current = null
      finishBox(sx, sy, cx, cy)
    }
  }

  function finishBox(sx, sy, ex, ey) {
    if (Math.abs(ex - sx) < 4 || Math.abs(ey - sy) < 4) return
    const [nx1, ny1] = normPos(sx, sy)
    const [nx2, ny2] = normPos(ex, ey)
    const x1 = clamp01(Math.min(nx1, nx2)), y1 = clamp01(Math.min(ny1, ny2))
    const x2 = clamp01(Math.max(nx1, nx2)), y2 = clamp01(Math.max(ny1, ny2))
    if (x2 - x1 < 0.001 || y2 - y1 < 0.001) return
    const cid = ensureClass()
    pushHistory([...boxes], [...polygons])
    setBoxes(prev => [...prev, [cid, (x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1]])
    setSelected({ type: 'box', idx: boxes.length })
  }

  function closePolygon() {
    if (polyDraft.length < 3) return
    const pts = polyDraft.map(([cx, cy]) => {
      const [nx, ny] = normPos(cx, cy)
      return [clamp01(nx), clamp01(ny)]
    })
    const cid = ensureClass()
    pushHistory([...boxes], [...polygons])
    setPolygons(prev => [...prev, { class_id: cid, pts }])
    setSelected({ type: 'poly', idx: polygons.length })
    setPolyDraft([])
  }

  /* ── SAM click ── */
  async function handleSamClick(cx, cy) {
    if (!currentImage || !imgRef.current || samLoading) return
    const [nx, ny] = normPos(cx, cy)
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return

    setSamLoading(true)
    setSamPreview(null)
    try {
      const iw = imgNat.current.w, ih = imgNat.current.h
      const canvas2 = document.createElement('canvas')
      canvas2.width = iw; canvas2.height = ih
      canvas2.getContext('2d').drawImage(imgRef.current, 0, 0)
      const blob = await new Promise(r => canvas2.toBlob(r, 'image/jpeg', 0.9))
      const fd = new FormData()
      fd.append('image', blob, 'img.jpg')
      fd.append('points', JSON.stringify([[nx * iw, ny * ih]]))
      fd.append('model', samModel)
      const res = await api.samPredict(fd)
      if (res.ok && res.polygons?.length) {
        setSamPreview(res.polygons[0])
      } else {
        showToast('SAM ไม่พบวัตถุ', 'error')
      }
    } catch (err) {
      showToast('SAM error: ' + err.message, 'error')
    } finally {
      setSamLoading(false)
    }
  }

  function applySamPreview() {
    if (!samPreview) return
    const cid = ensureClass()
    pushHistory([...boxes], [...polygons])
    setPolygons(prev => [...prev, { class_id: cid, pts: samPreview }])
    setSamPreview(null)
    showToast('เพิ่ม SAM polygon สำเร็จ')
  }

  /* ── hit test for SELECT ── */
  function hitTest(cx, cy) {
    const { w: rw, h: rh, ox, oy } = renderRect.current
    // check polygons first (top layer)
    for (let i = polygons.length - 1; i >= 0; i--) {
      if (pointInPolygon(cx, cy, polygons[i].pts, rw, rh, ox, oy)) {
        setSelected({ type: 'poly', idx: i }); return
      }
    }
    // check boxes
    for (let i = boxes.length - 1; i >= 0; i--) {
      const [, bCx, bCy, bw, bh] = boxes[i]
      const x1 = ox + (bCx - bw / 2) * rw, y1 = oy + (bCy - bh / 2) * rh
      if (cx >= x1 && cx <= x1 + bw * rw && cy >= y1 && cy <= y1 + bh * rh) {
        setSelected({ type: 'box', idx: i }); return
      }
    }
    setSelected(null)
  }

  function pointInPolygon(cx, cy, pts, rw, rh, ox, oy) {
    let inside = false
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = ox + pts[i][0] * rw, yi = oy + pts[i][1] * rh
      const xj = ox + pts[j][0] * rw, yj = oy + pts[j][1] * rh
      if ((yi > cy) !== (yj > cy) && cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }

  /* ── delete ── */
  function deleteSelected() {
    if (!selected) return
    pushHistory([...boxes], [...polygons])
    if (selected.type === 'box') setBoxes(prev => prev.filter((_, i) => i !== selected.idx))
    else setPolygons(prev => prev.filter((_, i) => i !== selected.idx))
    setSelected(null)
  }

  function clearAll() {
    if (!boxes.length && !polygons.length) return
    pushHistory([...boxes], [...polygons])
    setBoxes([]); setPolygons([]); setSelected(null)
  }

  /* ── class management ── */
  function ensureClass() {
    if (classes.length === 0) {
      setClasses(['default']); setActiveClass(0); return 0
    }
    return activeClass
  }

  function addClass() {
    const name = newClassName.trim()
    if (!name || classes.includes(name)) return
    setClasses(prev => [...prev, name])
    setActiveClass(classes.length)
    setNewClassName('')
  }

  /* ── save ── */
  async function save() {
    if (!currentImage) return
    setLoading(true)
    try {
      await api.saveLabelExt({ image_path: currentImage, boxes, polygons, classes })
      showToast('บันทึกสำเร็จ')
    } catch (err) {
      showToast('บันทึกล้มเหลว: ' + err.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  /* ── LM apply ── */
  function handleApplyDetections(newBoxes, classNames) {
    pushHistory([...boxes], [...polygons])
    const upd = [...classes]
    const resolved = newBoxes.map((box, i) => {
      const name = classNames[i]; let cid = upd.indexOf(name)
      if (cid < 0) { upd.push(name); cid = upd.length - 1 }
      return [cid, box[1], box[2], box[3], box[4]]
    })
    setClasses(upd); setBoxes(prev => [...prev, ...resolved])
    showToast(`เพิ่ม ${resolved.length} วัตถุจาก LM`)
  }

  function handleRefineBox(boxIdx, newCoords) {
    if (boxIdx < 0 || boxIdx >= boxes.length) return
    pushHistory([...boxes], [...polygons])
    setBoxes(prev => prev.map((b, i) => i === boxIdx ? [b[0], newCoords[1], newCoords[2], newCoords[3], newCoords[4]] : b))
    showToast('ปรับกรอบสำเร็จ')
  }

  /* ── counts ── */
  function annCount(cid) {
    return boxes.filter(b => b[0] === cid).length + polygons.filter(p => p.class_id === cid).length
  }
  const totalAnn = boxes.length + polygons.length

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Annotator</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {loading && <><div className="ann-spinner" /><span style={{ fontSize: 13, color: 'var(--text-muted)' }}>กำลังบันทึก...</span></>}
          {samLoading && <><div className="ann-spinner" /><span style={{ fontSize: 13, color: 'var(--text-muted)' }}>SAM กำลังวิเคราะห์...</span></>}
        </div>
      </div>

      <div className="annotator-layout">
        {/* ── Left: class panel ── */}
        <div className="ann-sidebar">
          <div className="ann-sidebar-header">
            Classes ({classes.length})
            <span className="ann-sidebar-badge">{totalAnn} ann</span>
          </div>
          <div className="ann-class-list">
            {!classes.length && (
              <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 12 }}>
                ยังไม่มีคลาส — พิมพ์ด้านล่าง
              </div>
            )}
            {classes.map((cls, i) => (
              <div
                key={i}
                className={`ann-class-item${activeClass === i ? ' active' : ''}`}
                onClick={() => setActiveClass(i)}
              >
                <div className="ann-class-swatch" style={{ background: color(i) }} />
                <span className="ann-class-name">{cls}</span>
                <span className="ann-class-count">{annCount(i)}</span>
              </div>
            ))}
          </div>
          <div className="ann-add-class">
            <input
              placeholder="ชื่อคลาสใหม่..."
              value={newClassName}
              onChange={e => setNewClassName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addClass()}
            />
            <button className="ann-add-btn" onClick={addClass}><Plus size={14} /></button>
          </div>

          {/* SAM model selector */}
          <div className="ann-sam-config">
            <div className="ann-sam-label">SAM Model</div>
            <select value={samModel} onChange={e => setSamModel(e.target.value)} className="ann-sam-select">
              <option value="sam2_b.pt">SAM2 Base</option>
              <option value="sam2_t.pt">SAM2 Tiny</option>
              <option value="sam2_l.pt">SAM2 Large</option>
              <option value="sam_b.pt">SAM Base (v1)</option>
              <option value="sam_l.pt">SAM Large (v1)</option>
            </select>
          </div>

          {/* SAM preview confirm */}
          {samPreview && (
            <div className="ann-sam-preview">
              <div className="ann-sam-preview-title">SAM Preview</div>
              <div className="ann-sam-preview-info">{samPreview.length} จุด</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="ann-sam-apply" onClick={applySamPreview}>ใช้งาน</button>
                <button className="ann-sam-discard" onClick={() => setSamPreview(null)}>ทิ้ง</button>
              </div>
            </div>
          )}
        </div>

        {/* ── Center: canvas ── */}
        <div className="ann-main">
          {/* Toolbar */}
          <div className="ann-toolbar">
            {/* Tool group */}
            <div className="ann-tool-group">
              <button
                className={`ann-tool-btn${tool === TOOL.SELECT ? ' active' : ''}`}
                onClick={() => setTool(TOOL.SELECT)} title="Select (V)">
                <MousePointer2 size={14} />
              </button>
              <button
                className={`ann-tool-btn${tool === TOOL.BOX ? ' active' : ''}`}
                onClick={() => setTool(TOOL.BOX)} title="Draw Box (B)">
                <Square size={14} />
              </button>
              <button
                className={`ann-tool-btn${tool === TOOL.POLYGON ? ' active' : ''}`}
                onClick={() => { setTool(TOOL.POLYGON); setPolyDraft([]) }} title="Polygon (P) — Enter to close">
                <Pentagon size={14} />
              </button>
              <button
                className={`ann-tool-btn${tool === TOOL.SAM ? ' active' : ''}`}
                onClick={() => setTool(TOOL.SAM)} title="SAM Auto-Segment (S)" disabled={samLoading}>
                <Wand2 size={14} />
                {samLoading && <span className="ann-spinner-inline" />}
              </button>
            </div>

            <div className="divider" />

            {/* Polygon draft controls */}
            {tool === TOOL.POLYGON && polyDraft.length >= 3 && (
              <>
                <button className="ann-tool-btn save" onClick={closePolygon}>
                  ปิด polygon ({polyDraft.length} จุด)
                </button>
                <button className="ann-tool-btn" onClick={() => setPolyDraft([])}>ยกเลิก</button>
                <div className="divider" />
              </>
            )}

            {/* History */}
            <button className="ann-tool-btn" onClick={undo} disabled={!history.length} title="Ctrl+Z"><Undo2 size={14} /></button>
            <button className="ann-tool-btn" onClick={redo} disabled={!future.length} title="Ctrl+Y"><Redo2 size={14} /></button>
            <button className="ann-tool-btn" onClick={deleteSelected} disabled={!selected} title="Delete"><Trash2 size={14} /></button>
            <button className="ann-tool-btn" onClick={clearAll} disabled={!totalAnn} title="ล้างทั้งหมด"><XCircle size={14} /></button>

            <div className="divider" />

            {/* Zoom */}
            <button className="ann-tool-btn" onClick={() => setZoom(z => Math.max(z - 0.25, 0.25))}><ZoomOut size={14} /></button>
            <span className="ann-zoom-label">{Math.round(zoom * 100)}%</span>
            <button className="ann-tool-btn" onClick={() => setZoom(z => Math.min(z + 0.25, 5))}><ZoomIn size={14} /></button>

            <div className="divider" />

            <button className="ann-tool-btn save" onClick={save} disabled={!currentImage || loading}>
              <Save size={14} /> บันทึก
            </button>
            <button
              className={`ann-tool-btn${lmVisible ? ' detect' : ''}`}
              onClick={() => setLmVisible(v => !v)} title="LM Assistant">
              <Sparkles size={14} /> Ask LM
            </button>
          </div>

          {/* Canvas */}
          <div className="ann-canvas-wrap" ref={wrapRef}
            style={{ cursor: tool === TOOL.SAM || tool === TOOL.POLYGON ? 'crosshair' : tool === TOOL.BOX ? 'crosshair' : 'default' }}>
            {currentImage ? (
              <canvas
                ref={canvasRef}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={() => { boxDrawRef.current = null; setHoverPt(null) }}
                onDoubleClick={() => { if (tool === TOOL.POLYGON && polyDraft.length >= 3) closePolygon() }}
              />
            ) : (
              <div className="ann-empty-state">
                <MousePointer2 size={40} style={{ marginBottom: 12, opacity: 0.4 }} />
                <div>เลือกโฟลเดอร์และภาพเพื่อเริ่ม Annotate</div>
              </div>
            )}
          </div>

          {/* Nav bar */}
          <div className="ann-nav-bar">
            <select value={folder} onChange={e => setFolder(e.target.value)}>
              {!folders.length && <option value="">-- ไม่พบโฟลเดอร์ --</option>}
              {folders.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
            <button className="ann-nav-btn" onClick={() => setImgIdx(i => i - 1)} disabled={imgIdx <= 0}>
              <ChevronLeft size={14} /> ก่อนหน้า
            </button>
            <span className="ann-nav-info">
              {imageList.length ? `${imgIdx + 1} / ${imageList.length}` : 'ไม่มีภาพ'}
            </span>
            <button className="ann-nav-btn" onClick={() => setImgIdx(i => i + 1)} disabled={imgIdx >= imageList.length - 1}>
              ถัดไป <ChevronRight size={14} />
            </button>
            <div style={{ flex: 1 }} />
            <div className="ann-stats">
              <span className="ann-stat-badge">☐ {boxes.length}</span>
              <span className="ann-stat-badge">⬡ {polygons.length}</span>
            </div>
          </div>
        </div>

        {/* ── LM panel ── */}
        <LMAssistant
          imageRef={imgRef}
          boxes={boxes}
          classes={classes}
          onApplyDetections={handleApplyDetections}
          onRefineBox={handleRefineBox}
          imagePath={currentImage}
          visible={lmVisible}
          onToggle={() => setLmVisible(v => !v)}
          imgNat={imgNat.current}
        />
      </div>

      {toast && <div className={`ann-toast ${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}
