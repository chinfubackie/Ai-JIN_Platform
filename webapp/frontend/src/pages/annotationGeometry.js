const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const round = (value) => Math.round(value * 1e12) / 1e12

export function moveYoloBox(box, dx, dy) {
  const [classId, cx, cy, width, height] = box
  const nextCx = clamp(cx + dx, width / 2, 1 - width / 2)
  const nextCy = clamp(cy + dy, height / 2, 1 - height / 2)
  return [classId, round(nextCx), round(nextCy), width, height]
}

export function resizeYoloBox(box, handle, nx, ny, minSize = 0.002) {
  const [classId, cx, cy, width, height] = box
  let x1 = cx - width / 2
  let y1 = cy - height / 2
  let x2 = cx + width / 2
  let y2 = cy + height / 2

  if (handle.includes('w')) x1 = clamp(nx, 0, x2 - minSize)
  if (handle.includes('e')) x2 = clamp(nx, x1 + minSize, 1)
  if (handle.includes('n')) y1 = clamp(ny, 0, y2 - minSize)
  if (handle.includes('s')) y2 = clamp(ny, y1 + minSize, 1)

  return [
    classId,
    round((x1 + x2) / 2),
    round((y1 + y2) / 2),
    round(x2 - x1),
    round(y2 - y1),
  ]
}
