import type { AssistGridSpan } from '@/features/tiling/assistGrid'
import type { DerpWindow } from '@/host/appWindowState'
import { canvasOriginXY, canvasRectToClientCss, type CanvasOrigin } from '@/lib/shellCoords'
import { SHELL_WINDOW_FLAG_SCRATCHPAD, SHELL_WINDOW_FLAG_SHELL_HOSTED } from '@/features/shell-ui/shellUiWindows'
import type { SessionSnapshot } from './sessionSnapshot'

export type E2eRectSnapshot = {
  x: number
  y: number
  width: number
  height: number
  global_x: number
  global_y: number
}

type E2eSnapshotTaskbarRow = {
  group_id: string
  window_id: number
  tab_count: number
}

type E2eSnapshotGroupMember = {
  window_id: number
}

type E2eSnapshotDropSlot = {
  insert_index: number
  rect: E2eRectSnapshot | null
}

type E2eSnapshotWorkspaceGroup = {
  id: string
  visibleWindowId: number
  splitLeftWindowId: number | null
  splitPaneFraction: number | null
  visibleWindowIds: number[]
  hiddenWindowIds: number[]
  members: E2eSnapshotGroupMember[]
}

type E2eFloatingPlacement = {
  gx: number
  gy: number
  gw: number
  gh: number
}

type E2eFloatingLayer = {
  id: string
  placement?: E2eFloatingPlacement | null
}

type E2eSnapPreviewCanvas = {
  x: number
  y: number
  w: number
  h: number
}

type E2eSnapAssistPicker = {
  windowId: number
  source: string
  monitorName: string | null
}

type E2eTabDragTarget = {
  windowId: number
  groupId: string
  insertIndex: number
}

export type BuildE2eShellSnapshotArgs = {
  document: Document
  viewport: unknown
  pointerClient: { x: number; y: number } | null
  compositorInteractionState:
    | {
        move_window_id: number | null
        resize_window_id: number | null
        move_proxy_window_id: number | null
        move_capture_window_id: number | null
      }
    | null
  main: HTMLElement | null
  origin: CanvasOrigin
  canvas: { w: number; h: number } | null
  windows: DerpWindow[]
  taskbarGroupRows: E2eSnapshotTaskbarRow[]
  workspaceGroups: E2eSnapshotWorkspaceGroup[]
  focusedWindowId: number | null
  keyboardLayoutLabel: string | null
  screenshotMode: unknown
  crosshairCursor: boolean
  programsMenuOpen: boolean
  powerMenuOpen: boolean
  volumeMenuOpen: boolean
  debugWindowVisible: boolean
  settingsWindowVisible: boolean
  snapAssistPicker: E2eSnapAssistPicker | null
  activeSnapPreviewCanvas: E2eSnapPreviewCanvas | null
  assistOverlayHoverSpan: AssistGridSpan | null
  programsMenuQuery: string
  sessionSnapshot: SessionSnapshot | null
  sessionSnapshotError: string | null
  sessionRestoreActive: boolean
  floatingLayers: E2eFloatingLayer[]
  tabDragTarget: E2eTabDragTarget | null
  projectCurrentMenuElementRect: (el: Element | null) => E2eRectSnapshot | null
  isWorkspaceWindowPinned: (windowId: number) => boolean
  menuLayerHost?: () => HTMLElement | undefined
}

type QueryCache = {
  query: (selector: string) => HTMLElement | null
  queryAll: (selector: string) => HTMLElement[]
  queryAttr: (attr: string, value: string | number) => HTMLElement | null
  queryAllAttr: (attr: string) => HTMLElement[]
}

export function snapshotRect(el: Element | null, origin: CanvasOrigin): E2eRectSnapshot | null {
  if (!(el instanceof HTMLElement)) return null
  if (el.closest('[data-shell-window-hidden="true"]')) return null
  const rect = visibleClientRect(el)
  if (!rect) return null
  const x = Math.round(rect.left)
  const y = Math.round(rect.top)
  const width = Math.max(0, Math.round(rect.width))
  const height = Math.max(0, Math.round(rect.height))
  if (width <= 0 || height <= 0) return null
  const { ox, oy } = canvasOriginXY(origin)
  return {
    x,
    y,
    width,
    height,
    global_x: ox + x,
    global_y: oy + y,
  }
}

function visibleClientRect(el: HTMLElement) {
  const initial = el.getBoundingClientRect()
  let left = initial.left
  let top = initial.top
  let right = initial.right
  let bottom = initial.bottom
  if (right <= left || bottom <= top) return null
  const viewportRight = window.innerWidth || document.documentElement.clientWidth || 0
  const viewportBottom = window.innerHeight || document.documentElement.clientHeight || 0
  right = Math.min(right, viewportRight)
  bottom = Math.min(bottom, viewportBottom)
  left = Math.max(left, 0)
  top = Math.max(top, 0)
  if (right <= left || bottom <= top) return null
  let parent = el.parentElement
  while (parent) {
    const style = window.getComputedStyle(parent)
    const clipX = shouldClipOverflowAxis(style.overflowX) || shouldClipOverflowAxis(style.overflow)
    const clipY = shouldClipOverflowAxis(style.overflowY) || shouldClipOverflowAxis(style.overflow)
    if (clipX || clipY) {
      const parentRect = parent.getBoundingClientRect()
      if (clipX) {
        left = Math.max(left, parentRect.left)
        right = Math.min(right, parentRect.right)
      }
      if (clipY) {
        top = Math.max(top, parentRect.top)
        bottom = Math.min(bottom, parentRect.bottom)
      }
      if (right <= left || bottom <= top) return null
    }
    parent = parent.parentElement
  }
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  }
}

function shouldClipOverflowAxis(value: string) {
  return value !== 'visible' && value !== 'unset'
}

function queryWithin(scope: ParentNode, selector: string): HTMLElement | null {
  const el = scope.querySelector(selector)
  return el instanceof HTMLElement ? el : null
}

