import { createMemo, For, Show, type Accessor } from 'solid-js'
import { canvasRectToClientCss } from '@/lib/shellCoords'
import { assistShapeToDims } from '@/features/tiling/assistGrid'
import { listCustomLayoutZones } from '@/features/tiling/customLayouts'
import { Taskbar, type TaskbarSniItem, type TaskbarWindowRow } from '@/features/taskbar/Taskbar'
import { SnapAssistTopStrip } from './SnapAssistTopStrip'
import type { AssistOverlayState, LayoutScreen, SnapAssistStripState } from './types'

type ShellSurfaceLayersProps = {
  assistOverlay: Accessor<AssistOverlayState | null>
  mainEl: Accessor<HTMLElement | undefined>
  outputGeom: Accessor<{ w: number; h: number } | null>
  workspaceSecondary: Accessor<LayoutScreen[]>
  screenCssRect: (screen: LayoutScreen) => LayoutScreen
  debugHudFrameVisible: Accessor<boolean>
  taskbarScreens: Accessor<LayoutScreen[]>
  taskbarHeight: number
  screenTaskbarHiddenForFullscreen: (screen: LayoutScreen) => boolean
  isPrimaryTaskbarScreen: (screen: LayoutScreen) => boolean
  volumeMuted: Accessor<boolean>
  volumePercent: Accessor<number | null>
  taskbarRowsForScreen: (screen: LayoutScreen) => TaskbarWindowRow[]
  focusedWindowId: Accessor<number | null>
  keyboardLayoutLabel: Accessor<string | null>
  settingsHudFrameVisible: Accessor<boolean>
  onSettingsPanelToggle: () => void
  onDebugPanelToggle: () => void
  onTaskbarActivate: (windowId: number) => void
  onTaskbarClose: (windowId: number) => void
  trayReservedPx: Accessor<number>
  sniTrayItems: Accessor<TaskbarSniItem[]>
  trayIconSlotPx: Accessor<number>
  onSniTrayActivate: (id: string) => void
  onSniTrayContextMenu: (id: string, clientX: number, clientY: number) => void
  snapStrip: Accessor<SnapAssistStripState | null>
  snapStripScreen: Accessor<LayoutScreen | null>
}

