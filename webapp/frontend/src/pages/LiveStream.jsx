import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Plus, Trash2, Play, Square, Camera, Settings, AlertCircle,
  CheckCircle2, Monitor, Wifi, WifiOff, RefreshCw, Download,
  TrendingUp, Target, SquareStack, Laptop, Cpu, Zap, PackageOpen,
  RotateCcw, BrainCircuit, SlidersHorizontal, ChevronLeft, ChevronRight,
  ChevronUp, ChevronDown,
} from 'lucide-react'
import VideoPlayer from '../components/VideoPlayer'
import { api } from '../api/client'
import './LiveStream.css'

/* ---------- กล้อง config card ---------- */
function CameraCard({ cam, onRemove, onStart, onStop, onSelect }) {
  const isOnline = cam.status === 'streaming'
  const isError = cam.status === 'error'

  return (
    <div
      className={`cam-card ${isOnline ? 'cam-online' : ''} ${isError ? 'cam-error' : ''}`}
      onClick={() => onSelect?.(cam)}
    >
      <div className="cam-card-header">
        <div className="cam-card-icon">
          {cam.source === 'browser' ? <Laptop size={20} /> : isOnline ? <Monitor size={20} /> : isError ? <WifiOff size={20} /> : <Camera size={20} />}
        </div>
        <div className="cam-card-info">
          <div className="cam-card-name">{cam.name || `Cam #${cam.id}`}</div>
          <div className="cam-card-source">{cam.source === 'browser' ? 'กล้องเครื่องนี้ (เบราว์เซอร์)' : cam.source}</div>
        </div>
        <div className="cam-card-status-dot">
          {isOnline ? <CheckCircle2 size={14} /> : isError ? <AlertCircle size={14} /> : <Wifi size={14} />}
        </div>
      </div>
      {isOnline && (
        <div className="cam-card-stats">
          <span>{cam.fps?.toFixed(1)} FPS</span>
          <span>#{cam.frame_count}</span>
          {cam.model && <span className="cam-model-chip"><BrainCircuit size={10} />{modelBasename(cam.model)}</span>}
        </div>
      )}
      {isError && <div className="cam-card-error">{cam.error}</div>}
      <div className="cam-card-actions">
        {!isOnline && !isError && (
          <button className="btn btn-sm btn-primary" onClick={(e) => { e.stopPropagation(); onStart?.(cam.id) }}>
            <Play size={12} /> เปิด
          </button>
        )}
        {(isOnline || isError) && (
          <button className="btn btn-sm btn-outline" onClick={(e) => { e.stopPropagation(); onStop?.(cam.id) }}>
            <Square size={12} /> หยุด
          </button>
        )}
        <button className="btn btn-sm btn-danger" onClick={(e) => { e.stopPropagation(); onRemove?.(cam.id) }}>
          <Trash2 size={12} /> ลบ
        </button>
      </div>
    </div>
  )
}

const modelBasename = (path) => {
  if (!path) return null
  return path.split(/[\\/]/).pop()
}

