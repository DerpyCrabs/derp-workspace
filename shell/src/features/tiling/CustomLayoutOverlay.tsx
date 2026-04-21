import { Portal } from 'solid-js/web'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
} from 'solid-js'
import { screensListForLayout } from '@/host/appLayout'
import type { LayoutScreen } from '@/host/types'
import { canvasRectToClientCss, rectGlobalToCanvasLocal } from '@/lib/shellCoords'
import {
  clampCustomLayoutRatio,
  createCustomLayout,
  firstLeafZoneId,
  listCustomLayoutMergePreviewZoneIds,
  listCustomLayoutSplitHandles,
  listCustomLayoutZones,
  mergeCustomLayoutZones,
  renameCustomLayout,
  splitCustomLayoutZone,
  updateCustomLayoutSplitRatio,
  type CustomLayout,
  type CustomLayoutSplitAxis,
  type CustomLayoutSplitPlacement,
} from './customLayouts'
import { getMonitorLayout } from './tilingConfig'

export type CustomLayoutOverlayState = {
  outputName: string
  initialLayoutId?: string | null
}

type CustomLayoutOverlayProps = {
  state: Accessor<CustomLayoutOverlayState | null>
  close: () => void
  saveLayouts: (outputName: string, layouts: CustomLayout[]) => void
  getMenuLayerHostEl: () => HTMLElement | undefined
  getMainEl: () => HTMLElement | undefined
  acquireOverlayPointer: () => void
  releaseOverlayPointer: () => void
  outputGeom: Accessor<{ w: number; h: number } | null>
  layoutCanvasOrigin: Accessor<{ x: number; y: number } | null>
  screenDraftRows: Accessor<LayoutScreen[]>
  reserveTaskbarForMon: (screen: LayoutScreen) => boolean
  scheduleExclusionZonesSync: () => void
}

type MergeDragState = {
  sourceZoneId: string
  startClientX: number
  startClientY: number
  splitAxis: CustomLayoutSplitAxis
  moved: boolean
}

type SplitPreviewState = {
  zoneId: string
  axis: CustomLayoutSplitAxis
  ratio: number
  placement: CustomLayoutSplitPlacement
}

type ResizePreviewState = {
  path: string
  axis: CustomLayoutSplitAxis
  ratio: number
  parentX: number
  parentY: number
  parentWidth: number
  parentHeight: number
}

const DRAG_THRESHOLD_PX = 8
const SPLIT_PREVIEW_RATIO_STEP = 0.005
const RESIZE_RATIO_STEP = 0.01
const SPLIT_STICKY_PX = 12
const ZONE_EDGE_EPSILON = 0.0001

function collectZoneIds(node: CustomLayout['root']): string[] {
  if (node.kind === 'leaf') return [node.zoneId]
  return [...collectZoneIds(node.first), ...collectZoneIds(node.second)]
}

