export type TextEditorWindowMemento = {
  viewingPath: string
  directory: string
  showHidden: boolean
}

export function sanitizeTextEditorWindowMemento(value: unknown): TextEditorWindowMemento | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const viewingPath = typeof row.viewingPath === 'string' ? row.viewingPath : ''
  const directory = typeof row.directory === 'string' ? row.directory : ''
  const showHidden = row.showHidden === true
  if (!viewingPath || !directory) return null
  return { viewingPath, directory, showHidden }
}

export function snapshotTextEditorWindowMemento(state: TextEditorWindowMemento): TextEditorWindowMemento {
  return {
    viewingPath: state.viewingPath,
    directory: state.directory,
    showHidden: state.showHidden,
  }
}