export function ShellSurfaceLayers(props: ShellSurfaceLayersProps) {
  const assistOverlay = createMemo(() => props.assistOverlay())
  const assistGridOverlay = createMemo(() => {
    const overlay = assistOverlay()
    return overlay?.kind === 'assist' ? overlay : null
  })
  const customOverlay = createMemo(() => {
    const overlay = assistOverlay()
    return overlay?.kind === 'custom' ? overlay : null
  })
  const assistOverlayStyle = createMemo(() => {
    const overlay = assistOverlay()
    const main = props.mainEl()
    const og = props.outputGeom()
    if (!overlay || !main || !og) {
      return {
        display: 'none',
      }
    }
    const css = canvasRectToClientCss(
      overlay.workCanvas.x,
      overlay.workCanvas.y,
      overlay.workCanvas.w,
      overlay.workCanvas.h,
      main.getBoundingClientRect(),
      og.w,
      og.h,
    )
    return {
      display: 'flex',
      left: `${css.left}px`,
      top: `${css.top}px`,
      width: `${css.width}px`,
      height: `${css.height}px`,
    }
  })

  return (
    <>
      <div
        data-shell-snap-overlay={assistOverlay()?.kind ?? undefined}
        class="pointer-events-none fixed z-450000"
        style={assistOverlayStyle()}
      >
        <Show when={assistGridOverlay()}>
          {(overlay) => <AssistGridOutlineOverlay overlay={overlay()} />}
        </Show>
        <Show when={customOverlay()}>
          {(overlay) => <CustomLayoutOutlineOverlay overlay={overlay()} />}
        </Show>
      </div>

      <For each={props.workspaceSecondary()}>
        {(screen) => {
          const loc = props.screenCssRect(screen)
          return (
            <div
              class="pointer-events-none absolute z-1 box-border border border-dashed border-(--shell-border) bg-(--shell-overlay-muted)"
              style={{
                left: `${loc.x}px`,
                top: `${loc.y}px`,
                width: `${loc.width}px`,
                height: `${loc.height}px`,
              }}
            >
              <Show when={props.debugHudFrameVisible()}>
                <span class="border border-(--shell-border) bg-(--shell-surface-elevated) text-(--shell-text-muted) absolute top-2 left-2 rounded px-2 py-1 text-[11px] font-semibold tracking-wider uppercase">
                  {screen.name || 'Display'}
                </span>
              </Show>
            </div>
          )
        }}
      </For>

      <Show when={props.snapStripScreen()}>
        <Show when={props.snapStrip()}>
          <SnapAssistTopStrip
            strip={props.snapStrip()!}
            screen={props.snapStripScreen()!}
            screenCssRect={props.screenCssRect}
          />
        </Show>
      </Show>

      <For each={props.taskbarScreens()}>
        {(screen) => {
          const loc = props.screenCssRect(screen)
          return (
            <Show when={!props.screenTaskbarHiddenForFullscreen(screen)}>
              <div
                class="pointer-events-auto absolute z-401000"
                style={{
                  left: `${loc.x}px`,
                  top: `${loc.y + loc.height - props.taskbarHeight}px`,
                  width: `${loc.width}px`,
                  height: `${props.taskbarHeight}px`,
                }}
              >
                <Taskbar
                  monitorName={screen.name}
                  isPrimary={props.isPrimaryTaskbarScreen(screen)}
                  trayReservedPx={
                    props.isPrimaryTaskbarScreen(screen) ? props.trayReservedPx() : 0
                  }
                  sniTrayItems={
                    props.isPrimaryTaskbarScreen(screen) ? props.sniTrayItems() : []
                  }
                  trayIconSlotPx={
                    props.isPrimaryTaskbarScreen(screen) ? props.trayIconSlotPx() : 40
                  }
                  onSniTrayActivate={props.onSniTrayActivate}
                  onSniTrayContextMenu={props.onSniTrayContextMenu}
                  volumeMuted={props.volumeMuted()}
                  volumePercent={props.volumePercent()}
                  windows={props.taskbarRowsForScreen(screen)}
                  focusedWindowId={props.focusedWindowId()}
                  keyboardLayoutLabel={
                    props.isPrimaryTaskbarScreen(screen) ? props.keyboardLayoutLabel() : null
                  }
                  settingsPanelOpen={props.settingsHudFrameVisible()}
                  onSettingsPanelToggle={props.onSettingsPanelToggle}
                  debugPanelOpen={props.debugHudFrameVisible()}
                  onDebugPanelToggle={props.onDebugPanelToggle}
                  onTaskbarActivate={props.onTaskbarActivate}
                  onTaskbarClose={props.onTaskbarClose}
                />
              </div>
            </Show>
          )
        }}
      </For>
    </>
  )
}

function AssistGridOutlineOverlay(props: {
  overlay: Extract<AssistOverlayState, { kind: 'assist' }>
}) {
  const dims = createMemo(() => assistShapeToDims(props.overlay.shape))
  const lines = createMemo(() => {
    const { cols, rows } = dims()
    const cellW = props.overlay.workCanvas.w / cols
    const cellH = props.overlay.workCanvas.h / rows
    const rects = Array.from({ length: cols * rows }, (_, index) => {
      const col = index % cols
      const row = Math.floor(index / cols)
      return snapOutlineRect({
        x: col * cellW,
        y: row * cellH,
        width: cellW,
        height: cellH,
      })
    })
    return outlineLinesFromRects(rects)
  })
  return (
    <OutlineEdgeOverlay lines={lines()} kind="assist" />
  )
}

