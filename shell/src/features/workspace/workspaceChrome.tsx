import { canvasRectToClientCss } from '@/lib/shellCoords'
import { SHELL_LAYOUT_FLOATING } from '@/lib/chromeConstants'
import { ShellWindowFrame, type ShellWindowModel } from '@/host/ShellWindowFrame'
import { WorkspaceTabStrip } from './WorkspaceTabStrip'
import { findMergeTarget, splitLeftWindowId, type TabMergeTarget } from './tabGroupOps'
import { clampWorkspaceSplitPaneFraction, type WorkspaceSnapshot } from './workspaceSnapshot'
import type { WorkspaceGroupModel } from './workspaceSelectors'
import { isShellTestWindowId, SHELL_UI_DEBUG_WINDOW_ID, SHELL_UI_SETTINGS_WINDOW_ID } from '@/features/shell-ui/backedShellWindows'
import { SHELL_WINDOW_FLAG_SCRATCHPAD, SHELL_WINDOW_FLAG_SHELL_HOSTED, type ShellUiMeasureEnv } from '@/features/shell-ui/shellUiWindows'
import type { DerpWindow } from '@/host/appWindowState'
import type { SnapAssistPickerSource } from '@/host/types'
import { createEffect, createMemo, createSignal, onCleanup, For, Show, type Accessor, type JSX } from 'solid-js'

type TabDragState = {
  pointerId: number
  windowId: number
  sourceGroupId: string
  startClientX: number
  startClientY: number
  currentClientX: number
  currentClientY: number
  dragging: boolean
  detached: boolean
  target: TabMergeTarget | null
}

function isShellHostedWorkspaceWindow(window: DerpWindow | undefined): boolean {
  return !!window && (
    (window.shell_flags & SHELL_WINDOW_FLAG_SHELL_HOSTED) !== 0 ||
    window.window_id === SHELL_UI_DEBUG_WINDOW_ID ||
    window.window_id === SHELL_UI_SETTINGS_WINDOW_ID ||
    isShellTestWindowId(window.window_id)
  )
}

function sameWindowIdList(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export type WorkspaceExternalTabDropDrag = {
  target: TabMergeTarget | null
  clientX: number
  clientY: number
  label: string
  canDrop: boolean
}

type SplitGroupRect = {
  x: number
  y: number
  width: number
  height: number
}

type SplitLayoutRects = {
  group: SplitGroupRect
  left: SplitGroupRect
  right: SplitGroupRect
  leftWindowId: number
  rightWindowIds: number[]
}

type NativeDragPreviewMetrics = {
  sourceWidth: number
  sourceHeight: number
  backingWidth: number
  backingHeight: number
}

type SplitGroupGestureState = {
  pointerId: number
  groupId: string
  kind: 'divider' | 'move' | 'resize'
  edges: number
  startGlobalX: number
  startGlobalY: number
  originGroupRect: SplitGroupRect
}

const WORKSPACE_SPLIT_DIVIDER_PX = 4
const WORKSPACE_SPLIT_MIN_PANE_PX = 160
const WORKSPACE_SPLIT_MIN_HEIGHT_PX = 140

type WorkspaceChromeOptions = {
  workspaceSnapshot: Accessor<WorkspaceSnapshot>
  workspaceGroupsById: Accessor<ReadonlyMap<string, WorkspaceGroupModel>>
  workspaceGroups: Accessor<readonly WorkspaceGroupModel[]>
  activeWorkspaceGroupId: Accessor<string | null>
  focusedWindowId: Accessor<number | null>
  allWindowsMap: Accessor<ReadonlyMap<number, DerpWindow>>
  windowById: (windowId: number) => Accessor<DerpWindow | undefined>
  outputGeom: Accessor<{ w: number; h: number } | null>
  layoutCanvasOrigin: Accessor<{ x: number; y: number } | null>
  getMainRef: () => HTMLElement | undefined
  snapChromeRev: Accessor<number>
  shellPointerGlobalLogical: (clientX: number, clientY: number) => { x: number; y: number } | null
  rectFromWindow: (window: Pick<DerpWindow, 'x' | 'y' | 'width' | 'height'>) => SplitGroupRect
  renderShellWindowContent: (windowId: number) => JSX.Element | undefined
  interactionFrameForWindow: (windowId: number) => {
    x: number
    y: number
    width: number
    height: number
    maximized: boolean
    fullscreen: boolean
  } | null
  pointerClient: Accessor<{ x: number; y: number } | null>
  compositorPointerClient: Accessor<{ x: number; y: number } | null>
  shellWindowDragId: Accessor<number | null>
  shellWindowDragMoved: Accessor<boolean>
  compositorMoveWindowId: Accessor<number | null>
  compositorMoveProxyWindowId: Accessor<number | null>
  compositorMoveCaptureWindowId: Accessor<number | null>
  nativeDragPreview: Accessor<{
    window_id: number
    generation: number
    image_path: string
    src: string
    loaded: boolean
    image: HTMLImageElement | null
  } | null>
  focusShellUiWindow: (windowId: number) => void
  activateTaskbarWindowViaShell: (windowId: number) => void
  focusWindowViaShell: (windowId: number) => void
  beginShellWindowMove: (windowId: number, clientX: number, clientY: number) => void
  adoptShellWindowMove: (windowId: number, clientX: number, clientY: number, moved?: boolean) => boolean
  beginShellWindowResize: (windowId: number, edges: number, clientX: number, clientY: number) => void
  toggleShellMaximizeForWindow: (windowId: number) => void
  closeWindow: (windowId: number) => void
  closeGroupWindow: (windowId: number) => void
  selectGroupWindow: (windowId: number) => boolean
  setSplitGroupFraction: (groupId: string, fraction: number) => void
  applyTabDrop: (windowId: number, target: TabMergeTarget) => boolean
  applyWindowDrop: (windowId: number, target: TabMergeTarget) => boolean
  detachGroupWindow: (windowId: number, clientX: number, clientY: number) => boolean
  workspaceGroupIdForWindow: (windowId: number) => string | null
  isWorkspaceWindowTiled: (windowId: number) => boolean
  isWorkspaceWindowPinned: (windowId: number) => boolean
  openSnapAssistPicker: (
    windowId: number,
    source: SnapAssistPickerSource,
    anchorRect: DOMRect,
    autoHover?: boolean,
    preferredMonitorName?: string | null,
  ) => void
  shellContextOpenTabMenu: (windowId: number, clientX: number, clientY: number) => void
  shellContextHideMenu: () => void
  externalTabDropDrag: Accessor<WorkspaceExternalTabDropDrag | null>
  shellWireSend: (
    op:
      | 'set_geometry'
      | 'taskbar_activate'
      | 'minimize'
      | 'shell_ui_grab_begin'
      | 'shell_ui_grab_end',
    arg?: number | string,
    arg2?: number | string,
    arg3?: number,
    arg4?: number,
    arg5?: number,
    arg6?: number,
  ) => boolean
}

function NativeDragPreviewCanvas(props: {
  image: HTMLImageElement | null
  onMetrics: (metrics: NativeDragPreviewMetrics | null) => void
}) {
  let canvas: HTMLCanvasElement | undefined

  const draw = () => {
    const image = props.image
    if (!canvas || !image || !image.complete) return
    const sourceWidth = image.naturalWidth
    const sourceHeight = image.naturalHeight
    if (sourceWidth < 1 || sourceHeight < 1) return
    const backingWidth = sourceWidth
    const backingHeight = sourceHeight
    if (canvas.width !== backingWidth) canvas.width = backingWidth
    if (canvas.height !== backingHeight) canvas.height = backingHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, backingWidth, backingHeight)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(image, 0, 0, backingWidth, backingHeight)
    props.onMetrics({ sourceWidth, sourceHeight, backingWidth, backingHeight })
  }

  createEffect(() => {
    props.onMetrics(null)
    draw()
  })

  return (
    <canvas
      ref={(el) => {
        canvas = el
      }}
      class="pointer-events-none block h-full w-full select-none"
    />
  )
}

