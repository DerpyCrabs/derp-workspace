import {
  buildBackedWindowOpenPayload,
  buildFileBrowserWindowOpenPayload,
  buildImageViewerWindowOpenPayload,
  buildPdfViewerWindowOpenPayload,
  buildShellTestWindowOpenPayload,
  buildTextEditorWindowOpenPayload,
  buildVideoViewerWindowOpenPayload,
  fileBrowserWindowId,
  fileBrowserWindowTitle,
  imageViewerWindowId,
  imageViewerWindowTitle,
  isFileBrowserWindowId,
  isImageViewerWindowId,
  isPdfViewerWindowId,
  isShellTestWindowId,
  isTextEditorWindowId,
  isVideoViewerWindowId,
  pdfViewerWindowId,
  pdfViewerWindowTitle,
  shellTestWindowId,
  shellTestWindowTitle,
  textEditorWindowId,
  textEditorWindowTitle,
  videoViewerWindowId,
  videoViewerWindowTitle,
  SHELL_UI_FILE_BROWSER_APP_ID,
  SHELL_UI_IMAGE_VIEWER_APP_ID,
  SHELL_UI_PDF_VIEWER_APP_ID,
  SHELL_UI_TEST_APP_ID,
  SHELL_UI_TEXT_EDITOR_APP_ID,
  SHELL_UI_VIDEO_VIEWER_APP_ID,
  type BackedShellWindowKind,
  type BackedWindowOpenPayload,
} from '@/features/shell-ui/backedShellWindows'
import { loadFileBrowserPrefs } from '@/apps/file-browser/fileBrowserPrefs'
import { primeFileBrowserWindowPath } from '@/apps/file-browser/fileBrowserState'
import { primeShellWindowState } from '@/features/shell-ui/shellWindowState'
import { SHELL_WINDOW_FLAG_SHELL_HOSTED } from '@/features/shell-ui/shellUiWindows'
import { screensListForLayout } from '@/host/appLayout'
import type { DerpWindow } from '@/host/appWindowState'
import type { LayoutScreen } from '@/host/types'
import { monitorWorkAreaGlobal } from '@/features/tiling/tileSnap'

type BackedShellWindowActionsOptions = {
  getWindows: () => DerpWindow[]
  getScreenDraftRows: () => LayoutScreen[]
  getOutputGeom: () => { w: number; h: number } | null
  getLayoutCanvasOrigin: () => { x: number; y: number } | null
  getPrimaryMonitorName: () => string
  getHostedWindowSpawnMonitorName?: () => string | null
  reserveTaskbarForMon: (screen: ReturnType<typeof screensListForLayout>[number]) => boolean
  sendHostedWindowOpen: (payload: BackedWindowOpenPayload) => boolean
}

function hostedWindowStaggerIndex(
  windows: readonly DerpWindow[],
  monitorName: string,
): number {
  return windows.filter(
    (window) =>
      window.output_name === monitorName &&
      !window.minimized &&
      (window.shell_flags & SHELL_WINDOW_FLAG_SHELL_HOSTED) !== 0,
  ).length
}

function nextWindowId(
  windows: readonly DerpWindow[],
  pendingIds: Iterable<number>,
  reservedIds: Iterable<number>,
  isWindowId: (windowId: number) => boolean,
  appId: string,
  makeWindowId: (instance: number) => number,
): number | null {
  const used = new Set<number>()
  for (const id of pendingIds) used.add(id)
  for (const id of reservedIds) used.add(id)
  for (const window of windows) {
    if (isWindowId(window.window_id) || window.app_id === appId) used.add(window.window_id)
  }
  for (let instance = 0; instance <= 99; instance += 1) {
    const windowId = makeWindowId(instance)
    if (!used.has(windowId)) return windowId
  }
  return null
}

