import type { FileBrowserEntry } from '@/apps/file-browser/fileBrowserBridge'

const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'webm',
  'ogg',
  'mov',
  'avi',
  'mkv',
  'm4v',
])

export function isVideoFilePath(path: string): boolean {
  const i = path.lastIndexOf('.')
  if (i < 0 || i === path.length - 1) return false
  const ext = path.slice(i + 1).toLowerCase()
  return VIDEO_EXTENSIONS.has(ext)
}

export function orderedVideoPathsFromDirectoryEntries(entries: readonly FileBrowserEntry[]): string[] {
  const paths: string[] = []
  for (const entry of entries) {
    if (entry.kind === 'file' && isVideoFilePath(entry.path)) {
      paths.push(entry.path)
    }
  }
  paths.sort((a, b) => a.localeCompare(b))
  return paths
}
