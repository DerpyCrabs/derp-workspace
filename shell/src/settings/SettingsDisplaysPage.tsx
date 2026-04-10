import { For, Show, batch, createMemo, createSignal, onCleanup } from 'solid-js'
import type { Setter } from 'solid-js'
import type { SetStoreFunction } from 'solid-js/store'
import { Select } from '../Select'
import { TransformPicker } from '../TransformPicker'
import type { SettingsLayoutScreen } from './settingsTypes'

const PREVIEW_W = 520
const PREVIEW_H = 260
const PREVIEW_PAD = 16
const PREVIEW_SNAP_PX = 14

type PreviewRect = {
  index: number
  row: SettingsLayoutScreen
  left: number
  top: number
  width: number
  height: number
}

type PreviewDrag = {
  index: number
  startPreviewX: number
  startPreviewY: number
  startScreenX: number
  startScreenY: number
  scale: number
}

function screenUnionBBox(rows: SettingsLayoutScreen[]): { x: number; y: number; w: number; h: number } | null {
  if (rows.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxR = -Infinity
  let maxB = -Infinity
  for (const row of rows) {
    minX = Math.min(minX, row.x)
    minY = Math.min(minY, row.y)
    maxR = Math.max(maxR, row.x + row.width)
    maxB = Math.max(maxB, row.y + row.height)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  return {
    x: minX,
    y: minY,
    w: Math.max(1, Math.round(maxR - minX)),
    h: Math.max(1, Math.round(maxB - minY)),
  }
}

function snapDisplayDraftPosition(
  rows: SettingsLayoutScreen[],
  index: number,
  x: number,
  y: number,
  scale: number,
): { x: number; y: number } {
  const row = rows[index]
  if (!row) return { x: Math.round(x), y: Math.round(y) }
  const threshold = Math.max(18, PREVIEW_SNAP_PX / Math.max(scale, 0.001))
  let bestX = x
  let bestY = y
  let bestDx = threshold + 1
  let bestDy = threshold + 1
  for (let i = 0; i < rows.length; i++) {
    if (i === index) continue
    const other = rows[i]!
    const xCandidates = [
      other.x - row.width,
      other.x,
      other.x + other.width - row.width,
      other.x + other.width,
    ]
    const yCandidates = [
      other.y - row.height,
      other.y,
      other.y + other.height - row.height,
      other.y + other.height,
    ]
    for (const candidate of xCandidates) {
      const dist = Math.abs(candidate - x)
      if (dist < bestDx) {
        bestDx = dist
        bestX = candidate
      }
    }
    for (const candidate of yCandidates) {
      const dist = Math.abs(candidate - y)
      if (dist < bestDy) {
        bestDy = dist
        bestY = candidate
      }
    }
  }
  return {
    x: Math.round(bestDx <= threshold ? bestX : x),
    y: Math.round(bestDy <= threshold ? bestY : y),
  }
}

function primaryBadgeLabel(
  name: string,
  explicitPrimary: string | null,
  autoPrimary: string | null,
): 'Primary' | 'Auto primary' | null {
  if (explicitPrimary) return explicitPrimary === name ? 'Primary' : null
  return autoPrimary === name ? 'Auto primary' : null
}

export type SettingsDisplaysPageProps = {
  screenDraft: { rows: SettingsLayoutScreen[] }
  setScreenDraft: SetStoreFunction<{ rows: SettingsLayoutScreen[] }>
  shellChromePrimaryName: () => string | null
  autoShellChromeMonitorName: () => string | null
  canSessionControl: () => boolean
  uiScalePercent: () => 100 | 150 | 200
  orientationPickerOpen: () => number | null
  setOrientationPickerOpen: Setter<number | null>
  setShellPrimary: (name: string) => void
  setUiScale: (pct: 100 | 150 | 200) => void
  applyCompositorLayoutFromDraft: () => void
  monitorRefreshLabel: (milli: number) => string
}

export function SettingsDisplaysPage(props: SettingsDisplaysPageProps) {
  const [draggingIndex, setDraggingIndex] = createSignal<number | null>(null)
  const primaryOptions = createMemo(() => ['', ...props.screenDraft.rows.map((row) => row.name)])
  const previewMetrics = createMemo(() => {
    const union = screenUnionBBox(props.screenDraft.rows)
    if (!union) return null
    const scale = Math.max(
      0.001,
      Math.min((PREVIEW_W - PREVIEW_PAD * 2) / union.w, (PREVIEW_H - PREVIEW_PAD * 2) / union.h),
    )
    const contentW = union.w * scale
    const contentH = union.h * scale
    const offsetX = (PREVIEW_W - contentW) / 2 - union.x * scale
    const offsetY = (PREVIEW_H - contentH) / 2 - union.y * scale
    return {
      scale,
      rects: props.screenDraft.rows.map(
        (row, index): PreviewRect => ({
          index,
          row,
          left: offsetX + row.x * scale,
          top: offsetY + row.y * scale,
          width: Math.max(1, row.width * scale),
          height: Math.max(1, row.height * scale),
        }),
      ),
    }
  })
  const resolvedPrimaryName = createMemo(
    () => props.shellChromePrimaryName() || props.autoShellChromeMonitorName() || null,
  )
  let previewRef: HTMLDivElement | undefined
  let dragState: PreviewDrag | null = null

  function previewPoint(clientX: number, clientY: number) {
    const bounds = previewRef?.getBoundingClientRect()
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null
    return {
      x: ((clientX - bounds.left) / bounds.width) * PREVIEW_W,
      y: ((clientY - bounds.top) / bounds.height) * PREVIEW_H,
    }
  }

  function stopPreviewDrag() {
    if (!dragState) return
    dragState = null
    setDraggingIndex(null)
    window.removeEventListener('pointermove', handlePreviewPointerMove)
    window.removeEventListener('pointerup', stopPreviewDrag)
    window.removeEventListener('pointercancel', stopPreviewDrag)
  }

  function handlePreviewPointerMove(e: PointerEvent) {
    if (!dragState) return
    const point = previewPoint(e.clientX, e.clientY)
    if (!point) return
    const nextX = dragState.startScreenX + (point.x - dragState.startPreviewX) / dragState.scale
    const nextY = dragState.startScreenY + (point.y - dragState.startPreviewY) / dragState.scale
    const snapped = snapDisplayDraftPosition(
      props.screenDraft.rows,
      dragState.index,
      nextX,
      nextY,
      dragState.scale,
    )
    batch(() => {
      props.setScreenDraft('rows', dragState!.index, 'x', snapped.x)
      props.setScreenDraft('rows', dragState!.index, 'y', snapped.y)
    })
  }

  function beginPreviewDrag(index: number, e: PointerEvent) {
    if (e.button !== 0) return
    const point = previewPoint(e.clientX, e.clientY)
    const metrics = previewMetrics()
    const row = props.screenDraft.rows[index]
    if (!point || !metrics || !row) return
    e.preventDefault()
    e.stopPropagation()
    stopPreviewDrag()
    dragState = {
      index,
      startPreviewX: point.x,
      startPreviewY: point.y,
      startScreenX: row.x,
      startScreenY: row.y,
      scale: metrics.scale,
    }
    setDraggingIndex(index)
    window.addEventListener('pointermove', handlePreviewPointerMove)
    window.addEventListener('pointerup', stopPreviewDrag)
    window.addEventListener('pointercancel', stopPreviewDrag)
  }

  onCleanup(() => stopPreviewDrag())

  return (
    <div class="space-y-4">
      <h2 class="text-base font-semibold tracking-wide text-[var(--shell-text)]">Displays</h2>
      <div class="shell-subpanel rounded-lg px-3 py-3">
        <p class="mb-2 text-[0.72rem] font-semibold uppercase tracking-wide text-[var(--shell-text-dim)]">
          Primary monitor
        </p>
        <div class="mb-[0.6rem] flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8rem]">
          <span class="mr-1 opacity-90">Panel + taskbar</span>
          <Show
            when={props.canSessionControl()}
            fallback={
              <div
                class="shell-pill min-w-48 rounded-[0.35rem] px-[0.55rem] py-1 text-[0.8rem] opacity-80"
                title="Needs cef_host wire"
              >
                {props.shellChromePrimaryName() || 'Auto (top-left output)'}
              </div>
            }
          >
            <Select
              options={primaryOptions()}
              value={props.shellChromePrimaryName() ?? ''}
              onChange={(v) => props.setShellPrimary(String(v))}
              itemLabel={(v) => (v ? String(v) : 'Auto (top-left output)')}
              equals={(a, b) => a === b}
              triggerClass="shell-btn-muted min-w-48 max-w-none cursor-pointer rounded py-1 px-[0.55rem] text-left font-inherit text-[0.8rem]"
              minMenuWidthPx={192}
            />
          </Show>
          <span class="text-[0.74rem] opacity-70">
            {props.shellChromePrimaryName()
              ? `Using ${props.shellChromePrimaryName()}`
              : `Auto picks ${props.autoShellChromeMonitorName() || 'the top-left output'}`}
          </span>
        </div>
        <div class="mb-[0.6rem] flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8rem]">
          <span class="mr-1 opacity-90">UI scale (all heads)</span>
          <button
            type="button"
            class="shell-btn-muted cursor-pointer rounded-[0.3rem] px-[0.55rem] py-1 font-inherit text-inherit disabled:cursor-default disabled:opacity-[0.55]"
            classList={{
              'shell-btn-accent disabled:opacity-[0.85]': props.uiScalePercent() === 100,
            }}
            disabled={!props.canSessionControl() || props.uiScalePercent() === 100}
            title={!props.canSessionControl() ? 'Needs cef_host wire' : undefined}
            onClick={() => props.setUiScale(100)}
          >
            100%
          </button>
          <button
            type="button"
            class="shell-btn-muted cursor-pointer rounded-[0.3rem] px-[0.55rem] py-1 font-inherit text-inherit disabled:cursor-default disabled:opacity-[0.55]"
            classList={{
              'shell-btn-accent disabled:opacity-[0.85]': props.uiScalePercent() === 150,
            }}
            disabled={!props.canSessionControl() || props.uiScalePercent() === 150}
            title={!props.canSessionControl() ? 'Needs cef_host wire' : undefined}
            onClick={() => props.setUiScale(150)}
          >
            150%
          </button>
          <button
            type="button"
            class="shell-btn-muted cursor-pointer rounded-[0.3rem] px-[0.55rem] py-1 font-inherit text-inherit disabled:cursor-default disabled:opacity-[0.55]"
            classList={{
              'shell-btn-accent disabled:opacity-[0.85]': props.uiScalePercent() === 200,
            }}
            disabled={!props.canSessionControl() || props.uiScalePercent() === 200}
            title={!props.canSessionControl() ? 'Needs cef_host wire' : undefined}
            onClick={() => props.setUiScale(200)}
          >
            200%
          </button>
        </div>
        <ul class="mb-2.5 list-none pl-[18px] text-xs leading-snug text-[var(--shell-text-muted)]">
          <For
            each={props.screenDraft.rows}
            fallback={
              <li class="shell-warning-text list-disc">
                No outputs listed — compositor should send <code>output_layout</code> with one entry per
                head.
              </li>
            }
          >
            {(row) => (
              <li class="mb-1.5 list-disc">
                <div class="flex flex-wrap items-start justify-between gap-x-2.5 gap-y-1.5">
                  <div class="min-w-0 flex-[1_1_12rem]">
                    <span class="font-semibold text-[var(--shell-text)]">{row.name || '—'}</span>
                    <Show
                      when={primaryBadgeLabel(
                        row.name,
                        props.shellChromePrimaryName(),
                        props.autoShellChromeMonitorName(),
                      )}
                    >
                      <span class="shell-badge-accent ml-2 rounded-full px-2 py-[0.1rem] text-[0.64rem] font-semibold uppercase tracking-wide">
                        {primaryBadgeLabel(
                          row.name,
                          props.shellChromePrimaryName(),
                          props.autoShellChromeMonitorName(),
                        )}
                      </span>
                    </Show>
                    <span class="opacity-92">
                      @ {row.x},{row.y} · {row.width}×{row.height} ·{' '}
                      {props.monitorRefreshLabel(row.refresh_milli_hz)} · orientation {row.transform}
                    </span>
                  </div>
                  <span class="text-[0.72rem] opacity-65">
                    {row.name === resolvedPrimaryName() ? 'Shown in preview as primary' : ''}
                  </span>
                </div>
              </li>
            )}
          </For>
        </ul>
        <Show
          when={props.screenDraft.rows.length > 0}
          fallback={
            <p class="mb-2 text-[0.78rem] opacity-[0.88]">
              Position and orientation unlock once screens are known.
            </p>
          }
        >
          <p class="mb-2 text-[0.72rem] font-semibold uppercase tracking-wide text-[var(--shell-text-dim)]">
            Arrangement
          </p>
          <div class="shell-subpanel mb-3 rounded-lg p-2.5">
            <div class="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <span class="text-[0.78rem] font-medium text-[var(--shell-text)]">Layout preview</span>
              <span class="text-[0.72rem] opacity-70">Drag displays to reposition them</span>
            </div>
            <div
              ref={(el) => (previewRef = el)}
              class="shell-display-preview relative aspect-2/1 w-full overflow-hidden rounded-md border border-[var(--shell-border)]"
            >
              <div class="shell-display-glow pointer-events-none absolute inset-0" />
              <For each={previewMetrics()?.rects ?? []}>
                    {(rect) => {
                      const badge = () =>
                        primaryBadgeLabel(
                          rect.row.name,
                          props.shellChromePrimaryName(),
                          props.autoShellChromeMonitorName(),
                        )
                      return (
                        <button
                          type="button"
                          class="shell-display-card absolute flex flex-col items-start justify-between overflow-hidden rounded-md px-2 py-1.5 text-left transition-shadow"
                          classList={{
                            'z-10 shadow-[0_14px_28px_rgba(0,0,0,0.42)]': draggingIndex() === rect.index,
                            'shell-display-card-primary':
                              rect.row.name === resolvedPrimaryName(),
                          }}
                          style={{
                            left: `${(rect.left / PREVIEW_W) * 100}%`,
                            top: `${(rect.top / PREVIEW_H) * 100}%`,
                            width: `${(rect.width / PREVIEW_W) * 100}%`,
                            height: `${(rect.height / PREVIEW_H) * 100}%`,
                            cursor: draggingIndex() === rect.index ? 'grabbing' : 'grab',
                          }}
                          onPointerDown={(e) => beginPreviewDrag(rect.index, e)}
                        >
                          <div class="min-w-0">
                            <div class="truncate text-[0.74rem] font-semibold">{rect.row.name || '—'}</div>
                            <div class="text-[0.66rem] opacity-80">
                              {rect.row.width}×{rect.row.height}
                            </div>
                          </div>
                          <Show when={badge()}>
                            <span class="shell-pill rounded-full px-1.5 py-[0.08rem] text-[0.56rem] font-semibold uppercase tracking-wide">
                              {badge()}
                            </span>
                          </Show>
                        </button>
                      )
                    }}
              </For>
            </div>
          </div>
          <For each={props.screenDraft.rows}>
            {(row, i) => (
              <div class="shell-subpanel mb-[0.55rem] rounded-md px-2.5 py-2">
                <div class="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[0.82rem]">
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="min-w-0 font-mono opacity-92">{row.name}</span>
                    <Show
                      when={primaryBadgeLabel(
                        row.name,
                        props.shellChromePrimaryName(),
                        props.autoShellChromeMonitorName(),
                      )}
                    >
                      <span class="shell-badge-accent rounded-full px-2 py-[0.08rem] text-[0.6rem] font-semibold uppercase tracking-wide">
                        {primaryBadgeLabel(
                          row.name,
                          props.shellChromePrimaryName(),
                          props.autoShellChromeMonitorName(),
                        )}
                      </span>
                    </Show>
                  </div>
                  <span class="text-[0.75rem] opacity-65">
                    {row.width}×{row.height} · {props.monitorRefreshLabel(row.refresh_milli_hz)}
                  </span>
                </div>
                <div class="flex flex-wrap items-center gap-x-[0.65rem] gap-y-[0.45rem] text-[0.82rem]">
                  <label class="uppercase flex flex-col gap-[0.15rem] text-[0.7rem] tracking-wide opacity-80">
                    x
                    <input
                      type="number"
                      class="shell-input w-18 rounded px-[0.35rem] py-0.5 text-inherit"
                      value={row.x}
                      onInput={(e) =>
                        props.setScreenDraft('rows', i(), 'x', Number(e.currentTarget.value) || 0)
                      }
                    />
                  </label>
                  <label class="uppercase flex flex-col gap-[0.15rem] text-[0.7rem] tracking-wide opacity-80">
                    y
                    <input
                      type="number"
                      class="shell-input w-18 rounded px-[0.35rem] py-0.5 text-inherit"
                      value={row.y}
                      onInput={(e) =>
                        props.setScreenDraft('rows', i(), 'y', Number(e.currentTarget.value) || 0)
                      }
                    />
                  </label>
                  <label class="flex flex-col gap-[0.15rem] text-[0.7rem] tracking-wide opacity-80 [&_.relative]:mt-[0.15rem]">
                    orientation
                    <TransformPicker
                      value={row.transform}
                      rowIndex={i()}
                      openIndex={props.orientationPickerOpen}
                      setOpenIndex={props.setOrientationPickerOpen}
                      onChange={(v) => props.setScreenDraft('rows', i(), 'transform', v)}
                    />
                  </label>
                </div>
              </div>
            )}
          </For>
          <button
            type="button"
            class="shell-btn-accent mt-3 cursor-pointer rounded-[0.35rem] px-3 py-1.5 text-[0.85rem]"
            onClick={() => props.applyCompositorLayoutFromDraft()}
          >
            Apply layout to compositor
          </button>
        </Show>
      </div>
    </div>
  )
}
