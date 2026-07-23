export function buildSplitRequest({
  train,
  val,
  test,
  sessionGapSeconds,
  seed,
}) {
  const percentages = [train, val, test].map(Number)
  if (percentages.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error('สัดส่วน Train, Val และ Test ต้องมากกว่า 0')
  }
  const total = percentages.reduce((sum, value) => sum + value, 0)
  if (Math.abs(total - 100) > 0.0001) {
    throw new Error('สัดส่วน Train, Val และ Test รวมกันต้องเท่ากับ 100')
  }
  const gap = Number(sessionGapSeconds)
  const normalizedSeed = Number(seed)
  if (!Number.isInteger(gap) || gap < 0) {
    throw new Error('Session gap ต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป')
  }
  if (!Number.isInteger(normalizedSeed)) {
    throw new Error('Seed ต้องเป็นจำนวนเต็ม')
  }
  return {
    train_ratio: percentages[0] / 100,
    val_ratio: percentages[1] / 100,
    test_ratio: percentages[2] / 100,
    session_gap_seconds: gap,
    seed: normalizedSeed,
  }
}


export function splitPreviewRows(perWorkpiece = {}) {
  return Object.entries(perWorkpiece).sort(([left], [right]) =>
    left.localeCompare(right),
  )
}
