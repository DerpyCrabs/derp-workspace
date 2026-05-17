import {
  assistPickMatchesGridSpan,
  assistShapeToDims,
  assistSpanToGridLines,
  snapZoneAndPreviewFromAssistSpan,
  type AssistGridShape,
  type AssistGridSpan,
} from './assistGrid'
import {
  customSnapZoneId,
  firstLeafZoneId,
  listCustomLayoutZones,
  resolveCustomLayoutZoneBounds,
  type CustomLayout,
} from './customLayouts'
import { assistSpanFromMasterGridPoint } from './SnapAssistMasterGrid'
import {
  assistMonitorSnapLayout,
  customMonitorSnapLayout,
  type MonitorSnapLayout,
} from './tilingConfig'
import type { Rect, SnapZone } from './tileZones'
import type { SnapAssistPickerAnchorRect } from '@/host/types'
import { registerShellExclusionElement } from '@/features/bridge/shellExclusionSync'
import {
  invalidateShellUiWindow,
  registerShellUiWindow,
  shellUiWindowMeasureFromEnv,
  type ShellUiMeasureEnv,
} from '@/features/shell-ui/shellHostedSurfaceRegistry'

const SNAP_ASSIST_SHAPES: AssistGridShape[] = ['3x2', '3x3', '2x2', '2x3']
const PICKER_APPROX_WIDTH = 360
const PICKER_APPROX_HEIGHT = 760
const PICKER_GUTTER_PX = 18
const DEFAULT_PICKER_SPAN: AssistGridSpan = {
  gridCols: 3,
  gridRows: 2,
  gc0: 0,
  gc1: 0,
  gr0: 0,
  gr1: 0,
}

export type SnapPickerSelection = {
  zone: SnapZone
  previewRect: Rect
  snapLayout: MonitorSnapLayout
  shape: AssistGridShape | null
  hoverSpan: AssistGridSpan | null
}

export type ImperativeSnapAssistPickerState = {
  anchorRect: SnapAssistPickerAnchorRect
  container: HTMLElement
  workArea: { x: number; y: number; w: number; h: number }
  currentSnapLayout: MonitorSnapLayout
  customLayouts: CustomLayout[]
  hoverSelection: SnapPickerSelection | null
  autoHover?: boolean
  shellUiWindowId?: number
  shellUiWindowZ?: number
  getShellUiMeasureEnv?: () => ShellUiMeasureEnv | null
}

export type ImperativeSnapAssistPickerOptions = {
  onHoverSelectionChange: (selection: SnapPickerSelection | null) => void
  onSelectSelection: (selection: SnapPickerSelection) => void
  onClose: () => void
}

type GridNode = {
  root: HTMLElement
  shape: AssistGridShape
  tiles: HTMLElement[]
  hoverOverlay: HTMLElement
}

type CustomZoneNode = {
  root: HTMLElement
  layoutId: string
  zoneId: string
}

type PickerDom = {
  root: HTMLDivElement
  list: HTMLDivElement
  customZones: CustomZoneNode[]
  grids: GridNode[]
}

function shapeLabel(shape: AssistGridShape): string {
  switch (shape) {
    case '3x2':
      return '3x2'
    case '3x3':
      return '3x3'
    case '2x2':
      return '2x2'
    case '2x3':
      return '2x3'
  }
}

function selectionFromSpan(
  span: AssistGridSpan,
  shape: AssistGridShape,
  workArea: { x: number; y: number; w: number; h: number },
): SnapPickerSelection {
  const { zone, previewRect } = snapZoneAndPreviewFromAssistSpan(span, shape, workArea)
  return {
    zone,
    previewRect,
    snapLayout: assistMonitorSnapLayout(shape),
    shape,
    hoverSpan: span,
  }
}

function customSelection(
  layoutId: string,
  zone: string,
  customLayouts: readonly CustomLayout[],
  workArea: { x: number; y: number; w: number; h: number },
): SnapPickerSelection | null {
  const bounds = resolveCustomLayoutZoneBounds(customLayouts, zone, {
    x: workArea.x,
    y: workArea.y,
    width: workArea.w,
    height: workArea.h,
  })
  if (!bounds) return null
  return {
    zone,
    previewRect: bounds,
    snapLayout: customMonitorSnapLayout(layoutId),
    shape: null,
    hoverSpan: null,
  }
}

