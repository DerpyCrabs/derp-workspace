import type { FileBrowserEntry } from '@/apps/file-browser/fileBrowserBridge'

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'avif',
  'ico',
  'heic',
  'heif',
  'tif',
  'tiff',
])

export function isImageFilePath(path: string): boolean {
  const name = path.split(/[/\\]/).filter(Boolean).pop() ?? ''
  const lower = name.toLowerCase()
  if (!lower.includes('.')) return false
  const ext = lower.slice(lower.lastIndexOf('.') + 1)
  return IMAGE_EXTENSIONS.has(ext)
}

export function orderedImagePathsFromDirectoryEntries(entries: readonly FileBrowserEntry[]): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (entry.kind === 'file' && isImageFilePath(entry.path)) {
      out.push(entry.path)
    }
  }
  return out
}