export function createWorkspaceChrome(options: WorkspaceChromeOptions) {
  const [tabDragState, setTabDragState] = createSignal<TabDragState | null>(null)
  const [splitGroupGesture, setSplitGroupGesture] = createSignal<SplitGroupGestureState | null>(null)
  const [suppressTabClickWindowId, setSuppressTabClickWindowId] = createSignal<number | null>(null)
  const appliedSplitGroupLayoutKeys = new Map<string, string>()
  let tabDragPointerGrab = false

  function endTabDragPointerGrab() {
    if (!tabDragPointerGrab) return
    tabDragPointerGrab = false
    options.shellWireSend('shell_ui_grab_end')
  }

  function beginShellUiPointerGrab(windowId: number | null | undefined) {
    const nextWindowId = typeof windowId === 'number' && Number.isFinite(windowId) ? Math.trunc(windowId) : 0
    if (nextWindowId <= 0) return false
    return options.shellWireSend('shell_ui_grab_begin', nextWindowId)
  }

  function splitLayoutForGroup(
    group: WorkspaceGroupModel,
    overrideGroupRect?: SplitGroupRect,
  ): SplitLayoutRects | null {
    if (!group.splitLeftWindow || group.splitPaneFraction === null) return null
    const stateGroup = options.workspaceSnapshot().groups.find((entry) => entry.id === group.id)
    if (!stateGroup) return null
    const rightWindowIds = stateGroup.windowIds.filter((windowId) => windowId !== group.splitLeftWindowId)
    if (rightWindowIds.length === 0) return null
    const leftWindow = group.splitLeftWindow
    const rightWindow = group.visibleWindow
    const overlapping =
      leftWindow.x === rightWindow.x &&
      leftWindow.y === rightWindow.y &&
      leftWindow.width === rightWindow.width &&
      leftWindow.height === rightWindow.height
    const groupRect =
      overrideGroupRect ??
      (overlapping
        ? options.rectFromWindow(rightWindow)
        : {
            x: Math.min(leftWindow.x, rightWindow.x),
            y: Math.min(leftWindow.y, rightWindow.y),
            width:
              Math.max(leftWindow.x + leftWindow.width, rightWindow.x + rightWindow.width) -
              Math.min(leftWindow.x, rightWindow.x),
            height:
              Math.max(leftWindow.y + leftWindow.height, rightWindow.y + rightWindow.height) -
              Math.min(leftWindow.y, rightWindow.y),
          })
    const contentWidth = Math.max(2 * WORKSPACE_SPLIT_MIN_PANE_PX, groupRect.width)
    const leftWidth = Math.max(
      WORKSPACE_SPLIT_MIN_PANE_PX,
      Math.min(
        contentWidth - WORKSPACE_SPLIT_MIN_PANE_PX,
        Math.round(contentWidth * clampWorkspaceSplitPaneFraction(group.splitPaneFraction)),
      ),
    )
    const rightWidth = Math.max(WORKSPACE_SPLIT_MIN_PANE_PX, contentWidth - leftWidth)
    return {
      group: {
        x: groupRect.x,
        y: groupRect.y,
        width: leftWidth + rightWidth,
        height: Math.max(WORKSPACE_SPLIT_MIN_HEIGHT_PX, groupRect.height),
      },
      left: {
        x: groupRect.x,
        y: groupRect.y,
        width: leftWidth,
        height: Math.max(WORKSPACE_SPLIT_MIN_HEIGHT_PX, groupRect.height),
      },
      right: {
        x: groupRect.x + leftWidth,
        y: groupRect.y,
        width: rightWidth,
        height: Math.max(WORKSPACE_SPLIT_MIN_HEIGHT_PX, groupRect.height),
      },
      leftWindowId: group.splitLeftWindowId!,
      rightWindowIds,
    }
  }

  function applySplitGroupGeometry(groupId: string, overrideGroupRect?: SplitGroupRect) {
    const group = options.workspaceGroupsById().get(groupId)
    if (!group) return null
    const layout = splitLayoutForGroup(group, overrideGroupRect)
    if (!layout) return null
    for (const windowId of [layout.leftWindowId, ...layout.rightWindowIds]) {
      const rect = windowId === layout.leftWindowId ? layout.left : layout.right
      options.shellWireSend(
        'set_geometry',
        windowId,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        SHELL_LAYOUT_FLOATING,
      )
    }
    const leftWindow = options.allWindowsMap().get(layout.leftWindowId)
    const rightWindow = options.allWindowsMap().get(group.visibleWindowId)
    if (leftWindow?.minimized) options.shellWireSend('taskbar_activate', layout.leftWindowId)
    if (rightWindow?.minimized) queueMicrotask(() => options.activateTaskbarWindowViaShell(group.visibleWindowId))
    return layout
  }

  function findTabMergeTargetFromPointer(
    windowId: number,
    clientX: number,
    clientY: number,
    ignoreDraggedWindowFrame: boolean,
  ) {
    const state = options.workspaceSnapshot()
    const direct = findMergeTarget(state, windowId, clientX, clientY, ignoreDraggedWindowFrame)
    if (direct) return direct
    const main = options.getMainRef()
    const og = options.outputGeom()
    if (!main || !og) return null
    const { x: globalX, y: globalY } = options.shellPointerGlobalLogical(clientX, clientY) ?? {
      x: Math.round(clientX),
      y: Math.round(clientY),
    }
    const origin = options.layoutCanvasOrigin()
    const client = canvasRectToClientCss(
      globalX - (origin?.x ?? 0),
      globalY - (origin?.y ?? 0),
      0,
      0,
      main.getBoundingClientRect(),
      og.w,
      og.h,
    )
    return findMergeTarget(state, windowId, client.left, client.top, ignoreDraggedWindowFrame)
  }

  function refreshTabDragTarget(pointerId: number) {
    setTabDragState((current) => {
      if (!current || current.pointerId !== pointerId || !current.dragging || current.detached) return current
      const ignoreDraggedWindowFrame =
        current.detached || (options.workspaceGroupsById().get(current.sourceGroupId)?.members.length ?? 0) <= 1
      const nextTarget = findTabMergeTargetFromPointer(
        current.windowId,
        current.currentClientX,
        current.currentClientY,
        ignoreDraggedWindowFrame,
      )
      if (
        current.target?.groupId === nextTarget?.groupId &&
        current.target?.insertIndex === nextTarget?.insertIndex
      ) {
        return current
      }
      return {
        ...current,
        target: nextTarget,
      }
    })
  }

  function resolveWindowDragTarget(windowId: number, clientX: number, clientY: number) {
    const sourceGroupId = options.workspaceGroupIdForWindow(windowId)
    if (!sourceGroupId) return null
    const sourceGroup = options.workspaceGroupsById().get(sourceGroupId) ?? null
    if (!sourceGroup || sourceGroup.splitLeftWindowId !== null) return null
    const target = findTabMergeTargetFromPointer(windowId, clientX, clientY, true)
    if (!target || target.groupId === sourceGroupId) return null
    return target
  }

  function startTabPointerGesture(
    windowId: number,
    pointerId: number,
    clientX: number,
    clientY: number,
    button: number,
  ) {
    if (button !== 0) return
    const sourceGroupId = options.workspaceGroupIdForWindow(windowId)
    if (!sourceGroupId) return
    if (splitLeftWindowId(options.workspaceSnapshot(), sourceGroupId) === windowId) return
    const sourceGroup = options.workspaceGroupsById().get(sourceGroupId) ?? null
    if (sourceGroup && sourceGroup.members.length <= 1) {
      options.beginShellWindowMove(windowId, clientX, clientY)
      return
    }
    const grabWindowId =
      sourceGroup?.visibleWindowId ?? sourceGroup?.splitLeftWindowId ?? sourceGroup?.members[0]?.window_id ?? windowId
    options.shellContextHideMenu()
    setSuppressTabClickWindowId(null)
    if (!tabDragPointerGrab && beginShellUiPointerGrab(grabWindowId)) {
      tabDragPointerGrab = true
    }
    setTabDragState({
      pointerId,
      windowId,
      sourceGroupId,
      startClientX: clientX,
      startClientY: clientY,
      currentClientX: clientX,
      currentClientY: clientY,
      dragging: false,
      detached: false,
      target: null,
    })
  }

  function finishTabPointerGesture(pointerId: number, clientX: number, clientY: number) {
    const drag = tabDragState()
    if (!drag || drag.pointerId !== pointerId) return
    try {
    const dragDistance = Math.hypot(clientX - drag.startClientX, clientY - drag.startClientY)
    const dragging = drag.dragging || dragDistance >= 40
    const ignoreDraggedWindowFrame =
      drag.detached || (options.workspaceGroupsById().get(drag.sourceGroupId)?.members.length ?? 0) <= 1
    const nextTarget = dragging
      ? findTabMergeTargetFromPointer(drag.windowId, clientX, clientY, ignoreDraggedWindowFrame) ?? drag.target
      : drag.target
    const merged = dragging && nextTarget ? options.applyTabDrop(drag.windowId, nextTarget) : false
    const clickTarget = !dragging
      ? (document
          .elementsFromPoint(clientX, clientY)
          .find(
            (element) =>
              element instanceof HTMLElement && element.closest(`[data-workspace-tab="${drag.windowId}"]`),
          ) ?? null)
      : null
    const changed = merged || drag.detached
    if (changed) {
      setTabDragState(null)
      setSuppressTabClickWindowId(drag.windowId)
      return
    }
    if (clickTarget) {
      setTabDragState(null)
      setSuppressTabClickWindowId(drag.windowId)
      options.selectGroupWindow(drag.windowId)
      return
    }
    queueMicrotask(() => {
      setTabDragState((current) => (current?.pointerId === pointerId ? null : current))
    })
    } finally {
      endTabDragPointerGrab()
    }
  }

  function beginSplitGroupGesture(
    groupId: string,
    pointerId: number,
    kind: SplitGroupGestureState['kind'],
    edges: number,
    clientX: number,
    clientY: number,
  ) {
    if (splitGroupGesture()) return false
    const group = options.workspaceGroupsById().get(groupId)
    if (!group) return false
    const layout = splitLayoutForGroup(group)
    const global = options.shellPointerGlobalLogical(clientX, clientY)
    if (!layout || !global) return false
    setSplitGroupGesture({
      pointerId,
      groupId,
      kind,
      edges,
      startGlobalX: global.x,
      startGlobalY: global.y,
      originGroupRect: layout.group,
    })
    if (!beginShellUiPointerGrab(group.visibleWindowId ?? group.splitLeftWindowId ?? group.members[0]?.window_id)) {
      setSplitGroupGesture(null)
      return false
    }
    return true
  }

  function updateSplitGroupGesture(pointerId: number, clientX: number, clientY: number) {
    const gesture = splitGroupGesture()
    if (!gesture || gesture.pointerId !== pointerId) return
    const global = options.shellPointerGlobalLogical(clientX, clientY)
    if (!global) return
    if (gesture.kind === 'divider') {
      const group = options.workspaceGroupsById().get(gesture.groupId)
      if (!group) return
      const relativeX = Math.max(
        0,
        Math.min(gesture.originGroupRect.width, global.x - gesture.originGroupRect.x),
      )
      const fraction = clampWorkspaceSplitPaneFraction(relativeX / Math.max(1, gesture.originGroupRect.width))
      options.setSplitGroupFraction(gesture.groupId, fraction)
      applySplitGroupGeometry(gesture.groupId, gesture.originGroupRect)
      return
    }
    const dx = global.x - gesture.startGlobalX
    const dy = global.y - gesture.startGlobalY
    let nextRect = { ...gesture.originGroupRect }
    if (gesture.kind === 'move') {
      nextRect = {
        ...nextRect,
        x: gesture.originGroupRect.x + dx,
        y: gesture.originGroupRect.y + dy,
      }
    } else {
      if ((gesture.edges & 1) !== 0) {
        const maxLeft =
          gesture.originGroupRect.x + gesture.originGroupRect.width - 2 * WORKSPACE_SPLIT_MIN_PANE_PX
        const nextX = Math.min(gesture.originGroupRect.x + dx, maxLeft)
        nextRect.x = nextX
        nextRect.width = gesture.originGroupRect.width + (gesture.originGroupRect.x - nextX)
      }
      if ((gesture.edges & 4) !== 0) {
        nextRect.width = Math.max(
          2 * WORKSPACE_SPLIT_MIN_PANE_PX,
          gesture.originGroupRect.width + dx,
        )
      }
      if ((gesture.edges & 8) !== 0) {
        nextRect.height = Math.max(WORKSPACE_SPLIT_MIN_HEIGHT_PX, gesture.originGroupRect.height + dy)
      }
    }
    applySplitGroupGeometry(gesture.groupId, nextRect)
  }

  function cancelSplitGroupGesture() {
    if (!splitGroupGesture()) return
    setSplitGroupGesture(null)
    options.shellWireSend('shell_ui_grab_end')
  }

  function endSplitGroupGesture(pointerId: number) {
    const gesture = splitGroupGesture()
    if (!gesture || gesture.pointerId !== pointerId) return
    cancelSplitGroupGesture()
  }

  const onTabDragPointerMove = (event: PointerEvent) => {
    const prev = tabDragState()
    if (!prev || prev.pointerId !== event.pointerId) return
    const dx = event.clientX - prev.startClientX
    const dy = event.clientY - prev.startClientY
    const dragDistance = Math.hypot(dx, dy)
    const dragging = prev.dragging || dragDistance >= 40
    const ignoreDraggedWindowFrame =
      prev.detached || (options.workspaceGroupsById().get(prev.sourceGroupId)?.members.length ?? 0) <= 1
    const target = dragging
      ? findTabMergeTargetFromPointer(prev.windowId, event.clientX, event.clientY, ignoreDraggedWindowFrame)
      : null
    const state = options.workspaceSnapshot()
    const splitLeftTabEl =
      typeof document !== 'undefined'
        ? document.querySelector(
            `[data-workspace-tab-strip="${prev.sourceGroupId}"] [data-workspace-split-left-tab]`,
          )
        : null
    const splitLeftFromDom =
      splitLeftTabEl instanceof HTMLElement ? Number(splitLeftTabEl.getAttribute('data-workspace-tab')) : NaN
    const splitLeftId = Number.isFinite(splitLeftFromDom)
      ? Math.trunc(splitLeftFromDom)
      : splitLeftWindowId(state, prev.sourceGroupId)
    const splitRightStripDrag = splitLeftId !== null && prev.windowId !== splitLeftId
    const crossGroupMerge = target !== null && target.groupId !== prev.sourceGroupId
    const splitVerticalTear = splitRightStripDrag && Math.abs(dy) >= 64 && !crossGroupMerge
    const classicTear = !splitRightStripDrag && target === null && Math.abs(dy) >= 64
    let detached = prev.detached
    if (dragging && !detached && (splitVerticalTear || classicTear)) {
      detached = options.detachGroupWindow(prev.windowId, event.clientX, event.clientY)
    }
    setTabDragState({
      ...prev,
      currentClientX: event.clientX,
      currentClientY: event.clientY,
      dragging,
      detached,
      target,
    })
  }

  const onTabDragPointerUp = (event: PointerEvent) => {
    finishTabPointerGesture(event.pointerId, event.clientX, event.clientY)
  }

  const onTabDragPointerCancel = (event: PointerEvent) => {
    const prev = tabDragState()
    if (!prev || prev.pointerId !== event.pointerId) return
    endTabDragPointerGrab()
    setTabDragState(null)
  }

  const onSplitGroupPointerMove = (event: PointerEvent) => {
    updateSplitGroupGesture(event.pointerId, event.clientX, event.clientY)
  }

  const onSplitGroupPointerUp = (event: PointerEvent) => {
    endSplitGroupGesture(event.pointerId)
  }

  const onSplitGroupPointerCancel = (event: PointerEvent) => {
    endSplitGroupGesture(event.pointerId)
  }

  const onWindowDragPointerUp = (event: PointerEvent) => {
    finishWindowDragDrop({ x: event.clientX, y: event.clientY })
  }

  createEffect(() => {
    const activeSplitGesture = splitGroupGesture()
    const nextKeys = new Map<string, string>()
    for (const group of options.workspaceGroups()) {
      if (group.splitLeftWindowId === null || group.splitPaneFraction === null) continue
      if (activeSplitGesture?.groupId === group.id) continue
      const key = `${group.splitLeftWindowId}:${group.visibleWindowId}:${group.splitPaneFraction}`
      nextKeys.set(group.id, key)
      if (appliedSplitGroupLayoutKeys.get(group.id) === key) continue
      queueMicrotask(() => {
        applySplitGroupGeometry(group.id)
      })
    }
    appliedSplitGroupLayoutKeys.clear()
    for (const [groupId, key] of nextKeys) appliedSplitGroupLayoutKeys.set(groupId, key)
  })

  createEffect(() => {
    const drag = tabDragState()
    if (!drag?.dragging || drag.detached) return
    let frame = 0
    const update = () => {
      refreshTabDragTarget(drag.pointerId)
      const current = tabDragState()
      if (!current || current.pointerId !== drag.pointerId || !current.dragging || current.detached) return
      frame = requestAnimationFrame(update)
    }
    frame = requestAnimationFrame(update)
    onCleanup(() => cancelAnimationFrame(frame))
  })

  createEffect(() => {
    const drag = tabDragState()
    if (!drag?.detached) return
    if (options.compositorMoveWindowId() !== drag.windowId) return
    if (!options.adoptShellWindowMove(drag.windowId, drag.currentClientX, drag.currentClientY, drag.dragging)) {
      return
    }
    endTabDragPointerGrab()
    setSuppressTabClickWindowId(drag.windowId)
    setTabDragState(null)
  })

  const activeMoveProxyWindowId = createMemo(() => options.compositorMoveProxyWindowId())
  const activeWindowDragWindowId = createMemo(() => {
    if (tabDragState()) return null
    const localWindowId = options.shellWindowDragId()
    if (localWindowId !== null && options.shellWindowDragMoved()) return localWindowId
    return options.compositorMoveWindowId()
  })
  const [lastWindowDragPointerClient, setLastWindowDragPointerClient] = createSignal<{
    x: number
    y: number
  } | null>(null)
  const [lastWindowDragWindowId, setLastWindowDragWindowId] = createSignal<number | null>(null)
  const [lastWindowDragTarget, setLastWindowDragTarget] = createSignal<TabMergeTarget | null>(null)

  const windowDragPointerClient = () => options.compositorPointerClient() ?? options.pointerClient()

  const activeWindowDragTarget = createMemo(() => {
    const windowId = activeWindowDragWindowId()
    const pointer = windowDragPointerClient()
    if (windowId == null || !pointer) return null
    return resolveWindowDragTarget(windowId, pointer.x, pointer.y)
  })

  createEffect(() => {
    const windowId = activeWindowDragWindowId()
    if (windowId === null) return
    setLastWindowDragWindowId(windowId)
    const pointer = windowDragPointerClient()
    if (pointer) setLastWindowDragPointerClient({ x: pointer.x, y: pointer.y })
    const target = activeWindowDragTarget()
    if (target) setLastWindowDragTarget(target)
  })

  const activeFrameDragWindowId = createMemo(() => activeWindowDragWindowId())
  const activeDragWindowId = createMemo(() => {
    const tabDrag = tabDragState()
    if (tabDrag && (tabDrag.dragging || tabDrag.detached)) return tabDrag.windowId
    return activeWindowDragWindowId()
  })
  const activeDropTarget = createMemo(() => {
    const tabDrag = tabDragState()
    if (tabDrag && (tabDrag.dragging || tabDrag.detached)) return tabDrag.target
    const windowTarget = activeWindowDragTarget()
    if (windowTarget) return windowTarget
    return options.externalTabDropDrag()?.target ?? null
  })

  document.addEventListener('pointermove', onTabDragPointerMove, true)
  document.addEventListener('pointerup', onTabDragPointerUp, true)
  document.addEventListener('pointercancel', onTabDragPointerCancel, true)
  document.addEventListener('pointermove', onSplitGroupPointerMove, true)
  document.addEventListener('pointerup', onSplitGroupPointerUp, true)
  document.addEventListener('pointercancel', onSplitGroupPointerCancel, true)
  document.addEventListener('pointerup', onWindowDragPointerUp, true)
  onCleanup(() => {
    document.removeEventListener('pointermove', onTabDragPointerMove, true)
    document.removeEventListener('pointerup', onTabDragPointerUp, true)
    document.removeEventListener('pointercancel', onTabDragPointerCancel, true)
    document.removeEventListener('pointermove', onSplitGroupPointerMove, true)
    document.removeEventListener('pointerup', onSplitGroupPointerUp, true)
    document.removeEventListener('pointercancel', onSplitGroupPointerCancel, true)
    document.removeEventListener('pointerup', onWindowDragPointerUp, true)
  })

  function WorkspaceGroupFrame(props: { groupId: string }) {
    const group = createMemo(() => options.workspaceGroupsById().get(props.groupId) ?? null)
    const visibleWindowId = createMemo(() => group()?.visibleWindowId ?? null)
    const visibleWindowAccessor = createMemo(() => {
      const currentVisibleWindowId = visibleWindowId()
      return currentVisibleWindowId == null ? null : options.windowById(currentVisibleWindowId)
    })
    const visibleWindow = createMemo(() => {
      const accessor = visibleWindowAccessor()
      return accessor ? accessor() : undefined
    })
    const shellHostedMemberWindowIds = createMemo(() => {
      const g = group()
      if (!g) return [] as readonly number[]
      return g.members
        .filter((w) => isShellHostedWorkspaceWindow(w))
        .map((w) => w.window_id)
    })
    const visibleShellHostedMemberWindowIds = createMemo(() => {
      const visibleIds = new Set(group()?.visibleWindowIds ?? [])
      return shellHostedMemberWindowIds().filter((windowId) => visibleIds.has(windowId))
    })
    const nativeDragPreview = createMemo(() => {
      const window = visibleWindow()
      if (!window || isShellHostedWorkspaceWindow(window)) return null
      const preview = options.nativeDragPreview()
      return preview && preview.window_id === window.window_id ? preview : null
    })
    const nativeDragPreviewVisible = createMemo(() => {
      const preview = nativeDragPreview()
      const window = visibleWindow()
      if (!preview || !window || !preview.loaded) return null
      const windowId = window.window_id
      return options.compositorMoveWindowId() === windowId ||
        options.compositorMoveProxyWindowId() === windowId ||
        options.compositorMoveCaptureWindowId() === windowId
        ? preview
        : null
    })
    const nativeDragPreviewKey = createMemo(() => {
      const preview = nativeDragPreviewVisible()
      return preview ? `${preview.window_id}:${preview.generation}:${preview.image_path}` : null
    })
    const [nativeDragPreviewMetrics, setNativeDragPreviewMetrics] =
      createSignal<NativeDragPreviewMetrics | null>(null)
    createEffect(() => {
      nativeDragPreviewKey()
      setNativeDragPreviewMetrics(null)
    })
    const nativeDragPreviewLoaded = createMemo(() => {
      return nativeDragPreviewVisible()?.loaded ?? false
    })
    const nativeDragPreviewSrc = createMemo(() => {
      const preview = nativeDragPreviewVisible()
      if (!preview) return ''
      return preview.src
    })
    const keepShellContentMounted = createMemo(() => shellHostedMemberWindowIds().length > 0)
    const splitLayout = createMemo(() => {
      const currentGroup = group()
      return currentGroup ? splitLayoutForGroup(currentGroup) : null
    })
    const detachedNativeAwaitingMove = createMemo(() => {
      const window = visibleWindow()
      const drag = tabDragState()
      if (!window || !drag || !drag.detached || drag.windowId !== window.window_id) return false
      if (isShellHostedWorkspaceWindow(window)) return false
      return options.compositorMoveWindowId() !== window.window_id &&
        options.compositorMoveProxyWindowId() !== window.window_id &&
        options.compositorMoveCaptureWindowId() !== window.window_id
    })
    const frameHidden = createMemo(() => visibleWindow()?.minimized ?? false)
    const frameVisible = createMemo(() => visibleWindow()?.workspace_visible ?? false)
    const proxyHidden = createMemo(() => activeMoveProxyWindowId() === visibleWindowId())
    const dragOpacity = createMemo(() => {
      if (activeFrameDragWindowId() !== visibleWindowId()) return 1
      const window = visibleWindow()
      if (!window) return 1
      const shellHosted = isShellHostedWorkspaceWindow(window)
      if (shellHosted) return 0.76
      if (nativeDragPreviewLoaded()) return 0.76
      return activeMoveProxyWindowId() === visibleWindowId() ? 0.76 : 1
    })
    const contentPointerEvents = createMemo<'auto' | 'none'>(() => {
      const window = visibleWindow()
      if (!window) return 'auto'
      const shellHosted = isShellHostedWorkspaceWindow(window)
      if (shellHosted) return 'none'
      return nativeDragPreviewVisible() ? 'none' : 'auto'
    })
    const contentBackground = createMemo(() => {
      const window = visibleWindow()
      if (!window) return 'var(--shell-surface-inset)'
      const shellHosted = isShellHostedWorkspaceWindow(window)
      if (shellHosted) return 'transparent'
      return nativeDragPreviewLoaded() ? 'var(--shell-surface-inset)' : 'transparent'
    })
    const frameModel = createMemo((): ShellWindowModel | undefined => {
      const window = visibleWindow()
      if (!window) return undefined
      const liveFrame = options.interactionFrameForWindow(window.window_id)
      const split = splitLayout()
      if (!split && liveFrame) {
        return {
          ...window,
          x: liveFrame.x,
          y: liveFrame.y,
          width: liveFrame.width,
          height: liveFrame.height,
          maximized: liveFrame.maximized,
          fullscreen: liveFrame.fullscreen,
          snap_tiled:
            options.isWorkspaceWindowTiled(window.window_id) &&
            !liveFrame.maximized &&
            !liveFrame.fullscreen,
        }
      }
      if (!split) return { ...window, snap_tiled: options.isWorkspaceWindowTiled(window.window_id) }
      return {
        ...window,
        x: split.group.x,
        y: split.group.y,
        width: split.group.width,
        height: split.group.height,
        maximized: false,
        fullscreen: false,
        snap_tiled: false,
      }
    })
    const showFrame = createMemo(() => {
      const model = frameModel()
      return model !== undefined && frameVisible() && !detachedNativeAwaitingMove() && (!frameHidden() || keepShellContentMounted())
    })
    const stackZ = createMemo(() => {
      const currentVisibleWindowId = visibleWindowId()
      if (currentVisibleWindowId == null) return 0
      const base = visibleWindow()?.stack_z ?? 0
      return options.shellWindowDragId() === currentVisibleWindowId &&
        activeMoveProxyWindowId() !== currentVisibleWindowId
        ? base + 1_000_000
        : base
    })
    const rowFocused = createMemo(() => options.activeWorkspaceGroupId() === props.groupId)
    const deskShellUiReg = createMemo(() => {
      stackZ()
      options.outputGeom()
      options.layoutCanvasOrigin()
      return {
        id: visibleWindowId() ?? 0,
        z: stackZ(),
        getEnv: (): ShellUiMeasureEnv | null => {
          const main = options.getMainRef()
          const og = options.outputGeom()
          const origin = options.layoutCanvasOrigin()
          if (!main || !og || !origin) return null
          return {
            main,
            outputGeom: { w: og.w, h: og.h },
            origin,
          }
        },
      }
    })
    const selectTab = (windowId: number) => {
      const changed = options.selectGroupWindow(windowId)
      if (!changed) return
      if ((group()?.splitLeftWindowId ?? null) === windowId) return
      if (splitLayout()) {
        queueMicrotask(() => {
          applySplitGroupGeometry(props.groupId)
        })
      }
    }
    const renderSplitPane = (
      windowId: number,
      rect: SplitGroupRect,
      testId: string,
      extraAttrs: Record<string, string>,
    ) => {
      const window = options.windowById(windowId)()
      const shellHosted = isShellHostedWorkspaceWindow(window)
      return (
        <div
          data-testid={testId}
          {...extraAttrs}
          class="pointer-events-none absolute box-border"
          style={{
            left: '0',
            top: '0',
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
            'will-change': 'transform',
            'z-index': 1005 + stackZ(),
            contain: 'layout paint',
          }}
        >
          <Show when={shellHosted}>
            <ShellHostedContentMount
              windowId={windowId}
              class="pointer-events-auto h-full min-h-0 min-w-0 overflow-auto bg-(--shell-surface-inset) text-(--shell-text)"
              onPointerDown={() => {
                options.selectGroupWindow(windowId)
              }}
            >
              {options.renderShellWindowContent(windowId)}
            </ShellHostedContentMount>
          </Show>
        </div>
      )
    }
    return (
      <Show when={showFrame()} fallback={null}>
        <ShellWindowFrame
          win={frameModel}
          repaintKey={options.snapChromeRev}
          stackZ={stackZ}
          focused={rowFocused}
          dragging={() => activeFrameDragWindowId() === visibleWindowId()}
          dragOpacity={dragOpacity}
          contentPointerEvents={contentPointerEvents}
          contentBackground={contentBackground}
          frameVisible={frameVisible}
          contentVisible={() => visibleShellHostedMemberWindowIds().length > 0 || nativeDragPreviewVisible() !== null}
          hidden={() => frameHidden() || proxyHidden()}
          shellUiRegister={frameHidden() || !frameVisible() ? undefined : deskShellUiReg()}
          tabStrip={
            group() ? (
              <WorkspaceTabStrip
                groupId={props.groupId}
                tabs={group()!.members.map((member) => ({
                  window_id: member.window_id,
                  title: member.title,
                  app_id: member.app_id,
                  active: member.window_id === group()!.visibleWindowId,
                  pinned: options.isWorkspaceWindowPinned(member.window_id),
                }))}
                splitLeftWindowId={group()!.splitLeftWindowId}
                dragWindowId={activeDragWindowId() ?? (options.externalTabDropDrag() ? 0 : null)}
                dropTarget={activeDropTarget() ?? null}
                suppressClickWindowId={suppressTabClickWindowId()}
                onSelectTab={selectTab}
                onConsumeSuppressedClick={(windowId) => {
                  if (suppressTabClickWindowId() === windowId) setSuppressTabClickWindowId(null)
                }}
                onCloseTab={options.closeWindow}
                onTabPointerDown={startTabPointerGesture}
                onTabContextMenu={(windowId, clientX, clientY) => {
                  options.shellContextOpenTabMenu(windowId, clientX, clientY)
                }}
              />
            ) : undefined
          }
          onFocusRequest={() => {
            const currentVisibleWindowId =
              group()?.members.some((member) => member.window_id === options.focusedWindowId())
                ? options.focusedWindowId()
                : visibleWindowId()
            if (currentVisibleWindowId == null) return
            const window = options.windowById(currentVisibleWindowId)()
            if (!window) return
            if (isShellHostedWorkspaceWindow(window)) {
              options.focusShellUiWindow(currentVisibleWindowId)
              return
            }
            options.focusWindowViaShell(currentVisibleWindowId)
          }}
          onTitlebarPointerDown={(pointerId, clientX, clientY) => {
            if (splitLayout() && beginSplitGroupGesture(props.groupId, pointerId, 'move', 0, clientX, clientY)) return
            const currentVisibleWindowId = visibleWindowId()
            if (currentVisibleWindowId != null) options.beginShellWindowMove(currentVisibleWindowId, clientX, clientY)
          }}
          onSnapAssistOpen={(anchorRect: DOMRect) => {
            const currentVisibleWindowId = visibleWindowId()
            if (currentVisibleWindowId == null) return
            options.focusWindowViaShell(currentVisibleWindowId)
            options.openSnapAssistPicker(currentVisibleWindowId, 'button', anchorRect)
          }}
          onResizeEdgeDown={(edges, pointerId, clientX, clientY) => {
            if (
              splitLayout() &&
              beginSplitGroupGesture(props.groupId, pointerId, 'resize', edges, clientX, clientY)
            ) {
              return
            }
            const currentVisibleWindowId = visibleWindowId()
            if (currentVisibleWindowId != null) options.beginShellWindowResize(currentVisibleWindowId, edges, clientX, clientY)
          }}
          onMinimize={() => {
            if (splitLayout()) {
              const leftWindowId = group()?.splitLeftWindowId
              const rightWindowId = visibleWindowId()
              if (rightWindowId != null) options.focusWindowViaShell(rightWindowId)
              if (leftWindowId != null) options.shellWireSend('minimize', leftWindowId)
              if (rightWindowId != null) options.shellWireSend('minimize', rightWindowId)
              return
            }
            const currentVisibleWindowId = visibleWindowId()
            if (currentVisibleWindowId != null) {
              options.focusWindowViaShell(currentVisibleWindowId)
              options.shellWireSend('minimize', currentVisibleWindowId)
            }
          }}
          onMaximize={() => {
            const currentVisibleWindowId = visibleWindowId()
            if (currentVisibleWindowId != null) {
              options.focusWindowViaShell(currentVisibleWindowId)
              options.toggleShellMaximizeForWindow(currentVisibleWindowId)
            }
          }}
          onClose={() => {
            const focusedGroupWindowId =
              group()?.members.some((member) => member.window_id === options.focusedWindowId())
                ? options.focusedWindowId()
                : visibleWindowId()
            if (focusedGroupWindowId != null) {
              options.focusWindowViaShell(focusedGroupWindowId)
              options.closeGroupWindow(focusedGroupWindowId)
            }
          }}
        >
          <Show when={!splitLayout() && visibleWindowId() !== null}>
            <Show when={nativeDragPreviewVisible()}>
              {(preview) => (
                <div
                  class="pointer-events-none relative h-full min-h-0 min-w-0 overflow-hidden"
                  data-shell-native-drag-preview={preview().window_id}
                  data-shell-native-drag-preview-generation={preview().generation}
                  data-shell-native-drag-preview-loaded={
                    nativeDragPreviewLoaded() ? 'true' : 'false'
                  }
                  data-shell-native-drag-preview-src={nativeDragPreviewSrc()}
                  data-shell-native-drag-preview-src-width={
                    nativeDragPreviewMetrics()?.sourceWidth ?? ''
                  }
                  data-shell-native-drag-preview-src-height={
                    nativeDragPreviewMetrics()?.sourceHeight ?? ''
                  }
                  data-shell-native-drag-preview-backing-width={
                    nativeDragPreviewMetrics()?.backingWidth ?? ''
                  }
                  data-shell-native-drag-preview-backing-height={
                    nativeDragPreviewMetrics()?.backingHeight ?? ''
                  }
                  style={{
                    background: nativeDragPreviewLoaded() ? 'var(--shell-surface-inset)' : 'transparent',
                  }}
                >
                  <NativeDragPreviewCanvas
                    image={preview().loaded ? preview().image : null}
                    onMetrics={setNativeDragPreviewMetrics}
                  />
                </div>
              )}
            </Show>
          </Show>
        </ShellWindowFrame>
        <Show when={splitLayout()} keyed>
          {(layout) => (
            <>
              {renderSplitPane(layout.leftWindowId, layout.left, 'workspace-split-left-pane', {
                'data-workspace-split-left-pane': String(layout.leftWindowId),
              })}
              {renderSplitPane(group()!.visibleWindowId, layout.right, 'workspace-split-right-pane', {
                'data-workspace-split-right-pane': String(group()!.visibleWindowId),
              })}
              <div
                data-testid="workspace-split-divider"
                data-workspace-split-divider={props.groupId}
                class="absolute z-6 cursor-col-resize bg-[color-mix(in_srgb,var(--shell-border)_88%,var(--shell-accent)_12%)]"
                style={{
                  left: '0',
                  top: '0',
                  width: `${WORKSPACE_SPLIT_DIVIDER_PX}px`,
                  height: `${Math.max(24, layout.left.height - 12)}px`,
                  transform: `translate3d(${layout.left.x + layout.left.width - Math.floor(WORKSPACE_SPLIT_DIVIDER_PX / 2)}px, ${layout.left.y + 6}px, 0)`,
                  'will-change': 'transform',
                  'z-index': 1006 + stackZ(),
                }}
                onPointerDown={(event) => {
                  if (!event.isPrimary || event.button !== 0) return
                  event.preventDefault()
                  event.stopPropagation()
                  beginSplitGroupGesture(props.groupId, event.pointerId, 'divider', 0, event.clientX, event.clientY)
                }}
              />
            </>
          )}
        </Show>
      </Show>
    )
  }

  function ShellHostedContentMount(props: {
    windowId: number
    class: string
    style?: JSX.CSSProperties
    ['aria-hidden']?: 'true' | undefined
    onPointerDown?: JSX.EventHandlerUnion<HTMLDivElement, PointerEvent>
    children?: JSX.Element
  }) {
    return (
      <div
        data-shell-hosted-content-mount={props.windowId}
        class={`${props.class} [&>*]:h-full [&>*]:min-h-0 [&>*]:min-w-0`}
        style={props.style}
        aria-hidden={props['aria-hidden']}
        onPointerDown={props.onPointerDown}
      >
        {props.children}
      </div>
    )
  }

  const persistentShellHostedWindowIds = createMemo((prev: readonly number[] = []) => {
    const next = [...options.allWindowsMap().values()]
      .filter((window) => isShellHostedWorkspaceWindow(window))
      .sort((a, b) => a.window_id - b.window_id)
      .map((window) => window.window_id)
    return sameWindowIdList(prev, next) ? prev : next
  })

  function PersistentShellHostedContentHost() {
    const visibleIds = createMemo(() => {
      const ids = new Set<number>()
      for (const group of options.workspaceGroups()) {
        if (group.visibleWindowId !== null) ids.add(group.visibleWindowId)
        if (group.splitLeftWindowId !== null) ids.add(group.splitLeftWindowId)
      }
      for (const windowId of scratchpadWindowIds()) ids.add(windowId)
      return ids
    })
    return (
      <For each={persistentShellHostedWindowIds()}>
        {(windowId) => {
          const windowModel = options.windowById(windowId)
          const visible = createMemo(() => {
            const window = windowModel()
            return !!window && !window.minimized && window.workspace_visible && visibleIds().has(windowId)
          })
          const style = createMemo((): JSX.CSSProperties => {
            const window = windowModel()
            if (!window) {
              return { display: 'none' }
            }
            return {
              position: 'absolute',
              left: `${window.x}px`,
              top: `${window.y}px`,
              width: `${window.width}px`,
              height: `${window.height}px`,
              'z-index': 1000 + window.stack_z,
              visibility: visible() ? 'visible' : 'hidden',
              'pointer-events': visible() ? 'auto' : 'none',
            }
          })
          return (
            <ShellHostedContentMount
              windowId={windowId}
              class="pointer-events-auto min-h-0 min-w-0 overflow-auto bg-(--shell-surface-inset) text-(--shell-text)"
              style={style()}
              aria-hidden={visible() ? undefined : 'true'}
              onPointerDown={() => {
                if (visible()) options.focusShellUiWindow(windowId)
              }}
            >
              {options.renderShellWindowContent(windowId)}
            </ShellHostedContentMount>
          )
        }}
      </For>
    )
  }

  const scratchpadWindowIds = createMemo((prev: readonly number[] = []) => {
    const next = [...options.allWindowsMap().values()]
      .filter((window) => (window.shell_flags & SHELL_WINDOW_FLAG_SCRATCHPAD) !== 0)
      .sort((a, b) => a.stack_z - b.stack_z || a.window_id - b.window_id)
      .map((window) => window.window_id)
    return sameWindowIdList(prev, next) ? prev : next
  })

  function ScratchpadWindowFrame(props: { windowId: number }) {
    const windowModel = options.windowById(props.windowId)
    const frameModel = createMemo((): ShellWindowModel | undefined => {
      const window = windowModel()
      if (!window) return undefined
      const liveFrame = options.interactionFrameForWindow(window.window_id)
      return liveFrame
        ? {
            ...window,
            x: liveFrame.x,
            y: liveFrame.y,
            width: liveFrame.width,
            height: liveFrame.height,
            maximized: liveFrame.maximized,
            fullscreen: liveFrame.fullscreen,
            snap_tiled: false,
          }
        : { ...window, snap_tiled: false }
    })
    const shellHosted = createMemo(() => {
      const window = windowModel()
      return isShellHostedWorkspaceWindow(window)
    })
    const frameVisible = createMemo(() => windowModel()?.workspace_visible ?? false)
    const stackZ = createMemo(() => {
      const base = windowModel()?.stack_z ?? 0
      return options.shellWindowDragId() === props.windowId && activeMoveProxyWindowId() !== props.windowId
        ? base + 1_000_000
        : base
    })
    const shellUiReg = createMemo(() => {
      stackZ()
      options.outputGeom()
      options.layoutCanvasOrigin()
      return {
        id: props.windowId,
        z: stackZ(),
        getEnv: (): ShellUiMeasureEnv | null => {
          const main = options.getMainRef()
          const og = options.outputGeom()
          const origin = options.layoutCanvasOrigin()
          if (!main || !og || !origin) return null
          return {
            main,
            outputGeom: { w: og.w, h: og.h },
            origin,
          }
        },
      }
    })
    const focused = createMemo(() => options.focusedWindowId() === props.windowId)
    return (
      <Show when={frameModel()}>
        <ShellWindowFrame
          win={frameModel}
          repaintKey={options.snapChromeRev}
          stackZ={stackZ}
          focused={focused}
          dragging={() => activeFrameDragWindowId() === props.windowId}
          frameVisible={frameVisible}
          hidden={() => windowModel()?.minimized ?? true}
          shellUiRegister={windowModel()?.minimized || !frameVisible() ? undefined : shellUiReg()}
          contentPointerEvents={() => 'none'}
          contentBackground={() => 'transparent'}
          contentVisible={() => shellHosted() && frameVisible()}
          onFocusRequest={() => {
            if (shellHosted()) options.focusShellUiWindow(props.windowId)
            else options.focusWindowViaShell(props.windowId)
          }}
          onTitlebarPointerDown={(_, clientX, clientY) => {
            options.beginShellWindowMove(props.windowId, clientX, clientY)
          }}
          onSnapAssistOpen={(anchorRect) => {
            options.focusWindowViaShell(props.windowId)
            options.openSnapAssistPicker(props.windowId, 'button', anchorRect)
          }}
          onResizeEdgeDown={(edges, _pointerId, clientX, clientY) => {
            options.beginShellWindowResize(props.windowId, edges, clientX, clientY)
          }}
          onMinimize={() => {
            options.focusWindowViaShell(props.windowId)
            options.shellWireSend('minimize', props.windowId)
          }}
          onMaximize={() => {
            options.focusWindowViaShell(props.windowId)
            options.toggleShellMaximizeForWindow(props.windowId)
          }}
          onClose={() => {
            options.focusWindowViaShell(props.windowId)
            options.closeGroupWindow(props.windowId)
          }}
        >
        </ShellWindowFrame>
      </Show>
    )
  }

  function tabDropIndicatorForTarget(target: TabMergeTarget | null) {
    if (!target) return null
    const slot = document.querySelector(
      `[data-tab-drop-slot="${target.groupId}:${target.insertIndex}"]`,
    ) as HTMLElement | null
    const strip = document.querySelector(
      `[data-workspace-tab-strip="${target.groupId}"]`,
    ) as HTMLElement | null
    if (!slot) return null
    const slotRect = slot.getBoundingClientRect()
    const stripRect = strip?.getBoundingClientRect() ?? slotRect
    return {
      line: {
        left: `${Math.round(slotRect.left - 2)}px`,
        top: `${Math.round(stripRect.top + 2)}px`,
        width: '4px',
        height: `${Math.max(10, Math.round(stripRect.height - 4))}px`,
      },
      highlight: {
        left: `${Math.round(stripRect.left)}px`,
        top: `${Math.round(stripRect.top)}px`,
        width: `${Math.round(stripRect.width)}px`,
        height: `${Math.round(stripRect.height)}px`,
      },
      key: `${target.groupId}:${target.insertIndex}`,
    }
  }

  function TabDragOverlay() {
    const drag = createMemo(() => tabDragState())
    const dropIndicator = createMemo(() => tabDropIndicatorForTarget(activeDropTarget()))
    return (
      <Show when={drag()?.dragging}>
        <div
          data-tab-drag-capture={drag()!.windowId}
          class="fixed inset-0 z-470120 cursor-grabbing"
          onContextMenu={(event) => event.preventDefault()}
          onPointerMove={onTabDragPointerMove}
          onPointerUp={onTabDragPointerUp}
          onPointerCancel={onTabDragPointerCancel}
        >
          <Show when={dropIndicator()} keyed>
            {(indicator) => (
              <>
                <div
                  data-tab-drop-indicator={indicator.key}
                  class="pointer-events-none fixed rounded-sm bg-[color-mix(in_srgb,var(--shell-accent-soft)_80%,transparent)] ring-1 ring-[color-mix(in_srgb,var(--shell-accent)_58%,transparent)]"
                  style={indicator.highlight}
                />
                <div
                  data-tab-drop-indicator-line={indicator.key}
                  class="pointer-events-none fixed rounded-full bg-(--shell-accent) shadow-[0_0_0_1px_var(--shell-accent),0_0_18px_color-mix(in_srgb,var(--shell-accent)_55%,transparent)]"
                  style={indicator.line}
                />
              </>
            )}
          </Show>
        </div>
      </Show>
    )
  }

  function WindowDragDropOverlay() {
    const windowId = createMemo(() => activeWindowDragWindowId())
    const dropIndicator = createMemo(() => tabDropIndicatorForTarget(activeWindowDragTarget()))
    return (
      <Show when={windowId() !== null}>
        <div
          data-window-tab-drop-capture={windowId()!}
          class="pointer-events-none fixed inset-0 z-470119"
        >
          <Show when={dropIndicator()} keyed>
            {(indicator) => (
              <>
                <div
                  data-tab-drop-indicator={indicator.key}
                  class="pointer-events-none fixed rounded-sm bg-[color-mix(in_srgb,var(--shell-accent-soft)_80%,transparent)] ring-1 ring-[color-mix(in_srgb,var(--shell-accent)_58%,transparent)]"
                  style={indicator.highlight}
                />
                <div
                  data-tab-drop-indicator-line={indicator.key}
                  class="pointer-events-none fixed rounded-full bg-(--shell-accent) shadow-[0_0_0_1px_var(--shell-accent),0_0_18px_color-mix(in_srgb,var(--shell-accent)_55%,transparent)]"
                  style={indicator.line}
                />
              </>
            )}
          </Show>
        </div>
      </Show>
    )
  }

  function ExternalTabDropOverlay() {
    const drag = createMemo(() => options.externalTabDropDrag())
    const dropIndicator = createMemo(() => tabDropIndicatorForTarget(drag()?.target ?? null))
    const ghostStyle = createMemo(() => {
      const current = drag()
      if (!current) return {}
      const width = 260
      const height = 44
      const maxLeft = Math.max(8, window.innerWidth - width - 8)
      const maxTop = Math.max(8, window.innerHeight - height - 8)
      return {
        left: `${Math.min(Math.max(8, current.clientX + 14), maxLeft)}px`,
        top: `${Math.min(Math.max(8, current.clientY + 14), maxTop)}px`,
      }
    })
    return (
      <Show when={drag()} keyed>
        {(current) => (
          <div class="pointer-events-none fixed inset-0 z-470121">
            <div
              data-file-tab-drag-preview
              class="fixed max-w-[260px] rounded-md border bg-(--shell-surface-panel)/95 px-2.5 py-1.5 text-xs font-medium text-(--shell-text) shadow-lg ring-1"
              classList={{
                'border-(--shell-accent) ring-[color-mix(in_srgb,var(--shell-accent)_48%,transparent)]': current.canDrop,
                'border-(--shell-border) opacity-85 ring-[color-mix(in_srgb,var(--shell-border)_60%,transparent)]': !current.canDrop,
              }}
              style={ghostStyle()}
            >
              <span class="block truncate">{current.label}</span>
            </div>
            <Show when={dropIndicator()} keyed>
              {(indicator) => (
                <>
                  <div
                    data-tab-drop-indicator={indicator.key}
                    class="pointer-events-none fixed rounded-sm bg-[color-mix(in_srgb,var(--shell-accent-soft)_80%,transparent)] ring-1 ring-[color-mix(in_srgb,var(--shell-accent)_58%,transparent)]"
                    style={indicator.highlight}
                  />
                  <div
                    data-tab-drop-indicator-line={indicator.key}
                    class="pointer-events-none fixed rounded-full bg-(--shell-accent) shadow-[0_0_0_1px_var(--shell-accent),0_0_18px_color-mix(in_srgb,var(--shell-accent)_55%,transparent)]"
                    style={indicator.line}
                  />
                </>
              )}
            </Show>
          </div>
        )}
      </Show>
    )
  }

  function finishWindowDragDrop(pointerOverride?: { x: number; y: number } | null) {
    if (tabDragState()) return false
    const windowId = activeWindowDragWindowId() ?? lastWindowDragWindowId()
    const pointer = pointerOverride ?? windowDragPointerClient() ?? lastWindowDragPointerClient()
    setLastWindowDragPointerClient(null)
    setLastWindowDragWindowId(null)
    if (windowId == null || !pointer) return false
    const target = resolveWindowDragTarget(windowId, pointer.x, pointer.y) ?? lastWindowDragTarget()
    setLastWindowDragTarget(null)
    if (!target) return false
    return options.applyWindowDrop(windowId, target)
  }

  function SplitGestureOverlay() {
    const cursorClass = createMemo(() => {
      const gesture = splitGroupGesture()
      if (!gesture) return 'cursor-default'
      return gesture.kind === 'divider' ? 'cursor-col-resize' : 'cursor-grabbing'
    })
    return (
      <div
        data-workspace-split-gesture-overlay
        class={`fixed inset-0 z-470110 touch-none ${cursorClass()}`}
        onContextMenu={(event) => {
          event.preventDefault()
        }}
        onPointerMove={onSplitGroupPointerMove}
        onPointerUp={onSplitGroupPointerUp}
        onPointerCancel={onSplitGroupPointerCancel}
      />
    )
  }

  return {
    PersistentShellHostedContentHost,
    WorkspaceGroupFrame,
    ScratchpadWindowFrame,
    TabDragOverlay,
    WindowDragDropOverlay,
    ExternalTabDropOverlay,
    SplitGestureOverlay,
    applySplitGroupGeometry,
    cancelSplitGroupGesture,
    clearSuppressTabClickWindowId: () => setSuppressTabClickWindowId(null),
    finishWindowDragDrop,
    activeDragWindowId,
    activeDropTarget,
    scratchpadWindowIds,
    splitGroupGesture,
    tabDragState,
  }
}
