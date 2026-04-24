import type { Accessor } from 'solid-js'
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import ChevronLeft from 'lucide-solid/icons/chevron-left'
import ChevronRight from 'lucide-solid/icons/chevron-right'
import Expand from 'lucide-solid/icons/expand'
import Pause from 'lucide-solid/icons/pause'
import Play from 'lucide-solid/icons/play'
import Shrink from 'lucide-solid/icons/shrink'
import { fileBrowserStreamUrl, listFileBrowserDirectory } from '@/apps/file-browser/fileBrowserBridge'
import { ViewerFileActions } from '@/apps/file-browser/ViewerFileActions'
import { orderedVideoPathsFromDirectoryEntries } from '@/apps/video-viewer/videoViewerCore'
import {
  sanitizeVideoViewerWindowMemento,
  snapshotVideoViewerWindowMemento,
  type VideoViewerWindowMemento,
} from '@/apps/video-viewer/videoViewerState'
import { shellHttpBase } from '@/features/bridge/shellHttp'
import {
  peekShellWindowState,
  primedShellWindowStateVersion,
  subscribeShellWindowState,
} from '@/features/shell-ui/shellWindowState'
import type { ShellCompositorWireSend } from '@/features/shell-ui/shellWireSendType'
import type { DerpWindow } from '@/host/appWindowState'

type VideoViewerWindowProps = {
  windowId: number
  compositorAppState: Accessor<unknown | null>
  shellWireSend: ShellCompositorWireSend
  windowModel: Accessor<DerpWindow | undefined>
  onOpenContainingFolder?: (path: string) => void
  onOpenExternalFile?: (path: string, context: { directory: string; showHidden: boolean }) => void
}

type ListStatus = 'loading' | 'ready' | 'error'

type ViewerStore = VideoViewerWindowMemento & {
  videoPaths: string[]
  listStatus: ListStatus
  errorMessage: string | null
}

function initialStore(m: VideoViewerWindowMemento): ViewerStore {
  return {
    ...m,
    videoPaths: [],
    listStatus: 'loading',
    errorMessage: null,
  }
}

const PERSIST_TIME_MS = 2500

