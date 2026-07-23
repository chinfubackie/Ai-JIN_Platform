import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSplitRequest,
  splitPreviewRows,
} from './datasetSplitUi.js'


test('normalizes 80/10/10 percentages for the preview API', () => {
  assert.deepEqual(
    buildSplitRequest({
      train: 80,
      val: 10,
      test: 10,
      sessionGapSeconds: 30,
      seed: 42,
    }),
    {
      train_ratio: 0.8,
      val_ratio: 0.1,
      test_ratio: 0.1,
      session_gap_seconds: 30,
      seed: 42,
    },
  )
})


test('rejects non-positive ratios and totals other than 100', () => {
  assert.throws(
    () => buildSplitRequest({
      train: 90,
      val: 10,
      test: 10,
      sessionGapSeconds: 30,
      seed: 42,
    }),
    /รวมกันต้องเท่ากับ 100/,
  )
  assert.throws(
    () => buildSplitRequest({
      train: 90,
      val: 10,
      test: 0,
      sessionGapSeconds: 30,
      seed: 42,
    }),
    /มากกว่า 0/,
  )
})


test('sorts per-workpiece preview rows by workpiece name', () => {
  assert.deepEqual(
    splitPreviewRows({
      Zebra: { total: 3 },
      Alpha: { total: 2 },
    }).map(([name]) => name),
    ['Alpha', 'Zebra'],
  )
})
