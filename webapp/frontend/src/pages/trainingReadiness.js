export function isTrainImageFolder(folderPath) {
  if (typeof folderPath !== 'string') return false
  const normalized = folderPath.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  return normalized === 'auto_improve/images/train'
}

export function canStartTraining(folderPath, stats) {
  return isTrainImageFolder(folderPath) && Number(stats?.labeled || 0) > 0
}
