import { useRef, useEffect, useState } from 'react'

export default function VideoPlayer({ streamUrl, className = '' }) {
  const imgRef = useRef(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!streamUrl) {
      setConnected(false)
      return
    }

    const es = new EventSource(streamUrl)

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'frame' && imgRef.current) {
          const bytes = new Uint8Array(
            data.jpeg.match(/.{1,2}/g).map((b) => parseInt(b, 16)),
          )
          const blob = new Blob([bytes], { type: 'image/jpeg' })
          const url = URL.createObjectURL(blob)
          imgRef.current.src = url
          imgRef.current.onload = () => URL.revokeObjectURL(url)
        }
      } catch {}
    }

    es.onopen = () => setConnected(true)
    es.onerror = () => {}

    return () => {
      es.close()
      setConnected(false)
    }
  }, [streamUrl])

  return (
    <img
      ref={imgRef}
      className={`stream-video ${className}`}
      alt="Live stream"
      style={{ opacity: connected ? 1 : 0.5 }}
    />
  )
}
