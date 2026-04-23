export const FILE_BROWSER_DRAG_MIME = 'application/x-derp-file-browser-path'

export type FileBrowserDragPayload = {
  path: string
  kind?: string
  writable?: boolean
  directory?: string
  showHidden?: boolean
}

function dataTransferTypes(dataTransfer: DataTransfer | null): string[] {
  if (!dataTransfer) return []
  return Array.from(dataTransfer.types ?? [])
}

export function dataTransferHasFileBrowserDrag(dataTransfer: DataTransfer | null): boolean {
  return dataTransferTypes(dataTransfer).includes(FILE_BROWSER_DRAG_MIME)
}

export function parseFileBrowserDragPayload(dataTransfer: DataTransfer | null): FileBrowserDragPayload | null {
  if (!dataTransfer) return null
  const raw = dataTransfer.getData(FILE_BROWSER_DRAG_MIME) || dataTransfer.getData('text/plain')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    const path = record.path
    if (typeof path !== 'string' || path.length === 0) return null
    return {
      path,
      kind: typeof record.kind === 'string' ? record.kind : undefined,
      writable: typeof record.writable === 'boolean' ? record.writable : undefined,
      directory: typeof record.directory === 'string' ? record.directory : undefined,
      showHidden: typeof record.showHidden === 'boolean' ? record.showHidden : undefined,
    }
  } catch {
    return raw.startsWith('/') ? { path: raw } : null
  }
}
