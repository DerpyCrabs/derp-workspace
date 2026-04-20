import type { Accessor } from 'solid-js'
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import {
  copyFileBrowserFile,
  listFileBrowserDirectory,
  listFileBrowserRoots,
  mkdirFileBrowserEntry,
  removeFileBrowserPath,
  renameFileBrowserPath,
  statFileBrowserPath,
  touchFileBrowserFile,
  type FileBrowserEntry,
  type FileBrowserRoot,
} from './fileBrowserBridge'
import {
  fileBrowserFsClipClear,
  fileBrowserFsClipCopy,
  fileBrowserFsClipCut,
  fileBrowserFsClipState,
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

type FileBrowserWindowProps = {
  windowId: number
  compositorAppState: Accessor<unknown | null>
  shellWireSend: (op: 'shell_hosted_window_state', json: string) => boolean
  onOpenFile: (
    path: string,
    context: { directory: string; showHidden: boolean },
  ) => void
  onOpenInNewWindow?: (path: string) => void
  onOpenPathExternally: (path: string) => void
}

type Breadcrumb = {
  path: string
  label: string
}

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

function pickCopyDestName(sourcePath: string, existingNames: ReadonlySet<string>): string {
  const base = posixBasename(sourcePath)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let n = 0; n < 600; n += 1) {
    const candidate = n === 0 ? `${stem} (copy)${ext}` : `${stem} (copy ${n + 1})${ext}`
    if (!existingNames.has(candidate)) return candidate
  }
  return `${stem} (copy ${Date.now()})${ext}`
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
  const selectedEntry = createMemo(
    () => state.entries.find((entry) => entry.path === state.selectedPath) ?? null,
  )
  const canPasteHere = createMemo(() => {
    const c = fileBrowserFsClipState()
    const ap = state.activePath
    if (!ap || c.mode === 'none' || !c.path) return false
    if (c.mode === 'cut') {
      const destDir = ap.replace(/\/+$/, '') || '/'
      const srcDir = posixDirname(c.path).replace(/\/+$/, '') || '/'
      const destPath = ap === '/' ? `/${posixBasename(c.path)}` : `${ap.replace(/\/+$/, '')}/${posixBasename(c.path)}`
      if (destPath === c.path) return false
      if (destDir === srcDir) return destPath !== c.path
      return true
    }
    return true
  })

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
    const items: ShellContextMenuItem[] = [
      {
        actionId: 'open',
        label: 'Open',
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
        action: () => {
          openNew(entry.path)
        },
      })
    }
    if (isFile) {
      items.push({
        actionId: 'open-external',
        label: 'Open with default application',
        action: () => {
          props.onOpenPathExternally(entry.path)
        },
      })
    }
    if (writable) {
      if (isFile) {
        items.push({
          actionId: 'fs-cut',
          label: 'Cut',
          action: () => {
            fileBrowserFsClipCut(entry.path)
          },
        })
        items.push({
          actionId: 'fs-copy',
          label: 'Copy',
          action: () => {
            fileBrowserFsClipCopy(entry.path)
          },
        })
      } else if (isDir) {
        items.push({
          actionId: 'fs-cut-dir',
          label: 'Cut',
          action: () => {
            fileBrowserFsClipCut(entry.path)
          },
        })
      }
      items.push({
        actionId: 'rename',
        label: 'Rename…',
        action: () => {
          setDialog({ kind: 'rename', path: entry.path, draft: posixBasename(entry.path) })
        },
      })
      items.push({
        actionId: 'delete',
        label: 'Delete…',
        action: () => {
          setDialog({
            kind: 'delete',
            path: entry.path,
            label: normalizeDisplayName(entry),
          })
        },
      })
    }
    items.push({
      actionId: 'copy-path',
      label: 'Copy path',
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
        action: () => {
          openNew(root.path)
        },
      })
    }
    items.push({
      actionId: 'copy-path',
      label: 'Copy path',
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

  async function runPasteFromClip() {
    const base = shellHttpBase()
    const ap = state.activePath
    const c = fileBrowserFsClipState()
    if (!ap || c.mode === 'none' || !c.path) return
    setOpError(null)
    try {
      const baseName = posixBasename(c.path)
      const destPath = ap === '/' ? `/${baseName}` : `${ap.replace(/\/+$/, '')}/${baseName}`
      if (c.mode === 'cut') {
        if (destPath === c.path) return
        await renameFileBrowserPath(c.path, destPath, base)
        fileBrowserFsClipClear()
      } else {
        const st = await statFileBrowserPath(c.path, base)
        if (st.entry.kind !== 'file') {
          throw new Error('Copying folders is not supported yet.')
        }
        const names = new Set(state.entries.map((e) => e.name))
        const destName = pickCopyDestName(c.path, names)
        await copyFileBrowserFile(c.path, ap, destName, base)
      }
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
        <div class="border-b border-(--shell-border) px-3 py-2 text-xs font-semibold tracking-[0.08em] text-(--shell-text-dim) uppercase">
          Places
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          <div class="flex flex-col gap-1">
            {state.roots.map((root) => (
              <button
                type="button"
                class="flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm hover:bg-(--shell-control-muted-hover)"
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
                <span class="min-w-0 truncate">{root.label}</span>
                <span class="shrink-0 text-[11px] uppercase text-(--shell-text-dim)">{root.kind}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>
      <section class="flex min-h-0 min-w-0 flex-1 flex-col">
        <div class="flex items-center gap-2 border-b border-(--shell-border) px-3 py-2">
          <button
            type="button"
            class="rounded border border-(--shell-border) px-2 py-1 text-xs hover:bg-(--shell-control-muted-hover) disabled:cursor-not-allowed disabled:opacity-50"
            data-file-browser-primary-action="up"
            aria-label="Go to parent folder"
            disabled={!state.parentPath}
            onClick={() => state.parentPath && void loadDirectory(state.parentPath)}
          >
            Up
          </button>
          <button
            type="button"
            class="rounded border border-(--shell-border) px-2 py-1 text-xs hover:bg-(--shell-control-muted-hover) disabled:cursor-not-allowed disabled:opacity-50"
            data-file-browser-primary-action="new-folder"
            aria-label="New folder"
            disabled={!state.activePath}
            onClick={() => setDialog({ kind: 'mkdir', draft: '' })}
          >
            New Folder
          </button>
          <button
            type="button"
            class="rounded border border-(--shell-border) px-2 py-1 text-xs hover:bg-(--shell-control-muted-hover) disabled:cursor-not-allowed disabled:opacity-50"
            data-file-browser-primary-action="new-file"
            aria-label="New file"
            disabled={!state.activePath}
            onClick={() => setDialog({ kind: 'touch', draft: '' })}
          >
            New File
          </button>
          <button
            type="button"
            class="rounded border border-(--shell-border) px-2 py-1 text-xs hover:bg-(--shell-control-muted-hover) disabled:cursor-not-allowed disabled:opacity-50"
            data-file-browser-primary-action="paste"
            aria-label="Paste"
            disabled={!canPasteHere()}
            onClick={() => void runPasteFromClip()}
          >
            Paste
          </button>
          <button
            type="button"
            class="rounded border border-(--shell-border) px-2 py-1 text-xs hover:bg-(--shell-control-muted-hover)"
            data-file-browser-primary-action="refresh"
            aria-label="Refresh file browser"
            onClick={() => void loadDirectory(state.activePath, true)}
          >
            Refresh
          </button>
          <button
            type="button"
            class="rounded border border-(--shell-border) px-2 py-1 text-xs hover:bg-(--shell-control-muted-hover)"
            data-file-browser-primary-action={state.showHidden ? 'hide-hidden' : 'show-hidden'}
            aria-label={state.showHidden ? 'Hide hidden files' : 'Show hidden files'}
            onClick={toggleHidden}
          >
            {state.showHidden ? 'Hide Hidden' : 'Show Hidden'}
          </button>
          <div class="min-w-0 flex-1" data-file-browser-active-path={state.activePath ?? ''}>
            <div class="flex min-w-0 flex-wrap items-center gap-1">
              {breadcrumbs().map((crumb, index) => (
                <>
                  {index > 0 ? <span class="text-(--shell-text-dim)">/</span> : null}
                  <button
                    type="button"
                    class="max-w-full truncate rounded px-1 py-0.5 text-sm hover:bg-(--shell-control-muted-hover)"
                    data-file-browser-breadcrumb
                    data-file-browser-path={crumb.path}
                    data-file-browser-label={crumb.label}
                    onClick={() => void loadDirectory(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                </>
              ))}
            </div>
          </div>
        </div>
        <Show when={opError()}>
          <div class="border-b border-(--shell-border) px-3 py-2 text-xs text-red-300">{opError()}</div>
        </Show>
        <div class="grid grid-cols-[minmax(0,1fr)_110px_160px_96px] gap-3 border-b border-(--shell-border) px-3 py-2 text-[11px] font-semibold tracking-[0.08em] text-(--shell-text-dim) uppercase">
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
                    class="grid cursor-default grid-cols-[minmax(0,1fr)_110px_160px_96px] gap-3 px-3 py-2 text-sm hover:bg-(--shell-control-muted-hover)"
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
                    <div class="min-w-0 truncate font-medium">{normalizeDisplayName(entry)}</div>
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
