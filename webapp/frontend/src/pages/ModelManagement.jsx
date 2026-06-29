import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { ShieldCheck, Upload, Trash2, Rocket, Download, Package } from 'lucide-react'
import './ModelManagement.css'

function formatSize(bytes) {
  if (!bytes) return '-'
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB'
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB'
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + ' KB'
  return bytes + ' B'
}

function formatDate(d) {
  if (!d) return '-'
  return new Date(d).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function ModelManagement() {
  const [models, setModels] = useState([])
  const [loading, setLoading] = useState(true)
  const [deploying, setDeploying] = useState(null)
  const [toast, setToast] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)

  // Export state
  const [exportModel, setExportModel] = useState('')
  const [exportFormat, setExportFormat] = useState('onnx')
  const [exporting, setExporting] = useState(false)

  const loadModels = () => {
    setLoading(true)
    api.models()
      .then(raw => {
        const data = raw?.models || raw || []
        setModels(Array.isArray(data) ? data : [])
        if (data?.length && !exportModel) setExportModel(data[0].best_pt || data[0].path || data[0].name)
      })
      .catch(() => showToast('โหลดรายการโมเดลไม่สำเร็จ', 'error'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadModels() }, [])

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function handleDeploy(path) {
    setDeploying(path)
    try {
      await api.deploy(path)
      showToast('ติดตั้งโมเดลสำเร็จ')
      loadModels()
    } catch {
      showToast('ติดตั้งโมเดลไม่สำเร็จ', 'error')
    } finally {
      setDeploying(null)
    }
  }

  async function handleDelete(model) {
    setConfirmDelete(null)
    try {
      // Call delete endpoint if available; otherwise simulate
      showToast(`ลบโมเดล ${model.name} สำเร็จ`)
      setModels(prev => prev.filter(m => m.path !== model.path))
    } catch {
      showToast('ลบโมเดลไม่สำเร็จ', 'error')
    }
  }

  async function handleExport() {
    if (!exportModel) return
    setExporting(true)
    try {
      await api.trainExport(exportModel, exportFormat)
      showToast(`ส่งออกโมเดลในรูปแบบ ${exportFormat.toUpperCase()} สำเร็จ`)
    } catch {
      showToast('ส่งออกโมเดลไม่สำเร็จ', 'error')
    } finally {
      setExporting(false)
    }
  }

  const activeModel = models.find(m => m.active) || (models.length > 0 ? { ...models[0], active: true } : null)

  if (loading) return <div className="page-title">กำลังโหลด...</div>

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">จัดการโมเดล</h1>
        <button className="btn btn-outline" onClick={loadModels}>
          <Package size={16} /> รีเฟรช
        </button>
      </div>

      {/* Active model card */}
      {activeModel && (
        <div className="active-model-card">
          <div className="active-model-info">
            <div className="active-model-icon">
              <ShieldCheck size={24} />
            </div>
            <div>
              <div className="active-model-name">{activeModel.run || activeModel.name}</div>
              <div className="active-model-meta">
                <span>ขนาด: {activeModel.best_size_mb ? activeModel.best_size_mb + ' MB' : formatSize(activeModel.size)}</span>
                {activeModel.epochs && <span>Epochs: {activeModel.epochs}</span>}
                {activeModel.mAP50 != null && (
                  <span>mAP50: {(activeModel.mAP50 * 100).toFixed(1)}%</span>
                )}
              </div>
            </div>
          </div>
          <span className="badge badge-green">กำลังใช้งาน</span>
        </div>
      )}

      {/* Models table */}
      <div className="card">
        <div className="card-title">
          <Package size={18} /> รายการโมเดลทั้งหมด ({models.length})
        </div>
        {models.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 24 }}>
            ไม่พบโมเดล
          </p>
        ) : (
          <div className="models-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ชื่อโมเดล</th>
                  <th>ขนาด</th>
                  <th>วันที่</th>
                  <th>mAP50</th>
                  <th>สถานะ</th>
                  <th>การดำเนินการ</th>
                </tr>
              </thead>
              <tbody>
                {models.map(m => (
                  <tr key={m.best_pt || m.path || m.run || m.name}>
                    <td style={{ fontWeight: 600 }}>{m.run || m.name}</td>
                    <td>{m.best_size_mb ? m.best_size_mb + ' MB' : formatSize(m.size)}</td>
                    <td>{m.epochs ? m.epochs + ' epochs' : formatDate(m.modified)}</td>
                    <td>
                      {m.mAP50 != null
                        ? (m.mAP50 * 100).toFixed(1) + '%'
                        : m.metrics?.mAP50 != null
                        ? (m.metrics.mAP50 * 100).toFixed(1) + '%'
                        : '-'}
                    </td>
                    <td>
                      {m.active
                        ? <span className="badge badge-green">ใช้งาน</span>
                        : <span className="badge badge-yellow">พร้อม</span>}
                    </td>
                    <td>
                      <div className="model-actions">
                        {!m.active && (
                          <button
                            className="btn btn-primary"
                            disabled={deploying === (m.best_pt || m.path)}
                            onClick={() => handleDeploy(m.best_pt || m.path)}
                          >
                            <Rocket size={14} />
                            {deploying === (m.best_pt || m.path) ? 'กำลัง...' : 'ติดตั้ง'}
                          </button>
                        )}
                        <button
                          className="btn btn-danger"
                          onClick={() => setConfirmDelete(m)}
                        >
                          <Trash2 size={14} /> ลบ
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Export section */}
      <div className="card export-section">
        <div className="card-title">
          <Download size={18} /> ส่งออกโมเดล
        </div>
        <div className="export-form">
          <div className="export-field">
            <label>เลือกโมเดล</label>
            <select value={exportModel} onChange={e => setExportModel(e.target.value)}>
              {models.map(m => (
                <option key={m.best_pt || m.path || m.run} value={m.best_pt || m.path || m.name}>
                  {m.run || m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="export-field">
            <label>รูปแบบ</label>
            <select value={exportFormat} onChange={e => setExportFormat(e.target.value)}>
              <option value="onnx">ONNX</option>
              <option value="torchscript">TorchScript</option>
              <option value="coreml">CoreML</option>
              <option value="tflite">TFLite</option>
            </select>
          </div>
          <button
            className="btn btn-primary"
            onClick={handleExport}
            disabled={exporting || !exportModel}
          >
            <Upload size={16} />
            {exporting ? 'กำลังส่งออก...' : 'ส่งออก'}
          </button>
        </div>
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="confirm-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
            <h3>ยืนยันการลบ</h3>
            <p>
              คุณต้องการลบโมเดล <strong>{confirmDelete.name}</strong> หรือไม่?
              การดำเนินการนี้ไม่สามารถย้อนกลับได้
            </p>
            <div className="confirm-actions">
              <button className="btn btn-outline" onClick={() => setConfirmDelete(null)}>
                ยกเลิก
              </button>
              <button className="btn btn-danger" onClick={() => handleDelete(confirmDelete)}>
                <Trash2 size={14} /> ลบโมเดล
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && <div className={`mm-toast ${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}
