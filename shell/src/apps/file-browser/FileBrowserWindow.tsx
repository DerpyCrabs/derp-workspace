import type { Accessor } from 'solid-js'
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import {
  listFileBrowserDirectory,
  listFileBrowserRoots,
  fileBrowserReadUrl,
  mkdirFileBrowserEntry,
  removeFileBrowserPath,
  renameFileBrowserPath,
  statFileBrowserPath,
  touchFileBrowserFile,
  writeFileBrowserBytes,
  copyFileBrowserFile,
  type FileBrowserEntry,
  type FileBrowserRoot,
} from './fileBrowserBridge'
import {
  fileBrowserFsClipClear,
  fileBrowserFsClipCopy,
  fileBrowserFsClipCut,
  fileBrowserFsClipState,
} from './fileBrowserFsClipboard'
import {
  FILE_BROWSER_FAVORITES_PATH,
  useFileBrowserFilesSettings,
  type FileBrowserDefaultOpenTarget,
} from './fileBrowserFilesSettings'
import {
  FILE_BROWSER_CUSTOM_ICONS,
  renderFileBrowserCustomIcon,
} from './fileBrowserCustomIcons'
import {
  extractFileBrowserPasteData,
  fileToBase64,
  type FileBrowserPasteData,
} from './fileBrowserPaste'
import {
  FILE_BROWSER_DRAG_MIME,
  parseFileBrowserDragPayload,
  type FileBrowserDragPayload,
} from './fileBrowserDragPayload'
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
import {
  buildBreadcrumbs,
  customIconNameForPath,
  fileBrowserEntryCanOpenInShell,
  fileBrowserIconForEntry,
  fileBrowserPathCanOpenInShell,
  fileBrowserTitleForPath,
  formatEntryModified,
  formatEntrySize,
  normalizeDisplayName,
  normalizeFilesSettingsPath,
  pathWithinRoot,
  posixBasename,
  posixDirname,
  type BreadcrumbRow,
} from './fileBrowserPresentation'
import { shellHttpBase } from '@/features/bridge/shellHttp'
import {
  peekShellWindowState,
  primedShellWindowStateVersion,
  subscribeShellWindowState,
} from '@/features/shell-ui/shellWindowState'
import type { ShellContextMenuItem } from '@/host/contextMenu'
import { FileBrowserContextMenu } from './FileBrowserContextMenu'
import { isImageFilePath } from '@/apps/image-viewer/imageViewerCore'
import type { OpenWithOption } from '@/apps/default-applications/defaultApplications'
import Columns2 from 'lucide-solid/icons/columns-2'
import ArrowLeft from 'lucide-solid/icons/arrow-left'
import Clipboard from 'lucide-solid/icons/clipboard'
import Copy from 'lucide-solid/icons/copy'
import ClipboardPaste from 'lucide-solid/icons/clipboard-paste'
import ExternalLink from 'lucide-solid/icons/external-link'
import Eye from 'lucide-solid/icons/eye'
import EyeOff from 'lucide-solid/icons/eye-off'
import FilePlus from 'lucide-solid/icons/file-plus'
import Folder from 'lucide-solid/icons/folder'
import FolderInput from 'lucide-solid/icons/folder-input'
import FolderPlus from 'lucide-solid/icons/folder-plus'
import HardDrive from 'lucide-solid/icons/hard-drive'
import Home from 'lucide-solid/icons/home'
import LayoutGrid from 'lucide-solid/icons/layout-grid'
import List from 'lucide-solid/icons/list'
import MoreHorizontal from 'lucide-solid/icons/more-horizontal'
import Paintbrush from 'lucide-solid/icons/paintbrush'
import Pencil from 'lucide-solid/icons/pencil'
import RefreshCw from 'lucide-solid/icons/refresh-cw'
import Scissors from 'lucide-solid/icons/scissors'
import Star from 'lucide-solid/icons/star'
import Trash2 from 'lucide-solid/icons/trash-2'
import Upload from 'lucide-solid/icons/upload'
import Workflow from 'lucide-solid/icons/workflow'

type FileBrowserWindowProps = {
  windowId: number
  compositorAppState: Accessor<unknown | null>
  shellWireSend: (op: 'shell_hosted_window_state' | 'shell_hosted_window_title', json: string) => boolean
  onOpenFile: (
    path: string,
    context: { directory: string; showHidden: boolean },
  ) => void
  onOpenFileWith: (
    option: OpenWithOption,
    path: string,
    context: { directory: string; showHidden: boolean },
  ) => void
  openWithOptions: (path: string) => OpenWithOption[]
  onOpenInNewWindow?: (path: string) => void
  onOpenInTab?: (
    path: string,
    context: { directory: string; showHidden: boolean; isDirectory: boolean },
  ) => void
  onOpenInSplitView?: (
    path: string,
    context: { directory: string; showHidden: boolean; isDirectory: boolean },
  ) => void
  onOpenInTabDrop?: (
    path: string,
    context: { directory: string; showHidden: boolean; isDirectory: boolean },
    clientX: number,
    clientY: number,
  ) => boolean
  onPreviewInTabDrop?: (
    path: string,
    context: { directory: string; showHidden: boolean; isDirectory: boolean },
    label: string,
    clientX: number,
    clientY: number,
  ) => boolean
  onClearInTabDropPreview?: () => void
}

function menuSeparator(): ShellContextMenuItem {
  return { separator: true, label: '', action: () => undefined }
}

function tinyIcon(icon: typeof Folder) {
  const Icon = icon
  return <Icon class="h-4 w-4" stroke-width={2} />
}

function clipboardCanWritePath(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
}

type FileBrowserUiDialog =
  | { kind: 'closed' }
  | { kind: 'mkdir'; draft: string }
  | { kind: 'touch'; draft: string }
  | { kind: 'rename'; path: string; draft: string }
  | { kind: 'delete'; path: string; label: string }
  | { kind: 'open-with'; path: string; label: string; options: OpenWithOption[] }
  | { kind: 'move-to'; path: string; label: string; draft: string }
  | { kind: 'copy-to'; path: string; label: string; draft: string }
  | { kind: 'icon'; path: string; label: string; selected: string | null }
  | { kind: 'paste-file'; pasteData: FileBrowserPasteData; draft: string }
  | { kind: 'open-target'; path: string; label: string }

