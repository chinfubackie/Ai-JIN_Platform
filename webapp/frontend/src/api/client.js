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
      body: JSON.stringify({ model_path: path }),
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
      body: JSON.stringify({ config }),
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
  importClasses: () => fetchJSON('/import/classes'),
  importSplitInfo: () => fetchJSON('/import/split-info'),
  importDelete: (files) =>
    fetchJSON('/import/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    }),
  importMove: (files, target) =>
    fetchJSON('/import/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files, target_split: target }),
    }),
  importGenerateYaml: () =>
    fetchJSON('/import/generate-yaml', { method: 'POST' }),

  // SAM segmentation
  samPredict: (formData) =>
    fetchJSON('/sam/predict', { method: 'POST', body: formData }),

  // Extended labels (boxes + polygons)
  labelExt: (path) => fetchJSON(`/label/ext/${path}`),
  saveLabelExt: (data) =>
    fetchJSON('/label/ext/save', {
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
