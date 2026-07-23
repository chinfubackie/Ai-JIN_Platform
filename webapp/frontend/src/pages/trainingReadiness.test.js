import assert from 'node:assert/strict'
import test from 'node:test'

let readiness = {}
try {
  readiness = await import('./trainingReadiness.js')
} catch {
  // The first TDD run intentionally has no implementation module.
}

test('recognizes only the active Train image folder', () => {
  assert.equal(typeof readiness.isTrainImageFolder, 'function')
  assert.equal(readiness.isTrainImageFolder('auto_improve/images/train'), true)
  assert.equal(readiness.isTrainImageFolder('auto_improve/images/val'), false)
  assert.equal(readiness.isTrainImageFolder('split_quarantine/x/images/train'), false)
})

test('blocks training until the Train folder has at least one label', () => {
  assert.equal(typeof readiness.canStartTraining, 'function')
  assert.equal(
    readiness.canStartTraining('auto_improve/images/train', { total: 1015, labeled: 0 }),
    false,
  )
  assert.equal(
    readiness.canStartTraining('auto_improve/images/train', { total: 1015, labeled: 1 }),
    true,
  )
  assert.equal(
    readiness.canStartTraining('auto_improve/images/test', { total: 107, labeled: 1 }),
    false,
  )
})