function queryAllWithin(scope: ParentNode, selector: string): HTMLElement[] {
  return Array.from(scope.querySelectorAll(selector)).filter((el): el is HTMLElement => el instanceof HTMLElement)
}

function createQueryCache(doc: Document): QueryCache {
  const selectorCache = new Map<string, HTMLElement | null>()
  const selectorAllCache = new Map<string, HTMLElement[]>()
  const attrValueCache = new Map<string, Map<string, HTMLElement>>()
  const attrAllCache = new Map<string, HTMLElement[]>()

  function query(selector: string): HTMLElement | null {
    if (selectorCache.has(selector)) return selectorCache.get(selector) ?? null
    const el = doc.querySelector(selector)
    const next = el instanceof HTMLElement ? el : null
    selectorCache.set(selector, next)
    return next
  }

  function queryAll(selector: string): HTMLElement[] {
    const cached = selectorAllCache.get(selector)
    if (cached) return cached
    const next = Array.from(doc.querySelectorAll(selector)).filter((el): el is HTMLElement => el instanceof HTMLElement)
    selectorAllCache.set(selector, next)
    return next
  }

  function queryAllAttr(attr: string): HTMLElement[] {
    const cached = attrAllCache.get(attr)
    if (cached) return cached
    const next = queryAll(`[${attr}]`)
    attrAllCache.set(attr, next)
    return next
  }

  function queryAttr(attr: string, value: string | number): HTMLElement | null {
    const key = String(value)
    let index = attrValueCache.get(attr)
    if (!index) {
      index = new Map<string, HTMLElement>()
      for (const el of queryAllAttr(attr)) {
        const attrValue = el.getAttribute(attr)
        if (attrValue == null || index.has(attrValue)) continue
        index.set(attrValue, el)
      }
      attrValueCache.set(attr, index)
    }
    return index.get(key) ?? null
  }

  return {
    query,
    queryAll,
    queryAttr,
    queryAllAttr,
  }
}

function queryRect(cache: QueryCache, selector: string, origin: CanvasOrigin): E2eRectSnapshot | null {
  return snapshotRect(cache.query(selector), origin)
}

function queryLargestRect(cache: QueryCache, selector: string, origin: CanvasOrigin): E2eRectSnapshot | null {
  let best: E2eRectSnapshot | null = null
  let bestArea = -1
  for (const el of cache.queryAll(selector)) {
    const rect = snapshotRect(el, origin)
    if (!rect) continue
    const area = rect.width * rect.height
    if (area > bestArea) {
      best = rect
      bestArea = area
    }
  }
  return best
}

export function buildFileBrowserSnapshot(root: ParentNode, origin: CanvasOrigin) {
  const fileBrowserListStateEl = queryWithin(root, '[data-file-browser-list-state]')
  const fileBrowserActivePathEl = queryWithin(root, '[data-file-browser-active-path]')
  const fileBrowserViewerTitleEl = queryWithin(
    root,
    '[data-file-browser-viewer-title], [data-file-browser-editor-title]',
  )
  const fileBrowserRows = queryAllWithin(root, '[data-file-browser-row]').map((rowEl) => ({
    path: rowEl.getAttribute('data-file-browser-path') ?? '',
    name: rowEl.getAttribute('data-file-browser-name') ?? rowEl.textContent?.trim() ?? '',
    kind: rowEl.getAttribute('data-file-browser-kind'),
    selected:
      rowEl.getAttribute('data-file-browser-selected') === 'true' ||
      rowEl.getAttribute('aria-selected') === 'true',
    rect: snapshotRect(rowEl, origin),
  }))
  const fileBrowserBreadcrumbs = queryAllWithin(root, '[data-file-browser-breadcrumb]').map((crumbEl) => ({
    path: crumbEl.getAttribute('data-file-browser-path') ?? '',
    label: crumbEl.getAttribute('data-file-browser-label') ?? crumbEl.textContent?.trim() ?? '',
    rect: snapshotRect(crumbEl, origin),
  }))
  const fileBrowserPrimaryActions = queryAllWithin(root, '[data-file-browser-primary-action]').map((actionEl) => ({
    id: actionEl.getAttribute('data-file-browser-primary-action') ?? '',
    label: actionEl.getAttribute('aria-label') ?? actionEl.textContent?.trim() ?? '',
    rect: snapshotRect(actionEl, origin),
  }))
  const breadcrumbBarEl = queryWithin(root, '[data-file-browser-breadcrumb-bar]')
  const breadcrumbEllipsisEl = queryWithin(root, '[data-file-browser-breadcrumb-ellipsis]')
  const dialogInputEl = queryWithin(root, '[data-file-browser-dialog-input]')
  const dialogConfirmEl = queryWithin(root, '[data-file-browser-dialog-confirm]')
  const openWithOptions = queryAllWithin(root, '[data-file-browser-open-with-option]').map((optionEl) => ({
    id: optionEl.getAttribute('data-file-browser-open-with-option') ?? '',
    label: optionEl.textContent?.trim() ?? '',
    rect: snapshotRect(optionEl, origin),
  }))
  const iconOptions = queryAllWithin(root, '[data-file-browser-icon-option]').map((optionEl) => ({
    id: optionEl.getAttribute('data-file-browser-icon-option') ?? '',
    label: optionEl.textContent?.trim() ?? '',
    rect: snapshotRect(optionEl, origin),
  }))
  const openTargetOptions = queryAllWithin(root, '[data-file-browser-open-target]').map((optionEl) => ({
    id: optionEl.getAttribute('data-file-browser-open-target') ?? '',
    label: optionEl.textContent?.trim() ?? '',
    rect: snapshotRect(optionEl, origin),
  }))
  return {
    list_state: fileBrowserListStateEl?.getAttribute('data-file-browser-list-state') ?? null,
    mount_seq: Number(fileBrowserListStateEl?.getAttribute('data-file-browser-mount-seq') ?? 0),
    load_count: Number(fileBrowserListStateEl?.getAttribute('data-file-browser-load-count') ?? 0),
    active_path:
      fileBrowserActivePathEl?.getAttribute('data-file-browser-active-path') ??
      fileBrowserActivePathEl?.textContent?.trim() ??
      null,
    rows: fileBrowserRows,
    breadcrumbs: fileBrowserBreadcrumbs,
    breadcrumb_bar_rect: snapshotRect(breadcrumbBarEl, origin),
    breadcrumb_ellipsis_rect: snapshotRect(breadcrumbEllipsisEl, origin),
    viewer_editor_title:
      fileBrowserViewerTitleEl?.getAttribute('data-file-browser-document-title') ??
      fileBrowserViewerTitleEl?.textContent?.trim() ??
      null,
    primary_actions: fileBrowserPrimaryActions,
    dialog_input_rect: snapshotRect(dialogInputEl, origin),
    dialog_confirm_rect: snapshotRect(dialogConfirmEl, origin),
    open_with_options: openWithOptions,
    icon_options: iconOptions,
    open_target_options: openTargetOptions,
  }
}

