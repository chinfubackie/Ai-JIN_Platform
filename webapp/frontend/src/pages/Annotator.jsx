import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '../api/client'
import {
  ChevronLeft, ChevronRight, Undo2, Redo2, Trash2, XCircle,
  ZoomIn, ZoomOut, Save, Sparkles, Plus, MousePointer2,
  Square, Pentagon, Wand2, Zap, ArrowRight, CheckCircle2,
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
  Layers, Tag, Play, Pause,
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
  const [labeledSet, setLabeledSet] = useState(new Set())

  const [projects, setProjects]   = useState([])
  const [projectId, setProjectId] = useState('')

  const [classes, setClasses]         = useState([])
  const [activeClass, setActiveClass] = useState(0)
  const [newClassName, setNewClassName] = useState('')

  const [boxes, setBoxes]       = useState([])
  const [polygons, setPolygons] = useState([])
  const [selected, setSelected] = useState(null)   // {type:'box'|'poly', idx}

  const [history, setHistory] = useState([])
  const [future, setFuture]   = useState([])

  /* ── tools ── */
  const [tool, setTool]           = useState(TOOL.BOX)
  const [polyDraft, setPolyDraft] = useState([])
  const [hoverPt, setHoverPt]     = useState(null)

  /* ── SAM ── */
  const [samLoading, setSamLoading]   = useState(false)
  const [samModel, setSamModel]       = useState('sam2_b.pt')
  const [samPreview, setSamPreview]   = useState(null)
  const [sam3ConceptText, setSam3ConceptText] = useState('')
  const [sam3Status, setSam3Status] = useState(null)

  /* ── auto-label ── */
  const [autoLoading, setAutoLoading] = useState(false)
  const [autoModels, setAutoModels] = useState([])
  const [autoModel, setAutoModel] = useState('')
  const [batchLoading, setBatchLoading] = useState(false)

  /* ── auto-play (auto-detect each image, dwell, auto-advance) ── */
  const [autoPlay, setAutoPlay]           = useState(false)
  const [autoPlayDelay, setAutoPlayDelay] = useState(2)

  /* ── LM ── */
  const [lmVisible, setLmVisible] = useState(false)

  /* ── UI ── */
  const [zoom, setZoom]       = useState(1)
  const [toast, setToast]     = useState(null)
  const [loading, setLoading] = useState(false)
  const [leftOpen, setLeftOpen]   = useState(true)
  const [rightOpen, setRightOpen] = useState(true)

  /* ── refs ── */
  const canvasRef  = useRef(null)
  const wrapRef    = useRef(null)
  const imgRef     = useRef(null)
  const imgNat     = useRef({ w: 1, h: 1 })
  const loadedImageRef = useRef(null) // path of the image currently loaded into imgRef/imgNat
  const renderRect = useRef({ w: 1, h: 1, ox: 0, oy: 0 })
  const boxDrawRef = useRef(null)
  const drawRef    = useRef(null)
  const autoPlayRef = useRef(false)
  const autoPlayTimeoutRef = useRef(null)

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
      setBoxes(prev.boxes); setPolygons(prev.polygons); setSelected(null)
      return h.slice(0, -1)
    })
  }
  function redo() {
    setFuture(f => {
      if (!f.length) return f
      const next = f[f.length - 1]
      setHistory(h => [...h, { boxes, polygons }])
      setBoxes(next.boxes); setPolygons(next.polygons); setSelected(null)
      return f.slice(0, -1)
    })
  }

  /* ── lock page scroll while annotator is mounted ── */
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  /* ── load projects ── */
  useEffect(() => {
    api.projects().then(data => setProjects(Array.isArray(data) ? data : [])).catch(() => {})
  }, [])

  /* ── load models for auto-label ── */
  useEffect(() => {
    api.models().then(data => {
      const list = Array.isArray(data) ? data : data.models || data.registry || []
      setAutoModels(list)
      const deployed = data?.active?.active_model
      if (deployed) setAutoModel(deployed)
      else if (list.length > 0) setAutoModel(list[0].path || list[0].best_pt || list[0].name || '')
    }).catch(() => setAutoModels([]))
  }, [])

  /* ── persist: save folder index + classes on change ── */
  useEffect(() => {
    if (folder) localStorage.setItem('ann_last_folder', folder)
  }, [folder])

  useEffect(() => {
    if (folder) localStorage.setItem(`ann_idx_${folder}`, imgIdx)
  }, [folder, imgIdx])

  useEffect(() => {
    if (folder && classes.length > 0)
      localStorage.setItem(`ann_classes_${folder}`, JSON.stringify(classes))
  }, [folder, classes])

  useEffect(() => {
    if (folder) localStorage.setItem(`ann_project_${folder}`, projectId)
  }, [folder, projectId])

  /* ── restore state when folder loaded ── */
  useEffect(() => {
    if (!folder) return
    // Restore saved classes
    const savedClasses = localStorage.getItem(`ann_classes_${folder}`)
    if (savedClasses) {
      try { setClasses(JSON.parse(savedClasses)) } catch {}
    }
    // Restore saved project
    const savedProject = localStorage.getItem(`ann_project_${folder}`)
    if (savedProject !== null) setProjectId(savedProject)
  }, [folder])

  /* ── load classes from DB when project changes ── */
  useEffect(() => {
    if (!projectId) return
    api.projectClasses(parseInt(projectId)).then(data => {
      if (Array.isArray(data) && data.length > 0) {
        const names = data.map(c => c.name)
        setClasses(prev => {
          const merged = [...prev]
          names.forEach(n => { if (!merged.includes(n)) merged.push(n) })
          return merged
        })
      }
    }).catch(() => {})
  }, [projectId])

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
        if (e.key === 'ArrowRight') saveAndNext()
        if (e.key === 'ArrowLeft' && imgIdx > 0) setImgIdx(i => i - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /* ── wheel-to-zoom (passive:false to allow preventDefault) ── */
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      setZoom(z => Math.max(0.25, Math.min(5, z + (e.deltaY < 0 ? 0.1 : -0.1))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  /* ── load folders ── */
  useEffect(() => {
    api.folders().then(d => {
      const list = (d?.folders || []).map(f => (typeof f === 'string' ? f : f.path))
      setFolders(list)
      // Use saved folder if it exists in the list, otherwise default to first
      const saved = localStorage.getItem('ann_last_folder')
      const pick = saved && list.includes(saved) ? saved : list[0]
      if (pick) setFolder(pick)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!folder) return
    api.images(folder, 1, 9999).then(r => {
      const imgs = (r.images || []).map(i => (typeof i === 'string' ? i : i.path))
      setImageList(imgs)
      // Restore saved index (clamped to list length)
      const savedIdx = localStorage.getItem(`ann_idx_${folder}`)
      const startIdx = savedIdx !== null
        ? Math.min(Math.max(0, parseInt(savedIdx, 10)), Math.max(0, imgs.length - 1))
        : 0
      setImgIdx(startIdx)
      setLabeledSet(new Set())
    }).catch(() => setImageList([]))
  }, [folder])

  const currentImage = imageList[imgIdx] || null

  useEffect(() => {
    setSamPreview(null)
    setPolyDraft([])
  }, [currentImage])

  useEffect(() => {
    if (tool !== TOOL.SAM) setSamPreview(null)
  }, [tool])

  useEffect(() => {
    if (samModel !== 'sam3') return
    let cancelled = false
    api.sam3Status()
      .then(status => { if (!cancelled) setSam3Status(status) })
      .catch(err => {
        if (!cancelled) {
          setSam3Status({ available: false, model_exists: false, error: err.message })
        }
      })
    return () => { cancelled = true }
  }, [samModel])

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
      loadedImageRef.current = currentImage
      requestAnimationFrame(() => drawRef.current?.())
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
      if (data.boxes?.length || data.polygons?.length) {
        setLabeledSet(s => new Set([...s, currentImage]))
      }
    }).catch(() => {})
  }, [currentImage])

  /* ── render rect ── */
  const computeRect = useCallback(() => {
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
  }, [zoom])

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
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.closePath(); ctx.fill(); ctx.stroke()
      ctx.restore()
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
  }, [boxes, polygons, selected, tool, polyDraft, hoverPt, activeClass, classes, samPreview, computeRect])

  useEffect(() => {
    drawRef.current = draw
  }, [draw])

  function drawPoly(ctx, pts, r, c, isSel) {
    if (!pts?.length) return
    ctx.beginPath()
    pts.forEach(([nx, ny], i) => {
      const px = r.ox + nx * r.rw, py = r.oy + ny * r.rh
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    })
    ctx.closePath()
    ctx.fillStyle = c + (isSel ? '40' : '25'); ctx.fill()
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
    ctx.font = '11px Inter,system-ui,sans-serif'
    const tw = ctx.measureText(text).width
    ctx.fillStyle = c; ctx.fillRect(x, y - 16, tw + 8, 16)
    ctx.fillStyle = '#fff'; ctx.fillText(text, x + 4, y - 4)
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

  /* ── mouse events ── */
  function onMouseDown(e) {
    if (e.button !== 0) return
    const [cx, cy] = canvasPos(e)
    if (tool === TOOL.SELECT) { hitTest(cx, cy); return }
    if (tool === TOOL.BOX) { boxDrawRef.current = { sx: cx, sy: cy }; return }
    if (tool === TOOL.POLYGON) {
      if (polyDraft.length >= 3) {
        const [fx, fy] = polyDraft[0]
        if (Math.hypot(cx - fx, cy - fy) < 12) { closePolygon(); return }
      }
      setPolyDraft(prev => [...prev, [cx, cy]]); return
    }
    if (tool === TOOL.SAM) handleSamClick(cx, cy)
  }

  function onMouseMove(e) {
    const [cx, cy] = canvasPos(e)
    setHoverPt([cx, cy])
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
    if (x2 - x1 < 0.002 || y2 - y1 < 0.002) return
    const cid = ensureClass()
    pushHistory([...boxes], [...polygons])
    setBoxes(prev => [...prev, [cid, (x1+x2)/2, (y1+y2)/2, x2-x1, y2-y1]])
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

  /* ── SAM ── */
  async function handleSamClick(cx, cy) {
    if (!currentImage || !imgRef.current || samLoading) return
    if (samModel === 'sam3') {
      showToast('ใช้ Segment by Concept สำหรับ SAM 3', 'error')
      return
    }
    const [nx, ny] = normPos(cx, cy)
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return
    setSamLoading(true); setSamPreview(null)
    try {
      const iw = imgNat.current.w, ih = imgNat.current.h
      const c2 = document.createElement('canvas')
      c2.width = iw; c2.height = ih
      c2.getContext('2d').drawImage(imgRef.current, 0, 0)
      const blob = await new Promise(r => c2.toBlob(r, 'image/jpeg', 0.9))
      const fd = new FormData()
      fd.append('image', blob, 'img.jpg')
      fd.append('points', JSON.stringify([[nx * iw, ny * ih]]))
      fd.append('model', samModel)
      const res = await api.samPredict(fd)
      if (res.ok && res.polygons?.length) setSamPreview(res.polygons[0])
      else showToast('SAM ไม่พบวัตถุ', 'error')
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

  function selectedBoxToSam3Bbox() {
    if (selected?.type !== 'box') return null
    const box = boxes[selected.idx]
    if (!box) return null
    const [, cx, cy, bw, bh] = box
    const iw = imgNat.current.w, ih = imgNat.current.h
    return [
      (cx - bw / 2) * iw,
      (cy - bh / 2) * ih,
      (cx + bw / 2) * iw,
      (cy + bh / 2) * ih,
    ].map(v => Math.round(v * 100) / 100)
  }

  function addSam3Results(res, fallbackNames) {
    if (!res.boxes?.length) {
      showToast('SAM3 ไม่พบวัตถุตาม prompt', 'error')
      return
    }
    const iw = imgNat.current.w, ih = imgNat.current.h
    pushHistory([...boxes], [...polygons])
    const upd = [...classes]
    const newBoxes = res.boxes.map((bbox, idx) => {
      const name = res.labels?.[idx] || fallbackNames[idx % fallbackNames.length] || 'concept'
      let cid = upd.indexOf(name)
      if (cid < 0) { upd.push(name); cid = upd.length - 1 }
      const [x1, y1, x2, y2] = bbox
      const cx = (x1 + x2) / (2 * iw), cy = (y1 + y2) / (2 * ih)
      const bw = (x2 - x1) / iw, bh = (y2 - y1) / ih
      return [cid, cx, cy, bw, bh]
    })
    setClasses(upd)
    setBoxes(prev => [...prev, ...newBoxes])
    showToast(`SAM3: พบ ${newBoxes.length} วัตถุ`)
  }

  async function segmentByConcept() {
    if (!currentImage || !imgRef.current || samLoading) return
    const prompts = sam3ConceptText.split(',').map(s => s.trim()).filter(Boolean)
    if (!prompts.length) {
      showToast('ใส่ concept prompt ก่อน', 'error')
      return
    }
    setSamLoading(true)
    try {
      const res = await api.sam3Predict({
        image_path: currentImage,
        text: prompts,
        conf: 0.25,
      })
      if (res.error) {
        showToast(`${res.error}${res.hint ? ` ${res.hint}` : ''}`, 'error')
        return
      }
      addSam3Results(res, prompts)
    } catch (err) {
      showToast('SAM3 ล้มเหลว: ' + err.message, 'error')
    } finally {
      setSamLoading(false)
    }
  }

  async function segmentBySelectedBox() {
    if (!currentImage || !imgRef.current || samLoading) return
    const bbox = selectedBoxToSam3Bbox()
    if (!bbox) {
      showToast('เลือก box ตัวอย่างก่อน', 'error')
      return
    }
    setSamLoading(true)
    try {
      const selectedClass = classes[boxes[selected.idx]?.[0]] || 'exemplar'
      const res = await api.sam3Predict({
        image_path: currentImage,
        bboxes: [bbox],
        conf: 0.25,
      })
      if (res.error) {
        showToast(`${res.error}${res.hint ? ` ${res.hint}` : ''}`, 'error')
        return
      }
      addSam3Results(res, [selectedClass])
    } catch (err) {
      showToast('SAM3 exemplar ล้มเหลว: ' + err.message, 'error')
    } finally {
      setSamLoading(false)
    }
  }

  /* ── Auto-label (YOLO) ── */
  async function autoLabel() {
    if (!currentImage || !imgRef.current || autoLoading) return
    setAutoLoading(true)
    try {
      const iw = imgNat.current.w, ih = imgNat.current.h
      const c2 = document.createElement('canvas')
      c2.width = iw; c2.height = ih
      c2.getContext('2d').drawImage(imgRef.current, 0, 0)
      const blob = await new Promise(r => c2.toBlob(r, 'image/jpeg', 0.92))
      const fd = new FormData()
      fd.append('image', blob, 'img.jpg')
      if (autoModel) fd.append('model', autoModel)
      const res = await api.predictLocal(fd)
      if (!res.detections?.length) { showToast('ไม่พบวัตถุ', 'error'); return }
      pushHistory([...boxes], [...polygons])
      const upd = [...classes]
      const newBoxes = res.detections.map(d => {
        const name = d.class_name || d.class || `class_${d.class_id ?? 0}`
        let cid = upd.indexOf(name)
        if (cid < 0) { upd.push(name); cid = upd.length - 1 }
        const [x1,y1,x2,y2] = d.bbox
        const cx = (x1+x2)/(2*iw), cy = (y1+y2)/(2*ih)
        const bw = (x2-x1)/iw, bh = (y2-y1)/ih
        return [cid, cx, cy, bw, bh]
      })
      setClasses(upd)
      setBoxes(prev => [...prev, ...newBoxes])
      showToast(`Auto-label: พบ ${newBoxes.length} วัตถุ`)
    } catch (err) {
      showToast('Auto-label ล้มเหลว: ' + err.message, 'error')
    } finally {
      setAutoLoading(false)
    }
  }

  /* ── Auto-label whole folder (batch) ── */
  async function autoLabelFolder() {
    if (!folder || batchLoading) return
    setBatchLoading(true)
    try {
      const res = await api.autolabelBatch({ folder, model: autoModel, conf: 0.25, iou: 0.45 })
      if (!res.ok) { showToast(res.error || 'Auto-label ทั้งโฟลเดอร์ล้มเหลว', 'error'); return }
      showToast(`Auto-label ทั้งโฟลเดอร์: ${res.labeled}/${res.total} ภาพ, ${res.detections} วัตถุ`)
      // reload current image labels if they were just written
      if (currentImage) {
        api.labelExt(currentImage).then(data => {
          if (data.boxes?.length) setBoxes(data.boxes.map(b => [...b]))
          if (data.polygons?.length) setPolygons(data.polygons)
        }).catch(() => {})
      }
    } catch (err) {
      showToast('Auto-label ทั้งโฟลเดอร์ล้มเหลว: ' + err.message, 'error')
    } finally {
      setBatchLoading(false)
    }
  }

  /* ── auto-play: detect on the current image, wait autoPlayDelay
     seconds so it can be reviewed/edited, save, then auto-advance.
     Repeats until the last image or until the user stops it. ── */
  useEffect(() => { autoPlayRef.current = autoPlay }, [autoPlay])

  useEffect(() => {
    if (!autoPlay || !currentImage) return
    let cancelled = false
    ;(async () => {
      // The image element loads asynchronously (new Image().onload) — wait
      // until it actually finishes loading *this* image before detecting,
      // otherwise autoLabel() runs against the previous image's stale
      // pixels/dimensions while the boxes get attached to the new one.
      while (!cancelled && autoPlayRef.current && loadedImageRef.current !== currentImage) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (cancelled || !autoPlayRef.current) return
      await autoLabel()
      if (cancelled || !autoPlayRef.current) return
      await new Promise(resolve => {
        autoPlayTimeoutRef.current = setTimeout(resolve, autoPlayDelay * 1000)
      })
      if (cancelled || !autoPlayRef.current) return
      await save()
      if (cancelled || !autoPlayRef.current) return
      if (imgIdx < imageList.length - 1) {
        setImgIdx(i => i + 1)
      } else {
        setAutoPlay(false)
        showToast('เล่นอัตโนมัติจบแล้ว (ถึงภาพสุดท้าย)')
      }
    })()
    return () => {
      cancelled = true
      clearTimeout(autoPlayTimeoutRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, currentImage])

  /* ── hit test ── */
  function hitTest(cx, cy) {
    const { w: rw, h: rh, ox, oy } = renderRect.current
    for (let i = polygons.length - 1; i >= 0; i--) {
      if (pointInPolygon(cx, cy, polygons[i].pts, rw, rh, ox, oy)) {
        setSelected({ type: 'poly', idx: i }); return
      }
    }
    for (let i = boxes.length - 1; i >= 0; i--) {
      const [, bCx, bCy, bw, bh] = boxes[i]
      const x1 = ox + (bCx - bw/2) * rw, y1 = oy + (bCy - bh/2) * rh
      if (cx >= x1 && cx <= x1+bw*rw && cy >= y1 && cy <= y1+bh*rh) {
        setSelected({ type: 'box', idx: i }); return
      }
    }
    setSelected(null)
  }

  function pointInPolygon(cx, cy, pts, rw, rh, ox, oy) {
    let inside = false
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = ox + pts[i][0]*rw, yi = oy + pts[i][1]*rh
      const xj = ox + pts[j][0]*rw, yj = oy + pts[j][1]*rh
      if ((yi > cy) !== (yj > cy) && cx < ((xj-xi)*(cy-yi))/(yj-yi)+xi) inside = !inside
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

  function deleteAnnotation(type, idx) {
    pushHistory([...boxes], [...polygons])
    if (type === 'box') setBoxes(prev => prev.filter((_, i) => i !== idx))
    else setPolygons(prev => prev.filter((_, i) => i !== idx))
    if (selected?.type === type && selected.idx === idx) setSelected(null)
  }

  function clearAll() {
    if (!boxes.length && !polygons.length) return
    pushHistory([...boxes], [...polygons])
    setBoxes([]); setPolygons([]); setSelected(null)
  }

  /* ── class management ── */
  function ensureClass() {
    if (classes.length === 0) { setClasses(['object']); setActiveClass(0); return 0 }
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
      const payload = { image_path: currentImage, boxes, polygons, classes }
      if (projectId) payload.project_id = parseInt(projectId)
      await api.saveLabelExt(payload)
      setLabeledSet(s => new Set([...s, currentImage]))
      showToast('บันทึกสำเร็จ ✓')
    } catch (err) {
      showToast('บันทึกล้มเหลว: ' + err.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  async function saveAndNext() {
    await save()
    if (imgIdx < imageList.length - 1) setImgIdx(i => i + 1)
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
    setBoxes(prev => prev.map((b, i) => i === boxIdx
      ? [b[0], newCoords[1], newCoords[2], newCoords[3], newCoords[4]] : b))
  }

  /* ── counts ── */
  const totalAnn = boxes.length + polygons.length
  const labeledCount = labeledSet.size

  /* ── change class of selected ── */
  function changeSelectedClass(newCid) {
    if (!selected) return
    pushHistory([...boxes], [...polygons])
    if (selected.type === 'box') {
      setBoxes(prev => prev.map((b, i) => i === selected.idx ? [newCid, ...b.slice(1)] : b))
    } else {
      setPolygons(prev => prev.map((p, i) => i === selected.idx ? { ...p, class_id: newCid } : p))
    }
  }

  /* ── annotation list items ── */
  const annItems = [
    ...boxes.map((b, i) => ({ type: 'box', idx: i, cid: b[0] })),
    ...polygons.map((p, i) => ({ type: 'poly', idx: i, cid: p.class_id })),
  ]

  return (
    <div className="ann-page">
      {/* ── Top toolbar ── */}
      <div className="ann-topbar">
        <div className="ann-topbar-left">
          <h1 className="page-title" style={{ marginBottom: 0, fontSize: 16 }}>Annotator</h1>
          <div className="ann-tool-group">
            <button className={`ann-tool-btn${tool === TOOL.SELECT ? ' active' : ''}`}
              onClick={() => setTool(TOOL.SELECT)} title="Select (V)">
              <MousePointer2 size={14} />
            </button>
            <button className={`ann-tool-btn${tool === TOOL.BOX ? ' active' : ''}`}
              onClick={() => setTool(TOOL.BOX)} title="Box (B)">
              <Square size={14} />
            </button>
            <button className={`ann-tool-btn${tool === TOOL.POLYGON ? ' active' : ''}`}
              onClick={() => { setTool(TOOL.POLYGON); setPolyDraft([]) }} title="Polygon (P)">
              <Pentagon size={14} />
            </button>
            <button className={`ann-tool-btn${tool === TOOL.SAM ? ' active' : ''}`}
              onClick={() => setTool(TOOL.SAM)} title="SAM Auto (S)" disabled={samLoading}>
              <Wand2 size={14} />
              {samLoading && <span className="ann-spinner-inline" />}
            </button>
          </div>
          <div className="divider" />
          <button className="ann-tool-btn" onClick={undo} disabled={!history.length} title="Ctrl+Z"><Undo2 size={14} /></button>
          <button className="ann-tool-btn" onClick={redo} disabled={!future.length} title="Ctrl+Y"><Redo2 size={14} /></button>
          <button className="ann-tool-btn" onClick={deleteSelected} disabled={!selected} title="Delete"><Trash2 size={14} /></button>
          <button className="ann-tool-btn" onClick={clearAll} disabled={!totalAnn} title="ล้างทั้งหมด"><XCircle size={14} /></button>
          <div className="divider" />
          <button className="ann-tool-btn" onClick={() => setZoom(z => Math.max(z-0.25, 0.25))}><ZoomOut size={14}/></button>
          <span className="ann-zoom-label">{Math.round(zoom*100)}%</span>
          <button className="ann-tool-btn" onClick={() => setZoom(z => Math.min(z+0.25, 5))}><ZoomIn size={14}/></button>
          <div className="divider" />
          {tool === TOOL.POLYGON && polyDraft.length >= 3 && (
            <>
              <button className="ann-tool-btn active" onClick={closePolygon} style={{ background: 'var(--green)', borderColor: 'var(--green)', color: '#fff' }}>
                ปิด ({polyDraft.length} จุด)
              </button>
              <button className="ann-tool-btn" onClick={() => setPolyDraft([])}>ยกเลิก</button>
            </>
          )}
        </div>
        <div className="ann-topbar-right">
          {projects.length > 0 && (
            <select
              className="ann-project-select"
              value={projectId}
              onChange={e => setProjectId(e.target.value)}
              title="เลือกโปรเจกต์เพื่อบันทึก annotation ลง DB"
            >
              <option value="">-- ไม่ระบุโปรเจกต์ --</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
          {autoModels.length > 0 && (
            <select
              className="ann-project-select"
              value={autoModel}
              onChange={e => setAutoModel(e.target.value)}
              title="โมเดลที่ใช้สำหรับ Auto-label"
            >
              {autoModels.map((m, i) => {
                const value = m.path || m.best_pt || m.name || ''
                const label = m.name || m.run || value
                return <option key={value || i} value={value}>{label}</option>
              })}
            </select>
          )}
          <button className="ann-tool-btn" onClick={autoLabel} disabled={!currentImage || autoLoading} title="Auto-label ภาพปัจจุบันด้วย YOLO">
            {autoLoading ? <><span className="ann-spinner-inline" /> Auto...</> : <><Zap size={14} /> Auto-label</>}
          </button>
          <button className="ann-tool-btn" onClick={autoLabelFolder} disabled={!folder || batchLoading} title="Auto-label ทั้งโฟลเดอร์">
            {batchLoading ? <><span className="ann-spinner-inline" /> กำลังประมวลผล...</> : <><Layers size={14} /> Auto-label ทั้งโฟลเดอร์</>}
          </button>
          <input
            type="number" min={0} step={0.5} value={autoPlayDelay}
            onChange={e => setAutoPlayDelay(Math.max(0, Number(e.target.value) || 0))}
            title="เวลาหยุดรอต่อภาพก่อนไปภาพถัดไป (วินาที)"
            style={{ width: 56 }}
          />
          <button
            className={`ann-tool-btn${autoPlay ? ' detect' : ''}`}
            onClick={() => setAutoPlay(p => !p)}
            disabled={!folder || imgIdx >= imageList.length - 1 && !autoPlay}
            title="เล่นอัตโนมัติ: ดีเทคทีละภาพ หยุดรอตามเวลาที่ตั้ง แล้วไปภาพถัดไปเอง"
          >
            {autoPlay ? <><Pause size={14} /> หยุด</> : <><Play size={14} /> เล่นอัตโนมัติ</>}
          </button>
          <button className={`ann-tool-btn${lmVisible ? ' detect' : ''}`} onClick={() => setLmVisible(v => !v)}>
            <Sparkles size={14} /> Ask LM
          </button>
          <button className="ann-tool-btn save" onClick={save} disabled={!currentImage || loading}>
            <Save size={14} /> {loading ? 'กำลังบันทึก...' : 'บันทึก'}
          </button>
          <button className="ann-tool-btn" onClick={saveAndNext} disabled={!currentImage || imgIdx >= imageList.length-1}
            style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
            title="บันทึกและไปภาพถัดไป (→)">
            <ArrowRight size={14} /> บันทึก &amp; ถัดไป
          </button>
        </div>
      </div>

      <div className="annotator-layout">
        {/* ── Left: class panel ── */}
        <div className={`ann-sidebar${leftOpen ? '' : ' collapsed'}`}>
          <div className="ann-panel-header">
            <button className="ann-panel-toggle" onClick={() => setLeftOpen(v => !v)}
              title={leftOpen ? 'ซ่อน Classes' : 'แสดง Classes'}>
              {leftOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
            </button>
            {leftOpen && <span className="ann-panel-title"><Tag size={12} /> Classes</span>}
          </div>

          {leftOpen && (<>
            <div className="ann-sidebar-section">
              <div className="ann-sidebar-title">Classes ({classes.length})</div>
              <div className="ann-class-list">
                {!classes.length && (
                  <div style={{ padding: '8px 10px', color: 'var(--text-muted)', fontSize: 12 }}>
                    พิมพ์ชื่อคลาสด้านล่าง
                  </div>
                )}
                {classes.map((cls, i) => (
                  <div key={i}
                    className={`ann-class-item${activeClass === i ? ' active' : ''}`}
                    onClick={() => { setActiveClass(i); if (selected) changeSelectedClass(i) }}>
                    <div className="ann-class-swatch" style={{ background: color(i) }} />
                    <span className="ann-class-name">{cls}</span>
                    <span className="ann-class-count">
                      {boxes.filter(b => b[0] === i).length + polygons.filter(p => p.class_id === i).length}
                    </span>
                  </div>
                ))}
              </div>
              <div className="ann-add-class">
                <input placeholder="ชื่อคลาสใหม่..." value={newClassName}
                  onChange={e => setNewClassName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addClass()} />
                <button className="ann-add-btn" onClick={addClass}><Plus size={14} /></button>
              </div>
            </div>

            {/* SAM model selector */}
            <div className="ann-sidebar-section" style={{ borderTop: '1px solid var(--border)' }}>
              <div className="ann-sidebar-title">SAM Model</div>
              <select value={samModel} onChange={e => setSamModel(e.target.value)} className="ann-sam-select">
                <option value="sam2_b.pt">SAM2 Base</option>
                <option value="sam2_t.pt">SAM2 Tiny</option>
                <option value="sam2_l.pt">SAM2 Large</option>
                <option value="sam_b.pt">SAM v1 Base</option>
                <option value="sam_l.pt">SAM v1 Large</option>
                <option value="sam3">SAM 3 (Concept)</option>
              </select>
              {samModel === 'sam3' && (
                <div className="ann-sam3-panel">
                  {sam3Status && (!sam3Status.available || !sam3Status.model_exists) && (
                    <div className="ann-sam3-warning">
                      {!sam3Status.model_exists
                        ? 'sam3.pt not found'
                        : 'SAM3 not available'}
                    </div>
                  )}
                  <label className="ann-sam3-label" htmlFor="sam3-concepts">
                    Concept prompts (comma-separated)
                  </label>
                  <input
                    id="sam3-concepts"
                    className="ann-sam3-input"
                    value={sam3ConceptText}
                    onChange={e => setSam3ConceptText(e.target.value)}
                    placeholder="person, car, dog"
                  />
                  <button
                    className="ann-sam3-button"
                    onClick={segmentByConcept}
                    disabled={!currentImage || samLoading}
                  >
                    {samLoading ? <><span className="ann-spinner-inline" /> SAM3...</> : <><Sparkles size={14} /> Segment by Concept</>}
                  </button>
                  <button
                    className="ann-sam3-button secondary"
                    onClick={segmentBySelectedBox}
                    disabled={!currentImage || samLoading || selected?.type !== 'box'}
                  >
                    <Square size={14} /> Segment Similar to Box
                  </button>
                  <div className="ann-sam3-help">
                    เลือก box หนึ่งอันเพื่อใช้เป็น visual exemplar แล้วค้นหาวัตถุที่คล้ายกัน
                  </div>
                </div>
              )}
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
          </>)}
        </div>

        {/* ── Center: canvas ── */}
        <div className="ann-canvas-col">
          <div className="ann-canvas-wrap" ref={wrapRef}
            style={{ cursor: tool === TOOL.SELECT ? 'default' : 'crosshair' }}>
            {currentImage ? (
              <canvas ref={canvasRef}
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
            {samLoading && (
              <div className="ann-sam-overlay">
                <div className="ann-spinner" />
                <span>SAM กำลังวิเคราะห์...</span>
              </div>
            )}
          </div>

          {/* Nav bar */}
          <div className="ann-nav-bar">
            <select value={folder} onChange={e => setFolder(e.target.value)}>
              {!folders.length && <option value="">-- ไม่พบโฟลเดอร์ --</option>}
              {folders.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
            <button className="ann-nav-btn" onClick={() => setImgIdx(i => i-1)} disabled={imgIdx <= 0}>
              <ChevronLeft size={14} />
            </button>
            <span className="ann-nav-info">
              {imageList.length
                ? `${imgIdx+1} / ${imageList.length}`
                : 'ไม่มีภาพ'}
            </span>
            <button className="ann-nav-btn" onClick={() => setImgIdx(i => i+1)} disabled={imgIdx >= imageList.length-1}>
              <ChevronRight size={14} />
            </button>
            <div style={{ flex: 1 }} />
            {labeledCount > 0 && (
              <span style={{ fontSize: 11, color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <CheckCircle2 size={12} /> {labeledCount} labeled
              </span>
            )}
            <span className="ann-stat-badge">☐ {boxes.length}</span>
            <span className="ann-stat-badge">⬡ {polygons.length}</span>
          </div>
        </div>

        {/* ── Right: annotation list ── */}
        <div className={`ann-ann-panel${rightOpen ? '' : ' collapsed'}`}>
          <div className="ann-panel-header" style={{ justifyContent: rightOpen ? 'space-between' : 'center' }}>
            {rightOpen && <span className="ann-panel-title"><Layers size={12} /> Annotations ({totalAnn})</span>}
            <button className="ann-panel-toggle" onClick={() => setRightOpen(v => !v)}
              title={rightOpen ? 'ซ่อน Annotations' : 'แสดง Annotations'}>
              {rightOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
            </button>
          </div>
          {rightOpen && (
            <div className="ann-ann-list">
              {!totalAnn && (
                <div style={{ padding: '20px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                  ยังไม่มี annotation<br />วาด box หรือ polygon
                </div>
              )}
              {annItems.map(({ type, idx, cid }) => {
                const isSel = selected?.type === type && selected.idx === idx
                const cls = classes[cid] || `class_${cid}`
                return (
                  <div key={`${type}-${idx}`}
                    className={`ann-ann-item${isSel ? ' active' : ''}`}
                    onClick={() => setSelected({ type, idx })}>
                    <div className="ann-ann-swatch" style={{ background: color(cid) }} />
                    <span className="ann-ann-icon">{type === 'box' ? '☐' : '⬡'}</span>
                    <span className="ann-ann-name">{cls}</span>
                    <span className="ann-ann-type">{type === 'box' ? 'Box' : 'Poly'}</span>
                    <button className="ann-ann-del" onClick={e => { e.stopPropagation(); deleteAnnotation(type, idx) }}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
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