export function VideoViewerWindow(props: VideoViewerWindowProps) {
  const primed = sanitizeVideoViewerWindowMemento(peekShellWindowState(props.windowId))
  const [state, setState] = createStore<ViewerStore>(
    initialStore(
      primed ?? {
        viewingPath: '',
        directory: '',
        showHidden: false,
        playbackTime: 0,
        volume: 1,
      },
    ),
  )

  const [displayTime, setDisplayTime] = createSignal(0)
  const [duration, setDuration] = createSignal(0)
  const [playing, setPlaying] = createSignal(false)
  const [videoHost, setVideoHost] = createSignal<HTMLVideoElement | undefined>()

  let applyingFromCompositor = false
  let lastCompositorMementoJson = ''
  let lastAppliedRestoredStateVersion = 0
  let rootRef: HTMLDivElement | undefined
  let listRequestSeq = 0
  let lastPersistWallMs = 0
  let resumePending = true

  function pushVideoViewerStateToCompositor() {
    if (applyingFromCompositor) return
    if (!state.viewingPath || !state.directory) return
    props.shellWireSend(
      'shell_hosted_window_state',
      JSON.stringify({
        window_id: props.windowId,
        kind: 'video_viewer',
        state: snapshotVideoViewerWindowMemento(state),
      }),
    )
  }

  function applyRestoredState(value: unknown) {
    const next = sanitizeVideoViewerWindowMemento(value)
    if (!next) return
    setState('viewingPath', next.viewingPath)
    setState('directory', next.directory)
    setState('showHidden', next.showHidden)
    setState('playbackTime', next.playbackTime)
    setState('volume', next.volume)
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
      setState('videoPaths', [])
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
      const paths = orderedVideoPathsFromDirectoryEntries(listing.entries)
      setState('videoPaths', paths)
      setState('listStatus', 'ready')
    } catch (error) {
      if (runId !== listRequestSeq) return
      setState('videoPaths', [])
      setState('listStatus', 'error')
      setState('errorMessage', error instanceof Error ? error.message : String(error))
    }
  }

  const fileName = createMemo(() => state.viewingPath.split(/[/\\]/).filter(Boolean).pop() ?? 'file')

  const mediaUrl = createMemo(() => {
    const path = state.viewingPath
    if (!path) return ''
    return fileBrowserStreamUrl(path, shellHttpBase())
  })

  const currentVideoIndex = createMemo(() => state.videoPaths.findIndex((p) => p === state.viewingPath))
  const currentVideoNumber = createMemo(() =>
    currentVideoIndex() !== -1 ? currentVideoIndex() + 1 : state.videoPaths.length > 0 ? 1 : 0,
  )
  const totalVideos = createMemo(() => state.videoPaths.length)

  function goNextVideo() {
    const list = state.videoPaths
    const vp = state.viewingPath
    if (!vp || list.length === 0) return
    const i = list.findIndex((p) => p === vp)
    if (i === -1 || i === list.length - 1) return
    const nextFile = list[i + 1]
    if (nextFile) {
      setState('playbackTime', 0)
      setState('viewingPath', nextFile)
    }
  }

  function goPrevVideo() {
    const list = state.videoPaths
    const vp = state.viewingPath
    if (!vp || list.length === 0) return
    const i = list.findIndex((p) => p === vp)
    if (i === -1 || i === 0) return
    const prevFile = list[i - 1]
    if (prevFile) {
      setState('playbackTime', 0)
      setState('viewingPath', prevFile)
    }
  }

  function toggleWindowFullscreen() {
    const w = props.windowModel()
    if (!w || w.minimized) return
    props.shellWireSend('set_fullscreen', props.windowId, w.fullscreen ? 0 : 1)
  }

  function togglePlay() {
    const v = videoHost()
    if (!v) return
    if (v.paused) {
      void v.play().catch(() => {})
    } else {
      v.pause()
    }
  }

  function onSeekInput(e: Event & { currentTarget: HTMLInputElement }) {
    const v = videoHost()
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return
    const t = (parseFloat(e.currentTarget.value) / 1000) * v.duration
    if (Number.isFinite(t)) {
      v.currentTime = t
      setDisplayTime(t)
      setState('playbackTime', t)
      pushVideoViewerStateToCompositor()
    }
  }

  function onVolumeInput(e: Event & { currentTarget: HTMLInputElement }) {
    const v = videoHost()
    const vol = parseFloat(e.currentTarget.value)
    if (!Number.isFinite(vol) || vol < 0 || vol > 1) return
    setState('volume', vol)
    if (v) v.volume = vol
    pushVideoViewerStateToCompositor()
  }

  createEffect(() => {
    const v = state.volume
    const el = videoHost()
    if (el) el.volume = v
  })

  createEffect(() => {
    void state.viewingPath
    void mediaUrl()
    resumePending = true
  })

  createEffect(() => {
    const path = state.viewingPath
    const url = mediaUrl()
    const vid = videoHost()
    if (!path || !url || !vid) return
    const targetHref = new URL(url, window.location.origin).href
    if (vid.src !== targetHref) {
      vid.pause()
      vid.src = targetHref
      vid.load()
    }
  })

  createEffect(() => {
    const el = videoHost()
    if (!el) return
    const onLoaded = () => {
      setDuration(Number.isFinite(el.duration) ? el.duration : 0)
      el.volume = state.volume
      if (resumePending) {
        resumePending = false
        const t = state.playbackTime
        if (t > 0 && Number.isFinite(t)) {
          try {
            el.currentTime = t
          } catch {}
        }
        setDisplayTime(el.currentTime)
      }
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => {
      setPlaying(false)
      setState('playbackTime', el.currentTime)
      pushVideoViewerStateToCompositor()
    }
    const onTimeupdate = () => {
      setDisplayTime(el.currentTime)
      setState('playbackTime', el.currentTime)
      const now = performance.now()
      if (now - lastPersistWallMs >= PERSIST_TIME_MS) {
        lastPersistWallMs = now
        pushVideoViewerStateToCompositor()
      }
    }
    const onSeeked = () => {
      setState('playbackTime', el.currentTime)
      pushVideoViewerStateToCompositor()
    }
    const onEnded = () => {
      setState('playbackTime', 0)
      pushVideoViewerStateToCompositor()
    }
    el.addEventListener('loadedmetadata', onLoaded)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('timeupdate', onTimeupdate)
    el.addEventListener('seeked', onSeeked)
    el.addEventListener('ended', onEnded)
    onCleanup(() => {
      el.removeEventListener('loadedmetadata', onLoaded)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('timeupdate', onTimeupdate)
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('ended', onEnded)
    })
  })

  createEffect(() => {
    void state.viewingPath
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest?.('input, textarea, select, [contenteditable="true"]') != null) {
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrevVideo()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNextVideo()
      } else if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      }
    }
    window.addEventListener('keydown', handler)
    onCleanup(() => window.removeEventListener('keydown', handler))
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
    void state.playbackTime
    void state.volume
    void state.listStatus
    if ((state.listStatus !== 'ready' && state.listStatus !== 'loading') || raw == null || typeof raw !== 'object')
      return
    const next = sanitizeVideoViewerWindowMemento(raw)
    if (!next) return
    const j = JSON.stringify(next)
    const local = JSON.stringify(snapshotVideoViewerWindowMemento(state))
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
    void state.playbackTime
    void state.volume
    void state.listStatus
    if (state.listStatus !== 'ready' || applyingFromCompositor) return
    if (!state.viewingPath || !state.directory) return
    pushVideoViewerStateToCompositor()
  })

  const seekValue = createMemo(() => {
    const d = duration()
    if (!Number.isFinite(d) || d <= 0) return 0
    return Math.round((displayTime() / d) * 1000)
  })

  return (
    <div
      ref={(el) => {
        rootRef = el
      }}
      class="absolute inset-0 flex min-h-0 flex-col overflow-hidden bg-black"
      tabIndex={0}
      data-video-viewer-root
    >
      <Show when={state.viewingPath && state.listStatus !== 'error'}>
        <div class="flex h-full min-h-0 flex-col bg-black">
          <div class="flex h-8 shrink-0 items-center justify-between border-b border-white/10 bg-black/50 px-2">
            <span class="min-w-0 flex-1 truncate px-1 text-xs text-white/90">{fileName()}</span>
            <Show when={totalVideos() > 0}>
              <span
                class="mr-2 shrink-0 text-xs text-white/70"
                data-video-viewer-counter
              >{`${currentVideoNumber()} of ${totalVideos()}`}</span>
            </Show>
            <div class="flex shrink-0 items-center gap-1">
              <button
                type="button"
                class="inline-flex h-7 w-7 items-center justify-center rounded-md text-white hover:bg-white/10"
                onClick={() => goPrevVideo()}
              >
                <ChevronLeft class="h-4 w-4" stroke-width={2} />
              </button>
              <button
                type="button"
                class="inline-flex h-7 w-7 items-center justify-center rounded-md text-white hover:bg-white/10"
                onClick={() => goNextVideo()}
              >
                <ChevronRight class="h-4 w-4" stroke-width={2} />
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
          <div class="relative flex min-h-0 flex-1 flex-col items-stretch justify-center">
            <video
              ref={(el) => {
                setVideoHost(el ?? undefined)
              }}
              class="max-h-full w-full flex-1 bg-black object-contain"
              controls={false}
              preload="metadata"
              playsinline
              data-video-viewer-element
            />
            <div class="flex shrink-0 flex-col gap-1 border-t border-white/10 bg-black/80 px-2 py-2">
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-white hover:bg-white/10"
                  onClick={() => togglePlay()}
                  data-video-viewer-play-toggle
                >
                  {playing() ? (
                    <Pause class="h-4 w-4" stroke-width={2} />
                  ) : (
                    <Play class="h-4 w-4" stroke-width={2} />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1000}
                  value={seekValue()}
                  class="h-2 min-w-0 flex-1 cursor-pointer accent-white"
                  onInput={onSeekInput}
                  data-video-viewer-seek
                />
              </div>
              <div class="flex items-center gap-2">
                <span class="w-10 shrink-0 text-xs text-white/70">Vol</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={state.volume}
                  class="h-2 min-w-0 flex-1 cursor-pointer accent-white"
                  onInput={onVolumeInput}
                  data-video-viewer-volume
                />
              </div>
            </div>
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