export function buildE2eShellSnapshot(args: BuildE2eShellSnapshotArgs) {
  const cache = createQueryCache(args.document)
  const settingsTilingLayoutTriggerRect = queryRect(cache, '[data-settings-tiling-layout-trigger]', args.origin)
  const settingsMonitorName =
    args.windows.find((window) => window.window_id === 9002 && !window.minimized)?.output_name ?? null

  const projectFloatingElementRect = (selector: string) => {
    const el = cache.query(selector)
    if (!el) return null
    const floatingRoot = el.closest('[data-floating-layer-id]') as HTMLElement | null
    const layerId = floatingRoot?.getAttribute('data-floating-layer-id')
    if (!layerId || !floatingRoot?.contains(el)) {
      return args.projectCurrentMenuElementRect(el)
    }
    const layer = args.floatingLayers.find((row) => row.id === layerId)
    const placement = layer?.placement
    if (!placement) return null
    const rootRect = floatingRoot.getBoundingClientRect()
    if (rootRect.width <= 0 || rootRect.height <= 0) return null
    const rect = el.getBoundingClientRect()
    const leftRatio = (rect.left - rootRect.left) / rootRect.width
    const topRatio = (rect.top - rootRect.top) / rootRect.height
    const rightRatio = (rect.right - rootRect.left) / rootRect.width
    const bottomRatio = (rect.bottom - rootRect.top) / rootRect.height
    const globalLeft = Math.round(placement.gx + leftRatio * placement.gw)
    const globalTop = Math.round(placement.gy + topRatio * placement.gh)
    const globalRight = Math.round(placement.gx + rightRatio * placement.gw)
    const globalBottom = Math.round(placement.gy + bottomRatio * placement.gh)
    const ox = args.origin?.x ?? 0
    const oy = args.origin?.y ?? 0
    return {
      x: globalLeft - ox,
      y: globalTop - oy,
      width: Math.max(1, globalRight - globalLeft),
      height: Math.max(1, globalBottom - globalTop),
      global_x: globalLeft,
      global_y: globalTop,
    }
  }

  const floatingMenuRect = (selector: string) => projectFloatingElementRect(selector) ?? queryRect(cache, selector, args.origin)
  const volumeMenuRect = (selector: string) => floatingMenuRect(selector)
  const powerMenuRect = (selector: string) => floatingMenuRect(selector)
  const windowInteractionCaptureEl = cache.query('[data-window-interaction-capture]')
  const windowInteractionCaptureRect = snapshotRect(windowInteractionCaptureEl, args.origin)
  const windowInteractionCaptureBlocksPointer =
    windowInteractionCaptureEl instanceof HTMLElement &&
    getComputedStyle(windowInteractionCaptureEl).pointerEvents !== 'none'
  const windowInteractionCaptureHitPointer = (() => {
    if (!windowInteractionCaptureEl || !args.pointerClient) return null
    const hit = args.document.elementFromPoint(args.pointerClient.x, args.pointerClient.y)
    return !!(hit && windowInteractionCaptureEl.contains(hit))
  })()
  const customLayoutOverlayEl = cache.query('[data-custom-layout-overlay]')
  const customLayoutOverlayBlocksPointer =
    customLayoutOverlayEl instanceof HTMLElement && getComputedStyle(customLayoutOverlayEl).pointerEvents !== 'none'
  const customLayoutOverlayHitPointer = (() => {
    if (!customLayoutOverlayEl || !args.pointerClient) return null
    const hit = args.document.elementFromPoint(args.pointerClient.x, args.pointerClient.y)
    return !!(hit && customLayoutOverlayEl.contains(hit))
  })()

  const stackOrderedWindows = [...args.windows].sort((a, b) => b.stack_z - a.stack_z || b.window_id - a.window_id)
  const taskbarButtons = cache.queryAllAttr('data-shell-taskbar-monitor').map((taskbarEl) => ({
    monitor: taskbarEl.getAttribute('data-shell-taskbar-monitor') ?? '',
    rect: snapshotRect(taskbarEl, args.origin),
  }))
  const taskbarWindowButtons = args.taskbarGroupRows.map((row) => ({
    group_id: row.group_id,
    window_id: row.window_id,
    tab_count: row.tab_count,
    activate: snapshotRect(cache.queryAttr('data-shell-taskbar-window-activate', row.window_id), args.origin),
    close: snapshotRect(cache.queryAttr('data-shell-taskbar-window-close', row.window_id), args.origin),
  }))
  const windowControls = args.windows.map((window) => {
    const nativeDragPreviewEl = cache.queryAttr('data-shell-native-drag-preview', window.window_id)
    const nativeDragPreviewImg = nativeDragPreviewEl?.querySelector('img')
    const nativeDragPreviewCanvas = nativeDragPreviewEl?.querySelector('canvas')
    return {
      window_id: window.window_id,
      titlebar: snapshotRect(cache.queryAttr('data-shell-titlebar', window.window_id), args.origin),
      minimize: snapshotRect(cache.queryAttr('data-shell-minimize-trigger', window.window_id), args.origin),
      maximize: snapshotRect(cache.queryAttr('data-shell-maximize-trigger', window.window_id), args.origin),
      close: snapshotRect(cache.queryAttr('data-shell-close-trigger', window.window_id), args.origin),
    snap_picker: snapshotRect(cache.queryAttr('data-shell-snap-picker-trigger', window.window_id), args.origin),
    resize_left: snapshotRect(cache.queryAttr('data-shell-resize-left', window.window_id), args.origin),
    resize_right: snapshotRect(cache.queryAttr('data-shell-resize-right', window.window_id), args.origin),
    resize_bottom_left: snapshotRect(cache.queryAttr('data-shell-resize-bottom-left', window.window_id), args.origin),
    resize_bottom_right: snapshotRect(cache.queryAttr('data-shell-resize-bottom-right', window.window_id), args.origin),
    dragging:
      cache.queryAttr('data-shell-window-frame', window.window_id)?.getAttribute('data-shell-window-dragging') === 'true',
      hidden:
        cache.queryAttr('data-shell-window-frame', window.window_id)?.getAttribute('data-shell-window-hidden') === 'true',
      frame_opacity: (() => {
        const frame = cache.queryAttr('data-shell-window-frame', window.window_id)
        if (!frame) return null
        const opacity = Number.parseFloat(getComputedStyle(frame).opacity)
        return Number.isFinite(opacity) ? opacity : null
      })(),
      frame_z: (() => {
        const frame = cache.queryAttr('data-shell-window-frame', window.window_id)
        if (!frame) return null
        const z = Number.parseInt(getComputedStyle(frame).zIndex, 10)
        return Number.isFinite(z) ? z : null
      })(),
      native_drag_preview_rect: snapshotRect(nativeDragPreviewEl, args.origin),
      native_drag_preview_generation: (() => {
        const raw = nativeDragPreviewEl?.getAttribute('data-shell-native-drag-preview-generation')
        if (raw == null) return null
        const value = Number.parseInt(raw, 10)
        return Number.isFinite(value) ? value : null
      })(),
      native_drag_preview_loaded:
        nativeDragPreviewEl?.getAttribute('data-shell-native-drag-preview-loaded') === 'true' ||
        (nativeDragPreviewImg instanceof HTMLImageElement && nativeDragPreviewImg.complete),
      native_drag_preview_src:
        nativeDragPreviewEl?.getAttribute('data-shell-native-drag-preview-src') ??
        (nativeDragPreviewImg instanceof HTMLImageElement ? nativeDragPreviewImg.currentSrc || nativeDragPreviewImg.src : null),
      native_drag_preview_source_width: (() => {
        const raw = nativeDragPreviewEl?.getAttribute('data-shell-native-drag-preview-src-width')
        if (raw == null || raw === '') return null
        const value = Number.parseInt(raw, 10)
        return Number.isFinite(value) ? value : null
      })(),
      native_drag_preview_source_height: (() => {
        const raw = nativeDragPreviewEl?.getAttribute('data-shell-native-drag-preview-src-height')
        if (raw == null || raw === '') return null
        const value = Number.parseInt(raw, 10)
        return Number.isFinite(value) ? value : null
      })(),
      native_drag_preview_backing_width: (() => {
        const raw = nativeDragPreviewEl?.getAttribute('data-shell-native-drag-preview-backing-width')
        if (raw == null || raw === '') {
          return nativeDragPreviewCanvas instanceof HTMLCanvasElement ? nativeDragPreviewCanvas.width : null
        }
        const value = Number.parseInt(raw, 10)
        return Number.isFinite(value) ? value : null
      })(),
      native_drag_preview_backing_height: (() => {
        const raw = nativeDragPreviewEl?.getAttribute('data-shell-native-drag-preview-backing-height')
        if (raw == null || raw === '') {
          return nativeDragPreviewCanvas instanceof HTMLCanvasElement ? nativeDragPreviewCanvas.height : null
        }
        const value = Number.parseInt(raw, 10)
        return Number.isFinite(value) ? value : null
      })(),
    }
  })
  const tabGroups = args.workspaceGroups.map((group) => ({
    group_id: group.id,
    visible_window_id: group.visibleWindowId,
    split_left_window_id: group.splitLeftWindowId,
    split_left_pane_fraction: group.splitPaneFraction,
    hidden_window_ids: [...group.hiddenWindowIds],
    member_window_ids: group.members.map((member) => member.window_id),
    visible_window_ids: [...group.visibleWindowIds],
    split_left_rect:
      group.splitLeftWindowId !== null
        ? snapshotRect(cache.queryAttr('data-workspace-split-left-pane', group.splitLeftWindowId), args.origin)
        : null,
    split_right_rect: snapshotRect(
      cache.queryAttr('data-workspace-split-right-pane', group.visibleWindowId),
      args.origin,
    ),
    split_divider_rect: snapshotRect(
      cache.queryAttr('data-workspace-split-divider', group.id),
      args.origin,
    ),
    tabs: group.members.map((member) => ({
      window_id: member.window_id,
      rect: snapshotRect(cache.queryAttr('data-workspace-tab', member.window_id), args.origin),
      handle: snapshotRect(cache.queryAttr('data-workspace-tab-handle', member.window_id), args.origin),
      close: snapshotRect(cache.queryAttr('data-workspace-tab-close', member.window_id), args.origin),
      active: member.window_id === group.visibleWindowId,
      pinned: args.isWorkspaceWindowPinned(member.window_id),
      split_left: member.window_id === group.splitLeftWindowId,
    })),
    drop_slots: cache
      .queryAllAttr('data-tab-drop-slot')
      .filter((el) => (el.getAttribute('data-tab-drop-slot') ?? '').startsWith(`${group.id}:`))
      .map((el) => {
        const raw = el.getAttribute('data-tab-drop-slot') ?? ''
        const insertIndex = Number(raw.slice(group.id.length + 1))
        return {
          insert_index: Number.isFinite(insertIndex) ? Math.trunc(insertIndex) : -1,
          rect: snapshotRect(el, args.origin),
        }
      })
      .filter((slot): slot is E2eSnapshotDropSlot => slot.insert_index >= 0),
  }))
  const snapPreviewRect =
    args.main && args.canvas && args.activeSnapPreviewCanvas
      ? (() => {
          const { ox, oy } = canvasOriginXY(args.origin)
          const css = canvasRectToClientCss(
            args.activeSnapPreviewCanvas.x,
            args.activeSnapPreviewCanvas.y,
            args.activeSnapPreviewCanvas.w,
            args.activeSnapPreviewCanvas.h,
            args.main.getBoundingClientRect(),
            args.canvas.w,
            args.canvas.h,
          )
          return {
            x: Math.round(css.left),
            y: Math.round(css.top),
            width: Math.round(css.width),
            height: Math.round(css.height),
            global_x: Math.round(ox + css.left),
            global_y: Math.round(oy + css.top),
          }
        })()
      : null
  const fileBrowserWindows = cache
    .queryAllAttr('data-file-browser-active-path')
    .map((el) => {
      const frameEl = el.closest('[data-shell-window-frame]') as HTMLElement | null
      if (!frameEl) return null
      const rawWindowId = Number(frameEl.getAttribute('data-shell-window-frame') ?? '')
      if (!Number.isInteger(rawWindowId) || rawWindowId < 1) return null
      return {
        window_id: rawWindowId,
        ...buildFileBrowserSnapshot(frameEl, args.origin),
      }
    })
    .filter((entry): entry is { window_id: number } & ReturnType<typeof buildFileBrowserSnapshot> => entry !== null)
  const textEditorWindows = cache
    .queryAllAttr('data-text-editor-root')
    .map((el) => {
      const frameEl = el.closest('[data-shell-window-frame]') as HTMLElement | null
      if (!frameEl) return null
      const rawWindowId = Number(frameEl.getAttribute('data-shell-window-frame') ?? '')
      if (!Number.isInteger(rawWindowId) || rawWindowId < 1) return null
      const img = el.querySelector('[data-text-editor-markdown] img')
      const editBtn = el.querySelector('[data-text-editor-edit]')
      const saveBtn = el.querySelector('[data-text-editor-save]')
      const ta = el.querySelector('[data-text-editor-textarea]')
      const zoomDlg = el.querySelector('[data-text-editor-markdown-image-dialog="1"]')
      return {
        window_id: rawWindowId,
        markdown_img_rect: img instanceof HTMLElement ? snapshotRect(img, args.origin) : null,
        markdown_img_dialog_open: zoomDlg instanceof HTMLElement,
        edit_rect: editBtn instanceof HTMLElement ? snapshotRect(editBtn, args.origin) : null,
        save_rect: saveBtn instanceof HTMLElement ? snapshotRect(saveBtn, args.origin) : null,
        textarea_rect: ta instanceof HTMLElement ? snapshotRect(ta, args.origin) : null,
      }
    })
    .filter(
      (
        entry,
      ): entry is {
        window_id: number
        markdown_img_rect: ReturnType<typeof snapshotRect>
        markdown_img_dialog_open: boolean
        edit_rect: ReturnType<typeof snapshotRect>
        save_rect: ReturnType<typeof snapshotRect>
        textarea_rect: ReturnType<typeof snapshotRect>
      } => entry !== null,
    )
  const imageViewerWindows = cache
    .queryAllAttr('data-image-viewer-root')
    .map((el) => {
      const frameEl = el.closest('[data-shell-window-frame]') as HTMLElement | null
      if (!frameEl) return null
      const rawWindowId = Number(frameEl.getAttribute('data-shell-window-frame') ?? '')
      if (!Number.isInteger(rawWindowId) || rawWindowId < 1) return null
      const img = el.querySelector('[data-image-viewer-img]')
      const rotate = el.querySelector('[data-image-viewer-rotate]')
      const fit = el.querySelector('[data-image-viewer-fit]')
      return {
        window_id: rawWindowId,
        img_rect: img instanceof HTMLElement ? snapshotRect(img, args.origin) : null,
        img_transform: img instanceof HTMLElement ? img.style.transform : '',
        rotate_rect: rotate instanceof HTMLElement ? snapshotRect(rotate, args.origin) : null,
        fit_rect: fit instanceof HTMLElement ? snapshotRect(fit, args.origin) : null,
      }
    })
    .filter(
      (
        entry,
      ): entry is {
        window_id: number
        img_rect: ReturnType<typeof snapshotRect>
        img_transform: string
        rotate_rect: ReturnType<typeof snapshotRect>
        fit_rect: ReturnType<typeof snapshotRect>
      } => entry !== null,
    )
  const pdfViewerWindows = cache
    .queryAllAttr('data-pdf-viewer-root')
    .map((el) => {
      const frameEl = el.closest('[data-shell-window-frame]') as HTMLElement | null
      if (!frameEl) return null
      const rawWindowId = Number(frameEl.getAttribute('data-shell-window-frame') ?? '')
      if (!Number.isInteger(rawWindowId) || rawWindowId < 1) return null
      const doc = el.querySelector('[data-pdf-viewer-document]')
      const title = el.querySelector('[data-pdf-viewer-title]')
      return {
        window_id: rawWindowId,
        document_rect: doc instanceof HTMLElement ? snapshotRect(doc, args.origin) : null,
        title: title instanceof HTMLElement ? title.textContent?.trim() ?? '' : '',
      }
    })
    .filter(
      (
        entry,
      ): entry is {
        window_id: number
        document_rect: ReturnType<typeof snapshotRect>
        title: string
      } => entry !== null,
    )
  const globalFileBrowserWindow =
    fileBrowserWindows.find((entry) => entry.window_id === args.focusedWindowId) ?? fileBrowserWindows[0] ?? null

  const fileBrowserContextMenu = cache.queryAll('[data-file-browser-context-action]').map((el) => ({
    id: el.getAttribute('data-file-browser-context-action') ?? '',
    label: (
      el.querySelector('[data-file-browser-context-label]')?.textContent ??
      el.textContent ??
      ''
    ).trim(),
    rect: snapshotRect(el, args.origin),
  }))

  const menuLayerHostElResolved =
    args.menuLayerHost?.() ??
    (args.document.getElementById('derp-shell-menu-layer-host') as HTMLElement | null) ??
    (args.document.querySelector('[data-shell-menu-layer-host]') as HTMLElement | null)

  const menu_layer_host_z_index = (() => {
    if (!menuLayerHostElResolved) return null
    const zAttr = menuLayerHostElResolved.getAttribute('data-shell-menu-layer-z')
    if (zAttr != null && zAttr !== '') {
      const n = Number.parseInt(zAttr, 10)
      if (Number.isFinite(n)) return n
    }
    const z = getComputedStyle(menuLayerHostElResolved).zIndex
    if (z === 'auto' || z === '') return null
    const n = Number.parseInt(z, 10)
    return Number.isFinite(n) ? n : null
  })()

  const menu_portal_hit_test = (() => {
    if (!menuLayerHostElResolved) return null
    let panel: HTMLElement | null = null
    if (args.volumeMenuOpen) panel = cache.query('[data-shell-volume-menu-panel]')
    else if (args.powerMenuOpen) panel = cache.query('[data-shell-power-menu-panel]')
    else if (args.programsMenuOpen) panel = cache.query('[data-shell-programs-menu-panel]')
    else return null
    if (!(panel instanceof HTMLElement)) return { hit_ok: false, tray_flap_above_toggle: null }
    const r = panel.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return { hit_ok: false, tray_flap_above_toggle: null }
    const hit = args.document.elementFromPoint(r.left + r.width * 0.5, r.top + r.height * 0.5)
    const hit_ok = !!(hit && menuLayerHostElResolved.contains(hit))
    let tray_flap_above_toggle: boolean | null = null
    if (args.volumeMenuOpen || args.powerMenuOpen) {
      const toggleSel = args.volumeMenuOpen ? '[data-shell-volume-toggle]' : '[data-shell-power-toggle]'
      const toggle = cache.query(toggleSel)
      if (toggle instanceof HTMLElement) {
        const tr = toggle.getBoundingClientRect()
        tray_flap_above_toggle = r.bottom <= tr.top + 3
      }
    }
    return { hit_ok, tray_flap_above_toggle }
  })()

  return {
    captured_at_ms: Date.now(),
    viewport: args.viewport,
    canvas_origin: args.origin ? { x: args.origin.x, y: args.origin.y } : null,
    focused_window_id: args.focusedWindowId,
    shell_keyboard_layout: args.keyboardLayoutLabel,
    screenshot_mode: args.screenshotMode,
    crosshair_cursor: args.crosshairCursor,
    programs_menu_open: args.programsMenuOpen,
    power_menu_open: args.powerMenuOpen,
    volume_menu_open: args.volumeMenuOpen,
    menu_layer_host_connected: !!menuLayerHostElResolved,
    menu_layer_host_z_index,
    menu_portal_hit_test,
    overlay_menu_dom:
      args.programsMenuOpen || args.volumeMenuOpen || args.powerMenuOpen
        ? {
            host_connected: !!menuLayerHostElResolved,
            volume_panel_dom: !!cache.query('[data-shell-volume-menu-panel]'),
            power_menu_dom: !!cache.query('[data-shell-power-menu-panel]'),
            programs_menu_dom: !!cache.query('[data-shell-programs-menu-panel]'),
          }
        : null,
    debug_window_visible: args.debugWindowVisible,
    settings_window_visible: args.settingsWindowVisible,
    snap_picker_open: args.snapAssistPicker !== null,
    snap_picker_window_id: args.snapAssistPicker?.windowId ?? null,
    snap_picker_source: args.snapAssistPicker?.source ?? null,
    snap_picker_monitor: args.snapAssistPicker?.monitorName ?? null,
    snap_picker_z: (() => {
      const picker = cache.query('[data-shell-snap-picker]')
      if (!picker) return null
      const z = Number.parseInt(getComputedStyle(picker).zIndex, 10)
      return Number.isFinite(z) ? z : null
    })(),
    snap_preview_visible: args.activeSnapPreviewCanvas !== null,
    snap_preview_rect: snapPreviewRect,
    snap_hover_span: args.assistOverlayHoverSpan,
    file_browser: globalFileBrowserWindow,
    file_browser_windows: fileBrowserWindows,
    image_viewer_windows: imageViewerWindows,
    text_editor_windows: textEditorWindows,
    pdf_viewer_windows: pdfViewerWindows,
    file_browser_context_menu: fileBrowserContextMenu,
    programs_menu_query: args.programsMenuQuery,
    session_snapshot: args.sessionSnapshot,
    session_snapshot_error: args.sessionSnapshotError,
    session_restore_active: args.sessionRestoreActive,
    tab_drag_target: args.tabDragTarget
      ? {
          window_id: args.tabDragTarget.windowId,
          group_id: args.tabDragTarget.groupId,
          insert_index: args.tabDragTarget.insertIndex,
        }
      : null,
    compositor_interaction_state: args.compositorInteractionState,
    window_interaction_capture: windowInteractionCaptureRect,
    window_interaction_capture_blocks_pointer: windowInteractionCaptureBlocksPointer,
    window_interaction_capture_hit_pointer: windowInteractionCaptureHitPointer,
    custom_layout_overlay_blocks_pointer: customLayoutOverlayBlocksPointer,
    custom_layout_overlay_hit_pointer: customLayoutOverlayHitPointer,
    programs_menu_list_scroll: (() => {
      if (!args.programsMenuOpen) return null
      const el = cache.query('[data-programs-menu-scroll]')
      if (!el) return null
      return {
        scroll_top: el.scrollTop,
        scroll_height: el.scrollHeight,
        client_height: el.clientHeight,
      }
    })(),
    window_stack_order: stackOrderedWindows.map((window) => window.window_id),
    tab_groups: tabGroups,
    windows: args.windows.map((window) => ({
      window_id: window.window_id,
      title: window.title,
      app_id: window.app_id,
      kind: window.kind,
      x11_class: window.x11_class,
      x11_instance: window.x11_instance,
      output_name: window.output_name,
      stack_z: window.stack_z,
      x: window.x,
      y: window.y,
      width: window.width,
      height: window.height,
      minimized: window.minimized,
      maximized: window.maximized,
      fullscreen: window.fullscreen,
      shell_hosted: !!(window.shell_flags & SHELL_WINDOW_FLAG_SHELL_HOSTED),
      scratchpad: !!(window.shell_flags & SHELL_WINDOW_FLAG_SCRATCHPAD),
    })),
    controls: {
      taskbar_programs_toggle: queryRect(cache, '[data-shell-programs-toggle]', args.origin),
      taskbar_settings_toggle: queryRect(cache, '[data-shell-settings-toggle]', args.origin),
      taskbar_debug_toggle: queryRect(cache, '[data-shell-debug-toggle]', args.origin),
      taskbar_volume_toggle: queryRect(cache, '[data-shell-volume-toggle]', args.origin),
      taskbar_power_toggle: queryRect(cache, '[data-shell-power-toggle]', args.origin),
      volume_menu_panel: volumeMenuRect('[data-shell-volume-menu-panel]'),
      volume_output_select: volumeMenuRect('[data-shell-volume-output-select] button'),
      volume_output_option_0: volumeMenuRect('[data-select-panel="volume-output"] [data-select-option-idx="0"]'),
      volume_output_option_1: volumeMenuRect('[data-select-panel="volume-output"] [data-select-option-idx="1"]'),
      volume_input_select: volumeMenuRect('[data-shell-volume-input-select] button'),
      volume_input_option_0: volumeMenuRect('[data-select-panel="volume-input"] [data-select-option-idx="0"]'),
      volume_input_option_1: volumeMenuRect('[data-select-panel="volume-input"] [data-select-option-idx="1"]'),
      volume_output_slider: volumeMenuRect('[data-shell-volume-output-default] input[type="range"]'),
      volume_playback_first_slider: volumeMenuRect('[data-shell-volume-playback-row="first"] input[type="range"]'),
      programs_menu_search: queryRect(cache, 'input[aria-label="Search applications"]', args.origin),
      programs_menu_first_item: queryRect(cache, '[data-programs-menu-idx="0"]', args.origin),
      programs_menu_panel: queryRect(cache, '[data-shell-programs-menu-panel]', args.origin),
      programs_menu_list: queryRect(cache, '[data-programs-menu-scroll]', args.origin),
      tab_menu_pin: queryRect(cache, '[data-tab-menu-idx="0"]', args.origin),
      tab_menu_unpin: queryRect(cache, '[data-tab-menu-idx="0"]', args.origin),
      tab_menu_use_split_left: queryRect(cache, '[data-tab-menu-action="use-split-left"]', args.origin),
      tab_menu_exit_split: queryRect(cache, '[data-tab-menu-action="exit-split"]', args.origin),
      settings_tab_user: queryRect(cache, '[data-settings-tab="user"]', args.origin),
      settings_tab_displays: queryRect(cache, '[data-settings-tab="displays"]', args.origin),
      settings_tab_tiling: queryRect(cache, '[data-settings-tab="tiling"]', args.origin),
      settings_tab_scratchpads: queryRect(cache, '[data-settings-tab="scratchpads"]', args.origin),
      settings_tab_keyboard: queryRect(cache, '[data-settings-tab="keyboard"]', args.origin),
      settings_tab_default_applications: queryRect(cache, '[data-settings-tab="default-applications"]', args.origin),
      settings_scratchpads_page: queryRect(cache, '[data-settings-scratchpads-page]', args.origin),
      settings_scratchpad_window_inspector: queryRect(
        cache,
        '[data-settings-scratchpad-window-inspector]',
        args.origin,
      ),
      settings_scratchpad_list: queryRect(cache, '[data-settings-scratchpad-list]', args.origin),
      settings_scratchpad_save: queryRect(cache, '[data-settings-scratchpad-save]', args.origin),
      settings_tiling_layout_trigger: settingsTilingLayoutTriggerRect,
      settings_tiling_layout_option_grid: queryRect(
        cache,
        '[data-settings-tiling-layout-option="grid"]',
        args.origin,
      ),
      settings_tiling_layout_option_custom_auto: queryRect(
        cache,
        '[data-settings-tiling-layout-option="custom-auto"]',
        args.origin,
      ),
      settings_tiling_layout_option_manual_snap: queryRect(
        cache,
        '[data-settings-tiling-layout-option="manual-snap"]',
        args.origin,
      ),
      settings_snap_layout_option_2x2: queryRect(
        cache,
        '[data-settings-snap-layout-option="2x2"]',
        args.origin,
      ),
      settings_snap_layout_option_3x2: queryRect(
        cache,
        '[data-settings-snap-layout-option="3x2"]',
        args.origin,
      ),
      settings_snap_layout_option_custom: queryRect(
        cache,
        '[data-settings-snap-layout-option-custom]',
        args.origin,
      ),
      settings_custom_layout_add: queryRect(
        cache,
        settingsMonitorName
          ? `[data-settings-custom-layout-open-overlay][data-settings-custom-layout-monitor="${settingsMonitorName}"]`
          : '[data-settings-custom-layout-open-overlay]',
        args.origin,
      ),
      custom_layout_overlay_root: queryRect(cache, '[data-custom-layout-overlay]', args.origin),
      custom_layout_overlay_add: queryRect(cache, '[data-custom-layout-overlay-add]', args.origin),
      custom_layout_overlay_save: queryRect(cache, '[data-custom-layout-overlay-save]', args.origin),
      custom_layout_overlay_close: queryRect(cache, '[data-custom-layout-overlay-close]', args.origin),
      custom_layout_overlay_zone_rules: queryRect(
        cache,
        '[data-custom-layout-overlay-zone-rules]',
        args.origin,
      ),
      custom_layout_overlay_selected_zone_rules: queryRect(
        cache,
        '[data-custom-layout-overlay-zone-rules][data-custom-layout-overlay-zone-rules-selected]',
        args.origin,
      ),
      custom_layout_overlay_rule_add: queryRect(
        cache,
        '[data-custom-layout-overlay-rule-add]',
        args.origin,
      ),
      custom_layout_overlay_rule_value: queryRect(
        cache,
        '[data-custom-layout-overlay-rule-value]',
        args.origin,
      ),
      settings_custom_layout_split_vertical: queryRect(
        cache,
        '[data-custom-layout-overlay-split-vertical]',
        args.origin,
      ),
      settings_custom_layout_split_horizontal: queryRect(
        cache,
        '[data-custom-layout-overlay-split-horizontal]',
        args.origin,
      ),
      settings_custom_layout_delete_zone: queryRect(
        cache,
        '[data-custom-layout-overlay-delete-zone]',
        args.origin,
      ),
      settings_custom_layout_editor_zone: queryLargestRect(
        cache,
        '[data-custom-layout-overlay-zone]',
        args.origin,
      ),
      settings_custom_layout_preview_first: queryRect(
        cache,
        '[data-custom-layout-overlay-preview="first"]',
        args.origin,
      ),
      settings_custom_layout_preview_second: queryRect(
        cache,
        '[data-custom-layout-overlay-preview="second"]',
        args.origin,
      ),
      settings_default_app_image: queryRect(cache, '[data-default-app-select="image"]', args.origin),
      settings_session_autosave_enable: queryRect(cache, '[data-settings-session-autosave-enable]', args.origin),
      settings_session_autosave_disable: queryRect(cache, '[data-settings-session-autosave-disable]', args.origin),
      power_menu_save_session: powerMenuRect('[data-power-menu-action="save-session"]'),
      power_menu_restore_session: powerMenuRect('[data-power-menu-action="restore-session"]'),
      power_menu_restart: powerMenuRect('[data-power-menu-action="restart"]'),
      power_menu_shutdown: powerMenuRect('[data-power-menu-action="shutdown"]'),
      debug_reload_button: queryRect(cache, '[data-shell-debug-reload]', args.origin),
      debug_copy_snapshot_button: queryRect(cache, '[data-shell-debug-copy-snapshot]', args.origin),
      debug_crosshair_toggle: queryRect(cache, '[data-shell-debug-crosshair-toggle]', args.origin),
      snap_strip_trigger: queryRect(cache, '[data-shell-snap-strip-trigger]', args.origin),
      snap_picker_root: queryRect(cache, '[data-shell-snap-picker]', args.origin),
      snap_picker_first_cell: queryLargestRect(
        cache,
        '[data-shell-snap-picker] [data-assist-mini-grid="3x2"] [data-testid="snap-assist-master-cell"]',
        args.origin,
      ),
      snap_picker_2x2_top_right_cell: queryLargestRect(
        cache,
        '[data-shell-snap-picker] [data-assist-mini-grid="2x2"] [data-testid="snap-assist-2x2-top-right-cell"]',
        args.origin,
      ),
      snap_picker_top_center_cell: queryLargestRect(
        cache,
        '[data-shell-snap-picker] [data-assist-mini-grid="3x2"] [data-assist-grid-span][data-grid-cols="3"][data-gc0="1"][data-gc1="1"][data-gr0="0"][data-gr1="0"]',
        args.origin,
      ),
      snap_picker_hgutter_col0: queryLargestRect(
        cache,
        '[data-shell-snap-picker] [data-assist-mini-grid="3x2"] [data-testid="snap-assist-hgutter-col0"]',
        args.origin,
      ),
      snap_picker_right_two_thirds: queryLargestRect(
        cache,
        '[data-shell-snap-picker] [data-assist-mini-grid="3x2"] [data-assist-grid-span][data-grid-cols="3"][data-gc0="1"][data-gc1="2"][data-gr0="0"][data-gr1="1"]',
        args.origin,
      ),
      snap_picker_top_two_thirds_left: queryLargestRect(
        cache,
        '[data-shell-snap-picker] [data-assist-mini-grid="3x3"] [data-assist-grid-span][data-grid-cols="3"][data-gc0="0"][data-gc1="0"][data-gr0="0"][data-gr1="1"]',
        args.origin,
      ),
      snap_picker_hover_overlay: queryRect(
        cache,
        '[data-shell-snap-picker] [data-assist-grid-hover-overlay]',
        args.origin,
      ),
      snap_picker_custom_zone: queryLargestRect(
        cache,
        '[data-shell-snap-picker] [data-snap-picker-custom-zone]',
        args.origin,
      ),
    },
    taskbars: taskbarButtons,
    taskbar_windows: taskbarWindowButtons,
    window_controls: windowControls,
  }
}

export function buildE2eShellHtml(doc: Document, selector?: string | null): string {
  if (selector && selector.trim().length > 0) {
    return (doc.querySelector(selector)?.outerHTML ?? '').toString()
  }
  return doc.documentElement.outerHTML
}