function customDefaultSelection(
  layoutId: string,
  customLayouts: readonly CustomLayout[],
  workArea: { x: number; y: number; w: number; h: number },
): SnapPickerSelection | null {
  const layout = customLayouts.find((entry) => entry.id === layoutId)
  if (!layout) return null
  return customSelection(layoutId, `custom:${layout.id}:${firstLeafZoneId(layout.root)}`, customLayouts, workArea)
}

function positionPicker(root: HTMLElement, state: ImperativeSnapAssistPickerState) {
  const rect = root.getBoundingClientRect()
  const width = Math.max(1, rect.width || PICKER_APPROX_WIDTH)
  const height = Math.max(1, rect.height || PICKER_APPROX_HEIGHT)
  const containerRect = state.container.getBoundingClientRect()
  const minLeft = containerRect.left + 8
  const maxLeft = containerRect.right - width - 8
  const minTop = containerRect.top + 8
  const maxTop = containerRect.bottom - height - 8
  let left = state.anchorRect.left + state.anchorRect.width / 2 - width / 2
  if (maxLeft >= minLeft) {
    if (left > maxLeft) left = maxLeft
    if (left < minLeft) left = minLeft
  } else {
    left = containerRect.left + Math.max(0, (containerRect.width - width) / 2)
  }
  let top = state.anchorRect.bottom
  if (top > maxTop) top = state.anchorRect.top - height
  if (maxTop >= minTop) {
    if (top > maxTop) top = maxTop
    if (top < minTop) top = minTop
  } else {
    top = containerRect.top + Math.max(0, (containerRect.height - height) / 2)
  }
  root.style.left = `${left}px`
  root.style.top = `${top}px`
}

function buildPlacements(cols: number, rows: number): Array<{ kind: 'cell' | 'vgutter' | 'hgutter' | 'junction'; span: AssistGridSpan; col: number; row: number; z?: number }> {
  const out: Array<{ kind: 'cell' | 'vgutter' | 'hgutter' | 'junction'; span: AssistGridSpan; col: number; row: number; z?: number }> = []
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      out.push({ kind: 'cell', col: c * 2 + 1, row: r * 2 + 1, span: { gridCols: cols, gridRows: rows, gc0: c, gc1: c, gr0: r, gr1: r } })
    }
  }
  for (let c = 0; c < cols - 1; c += 1) {
    for (let r = 0; r < rows; r += 1) {
      out.push({ kind: 'vgutter', col: (c + 1) * 2, row: r * 2 + 1, span: { gridCols: cols, gridRows: rows, gc0: c, gc1: c + 1, gr0: r, gr1: r } })
    }
  }
  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      out.push({ kind: 'hgutter', col: c * 2 + 1, row: (r + 1) * 2, span: { gridCols: cols, gridRows: rows, gc0: c, gc1: c, gr0: r, gr1: r + 1 } })
    }
  }
  for (let c = 0; c < cols - 1; c += 1) {
    for (let r = 0; r < rows - 1; r += 1) {
      out.push({ kind: 'junction', col: (c + 1) * 2, row: (r + 1) * 2, z: 10, span: { gridCols: cols, gridRows: rows, gc0: c, gc1: c + 1, gr0: r, gr1: r + 1 } })
    }
  }
  return out
}

function setActive(el: HTMLElement, active: boolean) {
  el.classList.toggle('border-(--shell-accent-border)', active)
  el.classList.toggle('bg-(--shell-accent-soft)', active)
  el.classList.toggle('shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]', active)
  el.classList.toggle('border-(--shell-border)', !active)
  el.classList.toggle('bg-(--shell-surface-elevated)', !active)
}

