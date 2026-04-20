import type { Accessor } from 'solid-js'
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import {
  listFileBrowserDirectory,
  listFileBrowserRoots,
  mkdirFileBrowserEntry,
  removeFileBrowserPath,
  renameFileBrowserPath,
  touchFileBrowserFile,
  type FileBrowserEntry,
  type FileBrowserRoot,
} from './fileBrowserBridge'
import {
  fileBrowserFsClipCopy,
  fileBrowserFsClipCut,
} from './fileBrowserFsClipboard'
import { loadFileBrowserPrefs, setFileBrowserShowHidden } from './fileBrowserPrefs'
import {
  clampFileBrowserSelection,
  consumeFileBrowserWindowPath,
  createInitialFileBrowserWindowState,
  fileBrowserEntryIsDirectory,
  moveFileBrowserSelection,
  sanitizeFileBrowserWindowMemento,
  snapshotFileBrowserWindowMemento,
} from './fileBrowserState'
import { shellHttpBase } from '@/features/bridge/shellHttp'
import {
  peekShellWindowState,
  primedShellWindowStateVersion,
  subscribeShellWindowState,
} from '@/features/shell-ui/shellWindowState'
import type { ShellContextMenuItem } from '@/host/contextMenu'
import { FileBrowserContextMenu } from './FileBrowserContextMenu'
import { isImageFilePath } from '@/apps/image-viewer/imageViewerCore'
import { isPdfFilePath } from '@/apps/pdf-viewer/pdfViewerCore'
import { isTextEditorFilePath } from '@/apps/text-editor/textEditorCore'
import { isVideoFilePath } from '@/apps/video-viewer/videoViewerCore'
import Archive from 'lucide-solid/icons/archive'
import Columns2 from 'lucide-solid/icons/columns-2'
import ArrowLeft from 'lucide-solid/icons/arrow-left'
import Clipboard from 'lucide-solid/icons/clipboard'
import Copy from 'lucide-solid/icons/copy'
import ExternalLink from 'lucide-solid/icons/external-link'
import Eye from 'lucide-solid/icons/eye'
import EyeOff from 'lucide-solid/icons/eye-off'
import File from 'lucide-solid/icons/file'
import FilePlus from 'lucide-solid/icons/file-plus'
import FileText from 'lucide-solid/icons/file-text'
import Folder from 'lucide-solid/icons/folder'
import FolderOpen from 'lucide-solid/icons/folder-open'
import FolderPlus from 'lucide-solid/icons/folder-plus'
import HardDrive from 'lucide-solid/icons/hard-drive'
import Home from 'lucide-solid/icons/home'
import Image from 'lucide-solid/icons/image'
import MoreHorizontal from 'lucide-solid/icons/more-horizontal'
import Music from 'lucide-solid/icons/music'
import Pencil from 'lucide-solid/icons/pencil'
import RefreshCw from 'lucide-solid/icons/refresh-cw'
import Scissors from 'lucide-solid/icons/scissors'
import Trash2 from 'lucide-solid/icons/trash-2'
import Video from 'lucide-solid/icons/video'
import Workflow from 'lucide-solid/icons/workflow'

type FileBrowserWindowProps = {
  windowId: number
  compositorAppState: Accessor<unknown | null>
  shellWireSend: (op: 'shell_hosted_window_state' | 'shell_hosted_window_title', json: string) => boolean
  onOpenFile: (
    path: string,
    context: { directory: string; showHidden: boolean },
  ) => void
  onOpenInNewWindow?: (path: string) => void
  onOpenInTab?: (
    path: string,
    context: { directory: string; showHidden: boolean; isDirectory: boolean },
  ) => void
  onOpenInSplitView?: (
    path: string,
    context: { directory: string; showHidden: boolean; isDirectory: boolean },
  ) => void
  onOpenPathExternally: (path: string) => void
}

type Breadcrumb = {
  path: string
  label: string
}

type BreadcrumbRow =
  | { kind: 'crumb'; crumb: Breadcrumb; index: number; current: boolean }
  | { kind: 'ellipsis'; hidden: Breadcrumb[] }