type FileBrowserPointerDrag = {
  path: string
  label: string
  kind: string
  writable: boolean
  directory: string
  showHidden: boolean
  pointerId: number
  startX: number
  startY: number
  dragging: boolean
  dropDir: string | null
}

type FileSystemEntryLike = {
  name: string
  isFile: boolean
  isDirectory: boolean
  file?: (success: (file: File) => void, failure?: (error: unknown) => void) => void
  createReader?: () => {
    readEntries: (success: (entries: FileSystemEntryLike[]) => void, failure?: (error: unknown) => void) => void
  }
}

const FILE_BROWSER_MUTATED_EVENT = 'derp-file-browser-mutated'

let nextFileBrowserMountSeq = 0

export function FileBrowserWindow(props: FileBrowserWindowProps) {
  const mountSeq = ++nextFileBrowserMountSeq
  const initialPrefs = loadFileBrowserPrefs()
  const filesSettings = useFileBrowserFilesSettings()
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
  let uploadInputRef: HTMLInputElement | undefined
  let pointerDrag: FileBrowserPointerDrag | null = null
  let lastFavoritesReloadKey = ''
  let typeSearchBuffer = ''
  let typeSearchTimer: number | null = null
  let suppressClickAfterPointerDrag = false
  let lastRowClick: { path: string; timeStamp: number; x: number; y: number } | null = null

  const [ctxMenu, setCtxMenu] = createSignal<{ x: number; y: number; items: ShellContextMenuItem[] } | null>(null)
  const [dialog, setDialog] = createSignal<FileBrowserUiDialog>({ kind: 'closed' })
  const [opError, setOpError] = createSignal<string | null>(null)
  const [dropTargetPath, setDropTargetPath] = createSignal<string | null>(null)
  const [externalUploadDragOver, setExternalUploadDragOver] = createSignal(false)
  const [uploadBusy, setUploadBusy] = createSignal(false)

  const breadcrumbs = createMemo(() => buildBreadcrumbs(state.activePath, state.roots))
  const favoritePathSet = createMemo(() => new Set(filesSettings.settings().favorites))
  const customIcons = createMemo(() => filesSettings.settings().custom_icons)
  const activeViewMode = createMemo(() => {
    const path = state.activePath
    if (!path) return 'list'
    return filesSettings.settings().view_modes[normalizeFilesSettingsPath(path)] ?? 'list'
  })
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
  const showParentRow = createMemo(() => !!state.parentPath && state.activePath !== FILE_BROWSER_FAVORITES_PATH)
  const parentEntryPath = createMemo(() => (showParentRow() ? state.parentPath : null))

  function withFavoritesRoot(roots: readonly FileBrowserRoot[]): FileBrowserRoot[] {
    const filtered = roots.filter((root) => root.path !== FILE_BROWSER_FAVORITES_PATH)
    return [
      ...filtered,
      {
        label: 'Favorites',
        path: FILE_BROWSER_FAVORITES_PATH,
        kind: 'favorite',
      },
    ]
  }

  async function listFavoriteEntries(base: string | null): Promise<FileBrowserEntry[]> {
    const entries: FileBrowserEntry[] = []
    for (const favorite of filesSettings.settings().favorites) {
      try {
        entries.push((await statFileBrowserPath(favorite, base)).entry)
      } catch {}
    }
    return entries
  }

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
      const nextRoots = withFavoritesRoot(roots.roots)
      setState('roots', nextRoots)
      const path = targetPath ?? state.activePath ?? roots.roots[0]?.path ?? null
      if (!path) {
        throw new Error('No file browser roots are available.')
      }
      if (path === FILE_BROWSER_FAVORITES_PATH) {
        const entries = await listFavoriteEntries(base)
        if (runId !== requestSeq) return
        setState('activePath', FILE_BROWSER_FAVORITES_PATH)
        setState('parentPath', null)
        setState('entries', entries)
        setState('selectedPath', clampFileBrowserSelection(entries, state.selectedPath))
        setState('status', 'ready')
        setOpError(null)
        return
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

  function openEntry(entry: FileBrowserEntry | null | undefined) {
    if (!entry) return
    if (fileBrowserEntryIsDirectory(entry)) {
      void loadDirectory(entry.path)
      return
    }
    const target = filesSettings.settings().default_open_target
    if (target === 'ask' && fileBrowserEntryCanOpenInShell(entry)) {
      setDialog({ kind: 'open-target', path: entry.path, label: normalizeDisplayName(entry) })
      return
    }
    openFilePathWithTarget(entry.path, target)
  }

  function openFilePathWithTarget(path: string, target: FileBrowserDefaultOpenTarget) {
    const directory = state.activePath ?? ''
    const context = { directory, showHidden: state.showHidden, isDirectory: false }
    const shellOpenable = fileBrowserPathCanOpenInShell(path)
    if (target === 'tab' && shellOpenable && props.onOpenInTab) {
      props.onOpenInTab(path, context)
      return
    }
    if (target === 'split' && shellOpenable && props.onOpenInSplitView) {
      props.onOpenInSplitView(path, context)
      return
    }
    props.onOpenFile(path, { directory, showHidden: state.showHidden })
  }

  function openEntryInDroppedTab(drag: FileBrowserPointerDrag, clientX: number, clientY: number): boolean {
    if (!props.onOpenInTabDrop) return false
    return props.onOpenInTabDrop(
      drag.path,
      {
        directory: drag.directory,
        showHidden: drag.showHidden,
        isDirectory: drag.kind === 'directory',
      },
      clientX,
      clientY,
    )
  }

  function previewEntryInDroppedTab(drag: FileBrowserPointerDrag, clientX: number, clientY: number) {
    props.onPreviewInTabDrop?.(
      drag.path,
      {
        directory: drag.directory,
        showHidden: drag.showHidden,
        isDirectory: drag.kind === 'directory',
      },
      drag.label,
      clientX,
      clientY,
    )
  }

  function openEntryWith(entryPath: string, option: OpenWithOption) {
    const directory = state.activePath ?? ''
    props.onOpenFileWith(option, entryPath, { directory, showHidden: state.showHidden })
  }

  function clickEntry(event: MouseEvent, entry: FileBrowserEntry) {
    if (suppressClickAfterPointerDrag) return
    const previous = lastRowClick
    const doubleClick =
      event.detail >= 2 ||
      (previous?.path === entry.path &&
        event.timeStamp - previous.timeStamp <= 500 &&
        Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 8)
    lastRowClick = doubleClick
      ? null
      : { path: entry.path, timeStamp: event.timeStamp, x: event.clientX, y: event.clientY }
    selectEntry(entry.path)
    if (doubleClick) openEntry(entry)
  }

  function setDragPayload(event: DragEvent, entry: FileBrowserEntry) {
    const dt = event.dataTransfer
    if (!dt) return
    const directory =
      state.activePath && state.activePath !== FILE_BROWSER_FAVORITES_PATH
        ? state.activePath
        : posixDirname(entry.path)
    const payload = JSON.stringify({
      path: entry.path,
      kind: entry.kind,
      writable: entry.writable === true,
      directory,
      showHidden: state.showHidden,
    } satisfies FileBrowserDragPayload)
    dt.effectAllowed = entry.writable === true ? 'copyMove' : 'copy'
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

  async function refreshAfterMutation(targetPath?: string | null) {
    notifyFileBrowserMutated()
    await loadDirectory(targetPath ?? state.activePath, true)
  }

  async function toggleFavoritePath(path: string) {
    const norm = normalizeFilesSettingsPath(path)
    try {
      await filesSettings.setFavorite(norm, !favoritePathSet().has(norm))
      if (state.activePath === FILE_BROWSER_FAVORITES_PATH) await loadDirectory(FILE_BROWSER_FAVORITES_PATH, true)
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e))
    }
  }

  async function pasteFsClipInto(targetDir: string) {
    const clip = fileBrowserFsClipState()
    if (!clip.path || clip.mode === 'none') return
    const base = shellHttpBase()
    setOpError(null)
    try {
      if (clip.mode === 'copy') {
        await copyFileBrowserFile(clip.path, targetDir, null, base)
      } else {
        const dest = targetDir === '/' ? `/${posixBasename(clip.path)}` : `${targetDir.replace(/\/+$/, '')}/${posixBasename(clip.path)}`
        await renameFileBrowserPath(clip.path, dest, base)
        fileBrowserFsClipClear()
      }
      await refreshAfterMutation(targetDir)
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e))
    }
  }

  async function writePasteDataToCurrentFolder(pasteData: FileBrowserPasteData, name: string) {
    if (!state.activePath || state.activePath === FILE_BROWSER_FAVORITES_PATH) return
    const base = shellHttpBase()
    setOpError(null)
    try {
      await writeFileBrowserBytes(state.activePath, name.trim(), pasteData.contentBase64, base)
      closeFileDialog()
      await refreshAfterMutation(state.activePath)
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e))
    }
  }

  function hasExternalFileDrop(event: DragEvent): boolean {
    const dt = event.dataTransfer
    if (!dt) return false
    if (dt.files && dt.files.length > 0) return true
    return Array.from(dt.types ?? []).includes('Files')
  }

  function dataTransferEntry(item: DataTransferItem): FileSystemEntryLike | null {
    const getter = (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntryLike | null }).webkitGetAsEntry
    return typeof getter === 'function' ? getter.call(item) : null
  }

  function fileFromEntry(entry: FileSystemEntryLike): Promise<File> {
    return new Promise((resolve, reject) => {
      if (!entry.file) {
        reject(new Error('Dropped item is not a file.'))
        return
      }
      entry.file(resolve, reject)
    })
  }

  function entriesFromDirectory(entry: FileSystemEntryLike): Promise<FileSystemEntryLike[]> {
    return new Promise((resolve, reject) => {
      const reader = entry.createReader?.()
      if (!reader) {
        resolve([])
        return
      }
      const out: FileSystemEntryLike[] = []
      const read = () => {
        reader.readEntries((chunk) => {
          if (chunk.length === 0) {
            resolve(out)
            return
          }
          out.push(...chunk)
          read()
        }, reject)
      }
      read()
    })
  }

  async function uploadEntryToFolder(entry: FileSystemEntryLike, targetDir: string, base: string | null) {
    if (entry.isFile) {
      const file = await fileFromEntry(entry)
      await writeFileBrowserBytes(targetDir, file.name || entry.name, await fileToBase64(file), base)
      return
    }
    if (!entry.isDirectory) return
    const made = await mkdirFileBrowserEntry(targetDir, entry.name, base)
    const nextDir =
      made.path ?? (targetDir === '/' ? `/${entry.name}` : `${targetDir.replace(/\/+$/, '')}/${entry.name}`)
    for (const child of await entriesFromDirectory(entry)) {
      await uploadEntryToFolder(child, nextDir, base)
    }
  }

  async function uploadFilesToCurrentFolder(files: readonly File[]) {
    if (!state.activePath || state.activePath === FILE_BROWSER_FAVORITES_PATH || files.length === 0) return
    setUploadBusy(true)
    setOpError(null)
    const base = shellHttpBase()
    try {
      for (const file of files) {
        await writeFileBrowserBytes(state.activePath, file.name, await fileToBase64(file), base)
      }
      await refreshAfterMutation(state.activePath)
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadBusy(false)
      setExternalUploadDragOver(false)
    }
  }

  async function uploadDataTransferToCurrentFolder(dataTransfer: DataTransfer) {
    if (!state.activePath || state.activePath === FILE_BROWSER_FAVORITES_PATH) return
    const entries = Array.from(dataTransfer.items ?? [])
      .map(dataTransferEntry)
      .filter((entry): entry is FileSystemEntryLike => entry !== null)
    if (entries.length === 0) {
      await uploadFilesToCurrentFolder(Array.from(dataTransfer.files ?? []))
      return
    }
    setUploadBusy(true)
    setOpError(null)
    const base = shellHttpBase()
    try {
      for (const entry of entries) {
        await uploadEntryToFolder(entry, state.activePath, base)
      }
      await refreshAfterMutation(state.activePath)
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadBusy(false)
      setExternalUploadDragOver(false)
    }
  }

  async function moveDraggedPathInto(sourcePath: string, targetDir: string) {
    if (!canDropPathInto(sourcePath, targetDir)) return
    const base = shellHttpBase()
    const destPath = targetDir === '/' ? `/${posixBasename(sourcePath)}` : `${targetDir.replace(/\/+$/, '')}/${posixBasename(sourcePath)}`
    setOpError(null)
    try {
      await renameFileBrowserPath(sourcePath, destPath, base)
      setDropTargetPath(null)
      await refreshAfterMutation(state.activePath)
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e))
    }
  }

  function dragOverDirectory(event: DragEvent, targetDir: string) {
    const payload = parseFileBrowserDragPayload(event.dataTransfer)
    if (!payload?.writable || !canDropPathInto(payload.path, targetDir)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    setDropTargetPath(targetDir)
  }

  function dropOnDirectory(event: DragEvent, targetDir: string) {
    const payload = parseFileBrowserDragPayload(event.dataTransfer)
    if (!payload?.writable) return
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
    drag.dropDir = drag.writable && dir && canDropPathInto(drag.path, dir) ? dir : null
    setDropTargetPath(drag.dropDir)
    previewEntryInDroppedTab(drag, event.clientX, event.clientY)
  }

  function onWindowPointerDragEnd(event: PointerEvent) {
    const drag = pointerDrag
    if (!drag || drag.pointerId !== event.pointerId) return
    clearPointerDragListeners()
    pointerDrag = null
    setDropTargetPath(null)
    props.onClearInTabDropPreview?.()
    if (!drag.dragging) return
    event.preventDefault()
    suppressClickAfterPointerDrag = true
    window.setTimeout(() => {
      suppressClickAfterPointerDrag = false
    }, 0)
    const dir = drag.dropDir ?? pointerDropDirAt(event.clientX, event.clientY)
    if (drag.writable && dir && canDropPathInto(drag.path, dir)) {
      void moveDraggedPathInto(drag.path, dir)
      return
    }
    openEntryInDroppedTab(drag, event.clientX, event.clientY)
  }

  function beginPointerDrag(event: PointerEvent, entry: FileBrowserEntry) {
    if (event.button !== 0) return
    if (entry.writable !== true && !fileBrowserEntryCanOpenInShell(entry)) return
    const directory =
      state.activePath && state.activePath !== FILE_BROWSER_FAVORITES_PATH
        ? state.activePath
        : posixDirname(entry.path)
    pointerDrag = {
      path: entry.path,
      label: normalizeDisplayName(entry),
      kind: entry.kind,
      writable: entry.writable === true,
      directory,
      showHidden: state.showHidden,
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
    const items: ShellContextMenuItem[] = []
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
        actionId: 'open-with',
        label: 'Open with…',
        icon: tinyIcon(ExternalLink),
        action: () => {
          setDialog({
            kind: 'open-with',
            path: entry.path,
            label: normalizeDisplayName(entry),
            options: props.openWithOptions(entry.path),
          })
        },
      })
    }
    if (items.length > 0) items.push(menuSeparator())
    items.push({
      actionId: favoritePathSet().has(normalizeFilesSettingsPath(entry.path)) ? 'unfavorite' : 'favorite',
      label: favoritePathSet().has(normalizeFilesSettingsPath(entry.path)) ? 'Unfavorite' : 'Favorite',
      icon: tinyIcon(Star),
      action: () => {
        void toggleFavoritePath(entry.path)
      },
    })
    items.push({
      actionId: 'set-icon',
      label: 'Set icon…',
      icon: tinyIcon(Paintbrush),
      action: () => {
        setDialog({
          kind: 'icon',
          path: entry.path,
          label: normalizeDisplayName(entry),
          selected: customIconNameForPath(entry.path, customIcons()),
        })
      },
    })
    if (writable) {
      if (items.length > 0) items.push(menuSeparator())
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
        items.push({
          actionId: 'copy-to',
          label: 'Copy to…',
          icon: tinyIcon(FolderInput),
          action: () => {
            setDialog({
              kind: 'copy-to',
              path: entry.path,
              label: normalizeDisplayName(entry),
              draft: state.activePath ?? posixDirname(entry.path),
            })
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
        actionId: 'move-to',
        label: 'Move to…',
        icon: tinyIcon(FolderInput),
        action: () => {
          setDialog({
            kind: 'move-to',
            path: entry.path,
            label: normalizeDisplayName(entry),
            draft: state.activePath ?? posixDirname(entry.path),
          })
        },
      })
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
    if (items.length > 0) items.push(menuSeparator())
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
    const items: ShellContextMenuItem[] = []
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
    if (fileBrowserFsClipState().mode !== 'none' && root.path !== FILE_BROWSER_FAVORITES_PATH) {
      if (items.length > 0) items.push(menuSeparator())
      items.push({
        actionId: 'fs-paste',
        label: 'Paste',
        icon: tinyIcon(ClipboardPaste),
        action: () => {
          void pasteFsClipInto(root.path)
        },
      })
    }
    if (items.length > 0) items.push(menuSeparator())
    items.push({
      actionId: 'set-icon',
      label: 'Set icon…',
      icon: tinyIcon(Paintbrush),
      action: () => {
        setDialog({
          kind: 'icon',
          path: root.path,
          label: root.label,
          selected: customIconNameForPath(root.path, customIcons()),
        })
      },
    })
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

  function handleTypeSearch(key: string) {
    if (typeSearchTimer !== null) window.clearTimeout(typeSearchTimer)
    typeSearchBuffer = `${typeSearchBuffer}${key}`.toLowerCase()
    typeSearchTimer = window.setTimeout(() => {
      typeSearchBuffer = ''
      typeSearchTimer = null
    }, 850)
    const selectedIndex = state.entries.findIndex((entry) => entry.path === state.selectedPath)
    const start = selectedIndex >= 0 ? selectedIndex + 1 : 0
    const candidates = [...state.entries.slice(start), ...state.entries.slice(0, start)]
    const found = candidates.find((entry) => normalizeDisplayName(entry).toLowerCase().startsWith(typeSearchBuffer))
    if (found) selectEntry(found.path)
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
      } else if (d.kind === 'move-to') {
        const destDir = d.draft.trim()
        if (!destDir) throw new Error('Destination folder is required.')
        const to = destDir === '/' ? `/${posixBasename(d.path)}` : `${destDir.replace(/\/+$/, '')}/${posixBasename(d.path)}`
        await renameFileBrowserPath(d.path, to, base)
        fileBrowserFsClipClear()
      } else if (d.kind === 'copy-to') {
        const destDir = d.draft.trim()
        if (!destDir) throw new Error('Destination folder is required.')
        await copyFileBrowserFile(d.path, destDir, null, base)
      } else if (d.kind === 'icon') {
        await filesSettings.setCustomIcon(d.path, d.selected)
      } else if (d.kind === 'paste-file') {
        const name = d.draft.trim()
        if (!name) throw new Error('Filename is required.')
        await writePasteDataToCurrentFolder(d.pasteData, name)
        return
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
    void filesSettings.warm()
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
    props.onClearInTabDropPreview?.()
    if (typeSearchTimer !== null) window.clearTimeout(typeSearchTimer)
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
    const favKey = filesSettings.settings().favorites.join('\u001f')
    if (state.activePath !== FILE_BROWSER_FAVORITES_PATH || state.status !== 'ready') return
    if (favKey === lastFavoritesReloadKey) return
    lastFavoritesReloadKey = favKey
    void loadDirectory(FILE_BROWSER_FAVORITES_PATH, true)
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
      class="relative flex h-full min-h-0 min-w-0 bg-(--shell-surface-inset) text-(--shell-text)"
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
        const keyTarget = event.target
        if (
          event.key.length === 1 &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !(keyTarget instanceof HTMLInputElement) &&
          !(keyTarget instanceof HTMLTextAreaElement) &&
          !(keyTarget instanceof HTMLSelectElement) &&
          state.entries.length > 0
        ) {
          event.preventDefault()
          handleTypeSearch(event.key)
          return
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
      onPaste={(event) => {
        if (!state.activePath || state.activePath === FILE_BROWSER_FAVORITES_PATH) return
        const data = event.clipboardData
        if (!data || (!data.files.length && !data.getData('text/plain') && !data.getData('text/html'))) return
        event.preventDefault()
        void extractFileBrowserPasteData(event.clipboardData).then((pasteData) => {
          if (!pasteData) return
          setDialog({ kind: 'paste-file', pasteData, draft: pasteData.suggestedName })
        })
      }}
      onDragOver={(event) => {
        if (!state.activePath) return
        if (hasExternalFileDrop(event) && state.activePath !== FILE_BROWSER_FAVORITES_PATH) {
          event.preventDefault()
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
          setExternalUploadDragOver(true)
          return
        }
        dragOverDirectory(event, state.activePath)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDropTargetPath(null)
        setExternalUploadDragOver(false)
      }}
      onDrop={(event) => {
        if (!state.activePath) return
        if (hasExternalFileDrop(event) && event.dataTransfer) {
          event.preventDefault()
          void uploadDataTransferToCurrentFolder(event.dataTransfer)
          return
        }
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
                  {root.path === FILE_BROWSER_FAVORITES_PATH ? (
                    <Star class="h-4 w-4" stroke-width={2} />
                  ) : (
                    renderFileBrowserCustomIcon(customIconNameForPath(root.path, customIcons()), 'h-4 w-4') ?? (
                      <HardDrive class="h-4 w-4" stroke-width={2} />
                    )
                  )}
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
                              ...(props.onOpenInNewWindow ? [menuSeparator()] : []),
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
            disabled={!state.activePath || state.activePath === FILE_BROWSER_FAVORITES_PATH}
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
            disabled={!state.activePath || state.activePath === FILE_BROWSER_FAVORITES_PATH}
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
          <button
            type="button"
            class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-(--shell-border) hover:bg-(--shell-control-muted-hover)"
            classList={{
              'bg-(--shell-accent) text-(--shell-accent-text)': activeViewMode() === 'list',
              'text-(--shell-text-dim)': activeViewMode() !== 'list',
            }}
            data-file-browser-primary-action="view-list"
            aria-label="List view"
            title="List view"
            onClick={() => {
              if (state.activePath) void filesSettings.setViewMode(state.activePath, 'list')
            }}
          >
            <List class="h-4 w-4" stroke-width={2} />
          </button>
          <button
            type="button"
            class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-(--shell-border) hover:bg-(--shell-control-muted-hover)"
            classList={{
              'bg-(--shell-accent) text-(--shell-accent-text)': activeViewMode() === 'grid',
              'text-(--shell-text-dim)': activeViewMode() !== 'grid',
            }}
            data-file-browser-primary-action="view-grid"
            aria-label="Grid view"
            title="Grid view"
            onClick={() => {
              if (state.activePath) void filesSettings.setViewMode(state.activePath, 'grid')
            }}
          >
            <LayoutGrid class="h-4 w-4" stroke-width={2} />
          </button>
          <button
            type="button"
            class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-(--shell-border) text-(--shell-text-dim) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text) disabled:cursor-not-allowed disabled:opacity-50"
            data-file-browser-primary-action="paste"
            aria-label="Paste"
            title="Paste"
            disabled={fileBrowserFsClipState().mode === 'none' || !state.activePath || state.activePath === FILE_BROWSER_FAVORITES_PATH}
            onClick={() => {
              if (state.activePath) void pasteFsClipInto(state.activePath)
            }}
          >
            <ClipboardPaste class="h-4 w-4" stroke-width={2} />
          </button>
          <input
            ref={(el) => {
              uploadInputRef = el
            }}
            type="file"
            multiple
            class="hidden"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? [])
              event.currentTarget.value = ''
              void uploadFilesToCurrentFolder(files)
            }}
          />
          <button
            type="button"
            class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-(--shell-border) text-(--shell-text-dim) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text) disabled:cursor-not-allowed disabled:opacity-50"
            data-file-browser-primary-action="upload"
            aria-label="Upload files"
            title="Upload files"
            disabled={!state.activePath || state.activePath === FILE_BROWSER_FAVORITES_PATH || uploadBusy()}
            onClick={() => uploadInputRef?.click()}
          >
            <Upload class="h-4 w-4" stroke-width={2} />
          </button>
          <select
            class="h-8 shrink-0 rounded-md border border-(--shell-border) bg-(--shell-surface-inset) px-2 text-xs text-(--shell-text-muted)"
            value={filesSettings.settings().default_open_target}
            title="Default file open target"
            onChange={(event) => {
              void filesSettings.setDefaultOpenTarget(event.currentTarget.value as FileBrowserDefaultOpenTarget)
            }}
          >
            <option value="window">Window</option>
            <option value="tab">Tab</option>
            <option value="split">Split</option>
            <option value="ask">Ask</option>
          </select>
        </div>
        <Show when={opError()}>
          <div class="border-b border-(--shell-border) px-3 py-2 text-xs text-red-300">{opError()}</div>
        </Show>
        <Show when={activeViewMode() === 'list'}>
          <div class="grid grid-cols-[minmax(0,1fr)_110px_160px_96px] gap-3 border-b border-(--shell-border) bg-(--shell-surface-panel) px-3 py-2 text-[11px] font-semibold tracking-[0.08em] text-(--shell-text-dim) uppercase">
            <div>Name</div>
            <div>Kind</div>
            <div>Modified</div>
            <div>Size</div>
          </div>
        </Show>
        <div class="min-h-0 flex-1 overflow-auto" data-file-browser-entry-scroll>
          {state.status === 'loading' ? (
            <div class="flex h-full items-center justify-center px-6 py-10">
              <div class="rounded border border-(--shell-border) bg-(--shell-surface-panel) px-4 py-3 text-sm text-(--shell-text-dim)">
                Loading files…
              </div>
            </div>
          ) : state.status === 'error' ? (
            <div class="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
              <div class="flex max-w-lg flex-col items-center gap-3 rounded border border-(--shell-border) bg-(--shell-surface-panel) px-5 py-4">
                <div class="text-sm font-medium text-(--shell-text)">Failed to load this folder.</div>
                <div class="text-sm text-(--shell-text-dim)">{state.errorMessage ?? 'Unknown error'}</div>
                <button
                  type="button"
                  class="rounded border border-(--shell-border) px-3 py-1.5 text-sm hover:bg-(--shell-control-muted-hover)"
                  onClick={() => void loadDirectory(state.activePath ?? state.roots[0]?.path, true)}
                >
                  Retry
                </button>
              </div>
            </div>
          ) : state.entries.length === 0 && !showParentRow() ? (
            <div class="flex h-full items-center justify-center px-6 py-10 text-sm text-(--shell-text-dim)">
              <div class="rounded border border-(--shell-border) bg-(--shell-surface-panel) px-4 py-3">
                {state.activePath === FILE_BROWSER_FAVORITES_PATH ? 'No favorites yet.' : 'This folder is empty.'}
              </div>
            </div>
          ) : activeViewMode() === 'grid' ? (
            <div class="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-3 p-3">
              <Show when={parentEntryPath()}>
                {(parentPath) => (
                  <button
                    type="button"
                    class="group flex min-h-36 flex-col items-center justify-center gap-2 rounded border border-(--shell-border) bg-(--shell-surface-panel) p-3 text-sm"
                    data-file-browser-row
                    data-file-browser-path={parentPath()}
                    data-file-browser-name=".."
                    data-file-browser-kind="directory"
                    data-file-browser-selected="false"
                    onClick={() => void loadDirectory(parentPath())}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setCtxMenu({
                        x: e.clientX,
                        y: e.clientY,
                        items: [
                          {
                            actionId: 'open-parent',
                            label: 'Open parent',
                            icon: tinyIcon(Folder),
                            action: () => void loadDirectory(parentPath()),
                          },
                        ],
                      })
                    }}
                  >
                    <FolderInput class="h-10 w-10 text-(--shell-text-dim)" stroke-width={2} />
                    <span class="max-w-full truncate font-medium">..</span>
                  </button>
                )}
              </Show>
              <Show when={state.entries.length === 0}>
                <div class="col-span-full flex min-h-24 items-center justify-center rounded border border-(--shell-border) bg-(--shell-surface-panel) px-4 py-3 text-sm text-(--shell-text-dim)">
                  This folder is empty.
                </div>
              </Show>
              {state.entries.map((entry) => {
                const selected = () => state.selectedPath === entry.path
                const favorite = () => favoritePathSet().has(normalizeFilesSettingsPath(entry.path))
                const imageThumb = () => entry.kind === 'file' && isImageFilePath(entry.path)
                return (
                  <div
                    class="group relative flex min-h-36 cursor-default flex-col rounded border border-(--shell-border) bg-(--shell-surface-panel) p-2 text-sm hover:bg-(--shell-control-muted-hover)"
                    classList={{
                      'border-(--shell-accent) bg-(--shell-accent-soft) text-(--shell-accent-soft-text)': selected(),
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
                    onClick={(event) => clickEntry(event, entry)}
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
                    <button
                      type="button"
                      class="absolute top-2 right-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded border border-(--shell-border) bg-(--shell-surface-inset)/85 text-(--shell-text-dim) opacity-0 hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text) group-hover:opacity-100"
                      classList={{ 'opacity-100 text-yellow-300': favorite() }}
                      aria-label={favorite() ? 'Unfavorite' : 'Favorite'}
                      title={favorite() ? 'Unfavorite' : 'Favorite'}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        void toggleFavoritePath(entry.path)
                      }}
                    >
                      <Star class="h-3.5 w-3.5" fill={favorite() ? 'currentColor' : 'none'} stroke-width={2} />
                    </button>
                    <div class="flex min-h-24 items-center justify-center overflow-hidden rounded bg-(--shell-surface-inset)">
                      {imageThumb() ? (
                        <img
                          src={fileBrowserReadUrl(entry.path, shellHttpBase())}
                          alt=""
                          class="h-full max-h-24 w-full object-cover"
                          draggable={false}
                        />
                      ) : (
                        <span class="text-(--shell-text-dim)">
                          {fileBrowserIconForEntry(entry, customIcons(), 'h-12 w-12')}
                        </span>
                      )}
                    </div>
                    <div class="mt-2 min-w-0">
                      <div class="truncate font-medium">{normalizeDisplayName(entry)}</div>
                      <div class="mt-1 flex items-center justify-between gap-2 text-xs text-(--shell-text-dim)">
                        <span class="truncate">{entry.kind}</span>
                        <span class="shrink-0">{formatEntrySize(entry.size)}</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div class="divide-y divide-(--shell-border)">
              <Show when={parentEntryPath()}>
                {(parentPath) => (
                  <div
                    class="group grid cursor-default grid-cols-[minmax(0,1fr)_110px_160px_96px] gap-3 px-3 py-2 text-sm"
                    role="row"
                    data-file-browser-row
                    data-file-browser-path={parentPath()}
                    data-file-browser-name=".."
                    data-file-browser-kind="directory"
                    data-file-browser-selected="false"
                    onClick={(event) => {
                      const previous = lastRowClick
                      const doubleClick =
                        event.detail >= 2 ||
                        (previous?.path === parentPath() &&
                          event.timeStamp - previous.timeStamp <= 500 &&
                          Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 8)
                      lastRowClick = doubleClick
                        ? null
                        : { path: parentPath(), timeStamp: event.timeStamp, x: event.clientX, y: event.clientY }
                      if (doubleClick) void loadDirectory(parentPath())
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setCtxMenu({
                        x: e.clientX,
                        y: e.clientY,
                        items: [
                          {
                            actionId: 'open-parent',
                            label: 'Open parent',
                            icon: tinyIcon(Folder),
                            action: () => void loadDirectory(parentPath()),
                          },
                        ],
                      })
                    }}
                  >
                    <div class="flex min-w-0 items-center gap-2 truncate font-medium">
                      <FolderInput class="h-4 w-4 shrink-0 text-(--shell-text-dim)" stroke-width={2} />
                      <span class="min-w-0 truncate">..</span>
                    </div>
                    <div class="truncate text-(--shell-text-dim)">directory</div>
                    <div class="truncate text-(--shell-text-dim)">—</div>
                    <div class="truncate text-(--shell-text-dim)">—</div>
                  </div>
                )}
              </Show>
              <Show when={state.entries.length === 0}>
                <div class="px-3 py-8 text-center text-sm text-(--shell-text-dim)">This folder is empty.</div>
              </Show>
              {state.entries.map((entry) => {
                const selected = () => state.selectedPath === entry.path
                const favorite = () => favoritePathSet().has(normalizeFilesSettingsPath(entry.path))
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
                    onClick={(event) => clickEntry(event, entry)}
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
                      <button
                        type="button"
                        class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-(--shell-text-dim) opacity-0 hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text) group-hover:opacity-100"
                        classList={{ 'opacity-100 text-yellow-300': favorite() }}
                        aria-label={favorite() ? 'Unfavorite' : 'Favorite'}
                        title={favorite() ? 'Unfavorite' : 'Favorite'}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          void toggleFavoritePath(entry.path)
                        }}
                      >
                        <Star class="h-3.5 w-3.5" fill={favorite() ? 'currentColor' : 'none'} stroke-width={2} />
                      </button>
                      <span
                        class="shrink-0 text-(--shell-text-dim)"
                        classList={{
                          'text-(--shell-accent-soft-text)': selected(),
                        }}
                      >
                        {fileBrowserIconForEntry(entry, customIcons())}
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
      <Show when={externalUploadDragOver()}>
        <div class="pointer-events-none absolute inset-4 z-20 flex items-center justify-center rounded border border-(--shell-accent) bg-(--shell-surface-panel)/90 text-sm font-medium text-(--shell-text)">
          Drop files to upload
        </div>
      </Show>
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
                const row = dialog()
                return row.kind === 'open-with' ? row : false
              })()}
            >
              {(d) => (
                <>
                  <div class="mb-1 text-sm font-medium">Open {d().label} with</div>
                  <div class="mb-3 text-xs text-(--shell-text-dim)">Choose an application for this file.</div>
                  <div class="max-h-80 overflow-y-auto rounded border border-(--shell-border)">
                    {d().options.map((option) => (
                      <button
                        type="button"
                        class="flex w-full items-center justify-between gap-3 border-b border-(--shell-border) px-3 py-2 text-left text-sm last:border-b-0 hover:bg-(--shell-control-muted-hover)"
                        data-file-browser-open-with-option={option.id}
                        onClick={() => {
                          openEntryWith(d().path, option)
                          closeFileDialog()
                        }}
                      >
                        <span class="min-w-0 truncate">{option.label}</span>
                        <span class="shrink-0 text-xs text-(--shell-text-dim)">
                          {option.kind === 'shell' ? 'Shell' : option.kind === 'desktop' ? 'App' : 'System'}
                        </span>
                      </button>
                    ))}
                  </div>
                  <div class="mt-4 flex justify-end">
                    <button
                      type="button"
                      class="rounded border border-(--shell-border) px-3 py-1.5 text-sm hover:bg-(--shell-control-muted-hover)"
                      data-file-browser-dialog-cancel
                      onClick={closeFileDialog}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </Show>
            <Show
              when={(() => {
                const row = dialog()
                return row.kind === 'open-target' ? row : false
              })()}
            >
              {(d) => (
                <>
                  <div class="mb-3 text-sm font-medium">Open {d().label}</div>
                  <div class="flex flex-col gap-2">
                    <button
                      type="button"
                      class="flex items-center justify-between rounded border border-(--shell-border) px-3 py-2 text-sm hover:bg-(--shell-control-muted-hover)"
                      data-file-browser-open-target="window"
                      onClick={() => {
                        openFilePathWithTarget(d().path, 'window')
                        closeFileDialog()
                      }}
                    >
                      <span>Window</span>
                      <ExternalLink class="h-4 w-4" stroke-width={2} />
                    </button>
                    <button
                      type="button"
                      class="flex items-center justify-between rounded border border-(--shell-border) px-3 py-2 text-sm hover:bg-(--shell-control-muted-hover) disabled:opacity-50"
                      data-file-browser-open-target="tab"
                      disabled={!props.onOpenInTab}
                      onClick={() => {
                        openFilePathWithTarget(d().path, 'tab')
                        closeFileDialog()
                      }}
                    >
                      <span>Tab</span>
                      <Workflow class="h-4 w-4" stroke-width={2} />
                    </button>
                    <button
                      type="button"
                      class="flex items-center justify-between rounded border border-(--shell-border) px-3 py-2 text-sm hover:bg-(--shell-control-muted-hover) disabled:opacity-50"
                      data-file-browser-open-target="split"
                      disabled={!props.onOpenInSplitView}
                      onClick={() => {
                        openFilePathWithTarget(d().path, 'split')
                        closeFileDialog()
                      }}
                    >
                      <span>Split view</span>
                      <Columns2 class="h-4 w-4" stroke-width={2} />
                    </button>
                  </div>
                  <div class="mt-4 flex justify-end">
                    <button
                      type="button"
                      class="rounded border border-(--shell-border) px-3 py-1.5 text-sm hover:bg-(--shell-control-muted-hover)"
                      data-file-browser-dialog-cancel
                      onClick={closeFileDialog}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </Show>
            <Show
              when={(() => {
                const row = dialog()
                return row.kind === 'icon' ? row : false
              })()}
            >
              {(d) => (
                <>
                  <div class="mb-1 text-sm font-medium">Icon for {d().label}</div>
                  <div class="grid grid-cols-4 gap-2">
                    {FILE_BROWSER_CUSTOM_ICONS.map((icon) => (
                      <button
                        type="button"
                        class="flex h-16 flex-col items-center justify-center gap-1 rounded border border-(--shell-border) text-xs hover:bg-(--shell-control-muted-hover)"
                        classList={{
                          'border-(--shell-accent) bg-(--shell-accent-soft) text-(--shell-accent-soft-text)': d().selected === icon.name,
                        }}
                        data-file-browser-icon-option={icon.name}
                        onClick={() =>
                          setDialog({
                            kind: 'icon',
                            path: d().path,
                            label: d().label,
                            selected: icon.name,
                          })
                        }
                      >
                        {renderFileBrowserCustomIcon(icon.name, 'h-5 w-5')}
                        <span class="max-w-full truncate">{icon.label}</span>
                      </button>
                    ))}
                  </div>
                  <div class="mt-4 flex justify-between gap-2">
                    <button
                      type="button"
                      class="rounded border border-(--shell-border) px-3 py-1.5 text-sm hover:bg-(--shell-control-muted-hover)"
                      data-file-browser-dialog-clear
                      onClick={() =>
                        setDialog({
                          kind: 'icon',
                          path: d().path,
                          label: d().label,
                          selected: null,
                        })
                      }
                    >
                      Clear
                    </button>
                    <div class="flex gap-2">
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
                  </div>
                </>
              )}
            </Show>
            <Show
              when={(() => {
                const row = dialog()
                return row.kind === 'paste-file' ? row : false
              })()}
            >
              {(d) => (
                <>
                  <div class="mb-1 text-sm font-medium">Paste as new file</div>
                  <div class="mb-3 text-xs text-(--shell-text-dim)">{formatEntrySize(d().pasteData.size)}</div>
                  <Show when={d().pasteData.previewDataUrl}>
                    {(src) => (
                      <img
                        src={src()}
                        alt=""
                        class="mb-3 max-h-48 w-full rounded border border-(--shell-border) object-contain"
                      />
                    )}
                  </Show>
                  <Show when={!d().pasteData.previewDataUrl && d().pasteData.previewText}>
                    {(text) => (
                      <pre class="mb-3 max-h-36 overflow-auto whitespace-pre-wrap rounded border border-(--shell-border) bg-(--shell-surface-inset) p-2 text-xs text-(--shell-text-dim)">
                        {text()}
                      </pre>
                    )}
                  </Show>
                  <input
                    type="text"
                    data-file-browser-dialog-input
                    class="w-full rounded border border-(--shell-border) bg-(--shell-surface-inset) px-2 py-1.5 text-sm text-(--shell-text)"
                    value={d().draft}
                    onInput={(e) =>
                      setDialog({
                        kind: 'paste-file',
                        pasteData: d().pasteData,
                        draft: e.currentTarget.value,
                      })
                    }
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
                      Paste
                    </button>
                  </div>
                </>
              )}
            </Show>
            <Show
              when={(() => {
                const k = dialog().kind
                return k === 'mkdir' || k === 'touch' || k === 'rename' || k === 'move-to' || k === 'copy-to'
              })()}
            >
              <div class="mb-2 text-sm font-medium text-(--shell-text-dim)">
                {(() => {
                  const k = dialog().kind
                  if (k === 'mkdir') return 'New folder'
                  if (k === 'touch') return 'New file'
                  if (k === 'move-to') return 'Move to folder'
                  if (k === 'copy-to') return 'Copy to folder'
                  return 'Rename'
                })()}
              </div>
              <input
                type="text"
                data-file-browser-dialog-input
                class="w-full rounded border border-(--shell-border) bg-(--shell-surface-inset) px-2 py-1.5 text-sm text-(--shell-text)"
                value={(() => {
                  const row = dialog()
                  if (
                    row.kind === 'mkdir' ||
                    row.kind === 'touch' ||
                    row.kind === 'rename' ||
                    row.kind === 'move-to' ||
                    row.kind === 'copy-to'
                  )
                    return row.draft
                  return ''
                })()}
                onInput={(e) => {
                  const v = e.currentTarget.value
                  const row = dialog()
                  if (row.kind === 'mkdir') setDialog({ kind: 'mkdir', draft: v })
                  else if (row.kind === 'touch') setDialog({ kind: 'touch', draft: v })
                  else if (row.kind === 'rename') setDialog({ kind: 'rename', path: row.path, draft: v })
                  else if (row.kind === 'move-to') setDialog({ kind: 'move-to', path: row.path, label: row.label, draft: v })
                  else if (row.kind === 'copy-to') setDialog({ kind: 'copy-to', path: row.path, label: row.label, draft: v })
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
