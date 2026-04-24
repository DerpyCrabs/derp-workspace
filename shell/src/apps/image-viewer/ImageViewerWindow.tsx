import type { Accessor } from 'solid-js'
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import Expand from 'lucide-solid/icons/expand'
import RotateCw from 'lucide-solid/icons/rotate-cw'
import Shrink from 'lucide-solid/icons/shrink'
import ZoomIn from 'lucide-solid/icons/zoom-in'
import ZoomOut from 'lucide-solid/icons/zoom-out'
import { fileBrowserReadUrl, listFileBrowserDirectory } from '@/apps/file-browser/fileBrowserBridge'
import { ViewerFileActions } from '@/apps/file-browser/ViewerFileActions'
import { orderedImagePathsFromDirectoryEntries } from '@/apps/image-viewer/imageViewerCore'
import {
  sanitizeImageViewerWindowMemento,
  snapshotImageViewerWindowMemento,
  type ImageViewerWindowMemento,
} from '@/apps/image-viewer/imageViewerState'
import { shellHttpBase } from '@/features/bridge/shellHttp'
import {
  peekShellWindowState,
  primedShellWindowStateVersion,
  subscribeShellWindowState,
} from '@/features/shell-ui/shellWindowState'
import type { ShellCompositorWireSend } from '@/features/shell-ui/shellWireSendType'
import type { DerpWindow } from '@/host/appWindowState'
import type { JSX } from 'solid-js'

type ImageViewerWindowProps = {
  windowId: number
  compositorAppState: Accessor<unknown | null>
  shellWireSend: ShellCompositorWireSend
  windowModel: Accessor<DerpWindow | undefined>
  onOpenContainingFolder?: (path: string) => void
  onOpenExternalFile?: (path: string, context: { directory: string; showHidden: boolean }) => void
}

type ListStatus = 'loading' | 'ready' | 'error'

type ViewerStore = ImageViewerWindowMemento & {
  imagePaths: string[]
  listStatus: ListStatus
  errorMessage: string | null
}

function initialStore(m: ImageViewerWindowMemento): ViewerStore {
  return {
    ...m,
    imagePaths: [],
    listStatus: 'loading',
    errorMessage: null,
  }
}

