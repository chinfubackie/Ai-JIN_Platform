import { useState, useEffect, useCallback } from 'react'
import {
  Plus, Trash2, Play, Square, Camera, Settings, AlertCircle,
  CheckCircle2, Monitor, Wifi, WifiOff, RefreshCw, Download,
  TrendingUp, Target, SquareStack,
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
          {isOnline ? <Monitor size={20} /> : isError ? <WifiOff size={20} /> : <Camera size={20} />}
        </div>
        <div className="cam-card-info">
          <div className="cam-card-name">{cam.name || `Cam #${cam.id}`}</div>
          <div className="cam-card-source">{cam.source}</div>
        </div>
        <div className="cam-card-status-dot">
          {isOnline ? <CheckCircle2 size={14} /> : isError ? <AlertCircle size={14} /> : <Wifi size={14} />}
        </div>
      </div>
      {isOnline && (
        <div className="cam-card-stats">
          <span>{cam.fps?.toFixed(1)} FPS</span>
          <span>Frame #{cam.frame_count}</span>
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

/* ---------- Main Page ---------- */
export default function LiveStream() {
  const [cameras, setCameras] = useState([])
  const [selectedCamera, setSelectedCamera] = useState(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newCamSource, setNewCamSource] = useState('')
  const [newCamName, setNewCamName] = useState('')
  const [newCamFps, setNewCamFps] = useState(15)
  const [error, setError] = useState(null)

  const [streamUrl, setStreamUrl] = useState(null)
  const [countStats, setCountStats] = useState(null)

  const [zones, setZones] = useState([])
  const [lines, setLines] = useState([])
  const [draftShape, setDraftShape] = useState(null) // {type:'zone'|'line', points:[[x,y],...], name, direction}

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
    loadCountingConfig(selectedCamera?.id)
  }, [selectedCamera, loadCountingConfig])

  // SSE stream
  useEffect(() => {
    if (!selectedCamera || selectedCamera.status !== 'streaming') {
      setStreamUrl(null)
      return
    }
    const es = new EventSource(`/api/cameras/${selectedCamera.id}/stream`)
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'result') {
          setCountStats(data)
        }
      } catch {}
    }
    es.onerror = () => {}
    setStreamUrl(`/api/cameras/${selectedCamera.id}/stream`)
    return () => {
      es.close()
      setStreamUrl(null)
    }
  }, [selectedCamera])

  // Add camera
  const handleAdd = async () => {
    if (!newCamSource.trim()) return
    try {
      await api.cameraAdd({
        source: newCamSource.trim(),
        name: newCamName.trim() || newCamSource.trim(),
        fps_target: newCamFps,
      })
      setNewCamSource('')
      setNewCamName('')
      setNewCamFps(15)
      setShowAddForm(false)
      await loadCameras()
    } catch (err) {
      setError('ไม่สามารถเพิ่มกล้องได้')
    }
  }

  // Remove camera
  const handleRemove = async (id) => {
    try {
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
      await api.cameraStart(id)
      await loadCameras()
    } catch (err) {
      setError('ไม่สามารถเปิดกล้องได้')
    }
  }

  // Stop camera
  const handleStop = async (id) => {
    try {
      await api.cameraStop(id)
      if (selectedCamera?.id === id) setSelectedCamera(null)
      await loadCameras()
    } catch (err) {
      setError('ไม่สามารถหยุดกล้องได้')
    }
  }

  const selectedCamData = cameras.find(c => c.id === selectedCamera?.id)
  const canDraw = selectedCamData?.status === 'streaming'

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

  const zoneName = (id) => zones.find(z => z.id === id)?.name || id
  const lineName = (id) => lines.find(l => l.id === id)?.name || id
  const shapeReady = draftShape && (
    (draftShape.type === 'zone' && draftShape.points.length >= 3) ||
    (draftShape.type === 'line' && draftShape.points.length === 2)
  )

  return (
    <div className="live-stream-page">
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
          <div className="add-cam-grid">
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
              <span className="form-hint">แนะนำ 5-15 FPS สำหรับสายผลิตทั่วไป</span>
            </div>
          </div>
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

      <div className="live-stream-layout">
        {/* Left: Camera list */}
        <div className="cam-list-panel">
          <div className="card">
            <div className="card-title"><Camera size={18} /> กล้องของฉัน</div>
            {cameras.length === 0 ? (
              <div className="cam-list-empty">
                ยังไม่มีกล้อง กด "เพิ่มกล้อง" เพื่อเริ่มต้น
              </div>
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
        </div>

        {/* Center: Live Stream */}
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
                  {selectedCamData.status === 'streaming' ? (
                    <>
                      <VideoPlayer streamUrl={streamUrl} />
                      {!streamUrl && (
                        <div className="stream-loading">กำลังเชื่อมต่อสตรีม...</div>
                      )}
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
                      <span>กล้องพร้อมใช้งาน กดเปิดเพื่อเริ่ม</span>
                      <button className="btn btn-primary" onClick={() => handleStart(selectedCamData.id)}>
                        <Play size={14} /> เปิดสตรีม
                      </button>
                    </div>
                  )}

                  {/* Zone/line overlay */}
                  <svg
                    className="zone-overlay"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    onClick={handleOverlayClick}
                    style={{ pointerEvents: draftShape ? 'auto' : 'none', cursor: draftShape ? 'crosshair' : 'default' }}
                  >
                    {zones.map(z => (
                      <polygon
                        key={z.id}
                        className="zone-shape"
                        points={z.points.map(p => `${p[0] * 100},${p[1] * 100}`).join(' ')}
                      />
                    ))}
                    {lines.map(l => (
                      <line
                        key={l.id}
                        className="line-shape"
                        x1={l.x1 * 100} y1={l.y1 * 100} x2={l.x2 * 100} y2={l.y2 * 100}
                      />
                    ))}
                    {draftShape?.points.length > 0 && (
                      <polyline
                        className="draft-shape"
                        points={draftShape.points.map(p => `${p[0] * 100},${p[1] * 100}`).join(' ')}
                      />
                    )}
                    {draftShape?.points.map((p, i) => (
                      <circle key={i} className="draft-point" cx={p[0] * 100} cy={p[1] * 100} r="1" />
                    ))}
                  </svg>

                  {/* Draft shape toolbar */}
                  {draftShape && (
                    <div className="draft-toolbar">
                      <span>
                        {draftShape.type === 'zone'
                          ? `กำลังวาดโซน (${draftShape.points.length} จุด, อย่างน้อย 3)`
                          : `กำลังวาดเส้นนับ (${draftShape.points.length}/2 จุด)`}
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
                            <select
                              value={draftShape.direction}
                              onChange={e => setDraftShape(d => ({ ...d, direction: e.target.value }))}
                            >
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
                {selectedCamData && (
                  <div className="stream-info-bar">
                    <span><Wifi size={12} /> {selectedCamData.fps?.toFixed(1) || 0} FPS</span>
                    <span><SquareStack size={12} /> Frame #{selectedCamData.frame_count || 0}</span>
                    <span><Settings size={12} /> {selectedCamData.source}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="stream-placeholder">
                <Camera size={64} />
                <span>คลิกเลือกกล้องจากด้านซ้าย</span>
              </div>
            )}
          </div>
        </div>

        {/* Right: Counting Stats */}
        <div className="stats-panel">
          <div className="card">
            <div className="card-title"><TrendingUp size={18} /> จำนวนนับ</div>
            {countStats ? (
              <div className="count-stats">
                <div className="count-item-main">
                  <span className="count-label">ทั้งหมด</span>
                  <span className="count-value">
                    {Object.values(countStats.total_class_counts || {}).reduce((a, b) => a + b, 0)}
                  </span>
                </div>
                {Object.entries(countStats.total_class_counts || {}).map(([cls, cnt]) => (
                  <div key={cls} className="count-item">
                    <span className="count-label">{cls}</span>
                    <span className="count-value">{cnt}</span>
                  </div>
                ))}
                {countStats.zone_counts && Object.keys(countStats.zone_counts).length > 0 && (
                  <>
                    <div className="count-section-title"><Target size={14} /> โซน</div>
                    {Object.entries(countStats.zone_counts).map(([zone, cnt]) => (
                      <div key={zone} className="count-item">
                        <span className="count-label">{zoneName(zone)}</span>
                        <span className="count-value">{cnt}</span>
                      </div>
                    ))}
                  </>
                )}
                {countStats.line_counts && Object.keys(countStats.line_counts).length > 0 && (
                  <>
                    <div className="count-section-title"><SquareStack size={14} /> เส้นนับ</div>
                    {Object.entries(countStats.line_counts).map(([line, cnt]) => (
                      <div key={line} className="count-item">
                        <span className="count-label">{lineName(line)}</span>
                        <span className="count-value">{cnt}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            ) : (
              <div className="stats-empty">รอสตรีมกล้องเพื่อดูจำนวนนับ</div>
            )}
          </div>

          {/* Quick Actions */}
          <div className="card stats-actions-card">
            <div className="card-title"><Settings size={18} /> ตั้งค่าโซนนับ</div>
            <div className="quick-actions">
              <button
                className={`btn btn-sm ${draftShape?.type === 'zone' ? 'btn-primary' : 'btn-outline'}`}
                disabled={!canDraw}
                onClick={() => toggleDraw('zone')}
              >
                <Target size={14} /> {draftShape?.type === 'zone' ? 'ยกเลิกวาดโซน' : 'โซนนับ'}
              </button>
              <button
                className={`btn btn-sm ${draftShape?.type === 'line' ? 'btn-primary' : 'btn-outline'}`}
                disabled={!canDraw}
                onClick={() => toggleDraw('line')}
              >
                <SquareStack size={14} /> {draftShape?.type === 'line' ? 'ยกเลิกวาดเส้น' : 'เส้นนับ'}
              </button>
              <button className="btn btn-outline btn-sm" disabled={!countStats} onClick={handleExportStats}>
                <Download size={14} /> Export
              </button>
            </div>
            {(zones.length > 0 || lines.length > 0) && (
              <div className="shape-list">
                {zones.map(z => (
                  <div key={z.id} className="shape-chip">
                    <Target size={12} />
                    <span>{z.name || z.id}</span>
                    <button onClick={() => handleRemoveZone(z.id)} title="ลบโซนนี้">✕</button>
                  </div>
                ))}
                {lines.map(l => (
                  <div key={l.id} className="shape-chip">
                    <SquareStack size={12} />
                    <span>{l.name || l.id}</span>
                    <button onClick={() => handleRemoveLine(l.id)} title="ลบเส้นนี้">✕</button>
                  </div>
                ))}
              </div>
            )}
            <div className="stats-hint">
              {canDraw ? 'กดปุ่มด้านบนแล้วคลิกบนวิดีโอเพื่อวาดโซน/เส้นนับ' : 'เปิดสตรีมกล้องก่อนจึงจะวาดโซน/เส้นนับได้'}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}