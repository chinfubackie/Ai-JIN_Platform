import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '../api/client'
import {
  Upload, FolderOpen, Trash2, ArrowRightLeft, FileCode, RefreshCw,
  X, Check, ChevronLeft, ChevronRight, ImageIcon, Tag, CheckSquare, Square
} from 'lucide-react'
import './DataImport.css'

const PER_PAGE = 60

export default function DataImport() {
  // Upload state
  const [files, setFiles] = useState([])
  const [className, setClassName] = useState('')
  const [split, setSplit] = useState('train')
  const [classes, setClasses] = useState([])
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)
  const [projects, setProjects] = useState([])
  const [selectedProject, setSelectedProject] = useState('')
  const [lsFile, setLsFile] = useState(null)
  const [lsDragOver, setLsDragOver] = useState(false)
  const [lsUploading, setLsUploading] = useState(false)
  const [lsProgress, setLsProgress] = useState(0)
  const [lsResult, setLsResult] = useState(null)
  const lsFileInputRef = useRef(null)

  // Browse state
  const [folders, setFolders] = useState([])
  const [activeFolder, setActiveFolder] = useState('')
  const [images, setImages] = useState([])
  const [totalImages, setTotalImages] = useState(0)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState(new Set())

  // Split info
  const [splitInfo, setSplitInfo] = useState(null)

  // UI
  const [toast, setToast] = useState(null)
  const [yamlMsg, setYamlMsg] = useState('')
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderSplit, setNewFolderSplit] = useState('train')
  const [creatingFolder, setCreatingFolder] = useState(false)

  // --- Data loading ---
  const loadClasses = useCallback(() => {
    api.importClasses().then(data => {
      setClasses(data?.classes || (Array.isArray(data) ? data : []))
    }).catch(() => {})
  }, [])

  const loadSplitInfo = useCallback(() => {
    api.importSplitInfo().then(setSplitInfo).catch(() => {})
  }, [])

  const loadFolders = useCallback(() => {
    api.folders().then(data => {
      const list = (data?.folders || data || []).map(f => typeof f === 'string' ? f : f.path)
      setFolders(list)
    }).catch(() => {})
  }, [])

  const loadImages = useCallback((dir, p) => {
    if (!dir) return
    api.images(dir, p, PER_PAGE).then(res => {
      setImages((res.images || []).map(i => typeof i === 'string' ? i : i.path))
      setTotalImages(res.total || 0)
    }).catch(() => {
      setImages([])
      setTotalImages(0)
    })
  }, [])

  useEffect(() => {
    loadClasses()
    loadSplitInfo()
    loadFolders()
    api.projects().then(d => setProjects(Array.isArray(d) ? d : [])).catch(() => {})
  }, [loadClasses, loadSplitInfo, loadFolders])

  useEffect(() => {
    if (activeFolder) {
      loadImages(activeFolder, page)
      setSelected(new Set())
    }
  }, [activeFolder, page, loadImages])

  const refreshAll = useCallback(() => {
    loadClasses()
    loadSplitInfo()
    loadFolders()
    if (activeFolder) loadImages(activeFolder, page)
  }, [loadClasses, loadSplitInfo, loadFolders, loadImages, activeFolder, page])

  // --- Create Folder ---
  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return
    setCreatingFolder(true)
    try {
      await api.createFolder(newFolderName.trim(), newFolderSplit)
      showToast(`สร้างโฟลเดอร์ "${newFolderName}" สำเร็จ`)
      setNewFolderName('')
      loadFolders()
    } catch {
      showToast('สร้างโฟลเดอร์ไม่สำเร็จ', 'error')
    } finally {
      setCreatingFolder(false)
    }
  }

  // --- Toast helper ---
  const showToast = (msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  // --- File handling ---
  const handleFileSelect = (e) => {
    const newFiles = Array.from(e.target.files)
    setFiles(prev => [...prev, ...newFiles])
  }

  const handleDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    const newFiles = Array.from(e.dataTransfer.files)
    setFiles(prev => [...prev, ...newFiles])
  }

  const removeFile = (idx) => {
    setFiles(prev => prev.filter((_, i) => i !== idx))
  }

  const handleLabelStudioFile = (file) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.json')) {
      showToast('กรุณาเลือกไฟล์ .json จาก Label Studio', 'error')
      return
    }
    setLsFile(file)
    setLsResult(null)
  }

  const handleLabelStudioSelect = (e) => {
    handleLabelStudioFile(e.target.files?.[0])
  }

  const handleLabelStudioDrop = (e) => {
    e.preventDefault()
    setLsDragOver(false)
    handleLabelStudioFile(e.dataTransfer.files?.[0])
  }

  // --- Upload ---
  const handleUpload = async () => {
    if (files.length === 0) return
    if (!className.trim()) {
      showToast('กรุณาระบุชื่อคลาส', 'error')
      return
    }

    setUploading(true)
    setProgress(0)

    const formData = new FormData()
    files.forEach(f => formData.append('images', f))
    formData.append('class_name', className.trim())
    formData.append('split', split)

    try {
      // Simulate progress since fetch doesn't support upload progress natively
      const progressInterval = setInterval(() => {
        setProgress(prev => {
          if (prev >= 90) { clearInterval(progressInterval); return 90 }
          return prev + 10
        })
      }, 200)

      await api.importUpload(formData)

      clearInterval(progressInterval)
      setProgress(100)
      showToast(`อัปโหลดสำเร็จ ${files.length} ไฟล์`)
      setFiles([])
      if (fileInputRef.current) fileInputRef.current.value = ''
      refreshAll()

      // Auto-sync to project DB
      if (selectedProject) {
        try {
          const r = await api.projectSync(parseInt(selectedProject))
          showToast(`Sync โปรเจกต์สำเร็จ: ${r.synced ?? 0} ภาพ`)
        } catch { /* non-fatal */ }
      }
    } catch (err) {
      showToast(`อัปโหลดล้มเหลว: ${err.message}`, 'error')
    } finally {
      setUploading(false)
      setTimeout(() => setProgress(0), 1500)
    }
  }

  const handleLabelStudioImport = async () => {
    if (!lsFile || lsUploading) return
    setLsUploading(true)
    setLsProgress(0)
    setLsResult(null)
    const progressInterval = setInterval(() => {
      setLsProgress(prev => {
        if (prev >= 90) { clearInterval(progressInterval); return 90 }
        return prev + 15
      })
    }, 200)
    try {
      const res = await api.importLabelStudio(lsFile)
      clearInterval(progressInterval)
      setLsProgress(100)
      setLsResult(res)
      showToast(`นำเข้า Label Studio สำเร็จ ${res.imported ?? 0} ภาพ`)
      refreshAll()
    } catch (err) {
      setLsResult({ imported: 0, skipped: 0, classes: [], errors: [err.message] })
      showToast(`นำเข้า Label Studio ล้มเหลว: ${err.message}`, 'error')
    } finally {
      setLsUploading(false)
      setTimeout(() => setLsProgress(0), 1500)
    }
  }

  // --- Selection ---
  const toggleSelect = (img) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(img)) next.delete(img)
      else next.add(img)
      return next
    })
  }

  const selectAll = () => {
    if (selected.size === images.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(images))
    }
  }

  // --- Delete ---
  const handleDelete = async () => {
    if (selected.size === 0) return
    try {
      await api.importDelete(Array.from(selected))
      showToast(`ลบสำเร็จ ${selected.size} ไฟล์`)
      setSelected(new Set())
      refreshAll()
    } catch (err) {
      showToast(`ลบล้มเหลว: ${err.message}`, 'error')
    }
  }

  // --- Move ---
  const handleMove = async (target) => {
    if (selected.size === 0) return
    try {
      await api.importMove(Array.from(selected), target)
      showToast(`ย้ายสำเร็จ ${selected.size} ไฟล์ไปยัง ${target}`)
      setSelected(new Set())
      refreshAll()
    } catch (err) {
      showToast(`ย้ายล้มเหลว: ${err.message}`, 'error')
    }
  }

  // --- Generate YAML ---
  const handleGenerateYaml = async () => {
    try {
      const res = await api.importGenerateYaml()
      setYamlMsg(res.path || 'สร้าง YAML สำเร็จ')
      showToast('สร้าง dataset YAML สำเร็จ')
    } catch (err) {
      showToast(`สร้าง YAML ล้มเหลว: ${err.message}`, 'error')
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalImages / PER_PAGE))

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">นำเข้าข้อมูล</h1>
        <button className="btn btn-outline" onClick={refreshAll}>
          <RefreshCw size={14} /> รีเฟรช
        </button>
      </div>

      {/* ---- Split Info ---- */}
      {splitInfo && (
        <div className="card di-section">
          <div className="card-title">สถิติชุดข้อมูล</div>
          <div className="di-split-stats">
            {Object.entries(splitInfo).map(([key, val]) => (
              <div className="di-split-card" key={key}>
                <h4>
                  <Tag size={14} />
                  {key.toUpperCase()}
                </h4>
                <div className="di-split-row">
                  <span>รูปภาพ</span>
                  <span>{val.total ?? val.images ?? 0}</span>
                </div>
                <div className="di-split-row">
                  <span>Labels</span>
                  <span>{val.labels ?? 0}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- Upload Section ---- */}
      <div className="card di-section">
        <div className="card-title">อัปโหลดไฟล์</div>

        {/* Project selector */}
        {projects.length > 0 && (
          <div className="di-project-row">
            <label>บันทึกใต้โปรเจกต์:</label>
            <select
              value={selectedProject}
              onChange={e => setSelectedProject(e.target.value)}
              className="di-project-select"
            >
              <option value="">-- ไม่ระบุโปรเจกต์ --</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="di-upload-grid">
          {/* Drop zone */}
          <div>
            <div
              className={`di-dropzone${dragOver ? ' drag-over' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              <div className="di-dropzone-icon"><Upload size={32} /></div>
              <div className="di-dropzone-text">คลิกหรือลากไฟล์มาวางที่นี่</div>
              <div className="di-dropzone-hint">รองรับไฟล์ภาพ (.jpg, .png, .bmp) และ label (.txt)</div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.txt"
                style={{ display: 'none' }}
                onChange={handleFileSelect}
              />
            </div>

            {files.length > 0 && (
              <div className="di-file-list">
                {files.map((f, i) => (
                  <div className="di-file-item" key={`${f.name}-${i}`}>
                    <ImageIcon size={12} />
                    <span>{f.name}</span>
                    <button onClick={() => removeFile(i)}><X size={12} /></button>
                  </div>
                ))}
              </div>
            )}

            {progress > 0 && (
              <div className="di-progress">
                <div className="di-progress-bar">
                  <div className="di-progress-fill" style={{ width: `${progress}%` }} />
                </div>
                <div className="di-progress-text">{progress}%</div>
              </div>
            )}
          </div>

          {/* Upload options */}
          <div className="di-upload-options">
            <div className="di-field">
              <label>ชื่อคลาส (Class Name)</label>
              <input
                list="class-list"
                value={className}
                onChange={e => setClassName(e.target.value)}
                placeholder="เช่น cat, dog, person..."
              />
              <datalist id="class-list">
                {classes.map(c => <option key={c} value={c} />)}
              </datalist>
            </div>

            <div className="di-field">
              <label>Split</label>
              <select value={split} onChange={e => setSplit(e.target.value)}>
                <option value="train">Train</option>
                <option value="val">Validation</option>
              </select>
            </div>

            <div className="di-upload-actions">
              <button
                className="btn btn-primary"
                onClick={handleUpload}
                disabled={uploading || files.length === 0}
              >
                <Upload size={14} />
                {uploading ? 'กำลังอัปโหลด...' : `อัปโหลด (${files.length} ไฟล์)`}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ---- Label Studio Import ---- */}
      <div className="card di-section">
        <div className="card-title">Label Studio</div>
        <div className="di-upload-grid">
          <div>
            <div
              className={`di-dropzone${lsDragOver ? ' drag-over' : ''}`}
              onClick={() => lsFileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setLsDragOver(true) }}
              onDragLeave={() => setLsDragOver(false)}
              onDrop={handleLabelStudioDrop}
            >
              <div className="di-dropzone-icon"><FileCode size={32} /></div>
              <div className="di-dropzone-text">นำเข้า Label Studio JSON</div>
              <div className="di-dropzone-hint">รองรับไฟล์ export .json หนึ่งไฟล์</div>
              <input
                ref={lsFileInputRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={handleLabelStudioSelect}
              />
            </div>

            {lsFile && (
              <div className="di-file-list">
                <div className="di-file-item">
                  <FileCode size={12} />
                  <span>{lsFile.name}</span>
                  <button onClick={() => { setLsFile(null); setLsResult(null) }}><X size={12} /></button>
                </div>
              </div>
            )}

            {lsProgress > 0 && (
              <div className="di-progress">
                <div className="di-progress-bar">
                  <div className="di-progress-fill" style={{ width: `${lsProgress}%` }} />
                </div>
                <div className="di-progress-text">{lsProgress}%</div>
              </div>
            )}
          </div>

          <div className="di-upload-options">
            <div className="di-field">
              <label>ปลายทาง</label>
              <div className="di-static-field">auto_improve/images/train/&lt;class&gt;</div>
            </div>
            <div className="di-upload-actions">
              <button
                className="btn btn-primary"
                onClick={handleLabelStudioImport}
                disabled={!lsFile || lsUploading}
              >
                <Upload size={14} />
                {lsUploading ? 'กำลังนำเข้า...' : 'นำเข้า'}
              </button>
            </div>

            {lsResult && (
              <div className="di-ls-result">
                <div className="di-ls-summary">
                  นำเข้าสำเร็จ {lsResult.imported ?? 0} ภาพ, {(lsResult.classes || []).length} class:
                  {' '}
                  {(lsResult.classes || []).length ? (lsResult.classes || []).join(', ') : '-'}
                </div>
                {(lsResult.skipped ?? 0) > 0 && (
                  <div className="di-ls-skipped">ข้าม {lsResult.skipped} task</div>
                )}
                {(lsResult.errors || []).length > 0 && (
                  <div className="di-ls-errors">
                    {(lsResult.errors || []).map((err, i) => (
                      <div key={`${err}-${i}`}>{err}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---- Generate YAML ---- */}
      <div className="card di-section">
        <div className="card-title">สร้างไฟล์ตั้งค่า Dataset</div>
        <div className="di-yaml-section">
          <button className="btn btn-success" onClick={handleGenerateYaml}>
            <FileCode size={14} /> สร้าง YAML
          </button>
          {yamlMsg && <span className="di-yaml-msg">{yamlMsg}</span>}
        </div>
      </div>

      {/* ---- Add Folder Section ---- */}
      <div className="card di-section">
        <div className="card-title"><FolderOpen size={16} /> เพิ่มโฟลเดอร์ใหม่</div>
        <div className="di-add-folder-row">
          <input
            type="text"
            className="di-folder-input"
            placeholder="ชื่อคลาส / โฟลเดอร์ เช่น F-373130-K010"
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateFolder()}
          />
          <select
            className="di-split-select"
            value={newFolderSplit}
            onChange={e => setNewFolderSplit(e.target.value)}
          >
            <option value="train">Train</option>
            <option value="val">Val</option>
            <option value="test">Test</option>
          </select>
          <button
            className="btn btn-primary"
            onClick={handleCreateFolder}
            disabled={creatingFolder || !newFolderName.trim()}
          >
            <FolderOpen size={14} />
            {creatingFolder ? 'กำลังสร้าง...' : 'สร้างโฟลเดอร์'}
          </button>
        </div>
      </div>

      {/* ---- Browse Section ---- */}
      <div className="card di-section">
        <div className="card-title">เรียกดูไฟล์</div>
        <div className="di-browse-grid">
          {/* Folder sidebar */}
          <div className="di-folder-list">
            {folders.length === 0 && (
              <div className="di-empty">ไม่พบโฟลเดอร์</div>
            )}
            {folders.map(f => (
              <button
                key={f}
                className={`di-folder-item${activeFolder === f ? ' active' : ''}`}
                onClick={() => { setActiveFolder(f); setPage(1) }}
              >
                <FolderOpen size={14} />
                {f}
              </button>
            ))}
          </div>

          {/* Image grid */}
          <div>
            {activeFolder ? (
              <>
                <div className="di-browse-toolbar">
                  <button className="btn btn-outline" onClick={selectAll}>
                    {selected.size === images.length && images.length > 0
                      ? <><CheckSquare size={14} /> ยกเลิกทั้งหมด</>
                      : <><Square size={14} /> เลือกทั้งหมด</>
                    }
                  </button>
                  <button
                    className="btn btn-danger"
                    onClick={handleDelete}
                    disabled={selected.size === 0}
                  >
                    <Trash2 size={14} /> ลบ
                  </button>
                  <button
                    className="btn btn-outline"
                    onClick={() => handleMove('train')}
                    disabled={selected.size === 0}
                  >
                    <ArrowRightLeft size={14} /> ย้ายไป Train
                  </button>
                  <button
                    className="btn btn-outline"
                    onClick={() => handleMove('val')}
                    disabled={selected.size === 0}
                  >
                    <ArrowRightLeft size={14} /> ย้ายไป Val
                  </button>
                  {selected.size > 0 && (
                    <span className="di-select-count">
                      เลือกแล้ว {selected.size} ไฟล์
                    </span>
                  )}
                </div>

                {images.length === 0 ? (
                  <div className="di-empty">ไม่พบรูปภาพในโฟลเดอร์นี้</div>
                ) : (
                  <div className="di-image-grid">
                    {images.map(img => (
                      <div
                        key={img}
                        className={`di-image-cell${selected.has(img) ? ' selected' : ''}`}
                        onClick={() => toggleSelect(img)}
                      >
                        <img
                          src={api.image(img)}
                          alt={img}
                          loading="lazy"
                        />
                        <div className="di-image-check">
                          {selected.has(img) ? <Check size={12} /> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {totalPages > 1 && (
                  <div className="di-pagination">
                    <button
                      className="btn btn-outline"
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page <= 1}
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span className="di-page-info">
                      หน้า {page} / {totalPages} (ทั้งหมด {totalImages} ภาพ)
                    </span>
                    <button
                      className="btn btn-outline"
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                      disabled={page >= totalPages}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="di-empty">เลือกโฟลเดอร์เพื่อเรียกดูรูปภาพ</div>
            )}
          </div>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`di-toast ${toast.type}`}>{toast.msg}</div>
      )}
    </div>
  )
}
