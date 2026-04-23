import { Index, Show, createMemo } from 'solid-js'
import {
  assistPickMatchesGridSpan,
  assistShapeToDims,
  assistSpanToGridLines,
  type AssistGridShape,
  type AssistGridSpan,
} from './assistGrid'

type Placement = {
  kind: 'cell' | 'vgutter' | 'hgutter' | 'junction'
  gridColumn: number
  gridRow: number
  span: AssistGridSpan
  zIndex?: number
}

function buildPlacements(cols: number, rows: number): Placement[] {
  const out: Placement[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gc = c * 2 + 1
      const gr = r * 2 + 1
      out.push({
        kind: 'cell',
        gridColumn: gc,
        gridRow: gr,
        span: { gridCols: cols, gridRows: rows, gc0: c, gc1: c, gr0: r, gr1: r },
      })
    }
  }
  for (let c = 0; c < cols - 1; c++) {
    const gc = (c + 1) * 2
    for (let r = 0; r < rows; r++) {
      const gr = r * 2 + 1
      out.push({
        kind: 'vgutter',
        gridColumn: gc,
        gridRow: gr,
        span: { gridCols: cols, gridRows: rows, gc0: c, gc1: c + 1, gr0: r, gr1: r },
      })
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    const gr = (r + 1) * 2
    for (let c = 0; c < cols; c++) {
      const gc = c * 2 + 1
      out.push({
        kind: 'hgutter',
        gridColumn: gc,
        gridRow: gr,
        span: { gridCols: cols, gridRows: rows, gc0: c, gc1: c, gr0: r, gr1: r + 1 },
      })
    }
  }
  for (let c = 0; c < cols - 1; c++) {
    for (let r = 0; r < rows - 1; r++) {
      const gc = (c + 1) * 2
      const gr = (r + 1) * 2
      out.push({
        kind: 'junction',
        gridColumn: gc,
        gridRow: gr,
        zIndex: 10,
        span: { gridCols: cols, gridRows: rows, gc0: c, gc1: c + 1, gr0: r, gr1: r + 1 },
      })
    }
  }
  return out
}

function axisSpanFromPointer(
  value: number,
  total: number,
  count: number,
  gutterPx: number,
): { i0: number; i1: number } | null {
  if (count <= 0 || total <= 0) return null
  const g = Math.max(0, gutterPx)
  const cell = (total - (count - 1) * g) / count
  if (cell <= 0) return null
  const v = Math.max(0, Math.min(value, total - 1e-6))
  const band = Math.max(g, Math.min(38, cell * 1.7))
  for (let i = 0; i < count - 1; i += 1) {
    const center = (i + 1) * cell + i * g + g / 2
    if (Math.abs(v - center) <= band / 2) {
      return { i0: i, i1: i + 1 }
    }
  }
  const pitch = cell + g
  let index = Math.max(0, Math.min(count - 1, Math.floor(v / pitch)))
  const start = index * pitch
  if (v > start + cell && index < count - 1) {
    index = v < start + cell + g / 2 ? index : index + 1
  }
  return { i0: index, i1: index }
}

