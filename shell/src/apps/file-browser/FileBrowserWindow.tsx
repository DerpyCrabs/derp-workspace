import type { Accessor } from 'solid-js'
import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import {
  listFileBrowserDirectory,
  listFileBrowserRoots,
  type FileBrowserEntry,
  type FileBrowserRoot,
} from './fileBrowserBridge'
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

export function FileBrowserWindow(props: FileBrowserWindowProps) {
  const initialPrefs = loadFileBrowserPrefs()
  const [state, setState] = createStore(
    createInitialFileBrowserWindowState(
      sanitizeFileBrowserWindowMemento(peekShellWindowState(props.windowId))?.showHidden ?? initialPrefs.showHidden,
    ),
  )
  const [busy, setBusy] = createSignal(false)
  let requestSeq = 0
  let lastAppliedRestoredStateVersion = 0
  let applyingFromCompositor = false
  let lastCompositorMementoJson = ''
  let rootRef: HTMLDivElement | undefined

  const [ctxMenu, setCtxMenu] = createSignal<{ x: number; y: number; items: ShellContextMenuItem[] } | null>(null)

  const breadcrumbs = createMemo(() => buildBreadcrumbs(state.activePath, state.roots))
  const selectedEntry = createMemo(
    () => state.entries.find((entry) => entry.path === state.selectedPath) ?? null,
  )

  async function loadDirectory(targetPath?: string | null, forceRoots = false, showHiddenOverride?: boolean) {
    const base = shellHttpBase()
    const runId = ++requestSeq
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

  function closeCtxMenu() {
    setCtxMenu(null)
  }

  function entryContextItems(entry: FileBrowserEntry): ShellContextMenuItem[] {
    const clip = clipboardCanWritePath()
    const items: ShellContextMenuItem[] = [
      {
        actionId: 'open',
        label: 'Open',
        action: () => {
          openEntry(entry)
        },
      },
    ]
    if (fileBrowserEntryIsDirectory(entry) && props.onOpenInNewWindow) {
      const openNew = props.onOpenInNewWindow
      items.push({
        actionId: 'open-new',
        label: 'Open in new window',
        action: () => {
          openNew(entry.path)
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
    setFileBrowserShowHidden(nextState.showHidden)
    setState('showHidden', nextState.showHidden)
    setState('selectedPath', nextState.selectedPath)
    if (nextState.activePath || nextState.showHidden !== state.showHidden) {
      void loadDirectory(nextState.activePath ?? state.activePath, true, nextState.showHidden)
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
    const local = JSON.stringify(snapshotFileBrowserWindowMemento(state))
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

  return (
    <div
      ref={(el) => {
        rootRef = el
      }}
      class="flex h-full min-h-0 min-w-0 bg-(--shell-surface-inset) text-(--shell-text)"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return
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
        <div class="grid grid-cols-[minmax(0,1fr)_110px_160px_96px] gap-3 border-b border-(--shell-border) px-3 py-2 text-[11px] font-semibold tracking-[0.08em] text-(--shell-text-dim) uppercase">
          <div>Name</div>
          <div>Kind</div>
          <div>Modified</div>
          <div>Size</div>
        </div>
        <div class="min-h-0 flex-1 overflow-auto">
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
                    }}
                    role="row"
                    aria-selected={selected() ? 'true' : undefined}
                    data-file-browser-row
                    data-file-browser-path={entry.path}
                    data-file-browser-name={normalizeDisplayName(entry)}
                    data-file-browser-kind={entry.kind}
                    data-file-browser-selected={selected() ? 'true' : 'false'}
                    onClick={() => clickEntry(entry)}
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
    </div>
  )
}
