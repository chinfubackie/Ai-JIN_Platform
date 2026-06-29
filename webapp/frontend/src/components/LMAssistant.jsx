import { useEffect, useState, useCallback, useRef } from 'react'
import { api } from '../api/client'
import {
  Sparkles, ChevronRight, X, Box, RefreshCw,
} from 'lucide-react'
import './LMAssistant.css'

/* ── IoU helper ── */
function computeIoU(a, b) {
  // a, b = [cid, cx, cy, w, h] (YOLO normalized)
  const ax1 = a[1] - a[3] / 2, ay1 = a[2] - a[4] / 2
  const ax2 = a[1] + a[3] / 2, ay2 = a[2] + a[4] / 2
  const bx1 = b[1] - b[3] / 2, by1 = b[2] - b[4] / 2
  const bx2 = b[1] + b[3] / 2, by2 = b[2] + b[4] / 2

  const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1)
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2)
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1)
  const inter = iw * ih
  const areaA = (ax2 - ax1) * (ay2 - ay1)
  const areaB = (bx2 - bx1) * (by2 - by1)
  const union = areaA + areaB - inter
  return union > 0 ? inter / union : 0
}

/* ── bbox display helper (pixel coords) ── */
function bboxPixel(box, iw, ih) {
  const x = Math.round((box[1] - box[3] / 2) * iw)
  const y = Math.round((box[2] - box[4] / 2) * ih)
  const w = Math.round(box[3] * iw)
  const h = Math.round(box[4] * ih)
  return [x, y, w, h]
}

/* ── confidence badge class ── */
function confClass(c) {
  if (c >= 0.8) return 'high'
  if (c >= 0.5) return 'mid'
  return 'low'
}

