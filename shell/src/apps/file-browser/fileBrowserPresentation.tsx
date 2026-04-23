import Archive from 'lucide-solid/icons/archive'
import File from 'lucide-solid/icons/file'
import FileText from 'lucide-solid/icons/file-text'
import Folder from 'lucide-solid/icons/folder'
import Image from 'lucide-solid/icons/image'
import Music from 'lucide-solid/icons/music'
import Video from 'lucide-solid/icons/video'
import { isImageFilePath } from '@/apps/image-viewer/imageViewerCore'
import { isPdfFilePath } from '@/apps/pdf-viewer/pdfViewerCore'
import { isTextEditorFilePath } from '@/apps/text-editor/textEditorCore'
import { isVideoFilePath } from '@/apps/video-viewer/videoViewerCore'
import { FILE_BROWSER_FAVORITES_PATH } from './fileBrowserFilesSettings'
import { renderFileBrowserCustomIcon } from './fileBrowserCustomIcons'
import type { FileBrowserEntry, FileBrowserRoot } from './fileBrowserBridge'
import { fileBrowserEntryIsDirectory } from './fileBrowserState'

export type Breadcrumb = {
  path: string
  label: string
}

export type BreadcrumbRow =
  | { kind: 'crumb'; crumb: Breadcrumb; index: number; current: boolean }
  | { kind: 'ellipsis'; hidden: Breadcrumb[] }

const dateFormatter = new Intl.DateTimeFormat([], {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

const FILE_BROWSER_ICON_MATCHERS: Array<{ pattern: RegExp; icon: typeof File }> = [
  { pattern: /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/, icon: Image },
  { pattern: /\.(mp4|webm|mov|mkv|avi|m4v)$/, icon: Video },
  { pattern: /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/, icon: Music },
  { pattern: /\.(zip|tar|gz|tgz|7z|rar)$/, icon: Archive },
  { pattern: /\.(txt|md|json|toml|yaml|yml|rs|ts|tsx|js|jsx|css|html|pdf)$/, icon: FileText },
]

export function pathWithinRoot(path: string | null, rootPath: string): boolean {
  if (!path) return false
  if (path === rootPath) return true
  return rootPath === '/' ? path.startsWith('/') : path.startsWith(`${rootPath}/`)
}

export function formatEntrySize(size: number | null): string {
  if (size === null) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = size
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return value >= 10 || unit === 'B' ? `${Math.round(value)} ${unit}` : `${value.toFixed(1)} ${unit}`
}

export function formatEntryModified(modifiedMs: number | null): string {
  if (modifiedMs === null) return '—'
  try {
    return dateFormatter.format(new Date(modifiedMs))
  } catch {
    return '—'
  }
}

export function normalizeFilesSettingsPath(path: string): string {
  return path.replace(/\\/g, '/')
}

export function normalizeDisplayName(entry: FileBrowserEntry): string {
  return entry.name || entry.path
}

export function fileBrowserEntryCanOpenInShell(entry: FileBrowserEntry): boolean {
  if (fileBrowserEntryIsDirectory(entry)) return true
  return fileBrowserPathCanOpenInShell(entry.path)
}

export function fileBrowserPathCanOpenInShell(path: string): boolean {
  return (
    isImageFilePath(path) ||
    isVideoFilePath(path) ||
    isTextEditorFilePath(path) ||
    isPdfFilePath(path)
  )
}

export function customIconNameForPath(path: string, customIcons: Record<string, string>): string | null {
  return customIcons[path] ?? customIcons[normalizeFilesSettingsPath(path)] ?? null
}

export function fileBrowserIconForEntry(
  entry: FileBrowserEntry,
  customIcons: Record<string, string>,
  className = 'h-4 w-4',
) {
  const customIcon = renderFileBrowserCustomIcon(customIconNameForPath(entry.path, customIcons), className)
  if (customIcon) return customIcon
  if (fileBrowserEntryIsDirectory(entry)) return <Folder class={className} stroke-width={2} />
  const name = normalizeDisplayName(entry).toLowerCase()
  const match = FILE_BROWSER_ICON_MATCHERS.find((row) => row.pattern.test(name))
  const Icon = match?.icon ?? File
  return <Icon class={className} stroke-width={2} />
}

export function rootLabelForPath(path: string, roots: readonly FileBrowserRoot[]): string | null {
  const matches = roots
    .filter((root) => pathWithinRoot(path, root.path))
    .sort((a, b) => b.path.length - a.path.length)
  return matches[0]?.label ?? null
}

export function buildBreadcrumbs(path: string | null, roots: readonly FileBrowserRoot[]): Breadcrumb[] {
  if (!path) return []
  const matchingRoot = roots
    .filter((root) => pathWithinRoot(path, root.path))
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (matchingRoot) {
    const out: Breadcrumb[] = [{ path: matchingRoot.path, label: matchingRoot.label }]
    const suffix = path.slice(matchingRoot.path.length).replace(/^\/+/, '')
    if (!suffix) return out
    let current = matchingRoot.path.replace(/\/+$/, '') || '/'
    for (const part of suffix.split('/')) {
      current = current === '/' ? `/${part}` : `${current}/${part}`
      out.push({ path: current, label: part })
    }
    return out
  }
  if (path === '/') return [{ path: '/', label: 'Computer' }]
  const out: Breadcrumb[] = [{ path: '/', label: 'Computer' }]
  let current = ''
  for (const part of path.split('/').filter(Boolean)) {
    current += `/${part}`
    out.push({ path: current, label: part })
  }
  return out
}

export function posixDirname(p: string): string {
  const norm = p.replace(/\/+$/, '') || '/'
  const i = norm.lastIndexOf('/')
  if (i <= 0) return '/'
  return norm.slice(0, i) || '/'
}

export function posixBasename(p: string): string {
  const norm = p.replace(/\/+$/, '') || '/'
  const i = norm.lastIndexOf('/')
  return norm.slice(i + 1) || norm
}

export function fileBrowserTitleForPath(path: string | null): string {
  if (!path) return 'Files'
  if (path === FILE_BROWSER_FAVORITES_PATH) return 'Favorites'
  const base = posixBasename(path)
  return base === '/' ? 'Files' : base
}
