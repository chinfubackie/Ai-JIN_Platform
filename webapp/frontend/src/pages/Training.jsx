import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '../api/client'
import { Play, Square, Download, Brain, Clock, Activity, BarChart3, Target, Layers, ChevronDown, FolderOpen } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { canStartTraining, isTrainImageFolder } from './trainingReadiness'
import './Training.css'

const BASE_MODELS = [
  { value: 'yolov8n.pt', label: 'YOLOv8n (Nano)' },
  { value: 'yolov8s.pt', label: 'YOLOv8s (Small)' },
  { value: 'yolov8m.pt', label: 'YOLOv8m (Medium)' },
  { value: 'yolov8l.pt', label: 'YOLOv8l (Large)' },
  { value: 'yolov8x.pt', label: 'YOLOv8x (Extra Large)' },
]

const EXPORT_FORMATS = ['onnx', 'torchscript', 'tflite', 'coreml']

function modelPath(model) {
  return model?.path || model?.best_pt || model?.deployed_model || ''
}

function modelLabel(model) {
  return model?.run_name || model?.run || model?.name || modelPath(model)
}

function mergeModels(...groups) {
  const merged = []
  const seen = new Set()
  groups.flat().filter(Boolean).forEach(model => {
    const key = modelPath(model) || model?.id || model?.run_name || model?.name
    if (!key || seen.has(key)) return
    seen.add(key)
    merged.push(model)
  })
  return merged
}