function parseCssPx(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function assistSpanFromMasterGridPoint(
  grid: HTMLElement,
  clientX: number,
  clientY: number,
  shape: AssistGridShape,
  gutterPx: number,
): AssistGridSpan | null {
  const rect = grid.getBoundingClientRect()
  const style = getComputedStyle(grid)
  const left = parseCssPx(style.paddingLeft)
  const right = parseCssPx(style.paddingRight)
  const top = parseCssPx(style.paddingTop)
  const bottom = parseCssPx(style.paddingBottom)
  const width = rect.width - left - right
  const height = rect.height - top - bottom
  const x = clientX - rect.left - left
  const y = clientY - rect.top - top
  if (x < 0 || y < 0 || x > width || y > height) return null
  const { cols, rows } = assistShapeToDims(shape)
  const xs = axisSpanFromPointer(x, width, cols, gutterPx)
  const ys = axisSpanFromPointer(y, height, rows, gutterPx)
  if (!xs || !ys) return null
  return {
    gridCols: cols,
    gridRows: rows,
    gc0: xs.i0,
    gc1: xs.i1,
    gr0: ys.i0,
    gr1: ys.i1,
  }
}

function defaultShapeLabel(shape: AssistGridShape): string {
  switch (shape) {
    case '3x2':
      return '3×2'
    case '3x3':
      return '3×3'
    case '2x2':
      return '2×2'
    case '2x3':
      return '2×3'
  }
}

export type SnapAssistMasterGridProps = {
  shape: AssistGridShape
  gutterPx: number
  getHoverSpan: () => AssistGridSpan | null
  layoutLabel?: string
  pickMode?: boolean
  onHoverSpan?: (span: AssistGridSpan | null) => void
  onPickSpan?: (span: AssistGridSpan) => void
}

export function SnapAssistMasterGrid(props: SnapAssistMasterGridProps) {
  const hover = createMemo(() => props.getHoverSpan())
  const placements = createMemo(() => {
    const { cols, rows } = assistShapeToDims(props.shape)
    return buildPlacements(cols, rows)
  })
  const gridTemplate = createMemo(() => {
    const { cols, rows } = assistShapeToDims(props.shape)
    const g = Math.max(2, props.gutterPx)
    const colT = Array.from({ length: cols * 2 - 1 }, (_, i) =>
      i % 2 === 0 ? 'minmax(0,1fr)' : `${g}px`,
    ).join(' ')
    const rowT = Array.from({ length: rows * 2 - 1 }, (_, i) =>
      i % 2 === 0 ? 'minmax(0,1fr)' : `${g}px`,
    ).join(' ')
    return { colT, rowT }
  })
  const hoverSpan = createMemo(() => hover() ?? null)
  const hoverLines = createMemo(() => {
    const h = hoverSpan()
    if (!h) return null
    const d = assistShapeToDims(props.shape)
    if (h.gridCols !== d.cols || h.gridRows !== d.rows) return null
    return assistSpanToGridLines(h)
  })
  const title = createMemo(() => props.layoutLabel ?? defaultShapeLabel(props.shape))
  const spanFromEvent = (event: PointerEvent) =>
    assistSpanFromMasterGridPoint(event.currentTarget as HTMLElement, event.clientX, event.clientY, props.shape, props.gutterPx)

  return (
    <div
      class={`flex min-h-0 w-full min-w-0 flex-col overflow-hidden ${props.pickMode ? '' : 'h-full flex-1'}`}
      data-assist-mini-grid={props.shape}
    >
      <div class="mb-0.5 shrink-0 text-center text-[10px] font-medium tracking-wider text-(--shell-text-dim)">
        {title()}
      </div>
      <div
        data-assist-master-grid={props.shape}
        data-assist-master-grid-gutter-px={String(props.gutterPx)}
        class={`relative grid min-h-0 min-w-0 rounded-md border border-(--shell-border) bg-(--shell-surface-inset) p-1 shadow-md ${props.pickMode ? 'h-[112px]' : 'flex-1'}`}
        style={{
          'grid-template-columns': gridTemplate().colT,
          'grid-template-rows': gridTemplate().rowT,
        }}
        onPointerMove={(event) => {
          if (!props.pickMode) return
          props.onHoverSpan?.(spanFromEvent(event))
        }}
        onPointerDown={(event) => {
          if (!props.pickMode) return
          const span = spanFromEvent(event)
          if (!span) return
          event.preventDefault()
          props.onPickSpan?.(span)
        }}
        onPointerLeave={() => props.onHoverSpan?.(null)}
      >
        <Index each={placements()}>
          {(p) => {
            const active = createMemo(() => assistPickMatchesGridSpan(hover(), p().span))
            const isFirstCell = createMemo(() =>
              p().kind === 'cell' &&
              p().span.gc0 === 0 &&
              p().span.gc1 === 0 &&
              p().span.gr0 === 0 &&
              p().span.gr1 === 0,
            )
            const isFirstColumnHgutter = createMemo(() =>
              p().kind === 'hgutter' &&
              p().span.gc0 === 0 &&
              p().span.gc1 === 0 &&
              p().span.gr0 === 0 &&
              p().span.gr1 === 1,
            )
            const isVgutterTwoColsTopRow = createMemo(() =>
              p().kind === 'vgutter' &&
              p().span.gc0 === 0 &&
              p().span.gc1 === 1 &&
              p().span.gr0 === 0 &&
              p().span.gr1 === 0,
            )
            const is2x2TopRightCell = createMemo(() =>
              p().kind === 'cell' &&
              p().span.gridCols === 2 &&
              p().span.gridRows === 2 &&
              p().span.gc0 === 1 &&
              p().span.gc1 === 1 &&
              p().span.gr0 === 0 &&
              p().span.gr1 === 0,
            )
            const tileClass = createMemo(() =>
              p().kind === 'cell'
                ? 'rounded-sm border border-(--shell-border) bg-(--shell-surface-elevated) shadow-sm'
                : p().kind === 'junction'
                  ? 'rounded-sm bg-(--shell-surface-inset)'
                  : 'bg-(--shell-surface)',
            )
            return (
              <DynamicTile
                data-assist-grid-span=""
                data-gc0={String(p().span.gc0)}
                data-gc1={String(p().span.gc1)}
                data-gr0={String(p().span.gr0)}
                data-gr1={String(p().span.gr1)}
                data-grid-cols={String(p().span.gridCols)}
                data-grid-rows={String(p().span.gridRows)}
                data-snap-assist-hover-active={active() ? '' : undefined}
                data-testid={
                  isFirstCell()
                    ? 'snap-assist-master-cell'
                    : isFirstColumnHgutter()
                      ? 'snap-assist-hgutter-col0'
                      : is2x2TopRightCell()
                        ? 'snap-assist-2x2-top-right-cell'
                      : isVgutterTwoColsTopRow()
                        ? 'snap-assist-vgutter-two-cols-top'
                        : undefined
                }
                class={`box-border min-h-0 min-w-0 border-0 p-0 ${props.pickMode ? 'cursor-pointer transition-colors' : ''} ${tileClass()}`}
                style={{
                  'grid-column': String(p().gridColumn),
                  'grid-row': String(p().gridRow),
                  ...(p().zIndex != null ? { 'z-index': String(p().zIndex) } : {}),
                }}
                onPointerEnter={() => props.onHoverSpan?.(p().span)}
                onFocus={() => props.onHoverSpan?.(p().span)}
                onClick={(event) => {
                  if (event.detail === 0) props.onPickSpan?.(p().span)
                }}
                pickMode={!!props.pickMode}
              />
            )
          }}
        </Index>
        <Show when={hoverLines()} keyed>
          {(L) => (
            <div
              data-assist-grid-hover-overlay
              class="pointer-events-none z-20 rounded-md border-2 border-(--shell-preview-outline) bg-(--shell-accent-soft) shadow-md ring-2 ring-(--shell-preview-outline)"
              style={{
                'grid-column': `${L.colStart} / ${L.colEnd}`,
                'grid-row': `${L.rowStart} / ${L.rowEnd}`,
              }}
            />
          )}
        </Show>
      </div>
    </div>
  )
}

type DynamicTileProps = {
  pickMode: boolean
  class: string
  style: Record<string, string>
  ['data-assist-grid-span']: string
  ['data-gc0']: string
  ['data-gc1']: string
  ['data-gr0']: string
  ['data-gr1']: string
  ['data-grid-cols']: string
  ['data-grid-rows']: string
  ['data-snap-assist-hover-active']?: string | undefined
  ['data-testid']?: string | undefined
  onPointerDown?: (event: PointerEvent) => void
  onPointerEnter: () => void
  onFocus: () => void
  onClick?: (event: MouseEvent) => void
}

function DynamicTile(props: DynamicTileProps) {
  if (props.pickMode) {
    return (
      <button
        type="button"
        data-assist-grid-span={props['data-assist-grid-span']}
        data-gc0={props['data-gc0']}
        data-gc1={props['data-gc1']}
        data-gr0={props['data-gr0']}
        data-gr1={props['data-gr1']}
        data-grid-cols={props['data-grid-cols']}
        data-grid-rows={props['data-grid-rows']}
        data-snap-assist-hover-active={props['data-snap-assist-hover-active']}
        data-testid={props['data-testid']}
        class={props.class}
        style={props.style}
        onPointerDown={props.onPointerDown}
        onPointerEnter={props.onPointerEnter}
        onFocus={props.onFocus}
        onClick={props.onClick}
      />
    )
  }
  return (
    <div
      data-assist-grid-span={props['data-assist-grid-span']}
      data-gc0={props['data-gc0']}
      data-gc1={props['data-gc1']}
      data-gr0={props['data-gr0']}
      data-gr1={props['data-gr1']}
      data-grid-cols={props['data-grid-cols']}
      data-grid-rows={props['data-grid-rows']}
      data-snap-assist-hover-active={props['data-snap-assist-hover-active']}
      data-testid={props['data-testid']}
      class={props.class}
      style={props.style}
    />
  )
}
