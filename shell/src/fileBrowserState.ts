import type { FileBrowserEntry, FileBrowserRoot } from './fileBrowserBridge'

export type FileBrowserStatus = 'loading' | 'ready' | 'error'

export type FileBrowserWindowState = {
  activePath: string | null
  parentPath: string | null
  roots: FileBrowserRoot[]
  entries: FileBrowserEntry[]
  selectedPath: string | null
  status: FileBrowserStatus
  errorMessage: string | null
  showHidden: boolean
}

const initialPathByWindowId = new Map<number, string | null>()

export function createInitialFileBrowserWindowState(showHidden: boolean): FileBrowserWindowState {
  return {
    activePath: null,
    parentPath: null,
    roots: [],
    entries: [],
    selectedPath: null,
    status: 'loading',
    errorMessage: null,
    showHidden,
  }
}

export function primeFileBrowserWindowPath(windowId: number, path: string | null | undefined): void {
  initialPathByWindowId.set(windowId, path ?? null)
}

export function consumeFileBrowserWindowPath(windowId: number): string | null {
  const value = initialPathByWindowId.get(windowId) ?? null
  initialPathByWindowId.delete(windowId)
  return value
}

export function clearPrimedFileBrowserWindowPath(windowId: number): void {
  initialPathByWindowId.delete(windowId)
}

export function fileBrowserEntryIsDirectory(entry: Pick<FileBrowserEntry, 'kind'>): boolean {
  return entry.kind === 'directory'
}

export function fileBrowserEntryIndex(entries: readonly FileBrowserEntry[], path: string | null): number {
  if (!path) return entries.length > 0 ? 0 : -1
  const index = entries.findIndex((entry) => entry.path === path)
  return index >= 0 ? index : entries.length > 0 ? 0 : -1
}

export function clampFileBrowserSelection(
  entries: readonly FileBrowserEntry[],
  selectedPath: string | null,
): string | null {
  const index = fileBrowserEntryIndex(entries, selectedPath)
  return index >= 0 ? entries[index]?.path ?? null : null
}

export function moveFileBrowserSelection(
  entries: readonly FileBrowserEntry[],
  selectedPath: string | null,
  delta: number,
): string | null {
  if (entries.length === 0) return null
  const startIndex = fileBrowserEntryIndex(entries, selectedPath)
  const nextIndex = Math.max(0, Math.min(entries.length - 1, startIndex + delta))
  return entries[nextIndex]?.path ?? null
}