function createMasterGrid(shape: AssistGridShape): GridNode {
  const wrap = document.createElement('div')
  const label = document.createElement('div')
  const grid = document.createElement('div')
  const { cols, rows } = assistShapeToDims(shape)
  const g = Math.max(2, PICKER_GUTTER_PX)
  const colT = Array.from({ length: cols * 2 - 1 }, (_, i) => (i % 2 === 0 ? 'minmax(0,1fr)' : `${g}px`)).join(' ')
  const rowT = Array.from({ length: rows * 2 - 1 }, (_, i) => (i % 2 === 0 ? 'minmax(0,1fr)' : `${g}px`)).join(' ')
  const tiles: HTMLElement[] = []
  wrap.className = 'flex min-h-0 w-full min-w-0 flex-col overflow-hidden'
  wrap.dataset.assistMiniGrid = shape
  label.className = 'mb-0.5 shrink-0 text-center text-[10px] font-medium tracking-wider text-(--shell-text-dim)'
  label.textContent = shapeLabel(shape)
  grid.className = 'relative grid h-[112px] min-h-0 min-w-0 rounded-md border border-(--shell-border) bg-(--shell-surface-inset) p-1 shadow-md'
  grid.dataset.assistMasterGrid = shape
  grid.dataset.assistMasterGridGutterPx = String(PICKER_GUTTER_PX)
  grid.style.gridTemplateColumns = colT
  grid.style.gridTemplateRows = rowT
  for (const placement of buildPlacements(cols, rows)) {
    const tile = document.createElement('button')
    tile.type = 'button'
    tile.dataset.assistGridSpan = ''
    tile.dataset.gc0 = String(placement.span.gc0)
    tile.dataset.gc1 = String(placement.span.gc1)
    tile.dataset.gr0 = String(placement.span.gr0)
    tile.dataset.gr1 = String(placement.span.gr1)
    tile.dataset.gridCols = String(placement.span.gridCols)
    tile.dataset.gridRows = String(placement.span.gridRows)
    tile.dataset.kind = placement.kind
    tile.style.gridColumn = String(placement.col)
    tile.style.gridRow = String(placement.row)
    if (placement.z) tile.style.zIndex = String(placement.z)
    if (placement.kind === 'cell' && placement.span.gc0 === 0 && placement.span.gc1 === 0 && placement.span.gr0 === 0 && placement.span.gr1 === 0) {
      tile.dataset.testid = 'snap-assist-master-cell'
    } else if (placement.kind === 'hgutter' && placement.span.gc0 === 0 && placement.span.gc1 === 0 && placement.span.gr0 === 0 && placement.span.gr1 === 1) {
      tile.dataset.testid = 'snap-assist-hgutter-col0'
    } else if (placement.kind === 'cell' && placement.span.gridCols === 2 && placement.span.gridRows === 2 && placement.span.gc0 === 1 && placement.span.gc1 === 1 && placement.span.gr0 === 0 && placement.span.gr1 === 0) {
      tile.dataset.testid = 'snap-assist-2x2-top-right-cell'
    } else if (placement.kind === 'vgutter' && placement.span.gc0 === 0 && placement.span.gc1 === 1 && placement.span.gr0 === 0 && placement.span.gr1 === 0) {
      tile.dataset.testid = 'snap-assist-vgutter-two-cols-top'
    }
    tile.className =
      `box-border min-h-0 min-w-0 border-0 p-0 cursor-pointer transition-colors ${
        placement.kind === 'cell'
          ? 'rounded-sm border border-(--shell-border) bg-(--shell-surface-elevated) shadow-sm'
          : placement.kind === 'junction'
            ? 'rounded-sm bg-(--shell-surface-inset)'
            : 'bg-(--shell-surface)'
      }`
    grid.append(tile)
    tiles.push(tile)
  }
  const hoverOverlay = document.createElement('div')
  hoverOverlay.className = 'pointer-events-none z-20 hidden rounded-md border-2 border-(--shell-preview-outline) bg-(--shell-accent-soft) shadow-md ring-2 ring-(--shell-preview-outline)'
  grid.append(hoverOverlay)
  wrap.append(label, grid)
  return { root: wrap, shape, tiles, hoverOverlay }
}