function formatBytes(bytes) {
  if (!bytes) return '-'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatDate(dateStr) {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  return d.toLocaleDateString('th-TH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const TRACKERS = [
  { value: 'bytetrack', label: 'ByteTrack', desc: 'เร็ว เหมาะกับ real-time' },
  { value: 'botsort',   label: 'BoT-SORT',  desc: 'แม่นยำกว่า รองรับ ReID' },
]

export default function Training() {
  const [activeTab, setActiveTab] = useState('train') // 'train' | 'tracking'
  const [showAdvancedTracking, setShowAdvancedTracking] = useState(false)

  // Config form state
  const [config, setConfig] = useState({
    model: 'yolov8n.pt',
    epochs: 100,
    batch: 16,
    imgsz: 640,
  })

  const [projects, setProjects] = useState([])
  const [projectId, setProjectId] = useState('')

  // Tracking params
  const [trackCfg, setTrackCfg] = useState({
    tracker: 'bytetrack',
    conf: 0.3,
    iou: 0.5,
    imgsz: 640,
    max_age: 30,
    min_hits: 3,
    track_high_thresh: 0.5,
    track_low_thresh: 0.1,
    new_track_thresh: 0.6,
    reid: false,
  })
  const [trackResult, setTrackResult] = useState(null)

  // Training state
  const [status, setStatus] = useState(null)  // null = not fetched yet
  const [lossHistory, setLossHistory] = useState([])
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)

  // Model history
  const [models, setModels] = useState([])
  const [exporting, setExporting] = useState(null) // "modelName:format"

  // Dataset folder to train on + its labeled/environment breakdown
  const [datasetFolders, setDatasetFolders] = useState([])
  const [selectedFolder, setSelectedFolder] = useState('')
  const [folderStats, setFolderStats] = useState(null)
  const [folderStatsLoading, setFolderStatsLoading] = useState(false)

  const intervalRef = useRef(null)
  const logRef = useRef(null)

  // Fetch initial status + models + projects
  useEffect(() => {
    api.trainStatus().then(setStatus).catch(() => {})
    api.projects().then(data => setProjects(Array.isArray(data) ? data : [])).catch(() => {})
    Promise.allSettled([api.runs(), api.models()]).then(results => {
      const dbRuns = results[0].status === 'fulfilled' && Array.isArray(results[0].value) ? results[0].value : []
      const scanned = results[1].status === 'fulfilled' ? (results[1].value?.models || results[1].value || []) : []
      setModels(mergeModels(dbRuns, scanned))
    })
    api.folders().then(data => {
      const list = (data?.folders || data || [])
      const trainFolders = list
        .map(f => typeof f === 'string' ? { path: f, count: 0 } : f)
        .filter(f => isTrainImageFolder(f.path))
      setDatasetFolders(trainFolders)
      setSelectedFolder(current => current || trainFolders[0]?.path || '')
    }).catch(() => {})
  }, [])

  // Labeled ("ภาพเทรน") vs unlabeled ("ภาพสิ่งแวดล้อม") breakdown for the folder to train on
  useEffect(() => {
    if (!selectedFolder) { setFolderStats(null); return }
    setFolderStatsLoading(true)
    api.datasetFolderStats(selectedFolder)
      .then(setFolderStats)
      .catch(() => setFolderStats(null))
      .finally(() => setFolderStatsLoading(false))
  }, [selectedFolder])

  const localModelOptions = models
    .map(m => ({ value: modelPath(m), label: modelLabel(m) }))
    .filter(m => m.value)

  useEffect(() => {
    if (!localModelOptions.length || config.model !== 'yolov8n.pt') return
    setConfig(c => ({ ...c, model: localModelOptions[0].value }))
  }, [config.model, localModelOptions])

  // Poll during training
  const startPolling = useCallback(() => {
    if (intervalRef.current) return
    intervalRef.current = setInterval(async () => {
      try {
        const s = await api.trainStatus()
        setStatus(s)
        if (s.metrics && s.epoch) {
          setLossHistory(prev => {
            const last = prev[prev.length - 1]
            if (last && last.epoch === s.epoch) return prev
            return [...prev, {
              epoch: s.epoch,
              loss: s.metrics.loss ?? null,
              mAP50: s.metrics.mAP50 ?? s.metrics.map50 ?? null,
            }]
          })
        }
        if (s.status !== 'training') {
          clearInterval(intervalRef.current)
          intervalRef.current = null
          // Refresh model list after training ends
          api.models().then(d => setModels(d?.models || d || [])).catch(() => {})
        }
      } catch {
        // ignore poll errors
      }
    }, 5000)
  }, [])

  // Start polling if status is "training" on load
  useEffect(() => {
    if (status?.status === 'training') {
      startPolling()
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [status?.status, startPolling])

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [status?.log])

  // Handlers
  const handleStart = async () => {
    setError('')
    setStarting(true)
    setLossHistory([])
    try {
      const payload = { ...config, data: '/dataset/auto_improve/data.yaml' }
      if (projectId) payload.project_id = parseInt(projectId)
      await api.trainStart(payload)
      const s = await api.trainStatus()
      setStatus(s)
      startPolling()
    } catch (err) {
      setError(err.message || 'ไม่สามารถเริ่มเทรนได้')
    } finally {
      setStarting(false)
    }
  }

  const handleExport = async (modelName, format) => {
    const key = `${modelName}:${format}`
    setExporting(key)
    try {
      await api.trainExport(modelName, format)
      api.models().then(d => setModels(d?.models || d || [])).catch(() => {})
    } catch (err) {
      setError(err.message || 'ส่งออกโมเดลล้มเหลว')
    } finally {
      setExporting(null)
    }
  }

  const statusState = status?.state || status?.status || 'idle'
  const isTraining = statusState === 'training'
  const isCompleted = ['completed', 'done'].includes(statusState)
  const isError = statusState === 'error'
  const isOffline = statusState === 'offline'
  const trainingReady = canStartTraining(selectedFolder, folderStats)
  const progress = status?.progress ?? 0
  const runnerLabel = status?.runner ? ` (${status.runner})` : ''

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">เทรนโมเดล</h1>
        <div className="tab-group">
          <button className={`tab-btn${activeTab === 'train' ? ' active' : ''}`} onClick={() => setActiveTab('train')}>
            <Brain size={14} /> เทรน
          </button>
          <button className={`tab-btn${activeTab === 'tracking' ? ' active' : ''}`} onClick={() => setActiveTab('tracking')}>
            <Target size={14} /> Tracking
          </button>
        </div>
      </div>

      {/* ── Tracking tab ── */}
      {activeTab === 'tracking' && (
        <div className="tracking-layout">
          <div className="card">
            <div className="card-title"><Target size={16} /> พารามิเตอร์ Tracker</div>
            <div className="config-form">

              <div className="form-group">
                <label>Tracker Algorithm</label>
                <div className="tracker-cards">
                  {TRACKERS.map(t => (
                    <div
                      key={t.value}
                      className={`tracker-card${trackCfg.tracker === t.value ? ' active' : ''}`}
                      onClick={() => setTrackCfg(c => ({ ...c, tracker: t.value }))}
                    >
                      <div className="tracker-card-name">{t.label}</div>
                      <div className="tracker-card-desc">{t.desc}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Confidence Threshold ({trackCfg.conf})</label>
                  <input type="range" min="0.05" max="0.95" step="0.05"
                    value={trackCfg.conf}
                    onChange={e => setTrackCfg(c => ({ ...c, conf: parseFloat(e.target.value) }))} />
                </div>
                <div className="form-group">
                  <label>IOU Threshold ({trackCfg.iou})</label>
                  <input type="range" min="0.1" max="0.9" step="0.05"
                    value={trackCfg.iou}
                    onChange={e => setTrackCfg(c => ({ ...c, iou: parseFloat(e.target.value) }))} />
                </div>
              </div>

              <button
                type="button"
                className="advanced-toggle"
                onClick={() => setShowAdvancedTracking(v => !v)}
              >
                <ChevronDown size={14} className={showAdvancedTracking ? 'rotated' : ''} />
                ขั้นสูง (Image size, Max age, Track thresholds, ReID)
              </button>

              {showAdvancedTracking && (<>
              <div className="form-row">
                <div className="form-group">
                  <label>Image Size</label>
                  <select value={trackCfg.imgsz}
                    onChange={e => setTrackCfg(c => ({ ...c, imgsz: parseInt(e.target.value) }))}>
                    {[320,416,512,640,768,1280].map(v => <option key={v} value={v}>{v}px</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Max Age (frames)</label>
                  <input type="number" min="1" max="300" value={trackCfg.max_age}
                    onChange={e => setTrackCfg(c => ({ ...c, max_age: parseInt(e.target.value) }))} />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Track High Thresh ({trackCfg.track_high_thresh})</label>
                  <input type="range" min="0.1" max="0.95" step="0.05"
                    value={trackCfg.track_high_thresh}
                    onChange={e => setTrackCfg(c => ({ ...c, track_high_thresh: parseFloat(e.target.value) }))} />
                </div>
                <div className="form-group">
                  <label>Track Low Thresh ({trackCfg.track_low_thresh})</label>
                  <input type="range" min="0.01" max="0.5" step="0.01"
                    value={trackCfg.track_low_thresh}
                    onChange={e => setTrackCfg(c => ({ ...c, track_low_thresh: parseFloat(e.target.value) }))} />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>New Track Thresh ({trackCfg.new_track_thresh})</label>
                  <input type="range" min="0.1" max="0.95" step="0.05"
                    value={trackCfg.new_track_thresh}
                    onChange={e => setTrackCfg(c => ({ ...c, new_track_thresh: parseFloat(e.target.value) }))} />
                </div>
                <div className="form-group">
                  <label>Min Hits (frames)</label>
                  <input type="number" min="1" max="10" value={trackCfg.min_hits}
                    onChange={e => setTrackCfg(c => ({ ...c, min_hits: parseInt(e.target.value) }))} />
                </div>
              </div>

              {trackCfg.tracker === 'botsort' && (
                <div className="form-group">
                  <label className="checkbox-label">
                    <input type="checkbox" checked={trackCfg.reid}
                      onChange={e => setTrackCfg(c => ({ ...c, reid: e.target.checked }))} />
                    เปิดใช้ ReID (ต้องการ GPU เพิ่ม)
                  </label>
                </div>
              )}
              </>)}
            </div>
          </div>

          {/* Config preview */}
          <div className="card">
            <div className="card-title"><Layers size={16} /> Config Preview</div>
            <div className="track-config-preview">
              <pre>{JSON.stringify({
                tracker_type: trackCfg.tracker,
                conf: trackCfg.conf,
                iou: trackCfg.iou,
                imgsz: trackCfg.imgsz,
                max_age: trackCfg.max_age,
                min_hits: trackCfg.min_hits,
                track_high_thresh: trackCfg.track_high_thresh,
                track_low_thresh: trackCfg.track_low_thresh,
                new_track_thresh: trackCfg.new_track_thresh,
                with_reid: trackCfg.tracker === 'botsort' ? trackCfg.reid : undefined,
              }, null, 2)}</pre>
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="track-info-row">
                <span>Tracker file:</span>
                <code>{trackCfg.tracker}.yaml</code>
              </div>
              <div className="track-info-row">
                <span>รองรับ multi-object:</span>
                <span style={{ color: 'var(--green)' }}>ไม่จำกัด (ขึ้นกับ GPU)</span>
              </div>
              <div className="track-info-row">
                <span>Output:</span>
                <span>Track ID + BBox ต่อ frame</span>
              </div>
            </div>
            <button className="btn-primary" style={{ marginTop: 16, width: '100%' }}
              onClick={() => setTrackResult({ saved: true, cfg: trackCfg })}>
              <Target size={14} /> บันทึก Config
            </button>
            {trackResult?.saved && (
              <div className="track-saved-msg">บันทึก config แล้ว — ใช้ในหน้า Deploy</div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'train' && (
      <div className="training-layout">
        {/* Left: Config */}
        <div className="card">
          <div className="card-title"><Brain size={16} /> ตั้งค่าการเทรน</div>
          <div className="config-form">
            <div className="form-group">
              <label><FolderOpen size={13} style={{ verticalAlign: -2 }} /> โฟลเดอร์ Train สำหรับตรวจความพร้อม</label>
              <select
                value={selectedFolder}
                onChange={e => setSelectedFolder(e.target.value)}
                disabled={isTraining}
              >
                <option value="">-- ไม่พบโฟลเดอร์ images/train --</option>
                {datasetFolders.map(f => (
                  <option key={f.path} value={f.path}>{f.path} ({f.count} ภาพ)</option>
                ))}
              </select>
            </div>

            {selectedFolder && (
              <div className="folder-stats-card">
                {folderStatsLoading ? (
                  <span className="folder-stats-loading">กำลังโหลดสถิติ...</span>
                ) : folderStats ? (
                  <>
                    <div className="folder-stats-row">
                      <span>ภาพทั้งหมด</span>
                      <strong>{folderStats.total}</strong>
                    </div>
                    <div className="folder-stats-row">
                      <span><span className="folder-stats-labeled-dot" />ภาพเทรน (มี label)</span>
                      <strong>{folderStats.labeled}</strong>
                    </div>
                    <div className="folder-stats-row">
                      <span><span className="folder-stats-env-dot" />ภาพสิ่งแวดล้อม (ไม่มี label)</span>
                      <strong>{folderStats.environment}</strong>
                    </div>
                    {!trainingReady && (
                      <div className="training-readiness-warning" role="alert">
                        ยังเริ่มเทรนไม่ได้: ต้องทำ Label ในชุด Train อย่างน้อย 1 ภาพ
                      </div>
                    )}
                  </>
                ) : (
                  <span className="folder-stats-loading">โหลดสถิติไม่สำเร็จ</span>
                )}
              </div>
            )}

            {projects.length > 0 && (
              <div className="form-group">
                <label>โปรเจกต์ (สำหรับบันทึกประวัติ)</label>
                <select
                  value={projectId}
                  onChange={e => setProjectId(e.target.value)}
                  disabled={isTraining}
                >
                  <option value="">-- ไม่ระบุ --</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="form-group">
              <label>โมเดลพื้นฐาน</label>
              <select
                value={config.model}
                onChange={e => setConfig(c => ({ ...c, model: e.target.value }))}
                disabled={isTraining}
              >
                {BASE_MODELS.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
                {localModelOptions.length > 0 && (
                  <optgroup label="โมเดลในเครื่อง">
                    {localModelOptions.map(m => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

            <div className="form-group">
              <label>Epochs</label>
              <input
                type="number"
                min={1}
                max={1000}
                value={config.epochs}
                onChange={e => setConfig(c => ({ ...c, epochs: parseInt(e.target.value) || 1 }))}
                disabled={isTraining}
              />
            </div>

            <div className="form-group">
              <label>Batch Size</label>
              <input
                type="number"
                min={1}
                max={128}
                value={config.batch}
                onChange={e => setConfig(c => ({ ...c, batch: parseInt(e.target.value) || 1 }))}
                disabled={isTraining}
              />
            </div>

            <div className="form-group">
              <label>ขนาดภาพ (Image Size)</label>
              <input
                type="number"
                min={64}
                max={1280}
                step={32}
                value={config.imgsz}
                onChange={e => setConfig(c => ({ ...c, imgsz: parseInt(e.target.value) || 640 }))}
                disabled={isTraining}
              />
            </div>

            {error && (
              <div style={{ color: 'var(--red)', fontSize: 13 }}>{error}</div>
            )}

            <button
              className={`btn ${isTraining ? 'btn-danger' : 'btn-primary'}`}
              onClick={handleStart}
              disabled={isTraining || starting || !trainingReady}
              title={!trainingReady ? 'ต้องมี Label ในชุด Train อย่างน้อย 1 ภาพ' : undefined}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              {starting ? (
                <><span className="train-spinner" /> กำลังเริ่ม...</>
              ) : isTraining ? (
                <><Square size={14} /> กำลังเทรน...</>
              ) : (
                <><Play size={14} /> เริ่มเทรน</>
              )}
            </button>
          </div>
        </div>

        {/* Right: Progress */}
        <div className="progress-section">
          {/* Status + Progress Bar */}
          <div className="card">
            <div className="progress-header">
              <div className="card-title"><Activity size={16} /> สถานะการเทรน</div>
              <div className="progress-status">
                {isTraining && <span className="train-spinner" />}
                <span className={
                  `badge ${isTraining ? 'badge-yellow' : isCompleted ? 'badge-green' : (isError || isOffline) ? 'badge-red' : ''}`
                }>
                  {isTraining ? 'กำลังเทรน'
                    : isCompleted ? 'เสร็จสิ้น'
                    : isError ? 'ผิดพลาด'
                    : isOffline ? 'ออฟไลน์'
                    : 'ว่าง'}
                  {runnerLabel}
                </span>
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div className="progress-bar-track">
                <div
                  className={`progress-bar-fill ${isCompleted ? 'completed' : ''} ${isError ? 'error' : ''}`}
                  style={{ width: `${Math.min(progress, 100)}%` }}
                />
              </div>
              <div className="progress-info" style={{ marginTop: 6 }}>
                <span>Epoch {status?.epoch ?? 0} / {status?.total_epochs ?? config.epochs}</span>
                <span>{Math.round(progress)}%</span>
              </div>
            </div>

            {/* Metrics */}
            {status?.metrics && (
              <div className="metrics-grid" style={{ marginTop: 14 }}>
                <div className="metric-card">
                  <div className="metric-label">Loss</div>
                  <div className="metric-value">
                    {status.metrics.loss != null ? status.metrics.loss.toFixed(4) : '-'}
                  </div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">mAP50</div>
                  <div className="metric-value" style={{ color: 'var(--green)' }}>
                    {(status.metrics.mAP50 ?? status.metrics.map50) != null
                      ? ((status.metrics.mAP50 ?? status.metrics.map50) * 100).toFixed(1) + '%'
                      : '-'}
                  </div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">Precision</div>
                  <div className="metric-value">
                    {status.metrics.precision != null
                      ? (status.metrics.precision * 100).toFixed(1) + '%'
                      : '-'}
                  </div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">Recall</div>
                  <div className="metric-value">
                    {status.metrics.recall != null
                      ? (status.metrics.recall * 100).toFixed(1) + '%'
                      : '-'}
                  </div>
                </div>
              </div>
            )}

            {status?.remote_status === 'offline' && status?.runner === 'local' && (
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 10 }}>
                Remote training server offline; using local Ultralytics runner.
              </div>
            )}
          </div>

          {/* Loss Chart */}
          {lossHistory.length > 1 && (
            <div className="card">
              <div className="card-title"><BarChart3 size={16} /> กราฟ Loss / mAP50</div>
              <div className="chart-container">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={lossHistory}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="epoch"
                      stroke="var(--text-muted)"
                      fontSize={11}
                      label={{ value: 'Epoch', position: 'insideBottomRight', offset: -4, fill: 'var(--text-muted)', fontSize: 11 }}
                    />
                    <YAxis stroke="var(--text-muted)" fontSize={11} />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--bg-card)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius)',
                        color: 'var(--text-primary)',
                        fontSize: 12,
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="loss"
                      stroke="var(--red)"
                      strokeWidth={2}
                      dot={false}
                      name="Loss"
                    />
                    <Line
                      type="monotone"
                      dataKey="mAP50"
                      stroke="var(--green)"
                      strokeWidth={2}
                      dot={false}
                      name="mAP50"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Training Log */}
          {status?.log && (
            <div className="card">
              <div className="card-title"><Clock size={16} /> บันทึกการเทรน</div>
              <div className="training-log" ref={logRef}>
                {status.log}
              </div>
            </div>
          )}
        </div>
      </div>
      )}

      {activeTab === 'train' && (
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-title"><Download size={16} /> ประวัติโมเดล</div>
        {models.length === 0 ? (
          <div className="empty-state">ยังไม่มีโมเดลที่เทรนเสร็จ</div>
        ) : (
          <div className="history-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ชื่อโมเดล</th>
                  <th>ขนาด</th>
                  <th>วันที่</th>
                  <th>mAP50</th>
                  <th>Loss</th>
                  <th>ส่งออก</th>
                </tr>
              </thead>
              <tbody>
                {models.map(m => {
                  // Normalize: DB run vs file-scan shape
                  const label   = m.run_name || m.run || m.name || '-'
                  const modelId = m.path || m.best_pt || m.run_name || m.name
                  const size    = m.size_bytes
                    ? formatBytes(m.size_bytes)
                    : m.best_size_mb ? m.best_size_mb + ' MB' : formatBytes(m.size)
                  const epochs  = m.epochs ? m.epochs + ' ep' : ''
                  const date    = m.created_at || m.started_at || m.modified
                  const map50   = m.map50 ?? m.mAP50 ?? m.metrics?.mAP50
                  const map5095 = m.map50_95 ?? m.mAP50_95 ?? m.metrics?.mAP50_95
                  const status  = m.status
                  return (
                    <tr key={m.id || m.run || m.best_pt}>
                      <td style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                        {label}
                        {status && status !== 'completed' && (
                          <span className={`badge badge-${status === 'training' ? 'yellow' : status === 'failed' ? 'red' : ''}`}
                            style={{ marginLeft: 6, fontSize: 10 }}>
                            {status}
                          </span>
                        )}
                      </td>
                      <td>{size}</td>
                      <td>{epochs || formatDate(date)}</td>
                      <td style={{ color: map50 != null ? 'var(--green)' : 'var(--text-muted)' }}>
                        {map50 != null ? (map50 * 100).toFixed(1) + '%' : '-'}
                      </td>
                      <td>{map5095 != null ? (map5095 * 100).toFixed(1) + '%' : '-'}</td>
                      <td>
                        {modelId ? (
                          <div className="export-actions">
                            {EXPORT_FORMATS.map(fmt => {
                              const key = `${modelId}:${fmt}`
                              return (
                                <button key={fmt} className="btn btn-outline"
                                  onClick={() => handleExport(modelId, fmt)}
                                  disabled={exporting === key}>
                                  {exporting === key ? '...' : fmt.toUpperCase()}
                                </button>
                              )
                            })}
                          </div>
                        ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>-</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}
    </div>
  )
}