const dateFormatter = new Intl.DateTimeFormat([], {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

function pathWithinRoot(path: string | null, rootPath: string): boolean {
  if (!path) return false
  if (path === rootPath) return true
  return rootPath === '/' ? path.startsWith('/') : path.startsWith(`${rootPath}/`)
}

function formatEntrySize(size: number | null): string {
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

function formatEntryModified(modifiedMs: number | null): string {
  if (modifiedMs === null) return '—'
  try {
    return dateFormatter.format(new Date(modifiedMs))
  } catch {
    return '—'
  }
}

function normalizeDisplayName(entry: FileBrowserEntry): string {
  return entry.name || entry.path
}

function fileBrowserEntryCanOpenInShell(entry: FileBrowserEntry): boolean {
  if (fileBrowserEntryIsDirectory(entry)) return true
  return (
    isImageFilePath(entry.path) ||
    isVideoFilePath(entry.path) ||
    isTextEditorFilePath(entry.path) ||
    isPdfFilePath(entry.path)
  )
}

function fileBrowserIconForEntry(entry: FileBrowserEntry) {
  if (fileBrowserEntryIsDirectory(entry)) return <Folder class="h-4 w-4" stroke-width={2} />
  const name = normalizeDisplayName(entry).toLowerCase()
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/.test(name)) return <Image class="h-4 w-4" stroke-width={2} />
  if (/\.(mp4|webm|mov|mkv|avi|m4v)$/.test(name)) return <Video class="h-4 w-4" stroke-width={2} />
  if (/\.(mp3|wav|ogg|m4a|flac|aac|opus)$/.test(name)) return <Music class="h-4 w-4" stroke-width={2} />
  if (/\.(zip|tar|gz|tgz|7z|rar)$/.test(name)) return <Archive class="h-4 w-4" stroke-width={2} />
  if (/\.(txt|md|json|toml|yaml|yml|rs|ts|tsx|js|jsx|css|html|pdf)$/.test(name)) return <FileText class="h-4 w-4" stroke-width={2} />
  return <File class="h-4 w-4" stroke-width={2} />
}

function menuSeparator(): ShellContextMenuItem {
  return { separator: true, label: '', action: () => undefined }
}

function tinyIcon(icon: typeof Folder) {
  const Icon = icon
  return <Icon class="h-4 w-4" stroke-width={2} />
}

function rootLabelForPath(path: string, roots: readonly FileBrowserRoot[]): string | null {
  const matches = roots
    .filter((root) => pathWithinRoot(path, root.path))
    .sort((a, b) => b.path.length - a.path.length)
  return matches[0]?.label ?? null
}

function buildBreadcrumbs(path: string | null, roots: readonly FileBrowserRoot[]): Breadcrumb[] {
  if (!path) return []
  const rootLabel = rootLabelForPath(path, roots)
  const matchingRoot = roots
    .filter((root) => pathWithinRoot(path, root.path))
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (matchingRoot) {
    const out: Breadcrumb[] = [{ path: matchingRoot.path, label: rootLabel ?? matchingRoot.label }]
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

function clipboardCanWritePath(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
}

function posixDirname(p: string): string {
  const norm = p.replace(/\/+$/, '') || '/'
  const i = norm.lastIndexOf('/')
  if (i <= 0) return '/'
  return norm.slice(0, i) || '/'
}

function posixBasename(p: string): string {
  const norm = p.replace(/\/+$/, '') || '/'
  const i = norm.lastIndexOf('/')
  return norm.slice(i + 1) || norm
}

function fileBrowserTitleForPath(path: string | null): string {
  if (!path) return 'Files'
  const base = posixBasename(path)
  return base === '/' ? 'Files' : base
}

type FileBrowserUiDialog =
  | { kind: 'closed' }
  | { kind: 'mkdir'; draft: string }
  | { kind: 'touch'; draft: string }
  | { kind: 'rename'; path: string; draft: string }
  | { kind: 'delete'; path: string; label: string }

type FileBrowserDragPayload = {
  path: string
}

type FileBrowserPointerDrag = {
  path: string
  pointerId: number
  startX: number
  startY: number
  dragging: boolean
  dropDir: string | null
}

const FILE_BROWSER_DRAG_MIME = 'application/x-derp-file-browser-path'
const FILE_BROWSER_MUTATED_EVENT = 'derp-file-browser-mutated'

let nextFileBrowserMountSeq = 0

export function FileBrowserWindow(props: FileBrowserWindowProps) {
  const mountSeq = ++nextFileBrowserMountSeq
  const initialPrefs = loadFileBrowserPrefs()
  const [state, setState] = createStore(
    createInitialFileBrowserWindowState(
      sanitizeFileBrowserWindowMemento(peekShellWindowState(props.windowId))?.showHidden ?? initialPrefs.showHidden,
    ),
  )
  const [busy, setBusy] = createSignal(false)
  const [loadCount, setLoadCount] = createSignal(0)
  let requestSeq = 0
  let lastAppliedRestoredStateVersion = 0
  let applyingFromCompositor = false
  let lastCompositorMementoJson = ''
  let rootRef: HTMLDivElement | undefined
  let pointerDrag: FileBrowserPointerDrag | null = null
  let suppressClickAfterPointerDrag = false

  const [ctxMenu, setCtxMenu] = createSignal<{ x: number; y: number; items: ShellContextMenuItem[] } | null>(null)
  const [dialog, setDialog] = createSignal<FileBrowserUiDialog>({ kind: 'closed' })
  const [opError, setOpError] = createSignal<string | null>(null)
  const [dropTargetPath, setDropTargetPath] = createSignal<string | null>(null)

  const breadcrumbs = createMemo(() => buildBreadcrumbs(state.activePath, state.roots))
  const breadcrumbRows = createMemo((): BreadcrumbRow[] => {
    const list = breadcrumbs()
    if (list.length <= 3) {
      return list.map((crumb, index) => ({
        kind: 'crumb',
        crumb,
        index,
        current: index === list.length - 1,
      }))
    }
    return [
      { kind: 'crumb', crumb: list[0], index: 0, current: false },
      { kind: 'ellipsis', hidden: list.slice(1, -2) },
      { kind: 'crumb', crumb: list[list.length - 2], index: list.length - 2, current: false },
      { kind: 'crumb', crumb: list[list.length - 1], index: list.length - 1, current: true },
    ]
  })
  const selectedEntry = createMemo(
    () => state.entries.find((entry) => entry.path === state.selectedPath) ?? null,
  )
  async function loadDirectory(targetPath?: string | null, forceRoots = false, showHiddenOverride?: boolean) {
    const base = shellHttpBase()
    const runId = ++requestSeq
    setLoadCount((count) => count + 1)
    const showHidden = showHiddenOverride ?? state.showHidden
    setBusy(true)
    setState('status', 'loading')
    setState('errorMessage', null)
    try {
      const roots = forceRoots || state.roots.length === 0 ? await listFileBrowserRoots(base) : { roots: state.roots }
      if (runId !== requestSeq) return
      setState('roots', roots.roots)
      const path = targetPath ?? state.activePath ?? roots.roots[0]?.path ?? null
      if (!path) {
        throw new Error('No file browser roots are available.')
      }
      const listing = await listFileBrowserDirectory(path, showHidden, base)
      if (runId !== requestSeq) return
      setState('activePath', listing.path)
      setState('parentPath', listing.parent_path)
      setState('entries', listing.entries)
      setState('selectedPath', clampFileBrowserSelection(listing.entries, state.selectedPath))
      setState('status', 'ready')
      setOpError(null)
    } catch (error) {
      if (runId !== requestSeq) return
      setState('entries', [])
      setState('selectedPath', null)
      setState('status', 'error')
      setState('errorMessage', error instanceof Error ? error.message : String(error))
    } finally {
      if (runId === requestSeq) setBusy(false)
    }
  }

  function selectEntry(path: string) {
    setState('selectedPath', path)
  }

  function clickEntry(entry: FileBrowserEntry) {
    const alreadySelected = state.selectedPath === entry.path
    selectEntry(entry.path)
    if (alreadySelected) {
      openEntry(entry)
    }
  }

  function openEntry(entry: FileBrowserEntry | null | undefined) {
    if (!entry) return
    if (fileBrowserEntryIsDirectory(entry)) {
      void loadDirectory(entry.path)
      return
    }
    const directory = state.activePath ?? ''
    props.onOpenFile(entry.path, { directory, showHidden: state.showHidden })
  }

  function parseDragPayload(event: DragEvent): FileBrowserDragPayload | null {
    const dt = event.dataTransfer
    if (!dt) return null
    const raw = dt.getData(FILE_BROWSER_DRAG_MIME) || dt.getData('text/plain')
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object') return null
      const path = (parsed as { path?: unknown }).path
      return typeof path === 'string' && path.length > 0 ? { path } : null
    } catch {
      return raw.startsWith('/') ? { path: raw } : null
    }
  }

  function setDragPayload(event: DragEvent, entry: FileBrowserEntry) {
    const dt = event.dataTransfer
    if (!dt) return
    const payload = JSON.stringify({ path: entry.path } satisfies FileBrowserDragPayload)
    dt.effectAllowed = entry.writable === true ? 'move' : 'copyMove'
    dt.setData(FILE_BROWSER_DRAG_MIME, payload)
    dt.setData('text/plain', entry.path)
  }

  function canDropPathInto(sourcePath: string, targetDir: string): boolean {
    if (!sourcePath || !targetDir) return false
    const source = sourcePath.replace(/\/+$/, '') || '/'
    const target = targetDir.replace(/\/+$/, '') || '/'
    if (source === target) return false
    const sourceParent = posixDirname(source).replace(/\/+$/, '') || '/'
    if (sourceParent === target) return false
    return !(target.startsWith(`${source}/`))
  }

  function notifyFileBrowserMutated() {
    window.dispatchEvent(new CustomEvent(FILE_BROWSER_MUTATED_EVENT))
  }

  async function moveDraggedPathInto(sourcePath: string, targetDir: string) {
    if (!canDropPathInto(sourcePath, targetDir)) return
    const base = shellHttpBase()
    const destPath = targetDir === '/' ? `/${posixBasename(sourcePath)}` : `${targetDir.replace(/\/+$/, '')}/${posixBasename(sourcePath)}`
    setOpError(null)
    try {
      await renameFileBrowserPath(sourcePath, destPath, base)
      setDropTargetPath(null)
      notifyFileBrowserMutated()
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e))
    }
  }

  function dragOverDirectory(event: DragEvent, targetDir: string) {
    const payload = parseDragPayload(event)
    if (!payload || !canDropPathInto(payload.path, targetDir)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    setDropTargetPath(targetDir)
  }

  function dropOnDirectory(event: DragEvent, targetDir: string) {
    const payload = parseDragPayload(event)
    if (!payload) return
    event.preventDefault()
    event.stopPropagation()
    void moveDraggedPathInto(payload.path, targetDir)
  }

  function pointerDropDirAt(clientX: number, clientY: number): string | null {
    const el = document.elementFromPoint(clientX, clientY)
    if (!(el instanceof HTMLElement)) return null
    const row = el.closest('[data-file-browser-row]')
    if (row instanceof HTMLElement && row.getAttribute('data-file-browser-kind') === 'directory') {
      const path = row.getAttribute('data-file-browser-path')
      return path && path.length > 0 ? path : null
    }
    const root = el.closest('[data-file-browser-list-state]')
    if (root instanceof HTMLElement) {
      const active = root.querySelector('[data-file-browser-active-path]')
      if (active instanceof HTMLElement) {
        const path = active.getAttribute('data-file-browser-active-path')
        return path && path.length > 0 ? path : null
      }
    }
    return null
  }

  function clearPointerDragListeners() {
    window.removeEventListener('pointermove', onWindowPointerDragMove, true)
    window.removeEventListener('pointerup', onWindowPointerDragEnd, true)
    window.removeEventListener('pointercancel', onWindowPointerDragEnd, true)
  }

  function onWindowPointerDragMove(event: PointerEvent) {
    const drag = pointerDrag
    if (!drag || drag.pointerId !== event.pointerId) return
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)
    if (!drag.dragging && distance < 8) return
    event.preventDefault()
    drag.dragging = true
    const dir = pointerDropDirAt(event.clientX, event.clientY)
    drag.dropDir = dir && canDropPathInto(drag.path, dir) ? dir : null
    setDropTargetPath(drag.dropDir)
  }

  function onWindowPointerDragEnd(event: PointerEvent) {
    const drag = pointerDrag
    if (!drag || drag.pointerId !== event.pointerId) return
    clearPointerDragListeners()
    pointerDrag = null
    setDropTargetPath(null)
    if (!drag.dragging) return
    event.preventDefault()
    suppressClickAfterPointerDrag = true
    window.setTimeout(() => {
      suppressClickAfterPointerDrag = false
    }, 0)
    const dir = drag.dropDir ?? pointerDropDirAt(event.clientX, event.clientY)
    if (dir && canDropPathInto(drag.path, dir)) {
      void moveDraggedPathInto(drag.path, dir)
    }
  }

  function beginPointerDrag(event: PointerEvent, entry: FileBrowserEntry) {
    if (event.button !== 0 || entry.writable !== true) return
    pointerDrag = {
      path: entry.path,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      dropDir: null,
    }
    window.addEventListener('pointermove', onWindowPointerDragMove, true)
    window.addEventListener('pointerup', onWindowPointerDragEnd, true)
    window.addEventListener('pointercancel', onWindowPointerDragEnd, true)
  }

  function closeCtxMenu() {
    setCtxMenu(null)
  }

  function entryContextItems(entry: FileBrowserEntry): ShellContextMenuItem[] {
    const clip = clipboardCanWritePath()
    const writable = entry.writable === true
    const isDir = fileBrowserEntryIsDirectory(entry)
    const isFile = !isDir && entry.kind === 'file'
    const canOpenInWorkspace = fileBrowserEntryCanOpenInShell(entry)
    const openContext = () => ({
      directory: state.activePath ?? '',
      showHidden: state.showHidden,
      isDirectory: isDir,
    })
    const items: ShellContextMenuItem[] = [
      {
        actionId: 'open',
        label: 'Open',
        icon: tinyIcon(isDir ? FolderOpen : File),
        action: () => {
          openEntry(entry)
        },
      },
    ]
    if (isDir && props.onOpenInNewWindow) {
      const openNew = props.onOpenInNewWindow
      items.push({
        actionId: 'open-new',
        label: 'Open in new window',
        icon: tinyIcon(FolderPlus),
        action: () => {
          openNew(entry.path)
        },
      })
    }
    if (canOpenInWorkspace && props.onOpenInTab) {
      const openTab = props.onOpenInTab
      items.push({
        actionId: 'open-tab',
        label: 'Open in tab',
        icon: tinyIcon(Workflow),
        action: () => {
          openTab(entry.path, openContext())
        },
      })
    }
    if (canOpenInWorkspace && props.onOpenInSplitView) {
      const openSplit = props.onOpenInSplitView
      items.push({
        actionId: 'open-split-view',
        label: 'Open in split view',
        icon: tinyIcon(Columns2),
        action: () => {
          openSplit(entry.path, openContext())
        },
      })
    }
    if (isFile) {
      items.push({
        actionId: 'open-external',
        label: 'Open with default application',
        icon: tinyIcon(ExternalLink),
        action: () => {
          props.onOpenPathExternally(entry.path)
        },
      })
    }
    if (writable) {
      items.push(menuSeparator())
      if (isFile) {
        items.push({
          actionId: 'fs-cut',
          label: 'Cut',
          icon: tinyIcon(Scissors),
          action: () => {
            fileBrowserFsClipCut(entry.path)
          },
        })
        items.push({
          actionId: 'fs-copy',
          label: 'Copy',
          icon: tinyIcon(Copy),
          action: () => {
            fileBrowserFsClipCopy(entry.path)
          },
        })
      } else if (isDir) {
        items.push({
          actionId: 'fs-cut-dir',
          label: 'Cut',
          icon: tinyIcon(Scissors),
          action: () => {
            fileBrowserFsClipCut(entry.path)
          },
        })
      }
      items.push({
        actionId: 'rename',
        label: 'Rename…',
        icon: tinyIcon(Pencil),
        action: () => {
          setDialog({ kind: 'rename', path: entry.path, draft: posixBasename(entry.path) })
        },
      })
      items.push({
        actionId: 'delete',
        label: 'Delete…',
        icon: tinyIcon(Trash2),
        action: () => {
          setDialog({
            kind: 'delete',
            path: entry.path,
            label: normalizeDisplayName(entry),
          })
        },
      })
    }
    items.push(menuSeparator())
    items.push({
      actionId: 'copy-path',
      label: 'Copy path',
      icon: tinyIcon(Clipboard),
      disabled: !clip,
      title: clip ? undefined : 'Clipboard unavailable',
      action: () => {
        if (clip) void navigator.clipboard.writeText(entry.path)
      },
    })
    return items
  }

  function placeContextItems(root: FileBrowserRoot): ShellContextMenuItem[] {
    const clip = clipboardCanWritePath()
    const items: ShellContextMenuItem[] = [
      {
        actionId: 'open',
        label: 'Open',
        icon: tinyIcon(FolderOpen),
        action: () => {
          setState('selectedPath', null)
          void loadDirectory(root.path)
        },
      },
    ]
    if (props.onOpenInNewWindow) {
      const openNew = props.onOpenInNewWindow
      items.push({
        actionId: 'open-new',
        label: 'Open in new window',
        icon: tinyIcon(FolderPlus),
        action: () => {
          openNew(root.path)
        },
      })
    }
    items.push(menuSeparator())
    items.push({
      actionId: 'copy-path',
      label: 'Copy path',
      icon: tinyIcon(Clipboard),
      disabled: !clip,
      title: clip ? undefined : 'Clipboard unavailable',
      action: () => {
        if (clip) void navigator.clipboard.writeText(root.path)
      },
    })
    return items
  }

  function moveSelection(delta: number) {
    setState('selectedPath', moveFileBrowserSelection(state.entries, state.selectedPath, delta))
  }

  function toggleHidden() {
    const nextShowHidden = !state.showHidden
    setFileBrowserShowHidden(nextShowHidden)
    setState('showHidden', nextShowHidden)
    void loadDirectory(state.activePath, false, nextShowHidden)
  }

  function closeFileDialog() {
    setDialog({ kind: 'closed' })
  }

  async function submitFileDialog() {
    const d = dialog()
    const base = shellHttpBase()
    if (d.kind === 'closed') return
    setOpError(null)
    try {
      const ap = state.activePath
      if (!ap) throw new Error('No folder selected.')
      if (d.kind === 'mkdir') {
        await mkdirFileBrowserEntry(ap, d.draft.trim(), base)
      } else if (d.kind === 'touch') {
        await touchFileBrowserFile(ap, d.draft.trim(), base)
      } else if (d.kind === 'rename') {
        const name = d.draft.trim()
        if (!name || name.includes('/') || name.includes('\\')) throw new Error('Invalid name.')
        const parent = posixDirname(d.path)
        const to = parent === '/' ? `/${name}` : `${parent}/${name}`
        if (to === d.path) {
          closeFileDialog()
          return
        }
        await renameFileBrowserPath(d.path, to, base)
      } else if (d.kind === 'delete') {
        await removeFileBrowserPath(d.path, base)
      }
      closeFileDialog()
      await loadDirectory(state.activePath, true)
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e))
    }
  }

  function pushFileBrowserStateToCompositor() {
    if (applyingFromCompositor) return
    props.shellWireSend(
      'shell_hosted_window_state',
      JSON.stringify({
        window_id: props.windowId,
        kind: 'file_browser',
        state: snapshotFileBrowserWindowMemento(state),
      }),
    )
  }

  function pushFileBrowserTitleToCompositor(title: string) {
    props.shellWireSend(
      'shell_hosted_window_title',
      JSON.stringify({
        window_id: props.windowId,
        title,
      }),
    )
  }

  function applyRestoredState(value: unknown) {
    const nextState = sanitizeFileBrowserWindowMemento(value)
    if (!nextState) return
    const prevActivePath = state.activePath
    const prevShowHidden = state.showHidden
    setFileBrowserShowHidden(nextState.showHidden)
    setState('showHidden', nextState.showHidden)
    setState('selectedPath', nextState.selectedPath)
    const nextPath = nextState.activePath ?? null
    const prevPath = prevActivePath ?? null
    if (nextPath !== prevPath || nextState.showHidden !== prevShowHidden) {
      void loadDirectory(nextPath ?? prevPath, true, nextState.showHidden)
    }
  }

  function applyPrimedRestoredState() {
    const version = primedShellWindowStateVersion(props.windowId)
    if (!version || version === lastAppliedRestoredStateVersion) return
    lastAppliedRestoredStateVersion = version
    applyRestoredState(peekShellWindowState(props.windowId))
  }

  onMount(() => {
    const wid = props.windowId
    const restored = sanitizeFileBrowserWindowMemento(peekShellWindowState(wid))
    const primed = consumeFileBrowserWindowPath(wid)
    const showHidden = restored?.showHidden ?? loadFileBrowserPrefs().showHidden
    setState('showHidden', showHidden)
    setFileBrowserShowHidden(showHidden)
    lastAppliedRestoredStateVersion = primedShellWindowStateVersion(wid)
    const target = restored?.activePath ?? primed ?? null
    void loadDirectory(target, true, showHidden)
    queueMicrotask(() => rootRef?.focus())
  })

  const unsubscribeShellWindowState = subscribeShellWindowState(() => {
    applyPrimedRestoredState()
  })
  onCleanup(unsubscribeShellWindowState)

  const onFileBrowserMutated = () => {
    if (state.status !== 'ready') return
    void loadDirectory(state.activePath, true)
  }
  window.addEventListener(FILE_BROWSER_MUTATED_EVENT, onFileBrowserMutated)
  onCleanup(() => {
    window.removeEventListener(FILE_BROWSER_MUTATED_EVENT, onFileBrowserMutated)
    clearPointerDragListeners()
  })

  createEffect(() => {
    const raw = props.compositorAppState()
    void state.activePath
    void state.selectedPath
    void state.showHidden
    void state.status
    if (
      (state.status !== 'ready' && state.status !== 'loading') ||
      raw == null ||
      typeof raw !== 'object'
    )
      return
    const next = sanitizeFileBrowserWindowMemento(raw)
    if (!next) return
    const j = JSON.stringify(next)
    const curSnapshot = snapshotFileBrowserWindowMemento(state)
    const samePath = (next.activePath ?? null) === (curSnapshot.activePath ?? null)
    if (
      (state.status === 'loading' || state.status === 'ready') &&
      samePath &&
      next.selectedPath !== curSnapshot.selectedPath
    ) {
      return
    }
    if (state.status === 'ready') {
      const na = next.activePath
      const ca = curSnapshot.activePath
      if (
        typeof na === 'string' &&
        typeof ca === 'string' &&
        na.length > 0 &&
        ca.length > 0 &&
        ca !== na &&
        pathWithinRoot(ca, na)
      ) {
        lastCompositorMementoJson = j
        return
      }
    }
    const local = JSON.stringify(curSnapshot)
    if (j === local) {
      lastCompositorMementoJson = j
      return
    }
    if (j === lastCompositorMementoJson) return
    lastCompositorMementoJson = j
    applyingFromCompositor = true
    applyRestoredState(next)
    queueMicrotask(() => {
      applyingFromCompositor = false
    })
  })

  createEffect(() => {
    void state.activePath
    void state.selectedPath
    void state.showHidden
    void state.status
    if (state.status !== 'ready' || applyingFromCompositor) return
    pushFileBrowserStateToCompositor()
  })

  createEffect(() => {
    void state.activePath
    void state.status
    if (state.status !== 'ready') return
    pushFileBrowserTitleToCompositor(fileBrowserTitleForPath(state.activePath))
  })

  createEffect(() => {
    void state.activePath
    closeCtxMenu()
  })

  createEffect(() => {
    void state.activePath
    void state.status
    if (state.status !== 'ready' || !rootRef) return
    queueMicrotask(() => {
      const root = rootRef
      if (!root) return
      const sc = root.querySelector('[data-file-browser-entry-scroll]')
      if (sc instanceof HTMLElement) sc.scrollTop = 0
    })
  })

  return (
    <div
      ref={(el) => {
        rootRef = el
      }}
      data-file-browser-list-state={state.status}
      data-file-browser-mount-seq={mountSeq}
      data-file-browser-load-count={loadCount()}
      class="flex h-full min-h-0 min-w-0 bg-(--shell-surface-inset) text-(--shell-text)"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return
        if (dialog().kind !== 'closed') {
          const t = event.target
          if (t instanceof HTMLElement && t.closest('[data-file-browser-dialog="1"]')) {
            return
          }
        }
        if (ctxMenu()) {
          if (
            event.key === 'ArrowDown' ||
            event.key === 'ArrowUp' ||
            event.key === 'Home' ||
            event.key === 'End' ||
            event.key === 'Enter' ||
            event.key === 'Backspace' ||
            event.key === 'ArrowLeft' ||
            event.key === 'ArrowRight'
          ) {
            closeCtxMenu()
          }
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          moveSelection(1)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          moveSelection(-1)
          return
        }
        if (event.key === 'Home') {
          event.preventDefault()
          setState('selectedPath', state.entries[0]?.path ?? null)
          return
        }
        if (event.key === 'End') {
          event.preventDefault()
          setState('selectedPath', state.entries[state.entries.length - 1]?.path ?? null)
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          openEntry(selectedEntry())
          return
        }
        if (event.key === 'Backspace') {
          if (!state.parentPath) return
          event.preventDefault()
          void loadDirectory(state.parentPath)
          return
        }
        if (event.key === 'ArrowRight') {
          const entry = selectedEntry()
          if (!entry || !fileBrowserEntryIsDirectory(entry)) return
          event.preventDefault()
          openEntry(entry)
          return
        }
        if (event.key === 'ArrowLeft') {
          if (!state.parentPath) return
          event.preventDefault()
          void loadDirectory(state.parentPath)
        }
      }}
      onDragOver={(event) => {
        if (!state.activePath) return
        dragOverDirectory(event, state.activePath)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDropTargetPath(null)
      }}
      onDrop={(event) => {
        if (!state.activePath) return
        dropOnDirectory(event, state.activePath)
      }}
    >
      <aside class="flex w-56 shrink-0 flex-col border-r border-(--shell-border) bg-(--shell-surface-panel)">
        <div class="min-h-0 flex-1 overflow-y-auto p-2">
          <div class="flex flex-col gap-1">
            {state.roots.map((root) => (
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-(--shell-control-muted-hover)"
                classList={{
                  'bg-(--shell-accent-soft) text-(--shell-accent-soft-text)':
                    pathWithinRoot(state.activePath, root.path),
                }}
                onClick={() => {
                  setState('selectedPath', null)
                  void loadDirectory(root.path)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setState('selectedPath', null)
                  setCtxMenu({ x: e.clientX, y: e.clientY, items: placeContextItems(root) })
                }}
              >
                <span class="shrink-0 text-(--shell-text-dim)">
                  <HardDrive class="h-4 w-4" stroke-width={2} />
                </span>
                <span class="min-w-0 flex-1 truncate">{root.label}</span>
                <span class="shrink-0 rounded border border-(--shell-border) px-1.5 py-0.5 text-[10px] uppercase text-(--shell-text-dim)">{root.kind}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>
      <section class="flex min-h-0 min-w-0 flex-1 flex-col">
        <div class="flex h-13 shrink-0 items-center gap-2 overflow-hidden border-b border-(--shell-border) bg-(--shell-surface-panel) px-3 py-2">
          <div class="min-w-0 flex-1 basis-0" data-file-browser-active-path={state.activePath ?? ''}>
            <div class="flex h-8 min-h-8 min-w-0 flex-nowrap items-center gap-1 overflow-hidden rounded-md border border-(--shell-border) bg-(--shell-surface-inset) px-1" data-file-browser-breadcrumb-bar>
              {breadcrumbRows().map((row, rowIndex) => (
                <Show
                  when={row.kind === 'crumb' ? row : false}
                  fallback={
                    <button
                      type="button"
                      class="inline-flex h-6 min-h-6 shrink-0 items-center justify-center rounded-md px-2 text-(--shell-text-dim) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text)"
                      aria-label="Show hidden path segments"
                      data-file-browser-breadcrumb-ellipsis
                      data-testid="breadcrumb-ellipsis"
                      onClick={(e) => {
                        const r = row as BreadcrumbRow
                        if (r.kind !== 'ellipsis') return
                        setCtxMenu({
                          x: e.currentTarget.getBoundingClientRect().left,
                          y: e.currentTarget.getBoundingClientRect().bottom + 2,
                          items: r.hidden.map((crumb) => ({
                            actionId: 'breadcrumb-open',
                            label: crumb.label,
                            icon: tinyIcon(Folder),
                            action: () => void loadDirectory(crumb.path),
                          })),
                        })
                      }}
                    >
                      <MoreHorizontal class="h-4 w-4" stroke-width={2} />
                    </button>
                  }
                >
                  {(crumbRow) => (
                    <>
                      {rowIndex > 0 ? <ArrowLeft class="h-3.5 w-3.5 rotate-180 shrink-0 text-(--shell-text-dim)" stroke-width={2} /> : null}
                      <button
                        type="button"
                        class="inline-flex h-6 min-h-6 min-w-0 max-w-48 shrink items-center gap-1.5 truncate rounded-md px-2 text-sm font-medium hover:bg-(--shell-control-muted-hover)"
                        classList={{
                          'bg-(--shell-accent) text-(--shell-accent-text) hover:bg-(--shell-accent)': crumbRow().current,
                        }}
                        data-file-browser-breadcrumb
                        data-file-browser-path={crumbRow().crumb.path}
                        data-file-browser-label={crumbRow().crumb.label}
                        onClick={() => void loadDirectory(crumbRow().crumb.path)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setCtxMenu({
                            x: e.clientX,
                            y: e.clientY,
                            items: [
                              {
                                actionId: 'open',
                                label: 'Open',
                                icon: tinyIcon(FolderOpen),
                                action: () => void loadDirectory(crumbRow().crumb.path),
                              },
                              ...(props.onOpenInNewWindow
                                ? [
                                    {
                                      actionId: 'open-new',
                                      label: 'Open in new window',
                                      icon: tinyIcon(FolderPlus),
                                      action: () => props.onOpenInNewWindow?.(crumbRow().crumb.path),
                                    } satisfies ShellContextMenuItem,
                                  ]
                                : []),
                              menuSeparator(),
                              {
                                actionId: 'copy-path',
                                label: 'Copy path',
                                icon: tinyIcon(Clipboard),
                                disabled: !clipboardCanWritePath(),
                                title: clipboardCanWritePath() ? undefined : 'Clipboard unavailable',
                                action: () => {
                                  if (clipboardCanWritePath()) void navigator.clipboard.writeText(crumbRow().crumb.path)
                                },
                              },
                            ],
                          })
                        }}
                      >
                        {crumbRow().index === 0 ? <Home class="h-4 w-4 shrink-0" stroke-width={2} /> : null}
                        <span class="min-w-0 truncate">{crumbRow().crumb.label}</span>
                      </button>
                    </>
                  )}
                </Show>
              ))}
            </div>
          </div>
          <button
            type="button"
            class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-(--shell-border) text-(--shell-text-dim) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text) disabled:cursor-not-allowed disabled:opacity-50"
            data-file-browser-primary-action="new-folder"
            aria-label="New folder"
            title="New folder"
            disabled={!state.activePath}
            onClick={() => setDialog({ kind: 'mkdir', draft: '' })}
          >
            <FolderPlus class="h-4 w-4" stroke-width={2} />
          </button>
          <button
            type="button"
            class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-(--shell-border) text-(--shell-text-dim) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text) disabled:cursor-not-allowed disabled:opacity-50"
            data-file-browser-primary-action="new-file"
            aria-label="New file"
            title="New file"
            disabled={!state.activePath}
            onClick={() => setDialog({ kind: 'touch', draft: '' })}
          >
            <FilePlus class="h-4 w-4" stroke-width={2} />
          </button>
          <button
            type="button"
            class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-(--shell-border) text-(--shell-text-dim) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text)"
            data-file-browser-primary-action="refresh"
            aria-label="Refresh file browser"
            title="Refresh"
            onClick={() => void loadDirectory(state.activePath, true)}
          >
            <RefreshCw class="h-4 w-4" stroke-width={2} />
          </button>
          <button
            type="button"
            class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-(--shell-border) text-(--shell-text-dim) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text)"
            data-file-browser-primary-action={state.showHidden ? 'hide-hidden' : 'show-hidden'}
            aria-label={state.showHidden ? 'Hide hidden files' : 'Show hidden files'}
            title={state.showHidden ? 'Hide hidden files' : 'Show hidden files'}
            onClick={toggleHidden}
          >
            {state.showHidden ? <EyeOff class="h-4 w-4" stroke-width={2} /> : <Eye class="h-4 w-4" stroke-width={2} />}
          </button>
        </div>
        <Show when={opError()}>
          <div class="border-b border-(--shell-border) px-3 py-2 text-xs text-red-300">{opError()}</div>
        </Show>
        <div class="grid grid-cols-[minmax(0,1fr)_110px_160px_96px] gap-3 border-b border-(--shell-border) bg-(--shell-surface-panel) px-3 py-2 text-[11px] font-semibold tracking-[0.08em] text-(--shell-text-dim) uppercase">
          <div>Name</div>
          <div>Kind</div>
          <div>Modified</div>
          <div>Size</div>
        </div>
        <div class="min-h-0 flex-1 overflow-auto" data-file-browser-entry-scroll>
          {state.status === 'loading' ? (
            <div class="flex h-full items-center justify-center px-6 py-10 text-sm text-(--shell-text-dim)">
              Loading files…
            </div>
          ) : state.status === 'error' ? (
            <div class="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
              <div class="text-sm font-medium text-(--shell-text)">Failed to load this folder.</div>
              <div class="max-w-lg text-sm text-(--shell-text-dim)">{state.errorMessage ?? 'Unknown error'}</div>
              <button
                type="button"
                class="rounded border border-(--shell-border) px-3 py-1.5 text-sm hover:bg-(--shell-control-muted-hover)"
                onClick={() => void loadDirectory(state.activePath ?? state.roots[0]?.path, true)}
              >
                Retry
              </button>
            </div>
          ) : state.entries.length === 0 ? (
            <div class="flex h-full items-center justify-center px-6 py-10 text-sm text-(--shell-text-dim)">
              This folder is empty.
            </div>
          ) : (
            <div class="divide-y divide-(--shell-border)">
              {state.entries.map((entry) => {
                const selected = () => state.selectedPath === entry.path
                return (
                  <div
                    class="group grid cursor-default grid-cols-[minmax(0,1fr)_110px_160px_96px] gap-3 px-3 py-2 text-sm hover:bg-(--shell-control-muted-hover)"
                    classList={{
                      'bg-(--shell-accent-soft) text-(--shell-accent-soft-text)': selected(),
                      'outline outline-2 outline-(--shell-accent)': dropTargetPath() === entry.path,
                    }}
                    draggable={entry.writable === true}
                    role="row"
                    aria-selected={selected() ? 'true' : undefined}
                    data-file-browser-row
                    data-file-browser-path={entry.path}
                    data-file-browser-name={normalizeDisplayName(entry)}
                    data-file-browser-kind={entry.kind}
                    data-file-browser-selected={selected() ? 'true' : 'false'}
                    data-file-browser-draggable={entry.writable === true ? 'true' : 'false'}
                    onClick={() => {
                      if (suppressClickAfterPointerDrag) return
                      clickEntry(entry)
                    }}
                    onPointerDown={(e) => beginPointerDrag(e, entry)}
                    onDragStart={(e) => {
                      selectEntry(entry.path)
                      setDragPayload(e, entry)
                    }}
                    onDragEnd={() => setDropTargetPath(null)}
                    onDragOver={(e) => {
                      if (!fileBrowserEntryIsDirectory(entry)) return
                      dragOverDirectory(e, entry.path)
                    }}
                    onDragLeave={(e) => {
                      if (!fileBrowserEntryIsDirectory(entry)) return
                      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                      setDropTargetPath((current) => (current === entry.path ? null : current))
                    }}
                    onDrop={(e) => {
                      if (!fileBrowserEntryIsDirectory(entry)) return
                      dropOnDirectory(e, entry.path)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      selectEntry(entry.path)
                      setCtxMenu({ x: e.clientX, y: e.clientY, items: entryContextItems(entry) })
                    }}
                  >
                    <div class="flex min-w-0 items-center gap-2 truncate font-medium">
                      <span
                        class="shrink-0 text-(--shell-text-dim)"
                        classList={{
                          'text-(--shell-accent-soft-text)': selected(),
                        }}
                      >
                        {fileBrowserIconForEntry(entry)}
                      </span>
                      <span class="min-w-0 truncate">{normalizeDisplayName(entry)}</span>
                    </div>
                    <div class="truncate text-(--shell-text-dim)">{entry.kind}</div>
                    <div class="truncate text-(--shell-text-dim)">{formatEntryModified(entry.modified_ms)}</div>
                    <div class="truncate text-(--shell-text-dim)">{formatEntrySize(entry.size)}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <div class="flex items-center justify-between border-t border-(--shell-border) px-3 py-2 text-xs text-(--shell-text-dim)">
          <span>{state.activePath ?? 'No folder selected'}</span>
          <span>{busy() ? 'Busy' : `${state.entries.length} item${state.entries.length === 1 ? '' : 's'}`}</span>
        </div>
      </section>
      <FileBrowserContextMenu
        open={() => ctxMenu() !== null}
        anchor={() => {
          const m = ctxMenu()
          return m ? { x: m.x, y: m.y } : null
        }}
        items={() => ctxMenu()?.items ?? []}
        onRequestClose={closeCtxMenu}
      />
      <Show when={dialog().kind !== 'closed'}>
        <div
          class="fixed inset-0 z-94000 flex items-center justify-center bg-black/40 p-6"
          data-file-browser-dialog="1"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeFileDialog()
          }}
        >
          <div
            class="w-full max-w-md rounded border border-(--shell-border) bg-(--shell-surface-panel) p-4 text-(--shell-text) shadow-xl"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <Show
              when={(() => {
                const row = dialog()
                return row.kind === 'delete' ? row : false
              })()}
            >
              {(d) => (
                <>
                  <div class="mb-3 text-sm font-medium">Delete {d().label}?</div>
                  <div class="flex justify-end gap-2">
                    <button
                      type="button"
                      class="rounded border border-(--shell-border) px-3 py-1.5 text-sm hover:bg-(--shell-control-muted-hover)"
                      data-file-browser-dialog-cancel
                      onClick={closeFileDialog}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      class="rounded border border-red-500/50 bg-red-500/20 px-3 py-1.5 text-sm text-red-100 hover:bg-red-500/30"
                      data-file-browser-dialog-confirm
                      onClick={() => void submitFileDialog()}
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </Show>
            <Show
              when={(() => {
                const k = dialog().kind
                return k === 'mkdir' || k === 'touch' || k === 'rename'
              })()}
            >
              <div class="mb-2 text-sm font-medium text-(--shell-text-dim)">
                {(() => {
                  const k = dialog().kind
                  if (k === 'mkdir') return 'New folder'
                  if (k === 'touch') return 'New file'
                  return 'Rename'
                })()}
              </div>
              <input
                type="text"
                data-file-browser-dialog-input
                class="w-full rounded border border-(--shell-border) bg-(--shell-surface-inset) px-2 py-1.5 text-sm text-(--shell-text)"
                value={(() => {
                  const row = dialog()
                  if (row.kind === 'mkdir' || row.kind === 'touch' || row.kind === 'rename') return row.draft
                  return ''
                })()}
                onInput={(e) => {
                  const v = e.currentTarget.value
                  const row = dialog()
                  if (row.kind === 'mkdir') setDialog({ kind: 'mkdir', draft: v })
                  else if (row.kind === 'touch') setDialog({ kind: 'touch', draft: v })
                  else if (row.kind === 'rename') setDialog({ kind: 'rename', path: row.path, draft: v })
                }}
              />
              <div class="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  class="rounded border border-(--shell-border) px-3 py-1.5 text-sm hover:bg-(--shell-control-muted-hover)"
                  data-file-browser-dialog-cancel
                  onClick={closeFileDialog}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="rounded border border-(--shell-border) px-3 py-1.5 text-sm hover:bg-(--shell-control-muted-hover)"
                  data-file-browser-dialog-confirm
                  onClick={() => void submitFileDialog()}
                >
                  OK
                </button>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