function renderCustomLayout(layout: CustomLayout, state: ImperativeSnapAssistPickerState, options: ImperativeSnapAssistPickerOptions, zonesOut: CustomZoneNode[]) {
  const card = document.createElement('div')
  const header = document.createElement('div')
  const title = document.createElement('span')
  const tag = document.createElement('span')
  const preview = document.createElement('div')
  card.className = 'flex flex-col gap-1.5 rounded-xl border border-(--shell-border) bg-(--shell-surface-panel) p-2'
  header.className = 'flex items-center justify-between gap-2 px-1'
  title.className = 'truncate text-[0.76rem] font-semibold text-(--shell-text)'
  title.textContent = layout.name
  tag.className = 'text-[0.68rem] text-(--shell-text-dim)'
  tag.textContent = 'Custom'
  preview.className = 'relative w-full overflow-hidden rounded-xl border border-(--shell-border) bg-(--shell-surface-inset) aspect-[16/10]'
  preview.dataset.customLayoutPreview = layout.id
  preview.addEventListener('pointerleave', () => options.onHoverSelectionChange(null))
  header.append(title, tag)
  card.append(header, preview)
  listCustomLayoutZones(layout).forEach((zone, index) => {
    const zoneKey = customSnapZoneId(layout.id, zone.zoneId)
    const button = document.createElement('button')
    const label = document.createElement('span')
    button.type = 'button'
    button.dataset.customLayoutZone = zone.zoneId
    button.dataset.customLayoutZoneKey = zoneKey
    button.dataset.snapPickerCustomLayout = layout.id
    button.dataset.snapPickerCustomZone = zone.zoneId
    button.className = 'absolute overflow-hidden rounded-lg border text-left cursor-pointer'
    button.style.left = `${zone.x * 100}%`
    button.style.top = `${zone.y * 100}%`
    button.style.width = `${zone.width * 100}%`
    button.style.height = `${zone.height * 100}%`
    label.className = 'pointer-events-none absolute left-2 top-1.5 text-[0.62rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)'
    label.textContent = String(index + 1)
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const selection = customSelection(layout.id, zoneKey, state.customLayouts, state.workArea)
      if (selection) options.onSelectSelection(selection)
    })
    button.addEventListener('pointerenter', () => {
      options.onHoverSelectionChange(customSelection(layout.id, zoneKey, state.customLayouts, state.workArea))
    })
    button.addEventListener('focus', () => {
      options.onHoverSelectionChange(customSelection(layout.id, zoneKey, state.customLayouts, state.workArea))
    })
    button.addEventListener('click', (event) => {
      if (event.detail !== 0) return
      const selection = customSelection(layout.id, zoneKey, state.customLayouts, state.workArea)
      if (selection) options.onSelectSelection(selection)
    })
    button.append(label)
    preview.append(button)
    zonesOut.push({ root: button, layoutId: layout.id, zoneId: zone.zoneId })
  })
  return card
}

function createPickerDom(state: ImperativeSnapAssistPickerState, options: ImperativeSnapAssistPickerOptions): PickerDom {
  const root = document.createElement('div')
  const heading = document.createElement('div')
  const list = document.createElement('div')
  const customZones: CustomZoneNode[] = []
  const grids = SNAP_ASSIST_SHAPES.map(createMasterGrid)
  root.dataset.shellSnapPicker = ''
  root.dataset.tilingPicker = ''
  root.className = 'fixed z-[1100000] max-h-[min(88vh,760px)] w-[min(360px,calc(100vw-16px))] overflow-y-auto rounded-lg border border-(--shell-border) bg-(--shell-surface-panel) p-3 shadow-2xl'
  heading.className = 'mb-2 text-[11px] font-semibold tracking-wider text-(--shell-text-dim) uppercase'
  heading.textContent = 'Snap layouts'
  list.className = 'flex flex-col gap-2.5'
  for (const layout of state.customLayouts) list.append(renderCustomLayout(layout, state, options, customZones))
  for (const grid of grids) {
    const gridEl = grid.root.querySelector<HTMLElement>('[data-assist-master-grid]')
    gridEl?.addEventListener('pointermove', (event) => {
      const span = assistSpanFromMasterGridPoint(gridEl, event.clientX, event.clientY, grid.shape, PICKER_GUTTER_PX)
      options.onHoverSelectionChange(span ? selectionFromSpan(span, grid.shape, state.workArea) : null)
    })
    gridEl?.addEventListener('pointerdown', (event) => {
      const span = assistSpanFromMasterGridPoint(gridEl, event.clientX, event.clientY, grid.shape, PICKER_GUTTER_PX)
      if (!span) return
      event.preventDefault()
      options.onSelectSelection(selectionFromSpan(span, grid.shape, state.workArea))
    })
    gridEl?.addEventListener('pointerleave', () => options.onHoverSelectionChange(null))
    list.append(grid.root)
  }
  root.append(heading, list)
  state.container.append(root)
  return { root, list, customZones, grids }
}

function updateActiveState(dom: PickerDom, state: ImperativeSnapAssistPickerState) {
  const hover = state.hoverSelection
  for (const zone of dom.customZones) {
    const active =
      hover?.snapLayout.kind === 'custom' &&
      hover.snapLayout.layoutId === zone.layoutId &&
      hover.zone === customSnapZoneId(zone.layoutId, zone.zoneId)
    setActive(zone.root, active)
  }
  const hoverSpan = hover?.hoverSpan ?? null
  for (const grid of dom.grids) {
    const lines = hoverSpan ? assistSpanToGridLines(hoverSpan) : null
    const dims = assistShapeToDims(grid.shape)
    const overlayVisible =
      !!lines &&
      hoverSpan?.gridCols === dims.cols &&
      hoverSpan.gridRows === dims.rows
    grid.hoverOverlay.classList.toggle('hidden', !overlayVisible)
    if (overlayVisible) grid.hoverOverlay.dataset.assistGridHoverOverlay = ''
    else delete grid.hoverOverlay.dataset.assistGridHoverOverlay
    if (overlayVisible && lines) {
      grid.hoverOverlay.style.gridColumn = `${lines.colStart} / ${lines.colEnd}`
      grid.hoverOverlay.style.gridRow = `${lines.rowStart} / ${lines.rowEnd}`
    }
    for (const tile of grid.tiles) {
      const span: AssistGridSpan = {
        gridCols: Number(tile.dataset.gridCols),
        gridRows: Number(tile.dataset.gridRows),
        gc0: Number(tile.dataset.gc0),
        gc1: Number(tile.dataset.gc1),
        gr0: Number(tile.dataset.gr0),
        gr1: Number(tile.dataset.gr1),
      }
      const active = assistPickMatchesGridSpan(hoverSpan, span)
      if (active) tile.dataset.snapAssistHoverActive = ''
      else delete tile.dataset.snapAssistHoverActive
    }
  }
}

