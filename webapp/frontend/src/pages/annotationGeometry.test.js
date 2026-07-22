import assert from 'node:assert/strict'
import test from 'node:test'

let geometry = {}
try {
  geometry = await import('./annotationGeometry.js')
} catch {
  // The first TDD run intentionally has no implementation module.
}

const near = (actual, expected) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)
}

test('moves a YOLO box without changing size and clamps it inside the image', () => {
  assert.equal(typeof geometry.moveYoloBox, 'function')

  const moved = geometry.moveYoloBox([2, 0.5, 0.5, 0.4, 0.2], 0.4, -0.6)

  assert.deepEqual(moved, [2, 0.8, 0.1, 0.4, 0.2])
})

test('resizes a YOLO box from each selected corner', () => {
  assert.equal(typeof geometry.resizeYoloBox, 'function')
  const box = [1, 0.5, 0.5, 0.4, 0.2]

  const nw = geometry.resizeYoloBox(box, 'nw', 0.25, 0.35)
  const se = geometry.resizeYoloBox(box, 'se', 0.85, 0.75)

  assert.deepEqual(nw, [1, 0.475, 0.475, 0.45, 0.25])
  assert.deepEqual(se, [1, 0.575, 0.575, 0.55, 0.35])
})

test('keeps a resized box in bounds and above the minimum size', () => {
  assert.equal(typeof geometry.resizeYoloBox, 'function')
  const resized = geometry.resizeYoloBox([0, 0.5, 0.5, 0.4, 0.2], 'nw', 1.5, 1.5)

  near(resized[1], 0.699)
  near(resized[2], 0.599)
  near(resized[3], 0.002)
  near(resized[4], 0.002)
})
