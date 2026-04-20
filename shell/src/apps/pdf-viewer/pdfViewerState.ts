export type PdfViewerWindowMemento = {
  viewingPath: string
  directory: string
  showHidden: boolean
}

export function sanitizePdfViewerWindowMemento(value: unknown): PdfViewerWindowMemento | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const viewingPath = typeof row.viewingPath === 'string' ? row.viewingPath : ''
  const directory = typeof row.directory === 'string' ? row.directory : ''
  const showHidden = row.showHidden === true
  if (!viewingPath || !directory) return null
  return { viewingPath, directory, showHidden }
}

export function snapshotPdfViewerWindowMemento(state: PdfViewerWindowMemento): PdfViewerWindowMemento {
  return {
    viewingPath: state.viewingPath,
    directory: state.directory,
    showHidden: state.showHidden,
  }
}