export function createImperativeSnapAssistPicker(options: ImperativeSnapAssistPickerOptions) {
  let dom: PickerDom | null = null
  let state: ImperativeSnapAssistPickerState | null = null
  let shellUiUnregister: (() => void) | null = null
  let exclusionUnregister: (() => void) | null = null
  let resizeObserver: ResizeObserver | null = null
  const onPointerDown = (event: PointerEvent) => {
    if (!dom) return
    const target = event.target
    if (!(target instanceof Node)) return
    if (dom.root.contains(target)) return
    options.onClose()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') options.onClose()
  }
  const updatePosition = () => {
    if (!dom || !state) return
    positionPicker(dom.root, state)
    if (state.shellUiWindowId) invalidateShellUiWindow(state.shellUiWindowId)
  }

  function destroy() {
    resizeObserver?.disconnect()
    resizeObserver = null
    shellUiUnregister?.()
    shellUiUnregister = null
    exclusionUnregister?.()
    exclusionUnregister = null
    dom?.root.remove()
    dom = null
    state = null
    document.removeEventListener?.('pointerdown', onPointerDown, true)
    document.removeEventListener?.('keydown', onKeyDown)
    window.removeEventListener?.('resize', updatePosition)
    options.onHoverSelectionChange(null)
  }

  function render(next: ImperativeSnapAssistPickerState | null) {
    if (!next) {
      if (dom) destroy()
      return
    }
    const needsRecreate =
      !dom ||
      state?.container !== next.container ||
      state.currentSnapLayout.kind !== next.currentSnapLayout.kind ||
      (state.currentSnapLayout.kind === 'custom' && next.currentSnapLayout.kind === 'custom' && state.currentSnapLayout.layoutId !== next.currentSnapLayout.layoutId)
    if (needsRecreate) {
      if (dom) destroy()
      state = next
      dom = createPickerDom(next, options)
      exclusionUnregister = registerShellExclusionElement('base', 'snap-picker', dom.root).unregister
      if (next.shellUiWindowId && next.shellUiWindowZ != null && next.getShellUiMeasureEnv) {
        shellUiUnregister = registerShellUiWindow(next.shellUiWindowId, () =>
          shellUiWindowMeasureFromEnv(next.shellUiWindowId!, next.shellUiWindowZ!, dom?.root, next.getShellUiMeasureEnv!),
        )
      }
      resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updatePosition) : null
      resizeObserver?.observe(next.container)
      resizeObserver?.observe(dom.root)
      window.addEventListener('resize', updatePosition)
      document.addEventListener('pointerdown', onPointerDown, true)
      document.addEventListener('keydown', onKeyDown)
      if (next.autoHover !== false) {
        const defaultSelection =
          next.currentSnapLayout.kind === 'assist'
            ? selectionFromSpan(DEFAULT_PICKER_SPAN, next.currentSnapLayout.shape, next.workArea)
            : customDefaultSelection(next.currentSnapLayout.layoutId, next.customLayouts, next.workArea)
        const initialSelection = next.hoverSelection ?? defaultSelection
        if (initialSelection) {
          queueMicrotask(() => {
            if (!dom || state?.container !== next.container) return
            options.onHoverSelectionChange(initialSelection)
          })
        }
      }
    }
    state = next
    if (!dom) return
    positionPicker(dom.root, next)
    updateActiveState(dom, next)
    updatePosition()
  }

  function updateHoverSelection(selection: SnapPickerSelection | null) {
    if (!dom || !state) return
    state = { ...state, hoverSelection: selection }
    updateActiveState(dom, state)
  }

  return { render, updateHoverSelection, destroy }
}