export function CustomLayoutOverlay(props: CustomLayoutOverlayProps) {
  const [draftLayouts, setDraftLayouts] = createSignal<CustomLayout[]>([])
  const [selectedLayoutId, setSelectedLayoutId] = createSignal<string | null>(null)
  const [selectedZoneId, setSelectedZoneId] = createSignal<string | null>(null)
  const [mergeDrag, setMergeDrag] = createSignal<MergeDragState | null>(null)
  const [mergeTargetZoneId, setMergeTargetZoneId] = createSignal<string | null>(null)
  const [resizePreview, setResizePreview] = createSignal<ResizePreviewState | null>(null)
  const [splitPreview, setSplitPreview] = createSignal<SplitPreviewState | null>(null)
  const [shiftPressed, setShiftPressed] = createSignal(false)
  let cleanupPointerInteraction: (() => void) | null = null
  let hoverPreviewPoint: { x: number; y: number } | null = null

  createEffect(() => {
    const current = props.state()
    if (!current) return
    const layouts = getMonitorLayout(current.outputName).customLayouts
    setDraftLayouts(layouts)
    const initial =
      (current.initialLayoutId ? layouts.find((layout) => layout.id === current.initialLayoutId) : undefined) ??
      layouts[0] ??
      null
    setSelectedLayoutId(initial?.id ?? null)
    setSelectedZoneId(initial ? firstLeafZoneId(initial.root) : null)
    setMergeDrag(null)
    setMergeTargetZoneId(null)
    setResizePreview(null)
    setSplitPreview(null)
    hoverPreviewPoint = null
  })

  createEffect(() => {
    if (!props.state()) return
    props.acquireOverlayPointer()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        setShiftPressed(true)
        refreshSplitPreview()
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        props.close()
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        setShiftPressed(false)
        refreshSplitPreview()
      }
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!props.state() || mergeDrag() || resizePreview()) return
      updateSplitPreviewForPointer(event.clientX, event.clientY, event.shiftKey)
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('keyup', onKeyUp, true)
    document.addEventListener('pointermove', onPointerMove, true)
    queueMicrotask(() => props.scheduleExclusionZonesSync())
    onCleanup(() => {
      cleanupPointerInteraction?.()
      cleanupPointerInteraction = null
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('keyup', onKeyUp, true)
      document.removeEventListener('pointermove', onPointerMove, true)
      props.releaseOverlayPointer()
      props.scheduleExclusionZonesSync()
    })
  })

  const screens = createMemo(() =>
    screensListForLayout(props.screenDraftRows(), props.outputGeom(), props.layoutCanvasOrigin()),
  )

  const selectedScreen = createMemo(() => {
    const current = props.state()
    if (!current) return null
    return screens().find((screen) => screen.name === current.outputName) ?? null
  })

  const overlayCss = createMemo(() => {
    const current = props.state()
    const screen = selectedScreen()
    const main = props.getMainEl()
    const canvas = props.outputGeom()
    if (!current || !screen || !main || !canvas) return null
    const mainRect = main.getBoundingClientRect()
    const screenCss = canvasRectToClientCss(
      screen.x,
      screen.y,
      screen.width,
      screen.height,
      mainRect,
      canvas.w,
      canvas.h,
    )
    const taskbarReserve = props.reserveTaskbarForMon(screen) ? 44 : 0
    const work = {
      x: screen.x,
      y: screen.y,
      w: Math.max(1, screen.width),
      h: Math.max(1, screen.height - taskbarReserve),
    }
    const workCanvas = rectGlobalToCanvasLocal(
      work.x,
      work.y,
      work.w,
      work.h,
      props.layoutCanvasOrigin(),
    )
    const workCss = canvasRectToClientCss(
      workCanvas.x,
      workCanvas.y,
      workCanvas.w,
      workCanvas.h,
      mainRect,
      canvas.w,
      canvas.h,
    )
    return { screenCss, workCss }
  })

  const panelCss = createMemo(() => {
    const css = overlayCss()
    if (!css) return null
    const width = Math.min(540, Math.max(420, css.screenCss.width - 32))
    const left = css.screenCss.left + Math.max(16, (css.screenCss.width - width) / 2)
    const top = css.screenCss.top + 16
    return { left, top, width }
  })

  const selectedLayout = createMemo(() => {
    const current = selectedLayoutId()
    return draftLayouts().find((layout) => layout.id === current) ?? draftLayouts()[0] ?? null
  })

  const renderedLayout = createMemo(() => {
    const layout = selectedLayout()
    const preview = resizePreview()
    if (!layout || !preview) return layout
    return updateCustomLayoutSplitRatio(layout, preview.path, preview.ratio)
  })

  createEffect(() => {
    const current = selectedLayout()
    if (!current) {
      setSelectedLayoutId(null)
      setSelectedZoneId(null)
      return
    }
    if (current.id !== selectedLayoutId()) setSelectedLayoutId(current.id)
    const zoneIds = collectZoneIds(current.root)
    const nextZoneId = selectedZoneId() && zoneIds.includes(selectedZoneId()!) ? selectedZoneId() : zoneIds[0] ?? null
    if (nextZoneId !== selectedZoneId()) setSelectedZoneId(nextZoneId)
  })

  const editorZones = createMemo(() => {
    const layout = renderedLayout()
    return layout ? listCustomLayoutZones(layout) : []
  })

  const editorHandles = createMemo(() => {
    const layout = renderedLayout()
    return layout ? listCustomLayoutSplitHandles(layout) : []
  })

  const splitPreviewZone = createMemo(() => {
    const preview = splitPreview()
    if (!preview) return null
    return editorZones().find((zone) => zone.zoneId === preview.zoneId) ?? null
  })

  const splitPreviewRenderState = createMemo(() => {
    const preview = splitPreview()
    const zone = splitPreviewZone()
    if (!preview || !zone) return null
    const firstRatio = preview.ratio
    const secondRatio = 1 - preview.ratio
    return {
      preview,
      firstStyle:
        preview.axis === 'vertical'
          ? {
              left: `${zone.x * 100}%`,
              top: `${zone.y * 100}%`,
              width: `${zone.width * firstRatio * 100}%`,
              height: `${zone.height * 100}%`,
            }
          : {
              left: `${zone.x * 100}%`,
              top: `${zone.y * 100}%`,
              width: `${zone.width * 100}%`,
              height: `${zone.height * firstRatio * 100}%`,
            },
      secondStyle:
        preview.axis === 'vertical'
          ? {
              left: `${(zone.x + zone.width * firstRatio) * 100}%`,
              top: `${zone.y * 100}%`,
              width: `${zone.width * secondRatio * 100}%`,
              height: `${zone.height * 100}%`,
            }
          : {
              left: `${zone.x * 100}%`,
              top: `${(zone.y + zone.height * firstRatio) * 100}%`,
              width: `${zone.width * 100}%`,
              height: `${zone.height * secondRatio * 100}%`,
            },
    }
  })

  const mergePreviewZoneIds = createMemo(() => {
    const layout = selectedLayout()
    const drag = mergeDrag()
    const target = mergeTargetZoneId()
    if (!layout || !drag?.moved || !target) return []
    return listCustomLayoutMergePreviewZoneIds(layout, drag.sourceZoneId, target)
  })

  function persist(nextLayouts: CustomLayout[], nextLayoutId?: string | null, nextZoneId?: string | null) {
    setDraftLayouts(nextLayouts)
    if (nextLayoutId !== undefined) setSelectedLayoutId(nextLayoutId)
    if (nextZoneId !== undefined) setSelectedZoneId(nextZoneId)
  }

  function replaceSelectedLayout(nextLayout: CustomLayout, nextZoneId: string | null) {
    const current = selectedLayout()
    if (!current) return
    persist(
      draftLayouts().map((layout) => (layout.id === current.id ? nextLayout : layout)),
      current.id,
      nextZoneId,
    )
  }

  function addLayout() {
    const nextLayouts = [...draftLayouts(), createCustomLayout(`Custom ${draftLayouts().length + 1}`)]
    const next = nextLayouts[nextLayouts.length - 1] ?? null
    persist(nextLayouts, next?.id ?? null, next ? firstLeafZoneId(next.root) : null)
  }

  function renameSelected(name: string) {
    const current = selectedLayout()
    if (!current) return
    replaceSelectedLayout(renameCustomLayout(current, name), selectedZoneId())
  }

  function removeSelectedLayout() {
    const current = selectedLayout()
    if (!current) return
    const nextLayouts = draftLayouts().filter((layout) => layout.id !== current.id)
    const fallback = nextLayouts[0] ?? null
    persist(nextLayouts, fallback?.id ?? null, fallback ? firstLeafZoneId(fallback.root) : null)
  }

  function saveAndClose() {
    const current = props.state()
    if (!current) return
    props.saveLayouts(current.outputName, draftLayouts())
    props.close()
  }

  function clearPointerInteraction() {
    cleanupPointerInteraction?.()
    cleanupPointerInteraction = null
    setMergeDrag(null)
    setMergeTargetZoneId(null)
    setResizePreview(null)
    setSplitPreview(null)
    hoverPreviewPoint = null
  }

  function normalizePointer(clientX: number, clientY: number) {
    const css = overlayCss()?.workCss
    if (!css || css.width <= 0 || css.height <= 0) return null
    const localX = (clientX - css.left) / css.width
    const localY = (clientY - css.top) / css.height
    return {
      inside: localX >= 0 && localX <= 1 && localY >= 0 && localY <= 1,
      x: Math.min(1, Math.max(0, localX)),
      y: Math.min(1, Math.max(0, localY)),
    }
  }

  function findZoneAtPoint(clientX: number, clientY: number, excludeZoneId?: string | null) {
    const normalized = normalizePointer(clientX, clientY)
    if (!normalized?.inside) return null
    return findZoneForNormalizedPoint(normalized.x, normalized.y, excludeZoneId)?.zoneId ?? null
  }

  function findZoneForNormalizedPoint(x: number, y: number, excludeZoneId?: string | null) {
    return (
      editorZones().find(
        (zone) =>
          zone.zoneId !== excludeZoneId &&
          x >= zone.x &&
          x <= zone.x + zone.width &&
          y >= zone.y &&
          y <= zone.y + zone.height,
      ) ?? null
    )
  }

  function quantizeSplitRatio(value: number) {
    const ratio = clampCustomLayoutRatio(value)
    return Math.round(ratio / SPLIT_PREVIEW_RATIO_STEP) * SPLIT_PREVIEW_RATIO_STEP
  }

  function snapSplitRatioToNeighbor(
    axis: CustomLayoutSplitAxis,
    zone: { zoneId: string; x: number; y: number; width: number; height: number },
    rawRatio: number,
  ) {
    const workCss = overlayCss()?.workCss
    if (!workCss) return quantizeSplitRatio(rawRatio)
    const zoneSizePx = axis === 'vertical' ? zone.width * workCss.width : zone.height * workCss.height
    if (zoneSizePx <= 0) return quantizeSplitRatio(rawRatio)
    const stickyThreshold = Math.min(0.08, SPLIT_STICKY_PX / zoneSizePx)
    const candidates = [...new Set(
      editorZones().flatMap((entry) => {
        if (entry.zoneId === zone.zoneId) return []
        if (axis === 'vertical') {
          return [entry.x, entry.x + entry.width]
            .filter((value) => value > zone.x + ZONE_EDGE_EPSILON && value < zone.x + zone.width - ZONE_EDGE_EPSILON)
            .map((value) => (value - zone.x) / zone.width)
        }
        return [entry.y, entry.y + entry.height]
          .filter((value) => value > zone.y + ZONE_EDGE_EPSILON && value < zone.y + zone.height - ZONE_EDGE_EPSILON)
          .map((value) => (value - zone.y) / zone.height)
      }),
    )]
    let snapped: number | null = null
    for (const candidate of candidates) {
      if (Math.abs(candidate - rawRatio) > stickyThreshold) continue
      if (snapped === null || Math.abs(candidate - rawRatio) < Math.abs(snapped - rawRatio)) {
        snapped = candidate
      }
    }
    return snapped === null ? quantizeSplitRatio(rawRatio) : clampCustomLayoutRatio(snapped)
  }

  function splitPreviewForPointer(
    axis: CustomLayoutSplitAxis,
    zone: { zoneId: string; x: number; y: number; width: number; height: number },
    x: number,
    y: number,
  ): Omit<SplitPreviewState, 'zoneId' | 'axis'> & { ratio: number } {
    const localX = zone.width <= 0 ? 0.5 : (x - zone.x) / zone.width
    const localY = zone.height <= 0 ? 0.5 : (y - zone.y) / zone.height
    const ratio =
      axis === 'vertical'
        ? snapSplitRatioToNeighbor(axis, zone, localX)
        : snapSplitRatioToNeighbor(axis, zone, localY)
    const placement: CustomLayoutSplitPlacement =
      axis === 'vertical' ? (localX < 0.5 ? 'first' : 'second') : localY < 0.5 ? 'first' : 'second'
    return { ratio, placement }
  }

  function setSplitPreviewIfChanged(next: SplitPreviewState | null) {
    const current = splitPreview()
    if (
      current?.zoneId === next?.zoneId &&
      current?.axis === next?.axis &&
      current?.ratio === next?.ratio &&
      current?.placement === next?.placement
    ) {
      return
    }
    setSplitPreview(next)
  }

  function refreshSplitPreview() {
    if (!hoverPreviewPoint || mergeDrag() || resizePreview()) return
    const zone = findZoneForNormalizedPoint(hoverPreviewPoint.x, hoverPreviewPoint.y)
    if (!zone) {
      setSplitPreviewIfChanged(null)
      return
    }
    const axis: CustomLayoutSplitAxis = shiftPressed() ? 'vertical' : 'horizontal'
    const preview = splitPreviewForPointer(axis, zone, hoverPreviewPoint.x, hoverPreviewPoint.y)
    setSplitPreviewIfChanged({
      zoneId: zone.zoneId,
      axis,
      ratio: preview.ratio,
      placement: preview.placement,
    })
  }

  function updateSplitPreviewForPointer(clientX: number, clientY: number, shiftKey = shiftPressed()) {
    if (mergeDrag() || resizePreview()) return
    const normalized = normalizePointer(clientX, clientY)
    if (!normalized?.inside) {
      setSplitPreviewIfChanged(null)
      hoverPreviewPoint = null
      return
    }
    const zone = findZoneForNormalizedPoint(normalized.x, normalized.y)
    if (!zone) {
      setSplitPreviewIfChanged(null)
      hoverPreviewPoint = null
      return
    }
    hoverPreviewPoint = { x: normalized.x, y: normalized.y }
    const axis: CustomLayoutSplitAxis = shiftKey ? 'vertical' : 'horizontal'
    const preview = splitPreviewForPointer(axis, zone, normalized.x, normalized.y)
    setSplitPreviewIfChanged({
      zoneId: zone.zoneId,
      axis,
      ratio: preview.ratio,
      placement: preview.placement,
    })
  }

  function beginZoneGesture(zoneId: string, event: PointerEvent) {
    const layout = selectedLayout()
    if (!layout) return
    clearPointerInteraction()
    event.preventDefault()
    event.stopPropagation()
    setSelectedZoneId(zoneId)
    setMergeDrag({
      sourceZoneId: zoneId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      splitAxis: event.shiftKey ? 'vertical' : 'horizontal',
      moved: false,
    })
    const onPointerMove = (moveEvent: PointerEvent) => {
      const current = mergeDrag()
      if (!current) return
      const moved =
        Math.hypot(moveEvent.clientX - current.startClientX, moveEvent.clientY - current.startClientY) >= DRAG_THRESHOLD_PX
      if (moved !== current.moved) {
        setMergeDrag({
          ...current,
          moved,
        })
      }
      const nextTarget = moved ? findZoneAtPoint(moveEvent.clientX, moveEvent.clientY, current.sourceZoneId) : null
      if (nextTarget !== mergeTargetZoneId()) setMergeTargetZoneId(nextTarget)
    }
    const finish = (upEvent?: PointerEvent) => {
      const current = mergeDrag()
      const targetZoneId = mergeTargetZoneId()
      clearPointerInteraction()
      if (!layout) return
      if (current?.moved) {
        if (!targetZoneId) return
        const result = mergeCustomLayoutZones(layout, current.sourceZoneId, targetZoneId)
        replaceSelectedLayout(result.layout, result.nextZoneId)
        return
      }
      if (!current) return
      const zone = editorZones().find((entry) => entry.zoneId === zoneId)
      const normalized = upEvent ? normalizePointer(upEvent.clientX, upEvent.clientY) : null
      const preview =
        zone && normalized
          ? splitPreviewForPointer(current.splitAxis, zone, normalized.x, normalized.y)
          : splitPreview()?.zoneId === zoneId
            ? splitPreview()
            : null
      const result = splitCustomLayoutZone(
        layout,
        zoneId,
        current.splitAxis,
        preview?.ratio ?? 0.5,
        preview?.placement ?? 'second',
      )
      replaceSelectedLayout(result.layout, result.nextZoneId ?? zoneId)
      if (upEvent) {
        setSelectedZoneId(result.nextZoneId ?? zoneId)
      }
    }
    const onPointerUp = (upEvent: PointerEvent) => finish(upEvent)
    const onPointerCancel = () => clearPointerInteraction()
    document.addEventListener('pointermove', onPointerMove, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', onPointerCancel, true)
    cleanupPointerInteraction = () => {
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', onPointerCancel, true)
    }
  }

  function beginResize(path: string, axis: CustomLayoutSplitAxis, event: PointerEvent) {
    const layout = selectedLayout()
    if (!layout) return
    clearPointerInteraction()
    event.preventDefault()
    event.stopPropagation()
    const draggedHandle = listCustomLayoutSplitHandles(layout).find((entry) => entry.path === path)
    if (!draggedHandle) return
    hoverPreviewPoint = null
    setSplitPreviewIfChanged(null)
    setResizePreview({
      path,
      axis,
      ratio: clampCustomLayoutRatio(draggedHandle.ratio),
      parentX: draggedHandle.parentX,
      parentY: draggedHandle.parentY,
      parentWidth: draggedHandle.parentWidth,
      parentHeight: draggedHandle.parentHeight,
    })
    const apply = (clientX: number, clientY: number) => {
      const normalized = normalizePointer(clientX, clientY)
      if (!normalized) return
      const nextRatio =
        Math.round(
          clampCustomLayoutRatio(
            axis === 'vertical'
              ? (normalized.x - draggedHandle.parentX) / draggedHandle.parentWidth
              : (normalized.y - draggedHandle.parentY) / draggedHandle.parentHeight,
          ) / RESIZE_RATIO_STEP,
        ) * RESIZE_RATIO_STEP
      const currentPreview = resizePreview()
      if (Math.abs(nextRatio - clampCustomLayoutRatio(currentPreview?.ratio ?? draggedHandle.ratio)) < RESIZE_RATIO_STEP / 2) return
      setResizePreview({
        path,
        axis,
        ratio: nextRatio,
        parentX: draggedHandle.parentX,
        parentY: draggedHandle.parentY,
        parentWidth: draggedHandle.parentWidth,
        parentHeight: draggedHandle.parentHeight,
      })
    }
    const onPointerMove = (moveEvent: PointerEvent) => apply(moveEvent.clientX, moveEvent.clientY)
    const finish = () => {
      const finalRatio = resizePreview()?.path === path ? resizePreview()!.ratio : clampCustomLayoutRatio(draggedHandle.ratio)
      clearPointerInteraction()
      replaceSelectedLayout(updateCustomLayoutSplitRatio(layout, path, finalRatio), selectedZoneId())
    }
    document.addEventListener('pointermove', onPointerMove, true)
    document.addEventListener('pointerup', finish, true)
    document.addEventListener('pointercancel', finish, true)
    cleanupPointerInteraction = () => {
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('pointerup', finish, true)
      document.removeEventListener('pointercancel', finish, true)
    }
  }

  return (
    <Show when={props.state() && props.getMenuLayerHostEl()}>
      {(host) => (
        <Portal mount={host()}>
          <div
            data-shell-exclusion-floating
            data-custom-layout-overlay
            data-custom-layout-overlay-monitor={props.state()!.outputName}
            class="absolute inset-0 z-[430000]"
            onContextMenu={(event) => event.preventDefault()}
          >
            <div class="absolute inset-0 bg-black/60" />
            <Show when={overlayCss()}>
              {(css) => (
                <>
                  <div
                    class="pointer-events-none absolute bg-white/6 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18),0_24px_80px_rgba(0,0,0,0.45)]"
                    style={{
                      left: `${css().screenCss.left}px`,
                      top: `${css().screenCss.top}px`,
                      width: `${css().screenCss.width}px`,
                      height: `${css().screenCss.height}px`,
                    }}
                  />
                  <div
                    class="absolute bg-[color-mix(in_srgb,var(--shell-accent-soft)_76%,transparent)] shadow-[inset_0_0_0_1px_var(--shell-accent-border),inset_0_0_0_2px_var(--shell-accent-soft-border),0_30px_80px_rgba(0,0,0,0.35)]"
                    style={{
                      left: `${css().workCss.left}px`,
                      top: `${css().workCss.top}px`,
                      width: `${css().workCss.width}px`,
                      height: `${css().workCss.height}px`,
                    }}
                  >
                    <Show when={selectedLayout()} fallback={<div class="h-full" />}>
                      {(_layout) => (
                        <div
                          class="relative h-full overflow-hidden"
                          onPointerMove={(event) => {
                            if (resizePreview()) return
                            updateSplitPreviewForPointer(event.clientX, event.clientY, event.shiftKey)
                          }}
                          onPointerLeave={() => {
                            if (resizePreview()) return
                            hoverPreviewPoint = null
                            setSplitPreviewIfChanged(null)
                          }}
                        >
                          <For each={editorZones()}>
                            {(zone, index) => {
                              const mergeSource = () => mergeDrag()?.sourceZoneId === zone.zoneId
                              const mergeTarget = () => mergePreviewZoneIds().includes(zone.zoneId) && !mergeSource()
                              return (
                                <button
                                  type="button"
                                  data-custom-layout-overlay-zone={zone.zoneId}
                                  class="absolute overflow-hidden border text-left"
                                  classList={{
                                    'border-(--shell-accent-border) bg-(--shell-accent-soft) shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]':
                                      selectedZoneId() === zone.zoneId && !mergeSource() && !mergeTarget(),
                                    'border-white/15 bg-white/6 hover:bg-white/10':
                                      selectedZoneId() !== zone.zoneId && !mergeSource() && !mergeTarget(),
                                    'border-(--shell-accent-border) bg-[color-mix(in_srgb,var(--shell-accent)_28%,transparent)] shadow-[0_0_0_1px_var(--shell-accent-soft-border),0_18px_40px_rgba(0,0,0,0.28)]':
                                      mergeSource(),
                                    'border-emerald-300/80 bg-emerald-400/22 shadow-[0_0_0_1px_rgba(110,231,183,0.45),0_18px_40px_rgba(0,0,0,0.28)]':
                                      mergeTarget(),
                                  }}
                                  style={{
                                    left: `${zone.x * 100}%`,
                                    top: `${zone.y * 100}%`,
                                    width: `${zone.width * 100}%`,
                                    height: `${zone.height * 100}%`,
                                  }}
                                  onPointerDown={(event) => beginZoneGesture(zone.zoneId, event)}
                                  onClick={(event) => event.preventDefault()}
                                  onFocus={() => setSelectedZoneId(zone.zoneId)}
                                >
                                  <span class="pointer-events-none absolute left-5 top-4 text-[0.9rem] font-semibold uppercase tracking-[0.14em] text-(--shell-text-dim)">
                                    {index() + 1}
                                  </span>
                                  <Show when={mergeTarget()}>
                                    <span class="pointer-events-none absolute inset-x-3 bottom-3 rounded-md bg-emerald-950/55 px-2 py-1 text-[0.7rem] font-semibold text-emerald-100">
                                      Merge
                                    </span>
                                  </Show>
                                </button>
                              )
                            }}
                          </For>

                          <Show when={splitPreviewRenderState()}>
                            {(state) => (
                              <>
                                <div
                                  data-custom-layout-overlay-preview="first"
                                  data-custom-layout-overlay-preview-axis={state().preview.axis}
                                  class="pointer-events-none absolute border border-white/20 bg-white/8"
                                  classList={{
                                    'border-(--shell-accent-border) bg-[color-mix(in_srgb,var(--shell-accent)_28%,transparent)]':
                                      state().preview.placement === 'first',
                                  }}
                                  style={state().firstStyle}
                                />
                                <div
                                  data-custom-layout-overlay-preview="second"
                                  data-custom-layout-overlay-preview-axis={state().preview.axis}
                                  class="pointer-events-none absolute border border-white/20 bg-white/8"
                                  classList={{
                                    'border-(--shell-accent-border) bg-[color-mix(in_srgb,var(--shell-accent)_28%,transparent)]':
                                      state().preview.placement === 'second',
                                  }}
                                  style={state().secondStyle}
                                />
                              </>
                            )}
                          </Show>

                          <For each={editorHandles()}>
                            {(handle) => {
                              const vertical = handle.axis === 'vertical'
                              return (
                                <button
                                  type="button"
                                  data-custom-layout-overlay-handle={handle.path || 'root'}
                                  class="absolute z-10 rounded-full border border-white/15 bg-white/18 shadow-[0_8px_24px_rgba(0,0,0,0.22)] hover:bg-white/28"
                                  classList={{
                                    'bg-(--shell-accent) border-(--shell-accent-border)': resizePreview()?.path === handle.path,
                                    'cursor-col-resize': vertical,
                                    'cursor-row-resize': !vertical,
                                  }}
                                  style={
                                    vertical
                                      ? {
                                          left: `calc(${handle.x * 100}% - 0.75rem)`,
                                          top: `${handle.y * 100}%`,
                                          width: '1.5rem',
                                          height: `${handle.height * 100}%`,
                                        }
                                      : {
                                          left: `${handle.x * 100}%`,
                                          top: `calc(${handle.y * 100}% - 0.75rem)`,
                                          width: `${handle.width * 100}%`,
                                          height: '1.5rem',
                                        }
                                  }
                                  onPointerDown={(event) => beginResize(handle.path, handle.axis, event)}
                                  onClick={(event) => event.preventDefault()}
                                />
                              )
                            }}
                          </For>

                          <div class="pointer-events-none absolute inset-x-5 bottom-5 flex justify-center">
                            <div class="rounded-full border border-white/12 bg-black/35 px-4 py-2 text-[0.74rem] font-medium text-white/88 shadow-[0_12px_30px_rgba(0,0,0,0.3)]">
                              Click to split into rows. Hold Shift to split into columns. Drag dividers to resize. Drag one zone into another to merge.
                            </div>
                          </div>
                        </div>
                      )}
                    </Show>
                  </div>
                </>
              )}
            </Show>

            <Show when={panelCss()}>
              {(panel) => (
                <div
                  class="absolute z-[430001]"
                  style={{
                    left: `${panel().left}px`,
                    top: `${panel().top}px`,
                    width: `${panel().width}px`,
                  }}
                >
                  <div class="border border-white/12 bg-(--shell-overlay) min-w-0 rounded-[1.25rem] p-4 text-(--shell-text) shadow-2xl">
                    <div class="flex flex-wrap items-start justify-between gap-3">
                      <div class="min-w-0">
                        <div class="text-[1rem] font-semibold text-(--shell-text)">Custom layouts</div>
                        <div class="mt-1 inline-flex items-center rounded-full border border-(--shell-border) bg-(--shell-surface) px-2.5 py-1 text-[0.72rem] font-medium text-(--shell-text-dim)">
                          {props.state()!.outputName}
                        </div>
                      </div>
                      <div class="flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          data-custom-layout-overlay-add
                          class="border border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover) cursor-pointer rounded-lg px-3 py-2 text-[0.76rem] font-medium"
                          onClick={addLayout}
                        >
                          New layout
                        </button>
                        <button
                          type="button"
                          data-custom-layout-overlay-close
                          class="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) cursor-pointer rounded-lg px-3 py-2 text-[0.76rem] font-medium"
                          onClick={props.close}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          data-custom-layout-overlay-save
                          class="border border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover) cursor-pointer rounded-lg px-3 py-2 text-[0.76rem] font-medium"
                          onClick={saveAndClose}
                        >
                          Save
                        </button>
                      </div>
                    </div>

                    <div class="mt-4 grid gap-3">
                      <div class="flex items-center justify-between gap-3 px-1">
                        <span class="text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-(--shell-text-dim)">Layouts</span>
                        <span class="text-[0.72rem] text-(--shell-text-muted)">{draftLayouts().length}</span>
                      </div>
                      <div class="flex max-h-[24rem] min-w-0 flex-col gap-2 overflow-y-auto pr-1">
                        <For each={draftLayouts()}>
                          {(layout, index) => {
                            const selected = () => selectedLayoutId() === layout.id
                            return (
                              <div
                                class="rounded-xl border bg-(--shell-surface) transition-colors"
                                classList={{
                                  'border-(--shell-accent-border) bg-(--shell-accent-soft) shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]':
                                    selected(),
                                  'border-(--shell-border)': !selected(),
                                }}
                              >
                                <button
                                  type="button"
                                  data-custom-layout-overlay-layout={layout.id}
                                  aria-pressed={selected()}
                                  class="hover:bg-(--shell-surface-elevated) cursor-pointer flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors"
                                  classList={{
                                    'hover:bg-transparent': selected(),
                                  }}
                                  onClick={() => {
                                    setSelectedLayoutId(layout.id)
                                    setSelectedZoneId(firstLeafZoneId(layout.root))
                                  }}
                                >
                                  <div
                                    class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-[0.8rem] font-semibold"
                                    classList={{
                                      'border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground)': selected(),
                                      'border-(--shell-border) bg-(--shell-surface-panel) text-(--shell-text-dim)': !selected(),
                                    }}
                                  >
                                    {index() + 1}
                                  </div>
                                  <div class="min-w-0 flex-1">
                                    <div class="flex items-center justify-between gap-3">
                                      <span class="truncate text-[0.94rem] font-semibold text-(--shell-text)">{layout.name}</span>
                                      <Show when={selected()}>
                                        <span class="rounded-full border border-(--shell-accent-border) bg-(--shell-accent) px-2.5 py-1 text-[0.68rem] font-semibold text-(--shell-accent-foreground)">
                                          Editing
                                        </span>
                                      </Show>
                                    </div>
                                    <div class="mt-1 text-[0.76rem] text-(--shell-text-muted)">{collectZoneIds(layout.root).length} zones</div>
                                  </div>
                                </button>
                                <Show when={selected()}>
                                  <div class="grid gap-3 border-t border-white/8 px-4 py-3">
                                    <label class="grid gap-1.5">
                                      <span class="text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-(--shell-text-dim)">Rename</span>
                                      <input
                                        value={layout.name}
                                        placeholder="Layout name"
                                        data-custom-layout-overlay-name
                                        class="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) rounded-lg px-3 py-2 text-[0.84rem] outline-none"
                                        onInput={(event) => renameSelected(event.currentTarget.value)}
                                      />
                                    </label>
                                    <div class="flex items-center justify-between gap-3">
                                      <div class="text-[0.76rem] text-(--shell-text-muted)">
                                        {collectZoneIds(layout.root).length} zones
                                      </div>
                                      <button
                                        type="button"
                                        data-custom-layout-overlay-remove={layout.id}
                                        class="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) cursor-pointer rounded-lg px-3 py-2 text-[0.76rem] font-medium"
                                        onClick={removeSelectedLayout}
                                      >
                                        Delete layout
                                      </button>
                                    </div>
                                  </div>
                                </Show>
                              </div>
                            )
                          }}
                        </For>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </Portal>
      )}
    </Show>
  )
}