function CustomLayoutOutlineOverlay(props: {
  overlay: Extract<AssistOverlayState, { kind: 'custom' }>
}) {
  const lines = createMemo(() =>
    outlineLinesFromRects(
      listCustomLayoutZones(props.overlay.layout).map((zone) =>
        snapOutlineRect({
          x: zone.x * props.overlay.workCanvas.w,
          y: zone.y * props.overlay.workCanvas.h,
          width: zone.width * props.overlay.workCanvas.w,
          height: zone.height * props.overlay.workCanvas.h,
        }),
      ),
    ),
  )
  return (
    <OutlineEdgeOverlay lines={lines()} kind="custom" />
  )
}

function OutlineEdgeOverlay(props: {
  lines: Array<{ key: string; x: number; y: number; width: number; height: number }>
  kind: 'assist' | 'custom'
}) {
  return (
    <div class="absolute inset-0">
      <For each={props.lines}>
        {(line) => (
          <div
            data-shell-snap-overlay-zone={props.kind}
            class="absolute bg-(--shell-preview-outline)"
            style={{
              left: `${line.x}px`,
              top: `${line.y}px`,
              width: `${line.width}px`,
              height: `${line.height}px`,
              opacity: '0.65',
            }}
          />
        )}
      </For>
    </div>
  )
}

function outlineLinesFromRects(rects: Array<{
  x: number
  y: number
  width: number
  height: number
}>): Array<{ key: string; x: number; y: number; width: number; height: number }> {
  const vertical = mergeOutlineSegments(
    rects.flatMap((rect) => [
      { coord: rect.x, start: rect.y, end: rect.y + rect.height },
      { coord: rect.x + rect.width, start: rect.y, end: rect.y + rect.height },
    ]),
  )
  const horizontal = mergeOutlineSegments(
    rects.flatMap((rect) => [
      { coord: rect.y, start: rect.x, end: rect.x + rect.width },
      { coord: rect.y + rect.height, start: rect.x, end: rect.x + rect.width },
    ]),
  )
  return [
    ...vertical.map((line) => ({
      key: `v:${line.coord}:${line.start}:${line.end}`,
      x: line.coord - 0.5,
      y: line.start,
      width: 1,
      height: Math.max(1, line.end - line.start),
    })),
    ...horizontal.map((line) => ({
      key: `h:${line.coord}:${line.start}:${line.end}`,
      x: line.start,
      y: line.coord - 0.5,
      width: Math.max(1, line.end - line.start),
      height: 1,
    })),
  ]
}

function mergeOutlineSegments(
  segments: Array<{ coord: number; start: number; end: number }>,
): Array<{ coord: number; start: number; end: number }> {
  const groups = new Map<string, Array<{ coord: number; start: number; end: number }>>()
  for (const segment of segments) {
    const coord = Math.round(segment.coord * 1000) / 1000
    const start = Math.round(Math.min(segment.start, segment.end) * 1000) / 1000
    const end = Math.round(Math.max(segment.start, segment.end) * 1000) / 1000
    const key = coord.toFixed(3)
    const list = groups.get(key)
    if (list) {
      list.push({ coord, start, end })
    } else {
      groups.set(key, [{ coord, start, end }])
    }
  }
  const merged: Array<{ coord: number; start: number; end: number }> = []
  for (const list of groups.values()) {
    list.sort((a, b) => a.start - b.start || a.end - b.end)
    let current = list[0]
    for (let index = 1; index < list.length; index += 1) {
      const next = list[index]
      if (next.start <= current.end + 0.5) {
        current = { coord: current.coord, start: current.start, end: Math.max(current.end, next.end) }
      } else {
        merged.push(current)
        current = next
      }
    }
    merged.push(current)
  }
  return merged
}

function snapOutlineRect(rect: {
  x: number
  y: number
  width: number
  height: number
}) {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  }
}