export default function LMAssistant({
  imageRef,
  boxes,
  onApplyDetections,
  onRefineBox,
  imagePath,
  visible,
  onToggle,
  classes,
  imgNat,
}) {
  const [detections, setDetections] = useState([])   // missed objects
  const [refinements, setRefinements] = useState([])  // refinement suggestions
  const [loading, setLoading] = useState(false)
  const [lmOnline, setLmOnline] = useState(false)
  const [analyzeTime, setAnalyzeTime] = useState(null)
  const [sectOpen, setSectOpen] = useState({ detect: true, refine: true })
  const prevPathRef = useRef(null)

  const toggleSection = (key) => setSectOpen(s => ({ ...s, [key]: !s[key] }))

  /* ── run prediction when image changes ── */
  const analyze = useCallback(async () => {
    if (!imagePath || !imageRef?.current) return
    setLoading(true)
    setDetections([])
    setRefinements([])
    const t0 = performance.now()

    try {
      const canvas = document.createElement('canvas')
      const iw = imgNat?.w || imageRef.current.naturalWidth || 1
      const ih = imgNat?.h || imageRef.current.naturalHeight || 1
      canvas.width = iw
      canvas.height = ih
      const ctx = canvas.getContext('2d')
      ctx.drawImage(imageRef.current, 0, 0)
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9))
      const fd = new FormData()
      fd.append('file', blob, 'image.jpg')

      const result = await api.predictLocal(fd)
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
      setAnalyzeTime(elapsed)
      setLmOnline(true)

      if (!result.results || result.results.length === 0) {
        setDetections([])
        setRefinements([])
        return
      }

      const rIw = result.image_width || iw
      const rIh = result.image_height || ih

      // convert predictions to YOLO format
      const preds = result.results.map(det => {
        const [x1, y1, x2, y2] = det.bbox
        const cx = ((x1 + x2) / 2) / rIw
        const cy = ((y1 + y2) / 2) / rIh
        const bw = (x2 - x1) / rIw
        const bh = (y2 - y1) / rIh
        return {
          className: det.class,
          confidence: det.confidence || 0,
          box: [0, cx, cy, bw, bh], // cid=0 placeholder, resolved on apply
        }
      })

      // classify each prediction as missed or refinement
      const missed = []
      const refine = []

      preds.forEach(pred => {
        let bestIoU = 0
        let bestIdx = -1
        boxes.forEach((b, i) => {
          const iou = computeIoU(pred.box, b)
          if (iou > bestIoU) { bestIoU = iou; bestIdx = i }
        })

        if (bestIoU < 0.3) {
          missed.push(pred)
        } else if (bestIoU < 0.85 && bestIdx >= 0) {
          refine.push({
            ...pred,
            targetIdx: bestIdx,
            currentBox: boxes[bestIdx],
          })
        }
      })

      setDetections(missed)
      setRefinements(refine)
    } catch {
      setLmOnline(false)
      setDetections([])
      setRefinements([])
    } finally {
      setLoading(false)
    }
  }, [imagePath, imageRef, boxes, imgNat])

  useEffect(() => {
    if (visible && imagePath && imagePath !== prevPathRef.current) {
      prevPathRef.current = imagePath
      analyze()
    }
  }, [visible, imagePath, analyze])

  /* ── apply all detections ── */
  function handleApplyDetections() {
    if (detections.length === 0) return
    const newBoxes = detections.map(d => [...d.box])
    onApplyDetections(newBoxes, detections.map(d => d.className))
    setDetections([])
  }

  /* ── apply a single refinement ── */
  function handleRefine(ref) {
    onRefineBox(ref.targetIdx, ref.box)
    setRefinements(prev => prev.filter(r => r !== ref))
  }

  const iw = imgNat?.w || 1
  const ih = imgNat?.h || 1

  return (
    <div className={`lm-panel${visible ? '' : ' lm-hidden'}`}>
      {/* Header */}
      <div className="lm-header">
        <div className="lm-header-icon">
          <Sparkles size={16} />
        </div>
        <span className="lm-header-title">LM Assistant</span>
        <button className="lm-close-btn" onClick={onToggle} title="ปิดแผง">
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div className="lm-body">
        {loading && (
          <div className="lm-loading">
            <div className="ann-spinner" />
            <span>กำลังวิเคราะห์ภาพ...</span>
          </div>
        )}

        {!loading && (
          <>
            {/* ── Detect missed objects ── */}
            <div className="lm-section">
              <div className="lm-section-header" onClick={() => toggleSection('detect')}>
                <ChevronRight size={14} className={`lm-section-chevron${sectOpen.detect ? ' open' : ''}`} />
                <span className="lm-section-title">ตรวจจับวัตถุที่ขาด</span>
                <span className="lm-section-badge">{detections.length}</span>
              </div>
              <div className={`lm-section-content${sectOpen.detect ? ' open' : ''}`}>
                {detections.length === 0 ? (
                  <div className="lm-empty">ไม่มีวัตถุที่ขาดหายไป</div>
                ) : (
                  <>
                    <div className="lm-det-list">
                      {detections.map((det, i) => {
                        const px = bboxPixel(det.box, iw, ih)
                        return (
                          <div className="lm-det-card" key={i}>
                            <div className="lm-det-thumb">
                              <Box size={18} />
                            </div>
                            <div className="lm-det-info">
                              <div className="lm-det-class">
                                {det.className} ({i + 1})
                              </div>
                              <div className="lm-det-bbox">
                                [{px.join(', ')}]
                              </div>
                            </div>
                            <span className={`lm-conf ${confClass(det.confidence)}`}>
                              {det.confidence.toFixed(2)}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                    <div className="lm-apply-wrap">
                      <button className="lm-apply-btn" onClick={handleApplyDetections}>
                        <Sparkles size={14} />
                        เพิ่ม {detections.length} การตรวจจับ
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* ── Refine existing boxes ── */}
            <div className="lm-section">
              <div className="lm-section-header" onClick={() => toggleSection('refine')}>
                <ChevronRight size={14} className={`lm-section-chevron${sectOpen.refine ? ' open' : ''}`} />
                <span className="lm-section-title">ปรับกรอบที่มีอยู่</span>
                <span className="lm-section-badge">{refinements.length}</span>
              </div>
              <div className={`lm-section-content${sectOpen.refine ? ' open' : ''}`}>
                {refinements.length === 0 ? (
                  <div className="lm-empty">ไม่มีคำแนะนำการปรับกรอบ</div>
                ) : (
                  refinements.map((ref, i) => {
                    const curPx = bboxPixel(ref.currentBox, iw, ih)
                    const sugPx = bboxPixel(ref.box, iw, ih)
                    const clsName = classes?.[ref.currentBox[0]] || ref.className
                    return (
                      <div className="lm-refine-card" key={i}>
                        <div className="lm-refine-class">{clsName}</div>
                        <div className="lm-refine-row">
                          <span className="lm-refine-label">ปัจจุบัน</span>
                          <span className="lm-refine-coords">
                            [{curPx.join(', ')}]
                          </span>
                        </div>
                        <div className="lm-refine-row">
                          <span className="lm-refine-label">แนะนำ</span>
                          <span className="lm-refine-coords suggested">
                            [{sugPx.join(', ')}]
                          </span>
                        </div>
                        <button className="lm-refine-btn" onClick={() => handleRefine(ref)}>
                          <RefreshCw size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                          ปรับกรอบ
                        </button>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Footer status */}
      <div className="lm-footer">
        <div className={`lm-status-dot${lmOnline ? ' online' : ''}`} />
        <span className="lm-status-label">LM Status</span>
        <span className="lm-status-time">
          {lmOnline
            ? `วิเคราะห์ใน ${analyzeTime}s`
            : 'ไม่ได้เชื่อมต่อ'}
        </span>
      </div>
    </div>
  )
}
