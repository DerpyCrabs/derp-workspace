import { For, Show, type Accessor, type Setter } from 'solid-js'
import type { ExclusionHudZone, LayoutScreen } from '@/host/types'

type ShellDebugHudContentProps = {
  onReload: () => void
  onCopySnapshot: () => void
  shellBuildLabel: string
  hudFps: Accessor<number>
  crosshairCursor: Accessor<boolean>
  setCrosshairCursor: Setter<boolean>
  outputGeom: Accessor<{ w: number; h: number } | null>
  layoutUnionBbox: Accessor<{ x: number; y: number; w: number; h: number } | null>
  layoutCanvasOrigin: Accessor<{ x: number; y: number } | null>
  panelHostForHud: Accessor<LayoutScreen | null>
  shellChromePrimaryName: Accessor<string | null>
  viewportCss: Accessor<{ w: number; h: number }>
  windowsCount: Accessor<number>
  pointerClient: Accessor<{ x: number; y: number } | null>
  pointerInMain: Accessor<{ x: number; y: number } | null>
  rootPointerDowns: Accessor<number>
  exclusionZonesHud: Accessor<ExclusionHudZone[]>
}

export function ShellDebugHudContent(props: ShellDebugHudContentProps) {
  return (
    <div class="px-4 py-3 text-left text-xs leading-snug [&_strong]:text-shell-hud-strong" data-shell-debug-root>
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <span class="text-[0.8rem] font-semibold tracking-wide text-(--shell-text)">Debug</span>
        <button
          type="button"
          data-shell-debug-reload
          class="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) cursor-pointer rounded px-2 py-0.5 text-[0.7rem]"
          onClick={() => props.onReload()}
        >
          Reload shell
        </button>
        <button
          type="button"
          data-shell-debug-copy-snapshot
          class="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) cursor-pointer rounded px-2 py-0.5 text-[0.7rem]"
          onClick={() => props.onCopySnapshot()}
        >
          Copy snapshot
        </button>
      </div>
      <p class="mb-2 tabular-nums text-(--shell-text-muted)">
        Build <strong>{props.shellBuildLabel}</strong>
        {' · '}
        UI FPS ~<strong>{props.hudFps()}</strong>
      </p>
      <label class="mb-2 flex cursor-pointer items-center gap-2 select-none text-(--shell-text-muted)">
        <input
          type="checkbox"
          data-shell-debug-crosshair-toggle
          class="h-3.5 w-3.5 accent-shell-accent-ring"
          checked={props.crosshairCursor()}
          onChange={(e) => props.setCrosshairCursor(e.currentTarget.checked)}
        />
        <span>Crosshair</span>
      </label>
      <Show when={props.outputGeom()} keyed>
        {(og) => (
          <p class="mb-2 text-(--shell-text-muted)">
            Canvas{' '}
            <strong>
              {og.w}×{og.h}
            </strong>
          </p>
        )}
      </Show>
      <details class="border border-(--shell-border) bg-(--shell-surface) text-(--shell-text) mb-2 rounded px-2 py-1.5" open>
        <summary class="cursor-pointer select-none text-[0.68rem] font-medium uppercase tracking-wide text-(--shell-text-dim)">
          Layout / input
        </summary>
        <div class="mt-1.5 space-y-1 tabular-nums text-(--shell-text-muted)">
          <div>
            Union from <code>screens[]</code>
            {': '}
            <strong>
              {props.layoutUnionBbox()
                ? `@ ${props.layoutUnionBbox()!.x},${props.layoutUnionBbox()!.y} (${props.layoutUnionBbox()!.w}×${props.layoutUnionBbox()!.h})`
                : '—'}
            </strong>
          </div>
          <div>
            Compositor union min:{' '}
            <strong>
              {props.layoutCanvasOrigin()
                ? `@ ${props.layoutCanvasOrigin()!.x},${props.layoutCanvasOrigin()!.y}`
                : '—'}
            </strong>
          </div>
          <div>
            Panel host:{' '}
            <strong>
              {props.panelHostForHud()
                ? `${props.shellChromePrimaryName() ? `${props.shellChromePrimaryName()} (explicit) · ` : ''}${props.panelHostForHud()!.name || '—'} @ ${props.panelHostForHud()!.x},${props.panelHostForHud()!.y} (${props.panelHostForHud()!.width}×${props.panelHostForHud()!.height})`
                : '—'}
            </strong>
          </div>
          <div>
            Viewport (CSS){' '}
            <strong>
              {props.viewportCss().w}×{props.viewportCss().h}
            </strong>
            {' · dpr '}
            <strong>{typeof window !== 'undefined' ? window.devicePixelRatio : 1}</strong>
          </div>
          <div>
            Windows: <strong>{props.windowsCount()}</strong>
          </div>
          <Show when={props.crosshairCursor()}>
            <div>
              Pointer (client){' '}
              <strong>
                {props.pointerClient() ? `${props.pointerClient()!.x}, ${props.pointerClient()!.y}` : '—'}
              </strong>
            </div>
            <div>
              Pointer (main){' '}
              <strong>
                {props.pointerInMain() ? `${props.pointerInMain()!.x}, ${props.pointerInMain()!.y}` : '—'}
              </strong>
            </div>
          </Show>
          <div>
            Pointer downs: <strong>{props.rootPointerDowns()}</strong>
          </div>
        </div>
      </details>
      <details class="border border-(--shell-border) bg-(--shell-surface) text-(--shell-text) rounded px-2 py-1.5">
        <summary class="cursor-pointer select-none text-[0.68rem] font-medium uppercase tracking-wide text-(--shell-text-dim)">
          Exclusion zones
        </summary>
        <div class="mt-1.5">
          <Show
            when={props.exclusionZonesHud().length > 0}
            fallback={<span class="block text-(--shell-text-dim)">—</span>}
          >
            <ul class="max-h-40 list-disc space-y-0.5 overflow-auto pl-4 text-[0.72rem]">
              <For each={props.exclusionZonesHud()}>
                {(z) => (
                  <li class="my-0.5 list-disc">
                    <span class="mr-[0.35rem] inline-block min-w-28 text-(--shell-text-muted)">{z.label}</span>
                    <code class="font-mono text-[0.65rem] text-shell-hud-mono">
                      {z.x},{z.y} · {z.w}×{z.h}
                    </code>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </details>
    </div>
  )
}
