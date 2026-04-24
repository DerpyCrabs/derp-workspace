import type { Accessor } from 'solid-js'
import { Show, createEffect, createMemo, onCleanup, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import Expand from 'lucide-solid/icons/expand'
import Shrink from 'lucide-solid/icons/shrink'
import { fileBrowserStreamUrl } from '@/apps/file-browser/fileBrowserBridge'
import { ViewerFileActions } from '@/apps/file-browser/ViewerFileActions'
import {
  sanitizePdfViewerWindowMemento,
  snapshotPdfViewerWindowMemento,
  type PdfViewerWindowMemento,
} from '@/apps/pdf-viewer/pdfViewerState'
import { shellHttpBase } from '@/features/bridge/shellHttp'
import {
  peekShellWindowState,
  primedShellWindowStateVersion,
  subscribeShellWindowState,
} from '@/features/shell-ui/shellWindowState'
import type { ShellCompositorWireSend } from '@/features/shell-ui/shellWireSendType'
import type { DerpWindow } from '@/host/appWindowState'

type PdfViewerWindowProps = {
  windowId: number
  compositorAppState: Accessor<unknown | null>
  shellWireSend: ShellCompositorWireSend
  windowModel: Accessor<DerpWindow | undefined>
  onOpenContainingFolder?: (path: string) => void
  onOpenExternalFile?: (path: string, context: { directory: string; showHidden: boolean }) => void
}

function initialStore(m: PdfViewerWindowMemento): PdfViewerWindowMemento {
  return { ...m }
}

export function PdfViewerWindow(props: PdfViewerWindowProps) {
  const primed = sanitizePdfViewerWindowMemento(peekShellWindowState(props.windowId))
  const [state, setState] = createStore<PdfViewerWindowMemento>(
    initialStore(
      primed ?? {
        viewingPath: '',
        directory: '',
        showHidden: false,
      },
    ),
  )

  let applyingFromCompositor = false
  let lastCompositorMementoJson = ''
  let lastAppliedRestoredStateVersion = 0
  let rootRef: HTMLDivElement | undefined

  function pushPdfViewerStateToCompositor() {
    if (applyingFromCompositor) return
    if (!state.viewingPath || !state.directory) return
    props.shellWireSend(
      'shell_hosted_window_state',
      JSON.stringify({
        window_id: props.windowId,
        kind: 'pdf_viewer',
        state: snapshotPdfViewerWindowMemento(state),
      }),
    )
  }

  function applyRestoredState(value: unknown) {
    const next = sanitizePdfViewerWindowMemento(value)
    if (!next) return
    setState('viewingPath', next.viewingPath)
    setState('directory', next.directory)
    setState('showHidden', next.showHidden)
  }

  function applyPrimedRestoredState() {
    const version = primedShellWindowStateVersion(props.windowId)
    if (!version || version === lastAppliedRestoredStateVersion) return
    lastAppliedRestoredStateVersion = version
    applyRestoredState(peekShellWindowState(props.windowId))
  }

  const fileName = createMemo(() => state.viewingPath.split(/[/\\]/).filter(Boolean).pop() ?? 'file')

  const pdfUrl = createMemo(() => {
    const path = state.viewingPath
    if (!path) return ''
    return fileBrowserStreamUrl(path, shellHttpBase())
  })

  function toggleWindowFullscreen() {
    const w = props.windowModel()
    if (!w || w.minimized) return
    props.shellWireSend('set_fullscreen', props.windowId, w.fullscreen ? 0 : 1)
  }

  onMount(() => {
    queueMicrotask(() => rootRef?.focus())
  })

  const unsubscribeShellWindowState = subscribeShellWindowState(() => {
    applyPrimedRestoredState()
  })
  onCleanup(unsubscribeShellWindowState)

  createEffect(() => {
    const raw = props.compositorAppState()
    void state.viewingPath
    void state.directory
    void state.showHidden
    if (raw == null || typeof raw !== 'object') return
    const next = sanitizePdfViewerWindowMemento(raw)
    if (!next) return
    const j = JSON.stringify(next)
    const local = JSON.stringify(snapshotPdfViewerWindowMemento(state))
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
    void state.viewingPath
    void state.directory
    void state.showHidden
    if (applyingFromCompositor) return
    if (!state.viewingPath || !state.directory) return
    pushPdfViewerStateToCompositor()
  })

  return (
    <div
      ref={(el) => {
        rootRef = el
      }}
      class="absolute inset-0 flex min-h-0 flex-col overflow-hidden bg-neutral-950 text-white"
      tabIndex={0}
      data-pdf-viewer-root
    >
      <div class="flex h-8 shrink-0 items-center justify-between border-b border-white/10 bg-black/50 px-2">
        <span class="min-w-0 flex-1 truncate px-1 text-xs text-white/90" data-pdf-viewer-title>
          {fileName()}
        </span>
        <div class="flex shrink-0 items-center gap-1">
          <ViewerFileActions
            path={state.viewingPath}
            directory={state.directory}
            showHidden={state.showHidden}
            onOpenContainingFolder={props.onOpenContainingFolder}
            onOpenExternalFile={props.onOpenExternalFile}
          />
        </div>
        <button
          type="button"
          title={props.windowModel()?.fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          class="inline-flex h-7 w-7 items-center justify-center rounded-md text-white hover:bg-white/10"
          onClick={() => toggleWindowFullscreen()}
        >
          {props.windowModel()?.fullscreen ? (
            <Shrink class="h-3.5 w-3.5" stroke-width={2} />
          ) : (
            <Expand class="h-3.5 w-3.5" stroke-width={2} />
          )}
        </button>
      </div>
      <Show
        when={pdfUrl()}
        fallback={
          <div class="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-white/80">
            No PDF selected.
          </div>
        }
      >
        {(url) => (
          <object
            data={url()}
            type="application/pdf"
            class="min-h-0 flex-1 bg-white"
            data-pdf-viewer-document
          >
            <iframe title={fileName()} src={url()} class="h-full w-full border-0 bg-white" data-pdf-viewer-frame />
          </object>
        )}
      </Show>
    </div>
  )
}