/* ---------- Main Page ---------- */
export default function LiveStream() {
  const [cameras, setCameras] = useState([])
  const [selectedCamera, setSelectedCamera] = useState(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [addMode, setAddMode] = useState('remote') // 'remote' (RTSP/USB บนเซิร์ฟเวอร์) | 'browser' (กล้องเครื่องนี้)
  const [newCamSource, setNewCamSource] = useState('')
  const [newCamName, setNewCamName] = useState('')
  const [newCamFps, setNewCamFps] = useState(15)
  const [newCamModel, setNewCamModel] = useState('')
  const [newCamDevice, setNewCamDevice] = useState('cpu')
  const [availableModels, setAvailableModels] = useState([])
  const [availableDevices, setAvailableDevices] = useState([{ id: 'cpu', name: 'CPU', type: 'cpu' }])
  const [exportFormats, setExportFormats] = useState([])

  // Export panel state
  const [exportModel, setExportModel] = useState('')
  const [exportFormat, setExportFormat] = useState('onnx')
  const [exportDevice, setExportDevice] = useState('cpu')
  const [exportHalf, setExportHalf] = useState(false)
  const [exportStatus, setExportStatus] = useState(null) // null | 'loading' | {ok, output, error}
  const [resetting, setResetting] = useState(false)
  const [error, setError] = useState(null)

  // แถบการตั้งค่าที่พับเก็บได้ — เปิดเป็นค่าเริ่มต้น
  const [exportCollapsed, setExportCollapsed] = useState(false)
  const [inferCollapsed, setInferCollapsed] = useState(false)

  // กล้องที่แท็บนี้กำลัง capture ให้ (ใช้ getUserMedia ของเครื่องผู้ใช้เอง)
  const [browserCaptureId, setBrowserCaptureId] = useState(null)
  const hiddenVideoRef = useRef(null)
  const captureCanvasRef = useRef(null)
  const mediaStreamRef = useRef(null)
  const captureIntervalRef = useRef(null)

  const [streamUrl, setStreamUrl] = useState(null)
  const [countStats, setCountStats] = useState(null)
  const [detections, setDetections] = useState([])

  // Inference settings (local, synced from selected cam)
  const [localConf, setLocalConf] = useState(0.25)
  const [localIou, setLocalIou] = useState(0.45)
  const [localImgsz, setLocalImgsz] = useState(640)
  const [localDevice, setLocalDevice] = useState('cpu')
  const [localModel, setLocalModel] = useState('')
  const [applyingConfig, setApplyingConfig] = useState(false)

  const [zones, setZones] = useState([])
  const [lines, setLines] = useState([])
  const [draftShape, setDraftShape] = useState(null) // {type:'zone'|'line', points:[[x,y],...], name, direction}
  const [streamPort, setStreamPort] = useState('')

  // If the backend is configured with a dedicated STREAM_PORT, point
  // camera stream URLs there instead of the current page's origin/port.
  useEffect(() => {
    api.getConfig().then(cfg => setStreamPort(cfg.stream_port || '')).catch(() => {})
  }, [])

  const buildStreamUrl = useCallback((path) => {
    if (!streamPort) return `/api${path}`
    return `${window.location.protocol}//${window.location.hostname}:${streamPort}/api${path}`
  }, [streamPort])

  const loadCameras = useCallback(async () => {
    try {
      const res = await api.cameras()
      const list = Array.isArray(res) ? res : res.cameras || []
      setCameras(list)
      if (list.length === 0) setSelectedCamera(null)
    } catch (err) {
      setError('ไม่สามารถโหลดรายการกล้องได้')
    }
  }, [])

  useEffect(() => { loadCameras() }, [loadCameras])

  useEffect(() => {
    api.models().then(r => setAvailableModels(r.models || [])).catch(() => {})
    api.systemDevices().then(r => {
      if (r.devices) setAvailableDevices(r.devices)
      if (r.export_formats) setExportFormats(r.export_formats)
    }).catch(() => {})
  }, [])

  // Zone/line config for selected camera
  const loadCountingConfig = useCallback(async (camId) => {
    if (!camId) { setZones([]); setLines([]); return }
    try {
      const res = await api.countingConfig(camId)
      setZones(res.zones || [])
      setLines(res.lines || [])
    } catch {
      setZones([])
      setLines([])
    }
  }, [])

  useEffect(() => {
    setDraftShape(null)
    setDetections([])
    setCountStats(null)
    loadCountingConfig(selectedCamera?.id)
  }, [selectedCamera, loadCountingConfig])

  // Sync inference settings when switching cameras
  useEffect(() => {
    const cam = cameras.find(c => c.id === selectedCamera?.id)
    if (!cam) return
    if (cam.conf_threshold != null) setLocalConf(cam.conf_threshold)
    if (cam.iou_threshold != null) setLocalIou(cam.iou_threshold)
    if (cam.imgsz != null) setLocalImgsz(cam.imgsz)
    if (cam.device != null) setLocalDevice(cam.device)
    if (cam.model_path != null) setLocalModel(cam.model_path)
  }, [selectedCamera?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // SSE stream
  useEffect(() => {
    if (!selectedCamera || selectedCamera.status !== 'streaming') {
      setStreamUrl(null)
      return
    }
    const url = buildStreamUrl(`/cameras/${selectedCamera.id}/stream`)
    const es = new EventSource(url)
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'result') {
          if (data.detections) setDetections(data.detections)
          setCountStats(data)
        }
      } catch {}
    }
    es.onerror = () => {}
    setStreamUrl(url)
    return () => {
      es.close()
      setStreamUrl(null)
    }
  }, [selectedCamera, buildStreamUrl])

  // เริ่ม capture กล้องของเครื่องนี้ (getUserMedia) แล้วส่งเฟรมขึ้นไปให้ camId เรื่อย ๆ
  const startBrowserCapture = async (camId, fpsTarget = 10) => {
    // เบราว์เซอร์นี้ capture ได้ทีละกล้องเท่านั้น — ปิดตัวเดิมก่อนเสมอ
    // กันไม่ให้ interval/stream เก่าค้างส่งเฟรมทิ้งแบบไม่มีใครดู
    stopBrowserCapture()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true })
      mediaStreamRef.current = stream
      const video = hiddenVideoRef.current
      video.srcObject = stream
      await video.play()

      if (!captureCanvasRef.current) captureCanvasRef.current = document.createElement('canvas')
      const canvas = captureCanvasRef.current
      const ctx = canvas.getContext('2d')
      const intervalMs = Math.max(1000 / (fpsTarget || 10), 100)

      captureIntervalRef.current = setInterval(() => {
        if (!video.videoWidth) return
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        ctx.drawImage(video, 0, 0)
        canvas.toBlob((blob) => {
          if (!blob) return
          api.cameraBrowserFrame(camId, blob).catch(() => {})
        }, 'image/jpeg', 0.7)
      }, intervalMs)

      setBrowserCaptureId(camId)
    } catch (err) {
      setError('ไม่สามารถเปิดกล้องของเครื่องนี้ได้ (ตรวจสอบสิทธิ์การเข้าถึงกล้องของเบราว์เซอร์)')
    }
  }

  const stopBrowserCapture = useCallback(() => {
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current)
      captureIntervalRef.current = null
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop())
      mediaStreamRef.current = null
    }
    setBrowserCaptureId(null)
  }, [])

  useEffect(() => () => stopBrowserCapture(), [stopBrowserCapture])

  // Add camera
  const handleAdd = async () => {
    try {
      if (addMode === 'browser') {
        const res = await api.cameraAddBrowser({
          name: newCamName.trim() || 'กล้องเครื่องนี้',
          model_path: newCamModel,
          device: newCamDevice,
        })
        setNewCamSource('')
        setNewCamName('')
        setNewCamModel('')
        setNewCamDevice('cpu')
        setShowAddForm(false)
        await loadCameras()
        await startBrowserCapture(res.id, newCamFps)
        setNewCamFps(15)
        return
      }
      if (!newCamSource.trim()) return
      await api.cameraAdd({
        source: newCamSource.trim(),
        name: newCamName.trim() || newCamSource.trim(),
        fps_target: newCamFps,
        model_path: newCamModel,
        device: newCamDevice,
      })
      setNewCamSource('')
      setNewCamName('')
      setNewCamFps(15)
      setNewCamModel('')
      setNewCamDevice('cpu')
      setShowAddForm(false)
      await loadCameras()
    } catch (err) {
      setError('ไม่สามารถเพิ่มกล้องได้')
    }
  }

  // Remove camera
  const handleRemove = async (id) => {
    try {
      if (id === browserCaptureId) stopBrowserCapture()
      await api.cameraRemove(id)
      if (selectedCamera?.id === id) setSelectedCamera(null)
      await loadCameras()
    } catch (err) {
      setError('ไม่สามารถลบกล้องได้')
    }
  }

  // Start camera
  const handleStart = async (id) => {
    try {
      const cam = cameras.find(c => c.id === id)
      await api.cameraStart(id)
      if (cam?.source === 'browser') {
        await startBrowserCapture(id, 10)
      }
      await loadCameras()
    } catch (err) {
      setError('ไม่สามารถเปิดกล้องได้')
    }
  }

  // Stop camera
  const handleStop = async (id) => {
    try {
      if (id === browserCaptureId) stopBrowserCapture()
      await api.cameraStop(id)
      if (selectedCamera?.id === id) setSelectedCamera(null)
      await loadCameras()
    } catch (err) {
      setError('ไม่สามารถหยุดกล้องได้')
    }
  }

  const selectedCamData = cameras.find(c => c.id === selectedCamera?.id)
  const canDraw = !!selectedCamData  // วาดได้ทันทีที่เลือกกล้อง ไม่ต้องรอ stream

  // Zone/line drawing
  const handleOverlayClick = (e) => {
    if (!draftShape) return
    if (draftShape.type === 'line' && draftShape.points.length >= 2) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)
    const y = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1)
    setDraftShape(d => ({ ...d, points: [...d.points, [x, y]] }))
  }

  const toggleDraw = (type) => {
    if (!canDraw) return
    setDraftShape(d => (d?.type === type ? null : { type, points: [], name: '', direction: 'both' }))
  }

  const saveDraftShape = async () => {
    if (!draftShape || !selectedCamData) return
    try {
      if (draftShape.type === 'zone') {
        if (draftShape.points.length < 3) return
        await api.countingAddZone(selectedCamData.id, {
          name: draftShape.name.trim() || 'Zone',
          points: draftShape.points,
        })
      } else {
        if (draftShape.points.length !== 2) return
        const [[x1, y1], [x2, y2]] = draftShape.points
        await api.countingAddLine(selectedCamData.id, {
          name: draftShape.name.trim() || 'Line',
          x1, y1, x2, y2,
          direction: draftShape.direction || 'both',
        })
      }
      setDraftShape(null)
      await loadCountingConfig(selectedCamData.id)
    } catch (err) {
      setError('ไม่สามารถบันทึกการตั้งค่าโซน/เส้นนับได้')
    }
  }

  const handleRemoveZone = async (zoneId) => {
    if (!selectedCamData) return
    try {
      await api.countingRemoveZone(selectedCamData.id, zoneId)
      await loadCountingConfig(selectedCamData.id)
    } catch {
      setError('ไม่สามารถลบโซนนับได้')
    }
  }

  const handleRemoveLine = async (lineId) => {
    if (!selectedCamData) return
    try {
      await api.countingRemoveLine(selectedCamData.id, lineId)
      await loadCountingConfig(selectedCamData.id)
    } catch {
      setError('ไม่สามารถลบเส้นนับได้')
    }
  }

  const handleExportStats = () => {
    if (!countStats) return
    const blob = new Blob([JSON.stringify(countStats, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `counting-stats-cam${selectedCamData?.id ?? ''}-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleApplyConfig = async () => {
    if (!selectedCamData) return
    setApplyingConfig(true)
    try {
      await api.cameraUpdateConfig(selectedCamData.id, {
        conf_threshold: localConf,
        iou_threshold: localIou,
        imgsz: localImgsz,
        device: localDevice,
        model_path: localModel,
      })
      await loadCameras()
    } catch { setError('ไม่สามารถอัปเดตค่า inference ได้') }
    setApplyingConfig(false)
  }

  const zoneName = (id) => zones.find(z => z.id === id)?.name || id
  const lineName = (id) => lines.find(l => l.id === id)?.name || id
  const shapeReady = draftShape && (
    (draftShape.type === 'zone' && draftShape.points.length >= 3) ||
    (draftShape.type === 'line' && draftShape.points.length === 2)
  )

  return (
    <div className="live-stream-page">
      {/* ใช้จับเฟรมจากกล้องของเครื่องนี้เอง (getUserMedia) — ไม่แสดงผล ผู้ใช้ดูภาพผ่าน stream ปกติแทน */}
      <video ref={hiddenVideoRef} muted playsInline style={{ display: 'none' }} />
      <div className="page-header">
        <div>
          <h1 className="page-title">Camera</h1>
          <p className="page-subtitle">จัดการกล้องและนับชิ้นงานแบบ Real-Time</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAddForm(v => !v)}>
          <Plus size={16} /> เพิ่มกล้อง
        </button>
      </div>

      {/* Add Camera Form */}
      {showAddForm && (
        <div className="card add-cam-form">
          <div className="card-title"><Camera size={18} /> เพิ่มกล้องใหม่</div>
          <div className="add-cam-mode-tabs">
            <button
              className={`btn btn-sm ${addMode === 'remote' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setAddMode('remote')}
            >
              <Camera size={13} /> IP/USB (เซิร์ฟเวอร์)
            </button>
            <button
              className={`btn btn-sm ${addMode === 'browser' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setAddMode('browser')}
            >
              <Laptop size={13} /> กล้องเครื่องนี้ (เบราว์เซอร์)
            </button>
          </div>
          <div className="add-cam-grid">
            {addMode === 'remote' && (
              <div className="form-group">
                <label>แหล่งที่มา (Source)</label>
                <input
                  type="text"
                  placeholder='เช่น rtsp://192.168.1.100:554/stream1 หรือ 0 (USB)'
                  value={newCamSource}
                  onChange={e => setNewCamSource(e.target.value)}
                />
                <span className="form-hint">rtsp:// สำหรับ IP Camera, ตัวเลขสำหรับ USB</span>
              </div>
            )}
            <div className="form-group">
              <label>ชื่อกล้อง</label>
              <input
                type="text"
                placeholder="เช่น สายพาน A, กล้องนับชิ้นส่วน"
                value={newCamName}
                onChange={e => setNewCamName(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>FPS (Target)</label>
              <input
                type="number"
                min="1"
                max="30"
                value={newCamFps}
                onChange={e => setNewCamFps(parseInt(e.target.value) || 15)}
              />
              <span className="form-hint">
                {addMode === 'browser'
                  ? 'ความถี่ที่เบราว์เซอร์นี้จะส่งเฟรมขึ้นไปให้เซิร์ฟเวอร์ประมวลผล'
                  : 'แนะนำ 5-15 FPS สำหรับสายผลิตทั่วไป'}
              </span>
            </div>
            <div className="form-group">
              <label>โมเดล YOLO</label>
              <select value={newCamModel} onChange={e => setNewCamModel(e.target.value)}>
                <option value="">ใช้โมเดลที่ deploy ล่าสุด (ค่าเริ่มต้น)</option>
                {availableModels.map(m => (
                  <option key={m.best_pt} value={m.best_pt}>
                    {m.name || m.run}{m.mAP50 ? ` — mAP50: ${(m.mAP50 * 100).toFixed(1)}%` : ''} ({m.best_size_mb} MB)
                  </option>
                ))}
              </select>
              <span className="form-hint">เลือกโมเดลที่ต้องการใช้สำหรับกล้องนี้</span>
            </div>
            <div className="form-group">
              <label><Cpu size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />Device (Inference)</label>
              <select value={newCamDevice} onChange={e => setNewCamDevice(e.target.value)}>
                {availableDevices.map(d => (
                  <option key={d.id} value={d.id}>
                    {d.type === 'cuda' ? '⚡ ' : ''}{d.name}
                  </option>
                ))}
              </select>
              <span className="form-hint">GPU ประมวลผลเร็วกว่า CPU — ต้องมี CUDA</span>
            </div>
          </div>
          {addMode === 'browser' && (
            <div className="form-hint" style={{ marginBottom: 8 }}>
              จะขอสิทธิ์เข้าถึงกล้องของเครื่องที่เปิดหน้านี้อยู่ — ต้องเปิดค้างไว้ที่แท็บนี้ขณะใช้งาน
            </div>
          )}
          <div className="add-cam-actions">
            <button className="btn btn-primary" onClick={handleAdd}>
              <Plus size={14} /> เพิ่ม
            </button>
            <button className="btn btn-outline" onClick={() => setShowAddForm(false)}>
              ยกเลิก
            </button>
          </div>
        </div>
      )}

      {/* Error bar */}
      {error && (
        <div className="error-bar">
          <AlertCircle size={16} /> {error}
          <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>✕</button>
        </div>
      )}

      <div
        className="live-stream-layout"
        style={{ '--export-col-w': exportCollapsed ? '48px' : '220px' }}
      >

        {/* Left: Full-height video */}
        <div className="stream-panel">
          <div className="card stream-card">
            <div className="card-title">
              {selectedCamData ? (
                <><Monitor size={18} /> {selectedCamData.name || `Cam #${selectedCamData.id}`}</>
              ) : (
                <><Camera size={18} /> เลือกกล้องเพื่อดูสตรีม</>
              )}
              {selectedCamData?.status === 'streaming' && (
                <span className="live-badge">LIVE</span>
              )}
            </div>

            {selectedCamData ? (
              <div className="stream-container">
                <div className="stream-video-wrap">

                  {/* Video content */}
                  {selectedCamData.status === 'streaming' ? (
                    <>
                      <VideoPlayer streamUrl={streamUrl} />
                      {!streamUrl && <div className="stream-loading">กำลังเชื่อมต่อสตรีม...</div>}
                    </>
                  ) : selectedCamData.status === 'error' ? (
                    <div className="stream-error">
                      <AlertCircle size={32} />
                      <span>{selectedCamData.error || 'เกิดข้อผิดพลาด'}</span>
                      <button className="btn btn-outline" onClick={() => handleStart(selectedCamData.id)}>
                        <RefreshCw size={14} /> ลองใหม่
                      </button>
                    </div>
                  ) : (
                    <div className="stream-idle">
                      <Camera size={48} />
                      <span>กล้องพร้อมใช้งาน</span>
                      <button className="btn btn-primary" onClick={() => handleStart(selectedCamData.id)}>
                        <Play size={14} /> เปิดสตรีม
                      </button>
                      {draftShape && (
                        <p className="idle-draw-hint">คลิกบนพื้นที่นี้เพื่อวางจุด</p>
                      )}
                    </div>
                  )}

                  {/* Detection bbox overlay */}
                  {detections.length > 0 && (
                    <svg className="zone-overlay bbox-overlay" viewBox="0 0 100 100" preserveAspectRatio="none"
                      style={{ pointerEvents: 'none' }}>
                      {detections.map((d, i) => {
                        const [x1, y1, x2, y2] = d.bbox
                        return (
                          <g key={i}>
                            <rect className="bbox-rect" x={x1 * 100} y={y1 * 100}
                              width={(x2 - x1) * 100} height={(y2 - y1) * 100} />
                            <text className="bbox-label" x={x1 * 100 + 0.5} y={y1 * 100 - 0.8}>
                              {d.class_name} {Math.round(d.confidence * 100)}%
                            </text>
                          </g>
                        )
                      })}
                    </svg>
                  )}

                  {/* Zone/line overlay — แสดงตลอดเมื่อเลือกกล้องแล้ว */}
                  <svg
                    className="zone-overlay"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    onClick={handleOverlayClick}
                    style={{ pointerEvents: draftShape ? 'auto' : 'none', cursor: draftShape ? 'crosshair' : 'default' }}
                  >
                    {zones.map(z => (
                      <polygon key={z.id} className="zone-shape"
                        points={z.points.map(p => `${p[0] * 100},${p[1] * 100}`).join(' ')} />
                    ))}
                    {lines.map(l => (
                      <line key={l.id} className="line-shape"
                        x1={l.x1 * 100} y1={l.y1 * 100} x2={l.x2 * 100} y2={l.y2 * 100} />
                    ))}
                    {draftShape?.points.length > 0 && (
                      <polyline className="draft-shape"
                        points={draftShape.points.map(p => `${p[0] * 100},${p[1] * 100}`).join(' ')} />
                    )}
                    {draftShape?.points.map((p, i) => (
                      <circle key={i} className="draft-point" cx={p[0] * 100} cy={p[1] * 100} r="1.2" />
                    ))}
                  </svg>

                  {/* Draw toolbar — แสดงขณะกำลังวาด */}
                  {draftShape && (
                    <div className="draft-toolbar">
                      <span>
                        {draftShape.type === 'zone'
                          ? `วาดโซน — ${draftShape.points.length} จุด (ต้องการ ≥ 3)`
                          : `วาดเส้นนับ — ${draftShape.points.length}/2 จุด`}
                      </span>
                      {shapeReady && (
                        <>
                          <input
                            type="text"
                            placeholder="ชื่อ เช่น BIN_A"
                            value={draftShape.name}
                            onChange={e => setDraftShape(d => ({ ...d, name: e.target.value }))}
                          />
                          {draftShape.type === 'line' && (
                            <select value={draftShape.direction}
                              onChange={e => setDraftShape(d => ({ ...d, direction: e.target.value }))}>
                              <option value="both">ทั้งสองทิศทาง</option>
                              <option value="left_to_right">ซ้าย → ขวา</option>
                              <option value="right_to_left">ขวา → ซ้าย</option>
                              <option value="top_to_bottom">บน → ล่าง</option>
                              <option value="bottom_to_top">ล่าง → บน</option>
                            </select>
                          )}
                          <button className="btn btn-primary btn-sm" onClick={saveDraftShape}>บันทึก</button>
                        </>
                      )}
                      <button className="btn btn-outline btn-sm" onClick={() => setDraftShape(null)}>ยกเลิก</button>
                    </div>
                  )}
                </div>

                {/* Stream Info Bar */}
                <div className="stream-info-bar">
                  <span><Wifi size={12} /> {selectedCamData.fps?.toFixed(1) || 0} FPS</span>
                  <span><SquareStack size={12} /> Frame #{selectedCamData.frame_count || 0}</span>
                  <span className="info-model">
                    <BrainCircuit size={12} />
                    {modelBasename(selectedCamData.model) || <span className="model-idle">ยังไม่รันโมเดล</span>}
                  </span>
                  <span className="info-source"><Settings size={12} /> {selectedCamData.source}</span>
                </div>
              </div>
            ) : (
              <div className="stream-placeholder">
                <Camera size={56} />
                <span>เลือกกล้องจาก sidebar ขวา</span>
              </div>
            )}
          </div>
        </div>{/* /stream-panel */}

        {/* Right: Sidebar — camera list + stats + config */}
        <div className="sidebar">

          {/* Section: Camera list */}
          <div className="sb-section sb-cameras">
            <div className="sb-header">
              <Camera size={14} /> กล้อง
              <span className="sb-badge">{cameras.length}</span>
            </div>
            {cameras.length === 0 ? (
              <div className="sb-empty">กด "เพิ่มกล้อง" เพื่อเริ่มต้น</div>
            ) : (
              <div className="cam-list">
                {cameras.map(cam => (
                  <CameraCard
                    key={cam.id}
                    cam={cam}
                    onRemove={handleRemove}
                    onStart={handleStart}
                    onStop={handleStop}
                    onSelect={setSelectedCamera}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Section: Count stats */}
          <div className="sb-section sb-counts">
            <div className="sb-header"><TrendingUp size={14} /> จำนวนนับ
              <div className="sb-header-actions">
                <button
                  className="sb-icon-btn"
                  title="รีเซ็ตตัวนับ"
                  disabled={!selectedCamData || resetting}
                  onClick={async () => {
                    if (!selectedCamData) return
                    setResetting(true)
                    try { await api.countingReset(selectedCamData.id) } catch {}
                    setResetting(false)
                  }}
                >
                  <RotateCcw size={13} className={resetting ? 'spin' : ''} />
                </button>
                {countStats && (
                  <button className="sb-icon-btn" title="Export stats" onClick={handleExportStats}>
                    <Download size={13} />
                  </button>
                )}
              </div>
            </div>
            {countStats ? (
              <>
                <div className="count-total">
                  <span>ทั้งหมด</span>
                  <span className="count-total-num">
                    {Object.values(countStats.total_class_counts || {}).reduce((a, b) => a + b, 0)}
                  </span>
                </div>
                {Object.entries(countStats.total_class_counts || {}).map(([cls, cnt]) => (
                  <div key={cls} className="count-row">
                    <span className="count-label">{cls}</span>
                    <span className="count-val">{cnt}</span>
                  </div>
                ))}
                {countStats.zone_counts && Object.keys(countStats.zone_counts).length > 0 && (
                  <>
                    <div className="count-group-label"><Target size={11} /> โซน</div>
                    {Object.entries(countStats.zone_counts).map(([z, cnt]) => (
                      <div key={z} className="count-row">
                        <span className="count-label">{zoneName(z)}</span>
                        <span className="count-val">{cnt}</span>
                      </div>
                    ))}
                  </>
                )}
                {countStats.line_counts && Object.keys(countStats.line_counts).length > 0 && (
                  <>
                    <div className="count-group-label"><SquareStack size={11} /> เส้นนับ</div>
                    {Object.entries(countStats.line_counts).map(([l, cnt]) => (
                      <div key={l} className="count-row">
                        <span className="count-label">{lineName(l)}</span>
                        <span className="count-val">{cnt}</span>
                      </div>
                    ))}
                  </>
                )}
              </>
            ) : (
              <div className="sb-empty">รอสตรีมกล้อง...</div>
            )}
          </div>

          {/* Section: Zone / Line drawing */}
          <div className="sb-section">
            <div className="sb-header"><Target size={14} /> โซน / เส้นนับ</div>
            <div className="sb-btn-row">
              <button
                className={`btn btn-sm ${draftShape?.type === 'zone' ? 'btn-primary' : 'btn-outline'}`}
                disabled={!canDraw}
                onClick={() => toggleDraw('zone')}
              >
                <Target size={12} /> {draftShape?.type === 'zone' ? 'ยกเลิก' : 'โซน'}
              </button>
              <button
                className={`btn btn-sm ${draftShape?.type === 'line' ? 'btn-primary' : 'btn-outline'}`}
                disabled={!canDraw}
                onClick={() => toggleDraw('line')}
              >
                <SquareStack size={12} /> {draftShape?.type === 'line' ? 'ยกเลิก' : 'เส้น'}
              </button>
            </div>
            {(zones.length > 0 || lines.length > 0) && (
              <div className="shape-list">
                {zones.map(z => (
                  <div key={z.id} className="shape-chip">
                    <Target size={11} /><span>{z.name || z.id}</span>
                    <button onClick={() => handleRemoveZone(z.id)}>✕</button>
                  </div>
                ))}
                {lines.map(l => (
                  <div key={l.id} className="shape-chip">
                    <SquareStack size={11} /><span>{l.name || l.id}</span>
                    <button onClick={() => handleRemoveLine(l.id)}>✕</button>
                  </div>
                ))}
              </div>
            )}
            {!selectedCamData && <div className="sb-hint">เลือกกล้องก่อนวาด</div>}
            {selectedCamData && !draftShape && <div className="sb-hint">กดปุ่มแล้วคลิกบนวิดีโอ</div>}
          </div>

          {/* Section: Inference settings */}
          {selectedCamData && (
            <div className="sb-section sb-infer">
              <div className="sb-header">
                <SlidersHorizontal size={14} /> Inference
                <div className="sb-header-actions">
                  <button
                    className="sb-icon-btn"
                    title={inferCollapsed ? 'ขยายแถบตั้งค่า' : 'พับเก็บแถบตั้งค่า'}
                    onClick={() => setInferCollapsed(v => !v)}
                  >
                    {inferCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                  </button>
                </div>
              </div>
              {!inferCollapsed && (
                <>
                  <div className="sb-infer-row">
                    <label>Conf <span className="infer-val">{localConf.toFixed(2)}</span></label>
                    <input type="range" min="0.05" max="0.95" step="0.05"
                      value={localConf} onChange={e => setLocalConf(parseFloat(e.target.value))} />
                  </div>
                  <div className="sb-infer-row">
                    <label>IoU <span className="infer-val">{localIou.toFixed(2)}</span></label>
                    <input type="range" min="0.1" max="0.9" step="0.05"
                      value={localIou} onChange={e => setLocalIou(parseFloat(e.target.value))} />
                  </div>
                  <div className="form-group">
                    <label>Model Size (imgsz)</label>
                    <select value={localImgsz} onChange={e => setLocalImgsz(parseInt(e.target.value))}>
                      <option value={320}>320 (เร็ว)</option>
                      <option value={480}>480</option>
                      <option value={640}>640 (แนะนำ)</option>
                      <option value={960}>960</option>
                      <option value={1280}>1280 (ละเอียด)</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Device</label>
                    <select value={localDevice} onChange={e => setLocalDevice(e.target.value)}>
                      {availableDevices.map(d => (
                        <option key={d.id} value={d.id}>{d.type === 'cuda' ? '⚡ ' : ''}{d.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>โมเดล</label>
                    <select value={localModel} onChange={e => setLocalModel(e.target.value)}>
                      <option value="">โมเดลที่ deploy ล่าสุด</option>
                      {availableModels.map(m => (
                        <option key={m.best_pt} value={m.best_pt}>{m.name || m.run}</option>
                      ))}
                    </select>
                  </div>
                  <button className="btn btn-primary btn-sm" style={{ width: '100%' }}
                    disabled={applyingConfig} onClick={handleApplyConfig}>
                    <Settings size={12} /> {applyingConfig ? 'กำลังบันทึก...' : 'Apply'}
                  </button>
                </>
              )}
            </div>
          )}

        </div>{/* /sidebar */}

        {/* Right: Export panel */}
        <div className={`card export-panel${exportCollapsed ? ' collapsed' : ''}`}>
          <div className="card-title">
            <PackageOpen size={16} />
            {!exportCollapsed && <span>Export โมเดล</span>}
            <button
              className="panel-collapse-btn"
              title={exportCollapsed ? 'ขยายแถบ Export' : 'พับเก็บแถบ Export'}
              onClick={() => setExportCollapsed(v => !v)}
            >
              {exportCollapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
            </button>
          </div>
          {!exportCollapsed && (
            <>
              <div className="form-group">
                <label>โมเดล</label>
                <select value={exportModel} onChange={e => setExportModel(e.target.value)}>
                  <option value="">best.pt (deploy อยู่)</option>
                  {availableModels.map(m => (
                    <option key={m.best_pt} value={m.best_pt}>{m.name || m.run} ({m.best_size_mb} MB)</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Format</label>
                <select value={exportFormat} onChange={e => setExportFormat(e.target.value)}>
                  {exportFormats.length > 0 ? exportFormats.map(f => (
                    <option key={f.value} value={f.value}>{f.recommended ? '★ ' : ''}{f.label}</option>
                  )) : (
                    <>
                      <option value="engine">★ TensorRT (NVIDIA GPU)</option>
                      <option value="onnx">ONNX (ทั่วไป)</option>
                      <option value="openvino">OpenVINO (Intel CPU)</option>
                      <option value="tflite">TFLite (Mobile)</option>
                    </>
                  )}
                </select>
              </div>
              <div className="form-group">
                <label>Device</label>
                <select value={exportDevice} onChange={e => setExportDevice(e.target.value)}>
                  {availableDevices.map(d => (
                    <option key={d.id} value={d.id}>{d.type === 'cuda' ? '⚡ ' : ''}{d.name}</option>
                  ))}
                </select>
              </div>
              <label className="fp16-label" style={{ marginTop: 2 }}>
                <input type="checkbox" checked={exportHalf} onChange={e => setExportHalf(e.target.checked)} />
                FP16 Half Precision
              </label>
              <button
                className="btn btn-primary btn-sm"
                style={{ width: '100%', marginTop: 4 }}
                disabled={exportStatus === 'loading'}
                onClick={async () => {
                  setExportStatus('loading')
                  try {
                    const r = await api.exportModelLocal({ model_path: exportModel, format: exportFormat, device: exportDevice, half: exportHalf })
                    setExportStatus(r)
                  } catch (e) {
                    setExportStatus({ ok: false, error: String(e) })
                  }
                }}
              >
                <Zap size={13} /> {exportStatus === 'loading' ? 'กำลัง Export...' : 'Export'}
              </button>
              {exportStatus && exportStatus !== 'loading' && (
                <div className={`export-result ${exportStatus.ok ? 'ok' : 'err'}`}>
                  {exportStatus.ok ? <>✓ <code>{exportStatus.output}</code></> : <>✕ {exportStatus.error}</>}
                </div>
              )}
            </>
          )}
        </div>{/* /export-panel */}

      </div>
    </div>
  )
}