export function ImageViewerWindow(props: ImageViewerWindowProps) {
  const primed = sanitizeImageViewerWindowMemento(peekShellWindowState(props.windowId))
  const [state, setState] = createStore<ViewerStore>(
    initialStore(
      primed ?? {
        viewingPath: '',
        directory: '',
        showHidden: false,
      },
    ),
  )

  const [zoom, setZoom] = createSignal<number | 'fit'>('fit')
  const [rotationDeg, setRotationDeg] = createSignal(0)

  let applyingFromCompositor = false
  let lastCompositorMementoJson = ''
  let lastAppliedRestoredStateVersion = 0
  let rootRef: HTMLDivElement | undefined
  let listRequestSeq = 0

  function pushImageViewerStateToCompositor() {
    if (applyingFromCompositor) return
    if (!state.viewingPath || !state.directory) return
    props.shellWireSend(
      'shell_hosted_window_state',
      JSON.stringify({
        window_id: props.windowId,
        kind: 'image_viewer',
        state: snapshotImageViewerWindowMemento(state),
      }),
    )
  }

  function applyRestoredState(value: unknown) {
    const next = sanitizeImageViewerWindowMemento(value)
    if (!next) return
    setState('viewingPath', next.viewingPath)
    setState('directory', next.directory)
    setState('showHidden', next.showHidden)
    listRequestSeq += 1
    void runListLoad(next.directory, next.showHidden, listRequestSeq)
  }

  function applyPrimedRestoredState() {
    const version = primedShellWindowStateVersion(props.windowId)
    if (!version || version === lastAppliedRestoredStateVersion) return
    lastAppliedRestoredStateVersion = version
    applyRestoredState(peekShellWindowState(props.windowId))
  }

  async function runListLoad(dir: string, showHidden: boolean, runId: number) {
    if (!dir) {
      setState('imagePaths', [])
      setState('listStatus', 'ready')
      setState('errorMessage', null)
      return
    }
    setState('listStatus', 'loading')
    setState('errorMessage', null)
    const base = shellHttpBase()
    try {
      const listing = await listFileBrowserDirectory(dir, showHidden, base)
      if (runId !== listRequestSeq) return
      const paths = orderedImagePathsFromDirectoryEntries(listing.entries)
      setState('imagePaths', paths)
      setState('listStatus', 'ready')
    } catch (error) {
      if (runId !== listRequestSeq) return
      setState('imagePaths', [])
      setState('listStatus', 'error')
      setState('errorMessage', error instanceof Error ? error.message : String(error))
    }
  }

  const fileName = createMemo(() => state.viewingPath.split(/[/\\]/).filter(Boolean).pop() ?? 'file')

  const mediaUrl = createMemo(() => {
    const path = state.viewingPath
    if (!path) return ''
    return fileBrowserReadUrl(path, shellHttpBase())
  })

  const currentImageIndex = createMemo(() => state.imagePaths.findIndex((p) => p === state.viewingPath))
  const currentImageNumber = createMemo(() =>
    currentImageIndex() !== -1 ? currentImageIndex() + 1 : state.imagePaths.length > 0 ? 1 : 0,
  )
  const totalImages = createMemo(() => state.imagePaths.length)

  function goNextImage() {
    const list = state.imagePaths
    const vp = state.viewingPath
    if (!vp || list.length === 0) return
    const i = list.findIndex((p) => p === vp)
    if (i === -1 || i === list.length - 1) return
    const nextFile = list[i + 1]
    if (nextFile) setState('viewingPath', nextFile)
  }

  function goPrevImage() {
    const list = state.imagePaths
    const vp = state.viewingPath
    if (!vp || list.length === 0) return
    const i = list.findIndex((p) => p === vp)
    if (i === -1 || i === 0) return
    const prevFile = list[i - 1]
    if (prevFile) setState('viewingPath', prevFile)
  }

  createEffect(() => {
    state.viewingPath
    setZoom('fit')
    setRotationDeg(0)
  })

  function toggleWindowFullscreen() {
    const w = props.windowModel()
    if (!w || w.minimized) return
    props.shellWireSend('set_fullscreen', props.windowId, w.fullscreen ? 0 : 1)
  }

  createEffect(() => {
    void state.viewingPath
    if (!state.viewingPath) return
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest?.('input, textarea, select, [contenteditable="true"]') != null) {
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrevImage()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNextImage()
      }
    }
    window.addEventListener('keydown', handler)
    onCleanup(() => window.removeEventListener('keydown', handler))
  })

  const imgStyle = createMemo((): JSX.CSSProperties => {
    const z = zoom()
    const base: JSX.CSSProperties =
      z === 'fit'
        ? {
            width: '100%',
            height: '100%',
            'object-fit': 'contain',
          }
        : {
            'max-width': '100%',
            'max-height': '100%',
            width: 'auto',
            height: 'auto',
            'object-fit': 'none',
          }
    const scale = z === 'fit' ? 1 : z / 100
    return {
      ...base,
      transform: `scale(${scale}) rotate(${rotationDeg()}deg)`,
    }
  })

  onMount(() => {
    queueMicrotask(() => rootRef?.focus())
  })

  const unsubscribeShellWindowState = subscribeShellWindowState(() => {
    applyPrimedRestoredState()
  })
  onCleanup(unsubscribeShellWindowState)

  createEffect(() => {
    const dir = state.directory
    const hidden = state.showHidden
    listRequestSeq += 1
    void runListLoad(dir, hidden, listRequestSeq)
  })

  createEffect(() => {
    const raw = props.compositorAppState()
    void state.viewingPath
    void state.directory
    void state.showHidden
    void state.listStatus
    if ((state.listStatus !== 'ready' && state.listStatus !== 'loading') || raw == null || typeof raw !== 'object')
      return
    const next = sanitizeImageViewerWindowMemento(raw)
    if (!next) return
    const j = JSON.stringify(next)
    const local = JSON.stringify(snapshotImageViewerWindowMemento(state))
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
    void state.listStatus
    if (state.listStatus !== 'ready' || applyingFromCompositor) return
    if (!state.viewingPath || !state.directory) return
    pushImageViewerStateToCompositor()
  })

  return (
    <div
      ref={(el) => {
        rootRef = el
      }}
      class="absolute inset-0 flex min-h-0 flex-col overflow-hidden bg-black"
      tabIndex={0}
      data-image-viewer-root
    >
      <Show when={state.viewingPath && state.listStatus !== 'error'}>
        <div class="flex h-full min-h-0 flex-col bg-black">
          <div class="flex h-8 shrink-0 items-center justify-between border-b border-white/10 bg-black/50 px-2">
            <Show when={totalImages() > 0}>
              <span
                class="text-xs text-white/90"
                data-image-viewer-counter
              >{`${currentImageNumber()} of ${totalImages()}`}</span>
            </Show>
            <div class="flex flex-1 items-center justify-end gap-1">
              <button
                type="button"
                class="inline-flex h-7 w-7 items-center justify-center rounded-md text-white hover:bg-white/10"
                onClick={() =>
                  setZoom((prev) => {
                    const cur = prev === 'fit' ? 100 : prev
                    return Math.max(cur - 25, 25)
                  })
                }
              >
                <ZoomOut class="h-3.5 w-3.5" stroke-width={2} />
              </button>
              <button
                type="button"
                class="min-w-12 rounded px-1 text-center text-xs text-white/80 hover:bg-white/10 hover:text-white/90"
                title="Fit to screen"
                data-image-viewer-fit
                onClick={() => {
                  setZoom('fit')
                  setRotationDeg(0)
                }}
              >
                {zoom() === 'fit' ? 'Fit' : `${zoom()}%`}
              </button>
              <button
                type="button"
                class="inline-flex h-7 w-7 items-center justify-center rounded-md text-white hover:bg-white/10"
                onClick={() =>
                  setZoom((prev) => {
                    const cur = prev === 'fit' ? 100 : prev
                    return Math.min(cur + 25, 400)
                  })
                }
              >
                <ZoomIn class="h-3.5 w-3.5" stroke-width={2} />
              </button>
              <button
                type="button"
                class="inline-flex h-7 w-7 items-center justify-center rounded-md text-white hover:bg-white/10"
                title="Rotate clockwise"
                onClick={() => setRotationDeg((prev) => (prev + 90) % 360)}
                data-image-viewer-rotate
              >
                <RotateCw class="h-3.5 w-3.5" stroke-width={2} />
              </button>
              <ViewerFileActions
                path={state.viewingPath}
                directory={state.directory}
                showHidden={state.showHidden}
                onOpenContainingFolder={props.onOpenContainingFolder}
                onOpenExternalFile={props.onOpenExternalFile}
              />
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
          </div>
          <div class="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-2">
            <button
              type="button"
              class="absolute top-0 bottom-0 left-0 z-10 w-[30%] cursor-pointer"
              onClick={goPrevImage}
              aria-label="Previous image"
            />
            <button
              type="button"
              class="absolute top-0 right-0 bottom-0 z-10 w-[30%] cursor-pointer"
              onClick={goNextImage}
              aria-label="Next image"
            />
            <img
              src={mediaUrl()}
              alt={fileName()}
              class="pointer-events-none max-h-full transition-transform duration-200"
              style={imgStyle()}
              data-image-viewer-img
            />
          </div>
        </div>
      </Show>
      <Show when={state.listStatus === 'error'}>
        <div class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-sm text-white/80">
          <p>{state.errorMessage ?? 'Failed to load directory.'}</p>
        </div>
      </Show>
    </div>
  )
}
