export type VideoViewerWindowMemento = {
  viewingPath: string
  directory: string
  showHidden: boolean
  playbackTime: number
  volume: number
}

export function sanitizeVideoViewerWindowMemento(value: unknown): VideoViewerWindowMemento | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const viewingPath = typeof row.viewingPath === 'string' ? row.viewingPath : ''
  const directory = typeof row.directory === 'string' ? row.directory : ''
  const showHidden = row.showHidden === true
  const playbackTime =
    typeof row.playbackTime === 'number' && Number.isFinite(row.playbackTime) && row.playbackTime >= 0
      ? row.playbackTime
      : 0
  let volume = typeof row.volume === 'number' && Number.isFinite(row.volume) ? row.volume : 1
  if (volume < 0) volume = 0
  if (volume > 1) volume = 1
  if (!viewingPath || !directory) return null
  return { viewingPath, directory, showHidden, playbackTime, volume }
}

export function snapshotVideoViewerWindowMemento(state: VideoViewerWindowMemento): VideoViewerWindowMemento {
  return {
    viewingPath: state.viewingPath,
    directory: state.directory,
    showHidden: state.showHidden,
    playbackTime: state.playbackTime,
    volume: state.volume,
  }
}
