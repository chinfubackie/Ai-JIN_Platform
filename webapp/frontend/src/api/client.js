const BASE = '/api'

export async function fetchJSON(path, opts) {
  const res = await fetch(`${BASE}${path}`, opts)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

export const api = {
  stats: () => fetchJSON('/stats'),
  images: (dir, page = 1, perPage = 60) =>
    fetchJSON(`/images?dir=${encodeURIComponent(dir)}&page=${page}&per_page=${perPage}`),
  image: (path) => `${BASE}/image/${path}`,
  label: (path) => fetchJSON(`/label/${path}`),
  saveLabel: (data) =>
    fetchJSON('/label/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  predict: (formData) =>
    fetchJSON('/predict', { method: 'POST', body: formData }),
  predictLocal: (formData) =>
    fetchJSON('/predict/local', { method: 'POST', body: formData }),
  models: () => fetchJSON('/models'),
  deploy: (path) =>
    fetchJSON('/models/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: path }),
    }),
  folders: () => fetchJSON('/folders'),
  createFolder: (class_name, split = 'train') =>
    fetchJSON('/folders/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ class_name, split }),
    }),
  trainStart: (config) =>
    fetchJSON('/train/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }),
  trainStatus: () => fetchJSON('/train/status'),
  trainExport: (model, format) =>
    fetchJSON('/train/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, format }),
    }),
  importUpload: (formData) =>
    fetchJSON('/import/upload', { method: 'POST', body: formData }),
  importLabelStudio: (file) => {
    const formData = new FormData()
    formData.append('file', file)
    return fetchJSON('/import/labelstudio', { method: 'POST', body: formData })
  },
  importClasses: () => fetchJSON('/import/classes'),
  importSplitInfo: () => fetchJSON('/import/split-info'),
  datasetFolderStats: (folder) =>
    fetchJSON(`/dataset/folder-stats?folder=${encodeURIComponent(folder)}`),
  importDelete: (files) =>
    fetchJSON('/import/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: files }),
    }),
  importMove: (files, target) =>
    fetchJSON('/import/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: files, target_split: target }),
    }),
  importGenerateYaml: () =>
    fetchJSON('/import/generate-yaml', { method: 'POST' }),
  importExportNdjson: () =>
    fetchJSON('/import/export-ndjson', { method: 'POST' }),

  // Auto-label
  autolabelBatch: (data) =>
    fetchJSON('/autolabel/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  videoAutolabelStart: (formData) =>
    fetchJSON('/video/autolabel/start', { method: 'POST', body: formData }),
  videoAutolabelStatus: () => fetchJSON('/video/autolabel/status'),
  videoAutolabelCancel: () =>
    fetchJSON('/video/autolabel/cancel', { method: 'POST' }),

  // SAM segmentation
  samPredict: (formData) =>
    fetchJSON('/sam/predict', { method: 'POST', body: formData }),
  sam3Status: () => fetchJSON('/sam3/status'),
  sam3Predict: (data) => fetchJSON('/sam3/predict', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }),

  // Extended labels (boxes + polygons)
  labelExt: (path) => fetchJSON(`/label/ext/${path}`),
  saveLabelExt: (data) =>
    fetchJSON('/label/ext/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  // ── Camera & Counting ──
  cameras: () => fetchJSON('/cameras'),
  cameraAdd: (data) =>
    fetchJSON('/cameras', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  cameraRemove: (id) =>
    fetchJSON(`/cameras/${id}`, { method: 'DELETE' }),
  cameraStart: (id) =>
    fetchJSON(`/cameras/${id}/start`, { method: 'POST' }),
  cameraStop: (id) =>
    fetchJSON(`/cameras/${id}/stop`, { method: 'POST' }),
  cameraStatus: (id) => fetchJSON(`/cameras/${id}`),
  countingStats: (camId) => fetchJSON(`/counting/${camId}`),
  countingReset: (camId) =>
    fetchJSON(`/counting/${camId}/reset`, { method: 'POST' }),
  countingConfig: (camId) => fetchJSON(`/counting/${camId}/config`),
  countingAddZone: (camId, data) =>
    fetchJSON(`/counting/${camId}/zones`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  countingRemoveZone: (camId, zoneId) =>
    fetchJSON(`/counting/${camId}/zones/${zoneId}`, { method: 'DELETE' }),
  countingAddLine: (camId, data) =>
    fetchJSON(`/counting/${camId}/lines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  countingRemoveLine: (camId, lineId) =>
    fetchJSON(`/counting/${camId}/lines/${lineId}`, { method: 'DELETE' }),

  // ── Database / Projects ──
  dbStats: () => fetchJSON('/db/stats'),
  activity: (limit = 20) => fetchJSON(`/activity?limit=${limit}`),

  projects: () => fetchJSON('/projects'),
  projectGet: (id) => fetchJSON(`/projects/${id}`),
  projectCreate: (data) =>
    fetchJSON('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  projectUpdate: (id, data) =>
    fetchJSON(`/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  projectDelete: (id) =>
    fetchJSON(`/projects/${id}`, { method: 'DELETE' }),
  projectSync: (id) =>
    fetchJSON(`/projects/${id}/sync`, { method: 'POST' }),
  projectClasses: (pid) => fetchJSON(`/projects/${pid}/classes`),
  projectClassCreate: (pid, data) =>
    fetchJSON(`/projects/${pid}/classes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  classDelete: (cid) =>
    fetchJSON(`/classes/${cid}`, { method: 'DELETE' }),

  runs: (projectId) => fetchJSON(`/runs${projectId ? `?project_id=${projectId}` : ''}`),
  runGet: (rid) => fetchJSON(`/runs/${rid}`),

  registry: (projectId) => fetchJSON(`/registry${projectId ? `?project_id=${projectId}` : ''}`),
  registryDeploy: (mid) =>
    fetchJSON(`/registry/${mid}/deploy`, { method: 'POST' }),

  // System config
  getConfig: () => fetchJSON('/config'),
  setConfig: (data) => fetchJSON('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }),

  // LM Assistant (Ollama)
  lmModels: () => fetchJSON('/lm/models'),
  lmChat: (payload) =>
    fetchJSON('/lm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  lmChatStream: (payload, onToken, onDone, onError) => {
    fetch(`${BASE}/lm/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(async (res) => {
      if (!res.ok) { onError(`HTTP ${res.status}`); return }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (data === '[DONE]') { onDone(); return }
          try {
            const obj = JSON.parse(data)
            if (obj.token) onToken(obj.token)
            if (obj.error) onError(obj.error)
          } catch {}
        }
      }
      onDone()
    }).catch(onError)
  },
}