export function createBackedShellWindowActions(options: BackedShellWindowActionsOptions) {
  const pendingBackedWindowOpens = new Map<number, BackedWindowOpenPayload>()
  const reservedBackedWindowIds = new Set<number>()
  let backedWindowOpenRaf = 0

  const pruneReservedBackedWindowIds = () => {
    const ids = new Set(options.getWindows().map((w) => w.window_id))
    for (const id of [...reservedBackedWindowIds]) {
      if (ids.has(id)) reservedBackedWindowIds.delete(id)
    }
  }

  const resolveMonitorContext = () => {
    const screens = screensListForLayout(
      options.getScreenDraftRows(),
      options.getOutputGeom(),
      options.getLayoutCanvasOrigin(),
    )
    const origin = options.getLayoutCanvasOrigin()
    const primaryMonitorName = options.getPrimaryMonitorName()
    const hint = options.getHostedWindowSpawnMonitorName?.() ?? null
    const monitor =
      (hint ? screens.find((screen) => screen.name === hint) : undefined) ??
      screens.find((screen) => screen.name === primaryMonitorName) ??
      screens[0] ??
      null
    if (!monitor) return null
    const reserveTaskbar = options.reserveTaskbarForMon(monitor)
    return {
      origin,
      monitor,
      work: monitorWorkAreaGlobal(monitor, reserveTaskbar),
      staggerIndex: hostedWindowStaggerIndex(options.getWindows(), monitor.name),
    }
  }

  const flushPendingBackedWindowOpens = () => {
    if (backedWindowOpenRaf !== 0) return
    const trySend = () => {
      backedWindowOpenRaf = 0
      for (const [windowId, payload] of pendingBackedWindowOpens) {
        if (options.sendHostedWindowOpen(payload)) {
          pendingBackedWindowOpens.delete(windowId)
        }
      }
      if (pendingBackedWindowOpens.size > 0) {
        backedWindowOpenRaf = requestAnimationFrame(trySend)
      }
    }
    trySend()
  }

  const queueBackedWindowOpen = (payload: BackedWindowOpenPayload) => {
    pendingBackedWindowOpens.set(payload.window_id, payload)
    flushPendingBackedWindowOpens()
  }

  const openBackedShellWindow = (kind: 'debug' | 'settings') => {
    const context = resolveMonitorContext()
    if (!context) return
    queueBackedWindowOpen(
      buildBackedWindowOpenPayload(
        context.monitor.name,
        context.work,
        kind,
        context.origin,
        context.staggerIndex,
      ),
    )
  }

  const openDebugShellWindow = () => {
    openBackedShellWindow('debug')
  }

  const openSettingsShellWindow = () => {
    openBackedShellWindow('settings')
  }

  const openShellTestWindow = () => {
    const context = resolveMonitorContext()
    if (!context) return false
    pruneReservedBackedWindowIds()
    const windowId = nextWindowId(
      options.getWindows(),
      pendingBackedWindowOpens.keys(),
      reservedBackedWindowIds,
      isShellTestWindowId,
      SHELL_UI_TEST_APP_ID,
      shellTestWindowId,
    )
    if (windowId === null) return false
    reservedBackedWindowIds.add(windowId)
    const title = shellTestWindowTitle(windowId - shellTestWindowId(0))
    queueBackedWindowOpen(
      buildShellTestWindowOpenPayload(
        context.monitor.name,
        context.work,
        windowId,
        title,
        context.origin,
        context.staggerIndex,
      ),
    )
    return true
  }

  const openImageViewerWindow = (detail: { path: string; directory: string; showHidden: boolean }) => {
    const context = resolveMonitorContext()
    if (!context) return false
    pruneReservedBackedWindowIds()
    const windowId = nextWindowId(
      options.getWindows(),
      pendingBackedWindowOpens.keys(),
      reservedBackedWindowIds,
      isImageViewerWindowId,
      SHELL_UI_IMAGE_VIEWER_APP_ID,
      imageViewerWindowId,
    )
    if (windowId === null) return false
    reservedBackedWindowIds.add(windowId)
    const baseTitle = detail.path.split('/').filter(Boolean).pop() ?? imageViewerWindowTitle(0)
    const title = baseTitle.length > 0 ? baseTitle : imageViewerWindowTitle(windowId - imageViewerWindowId(0))
    primeShellWindowState(windowId, {
      viewingPath: detail.path,
      directory: detail.directory,
      showHidden: detail.showHidden,
    })
    queueBackedWindowOpen(
      buildImageViewerWindowOpenPayload(
        context.monitor.name,
        context.work,
        windowId,
        title,
        context.origin,
        context.staggerIndex,
      ),
    )
    return true
  }

  const openVideoViewerWindow = (detail: { path: string; directory: string; showHidden: boolean }) => {
    const context = resolveMonitorContext()
    if (!context) return false
    pruneReservedBackedWindowIds()
    const windowId = nextWindowId(
      options.getWindows(),
      pendingBackedWindowOpens.keys(),
      reservedBackedWindowIds,
      isVideoViewerWindowId,
      SHELL_UI_VIDEO_VIEWER_APP_ID,
      videoViewerWindowId,
    )
    if (windowId === null) return false
    reservedBackedWindowIds.add(windowId)
    const baseTitle = detail.path.split('/').filter(Boolean).pop() ?? videoViewerWindowTitle(0)
    const title = baseTitle.length > 0 ? baseTitle : videoViewerWindowTitle(windowId - videoViewerWindowId(0))
    primeShellWindowState(windowId, {
      viewingPath: detail.path,
      directory: detail.directory,
      showHidden: detail.showHidden,
      playbackTime: 0,
      volume: 1,
    })
    queueBackedWindowOpen(
      buildVideoViewerWindowOpenPayload(
        context.monitor.name,
        context.work,
        windowId,
        title,
        context.origin,
        context.staggerIndex,
      ),
    )
    return true
  }

  const openTextEditorWindow = (detail: { path: string; directory: string; showHidden: boolean }) => {
    const context = resolveMonitorContext()
    if (!context) return false
    pruneReservedBackedWindowIds()
    const windowId = nextWindowId(
      options.getWindows(),
      pendingBackedWindowOpens.keys(),
      reservedBackedWindowIds,
      isTextEditorWindowId,
      SHELL_UI_TEXT_EDITOR_APP_ID,
      textEditorWindowId,
    )
    if (windowId === null) return false
    reservedBackedWindowIds.add(windowId)
    const baseTitle = detail.path.split('/').filter(Boolean).pop() ?? textEditorWindowTitle(0)
    const title = baseTitle.length > 0 ? baseTitle : textEditorWindowTitle(windowId - textEditorWindowId(0))
    primeShellWindowState(windowId, {
      viewingPath: detail.path,
      directory: detail.directory,
      showHidden: detail.showHidden,
    })
    queueBackedWindowOpen(
      buildTextEditorWindowOpenPayload(
        context.monitor.name,
        context.work,
        windowId,
        title,
        context.origin,
        context.staggerIndex,
      ),
    )
    return true
  }

  const openPdfViewerWindow = (detail: { path: string; directory: string; showHidden: boolean }) => {
    const context = resolveMonitorContext()
    if (!context) return false
    pruneReservedBackedWindowIds()
    const windowId = nextWindowId(
      options.getWindows(),
      pendingBackedWindowOpens.keys(),
      reservedBackedWindowIds,
      isPdfViewerWindowId,
      SHELL_UI_PDF_VIEWER_APP_ID,
      pdfViewerWindowId,
    )
    if (windowId === null) return false
    reservedBackedWindowIds.add(windowId)
    const baseTitle = detail.path.split('/').filter(Boolean).pop() ?? pdfViewerWindowTitle(0)
    const title = baseTitle.length > 0 ? baseTitle : pdfViewerWindowTitle(windowId - pdfViewerWindowId(0))
    primeShellWindowState(windowId, {
      viewingPath: detail.path,
      directory: detail.directory,
      showHidden: detail.showHidden,
    })
    queueBackedWindowOpen(
      buildPdfViewerWindowOpenPayload(
        context.monitor.name,
        context.work,
        windowId,
        title,
        context.origin,
        context.staggerIndex,
      ),
    )
    return true
  }

  const openFileBrowserWindow = (path?: string | null) => {
    const context = resolveMonitorContext()
    if (!context) return false
    pruneReservedBackedWindowIds()
    const windowId = nextWindowId(
      options.getWindows(),
      pendingBackedWindowOpens.keys(),
      reservedBackedWindowIds,
      isFileBrowserWindowId,
      SHELL_UI_FILE_BROWSER_APP_ID,
      fileBrowserWindowId,
    )
    if (windowId === null) return false
    reservedBackedWindowIds.add(windowId)
    const title = fileBrowserWindowTitle(windowId - fileBrowserWindowId(0))
    const prefs = loadFileBrowserPrefs()
    primeShellWindowState(windowId, {
      activePath: path ?? null,
      selectedPath: null,
      showHidden: prefs.showHidden,
    })
    primeFileBrowserWindowPath(windowId, path)
    queueBackedWindowOpen(
      buildFileBrowserWindowOpenPayload(
        context.monitor.name,
        context.work,
        windowId,
        title,
        context.origin,
        context.staggerIndex,
      ),
    )
    return true
  }

  const dispose = () => {
    if (backedWindowOpenRaf !== 0) cancelAnimationFrame(backedWindowOpenRaf)
  }

  const openShellHostedApp = (kind: BackedShellWindowKind): boolean => {
    if (kind === 'debug') {
      openDebugShellWindow()
      return true
    }
    if (kind === 'settings') {
      openSettingsShellWindow()
      return true
    }
    if (kind === 'test') return openShellTestWindow()
    if (kind === 'file_browser') return openFileBrowserWindow()
    if (kind === 'image_viewer' || kind === 'video_viewer' || kind === 'text_editor' || kind === 'pdf_viewer') return false
    return false
  }

  return {
    openDebugShellWindow,
    openSettingsShellWindow,
    openShellTestWindow,
    openFileBrowserWindow,
    openImageViewerWindow,
    openVideoViewerWindow,
    openTextEditorWindow,
    openPdfViewerWindow,
    openShellHostedApp,
    dispose,
  }
}
