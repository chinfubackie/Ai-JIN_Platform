import { useState, useEffect, useRef, useCallback } from 'react'
import { Upload, Play, Copy, Download, Image, Target, SlidersHorizontal, AlertCircle } from 'lucide-react'
import { api } from '../api/client'
import './LiveDemo.css'

const BOX_COLORS = [
  '#6366f1', '#22c55e', '#ef4444', '#eab308', '#06b6d4',
  '#ec4899', '#f97316', '#8b5cf6', '#14b8a6', '#f43f5e',
  '#a855f7', '#84cc16', '#0ea5e9', '#e879f9', '#fb923c',
]

function getColor(classId) {
  return BOX_COLORS[classId % BOX_COLORS.length]
}

export default function LiveDemo() {
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [models, setModels] = useState([])
  const [selectedModel, setSelectedModel] = useState('')
  const [conf, setConf] = useState(0.25)
  const [iou, setIou] = useState(0.45)
  const [imgsz, setImgsz] = useState(640)
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [toast, setToast] = useState(null)

  const canvasRef = useRef(null)
  const imgRef = useRef(null)
  const fileInputRef = useRef(null)

  // Load models on mount
  useEffect(() => {
    api.models()
      .then(data => {
        const list = Array.isArray(data) ? data : data.models || []
        setModels(list)
        if (list.length > 0) {
          const name = typeof list[0] === 'string' ? list[0] : list[0].name || list[0].path || ''
          setSelectedModel(name)
        }
      })
      .catch(() => setModels([]))
  }, [])

  // Show toast
  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2500)
  }, [])

  // Handle file selection
  const handleFile = useCallback((f) => {
    if (!f || !f.type.startsWith('image/')) return
    setFile(f)
    setResults(null)
    setError(null)
    const url = URL.createObjectURL(f)
    setPreview(url)
  }, [])

  // Draw image + bounding boxes on canvas
  const drawCanvas = useCallback((imgEl, detections, imgWidth, imgHeight) => {
    const canvas = canvasRef.current
    if (!canvas || !imgEl) return

    canvas.width = imgEl.naturalWidth
    canvas.height = imgEl.naturalHeight
    const ctx = canvas.getContext('2d')

    ctx.drawImage(imgEl, 0, 0)

    if (!detections || detections.length === 0) return

    const scaleX = imgEl.naturalWidth / imgWidth
    const scaleY = imgEl.naturalHeight / imgHeight

    detections.forEach(det => {
      const [x1, y1, x2, y2] = det.bbox
      const sx1 = x1 * scaleX
      const sy1 = y1 * scaleY
      const sx2 = x2 * scaleX
      const sy2 = y2 * scaleY
      const w = sx2 - sx1
      const h = sy2 - sy1
      const color = getColor(det.class_id)

      // Box
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.strokeRect(sx1, sy1, w, h)

      // Label background
      const label = `${det.class} ${(det.confidence * 100).toFixed(1)}%`
      ctx.font = 'bold 13px Inter, system-ui, sans-serif'
      const textW = ctx.measureText(label).width
      const labelH = 20
      const labelY = sy1 - labelH > 0 ? sy1 - labelH : sy1

      ctx.fillStyle = color
      ctx.fillRect(sx1, labelY, textW + 8, labelH)

      // Label text
      ctx.fillStyle = '#fff'
      ctx.fillText(label, sx1 + 4, labelY + 14)
    })
  }, [])

  // Redraw when preview or results change
  useEffect(() => {
    if (!preview) return
    const img = new window.Image()
    img.onload = () => {
      imgRef.current = img
      if (results) {
        drawCanvas(img, results.results, results.image_width, results.image_height)
      } else {
        drawCanvas(img, [], 1, 1)
      }
    }
    img.src = preview
  }, [preview, results, drawCanvas])

  // Drag and drop handlers
  const onDragOver = (e) => {
    e.preventDefault()
    setDragOver(true)
  }
  const onDragLeave = () => setDragOver(false)
  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    handleFile(f)
  }

  // Run detection
  const runDetection = async () => {
    if (!file) return
    setLoading(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('model', selectedModel)
      fd.append('conf', conf)
      fd.append('iou', iou)
      fd.append('imgsz', imgsz)
      const data = await api.predictLocal(fd)
      setResults(data)
    } catch (err) {
      setError(err.message || 'เกิดข้อผิดพลาดในการตรวจจับ')
    } finally {
      setLoading(false)
    }
  }

  // Copy JSON
  const copyJSON = () => {
    if (!results) return
    navigator.clipboard.writeText(JSON.stringify(results, null, 2))
      .then(() => showToast('คัดลอก JSON สำเร็จ'))
      .catch(() => showToast('ไม่สามารถคัดลอกได้'))
  }

  // Download YOLO label
  const downloadYOLO = () => {
    if (!results || !results.results) return
    const lines = results.results.map(det => {
      const [x1, y1, x2, y2] = det.bbox
      const cx = ((x1 + x2) / 2) / results.image_width
      const cy = ((y1 + y2) / 2) / results.image_height
      const w = (x2 - x1) / results.image_width
      const h = (y2 - y1) / results.image_height
      return `${det.class_id} ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`
    })
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const baseName = file ? file.name.replace(/\.[^.]+$/, '') : 'detection'
    a.download = `${baseName}.txt`
    a.click()
    URL.revokeObjectURL(url)
    showToast('ดาวน์โหลด YOLO Label สำเร็จ')
  }

  const modelName = (m) => typeof m === 'string' ? m : m.name || m.path || ''

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Live Demo</h1>
      </div>

      <div className="live-demo-grid">
        {/* Left Panel */}
        <div>
          <div className="card">
            <div className="card-title"><Image size={18} /> ภาพนำเข้า</div>

            {!preview ? (
              <div
                className={`upload-zone${dragOver ? ' drag-over' : ''}`}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
              >
                <div className="upload-zone-icon"><Upload size={36} /></div>
                <div className="upload-zone-text">ลากไฟล์ภาพมาวางที่นี่</div>
                <div className="upload-zone-hint">หรือคลิกเพื่อเลือกไฟล์ (JPG, PNG, WEBP)</div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => handleFile(e.target.files[0])}
                />
              </div>
            ) : (
              <div>
                <div className="canvas-container">
                  <canvas ref={canvasRef} />
                </div>
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-outline"
                    style={{ fontSize: 12 }}
                    onClick={() => {
                      setFile(null)
                      setPreview(null)
                      setResults(null)
                      setError(null)
                    }}
                  >
                    <Upload size={14} /> เปลี่ยนภาพ
                  </button>
                  {file && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>
                      {file.name}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Parameters */}
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-title"><SlidersHorizontal size={18} /> พารามิเตอร์</div>
            <div className="params-section">
              <div className="param-row">
                <label className="param-label">
                  โมเดล
                </label>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                >
                  {models.length === 0 && <option value="">-- ไม่พบโมเดล --</option>}
                  {models.map((m) => (
                    <option key={modelName(m)} value={modelName(m)}>{modelName(m)}</option>
                  ))}
                </select>
              </div>

              <div className="param-row">
                <label className="param-label">
                  Confidence Threshold
                  <span className="param-value">{conf.toFixed(2)}</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={conf}
                  onChange={(e) => setConf(parseFloat(e.target.value))}
                />
              </div>

              <div className="param-row">
                <label className="param-label">
                  IoU Threshold
                  <span className="param-value">{iou.toFixed(2)}</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={iou}
                  onChange={(e) => setIou(parseFloat(e.target.value))}
                />
              </div>

              <div className="param-row">
                <label className="param-label">ขนาดภาพ (Image Size)</label>
                <input
                  type="number"
                  min="32"
                  max="4096"
                  step="32"
                  value={imgsz}
                  onChange={(e) => setImgsz(parseInt(e.target.value, 10) || 640)}
                />
              </div>
            </div>

            <div className="action-buttons">
              <button
                className="btn btn-primary"
                disabled={!file || loading}
                onClick={runDetection}
              >
                <Play size={16} /> รันการตรวจจับ
              </button>
            </div>
          </div>
        </div>

        {/* Right Panel */}
        <div>
          <div className="card">
            <div className="card-title"><Target size={18} /> ผลการตรวจจับ</div>

            {loading && (
              <div className="loading-overlay">
                <div className="spinner" />
                <span>กำลังประมวลผล...</span>
              </div>
            )}

            {error && (
              <div style={{ padding: 16, color: 'var(--red)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <AlertCircle size={18} />
                <span>{error}</span>
              </div>
            )}

            {!loading && !error && !results && (
              <div className="no-results">
                อัปโหลดภาพและกดรันการตรวจจับเพื่อดูผลลัพธ์
              </div>
            )}

            {!loading && results && (
              <>
                <div className="results-summary">
                  <div className="summary-item">
                    <strong>{results.results?.length || 0}</strong>
                    <span>วัตถุที่พบ</span>
                  </div>
                  <div className="summary-item">
                    <strong>{results.image_width}x{results.image_height}</strong>
                    <span>ขนาดภาพ</span>
                  </div>
                  {results.results?.length > 0 && (
                    <div className="summary-item">
                      <strong>
                        {[...new Set(results.results.map(r => r.class))].length}
                      </strong>
                      <span>คลาส</span>
                    </div>
                  )}
                </div>

                {results.results?.length > 0 ? (
                  <div className="results-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>คลาส</th>
                          <th>ความมั่นใจ</th>
                          <th>BBox (x1, y1, x2, y2)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.results.map((det, i) => {
                          const color = getColor(det.class_id)
                          const confPct = (det.confidence * 100).toFixed(1)
                          return (
                            <tr key={i}>
                              <td>{i + 1}</td>
                              <td>
                                <span className="result-color-dot" style={{ background: color }} />
                                {det.class}
                              </td>
                              <td>
                                {confPct}%
                                <span className="conf-bar">
                                  <span
                                    className="conf-bar-fill"
                                    style={{
                                      width: `${confPct}%`,
                                      background: det.confidence > 0.7 ? 'var(--green)' : det.confidence > 0.4 ? 'var(--yellow)' : 'var(--red)',
                                    }}
                                  />
                                </span>
                              </td>
                              <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                                {det.bbox.map(v => Math.round(v)).join(', ')}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="no-results">ไม่พบวัตถุในภาพ</div>
                )}

                <div className="results-actions">
                  <button className="btn btn-outline" onClick={copyJSON}>
                    <Copy size={14} /> คัดลอก JSON
                  </button>
                  <button className="btn btn-outline" onClick={downloadYOLO}>
                    <Download size={14} /> บันทึกเป็น YOLO Label
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
