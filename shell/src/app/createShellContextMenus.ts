import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
  type JSX,
} from 'solid-js'
import { createStore } from 'solid-js/store'
import { atlasTopFromLayout, type ShellContextMenuItem } from '../contextMenu'
import { searchDesktopApplications } from '../desktopAppSearch'
import { pushShellFloatingWireFromDom } from '../shellFloatingPlacement'
import { shellHttpBase } from '../shellHttp'
import { canvasRectToClientCss } from '../shellCoords'
import { parseDesktopApplicationsResponse, type DesktopAppEntry } from '../shellBridge'
import type { LayoutScreen } from './types'

type MenuKind = 'programs' | 'power' | null

type CreateShellContextMenusArgs = {
  mainEl: Accessor<HTMLElement | undefined>
  outputGeom: Accessor<{ w: number; h: number } | null>
  outputPhysical: Accessor<{ w: number; h: number } | null>
  layoutCanvasOrigin: Accessor<{ x: number; y: number } | null>
  screenDraftRows: Accessor<LayoutScreen[]>
  shellChromePrimaryName: Accessor<string | null>
  viewportCss: Accessor<{ w: number; h: number }>
  canvasCss: Accessor<{ w: number; h: number }>
  contextMenuAtlasBufferH: Accessor<number>
  screenshotMode: Accessor<boolean>
  stopScreenshotMode: () => void
  closeAllAtlasSelects: () => boolean
  spawnInCompositor: (cmd: string) => Promise<void>
  postSessionPower: (action: string) => Promise<void>
  canSessionControl: () => boolean
  exitSession: () => void
  clearShellActionIssue: () => void
  reportShellActionIssue: (message: string) => void
  describeError: (error: unknown) => string
  dismissFloatingWire: () => void
}

function layoutScreenCssRect(
  screen: LayoutScreen,
  origin: { x: number; y: number } | null,
): LayoutScreen {
  const ox = origin?.x ?? 0
  const oy = origin?.y ?? 0
  return {
    name: screen.name,
    x: screen.x - ox,
    y: screen.y - oy,
    width: screen.width,
    height: screen.height,
    transform: screen.transform,
    refresh_milli_hz: screen.refresh_milli_hz,
  }
}

function screensListForLayout(
  rows: LayoutScreen[],
  canvas: { w: number; h: number } | null,
  origin: { x: number; y: number } | null,
) {
  if (rows.length > 0) return rows
  if (canvas && canvas.w > 0 && canvas.h > 0) {
    return [
      {
        name: '',
        x: origin?.x ?? 0,
        y: origin?.y ?? 0,
        refresh_milli_hz: 0,
        width: canvas.w,
        height: canvas.h,
        transform: 0,
      },
    ]
  }
  return []
}

export function createShellContextMenus(args: CreateShellContextMenusArgs) {
  const [ctxMenuOpen, setCtxMenuOpen] = createSignal(false)
  const [ctxMenuKind, setCtxMenuKind] = createSignal<MenuKind>(null)
  const [ctxMenuAnchor, setCtxMenuAnchor] = createSignal<{
    x: number
    y: number
    alignAboveY?: number
  }>({ x: 0, y: 0 })
  const [programsMenuQuery, setProgramsMenuQuery] = createSignal('')
  const [programsMenuHighlightIdx, setProgramsMenuHighlightIdx] = createSignal(0)
  const [powerMenuHighlightIdx, setPowerMenuHighlightIdx] = createSignal(0)
  const [programsMenuOutputName, setProgramsMenuOutputName] = createSignal<string | null>(null)
  const [programsMenuBusy, setProgramsMenuBusy] = createSignal(false)
  const [programsMenuErr, setProgramsMenuErr] = createSignal<string | null>(null)
  const [programsCatalog, setProgramsCatalog] = createStore<{
    items: DesktopAppEntry[]
    loaded: boolean
  }>({
    items: [],
    loaded: false,
  })

  let programsMenuRefreshPromise: Promise<void> | null = null
  let menuAtlasHostRef: HTMLElement | undefined
  let menuPanelRef: HTMLElement | undefined
  let programsMenuSearchRef: HTMLInputElement | undefined

  const programsMenuOpen = createMemo(() => ctxMenuOpen() && ctxMenuKind() === 'programs')
  const powerMenuOpen = createMemo(() => ctxMenuOpen() && ctxMenuKind() === 'power')

  createEffect(() => {
    if (!ctxMenuOpen()) {
      setCtxMenuKind(null)
      setProgramsMenuQuery('')
      setProgramsMenuHighlightIdx(0)
      setProgramsMenuOutputName(null)
      setPowerMenuHighlightIdx(0)
    }
  })

  function hideContextMenu() {
    setCtxMenuOpen(false)
    setCtxMenuKind(null)
    setProgramsMenuQuery('')
    setProgramsMenuHighlightIdx(0)
    setProgramsMenuOutputName(null)
    setPowerMenuHighlightIdx(0)
    args.dismissFloatingWire()
  }

  const shellMenuAtlasTop = createMemo(() => {
    const g = args.outputGeom()
    const p = args.outputPhysical()
    const ah = args.contextMenuAtlasBufferH()
    const v = args.canvasCss()
    const clh = Math.max(1, g?.h ?? v.h)
    const cph = Math.max(1, p?.h ?? Math.round(clh * 1.5))
    return atlasTopFromLayout(clh, cph, ah)
  })

  function programsMenuMetrics(outputName?: string | null) {
    const og = args.outputGeom()
    const co = args.layoutCanvasOrigin()
    const screens = screensListForLayout(args.screenDraftRows(), og, co)
    const requestedOutput =
      outputName !== null && outputName !== undefined
        ? screens.find((screen) => screen.name === outputName)
        : undefined
    const explicitPrimaryName = args.shellChromePrimaryName()
    const explicitPrimary =
      explicitPrimaryName !== null
        ? screens.find((screen) => screen.name === explicitPrimaryName)
        : undefined
    let primary = requestedOutput ?? explicitPrimary ?? screens[0] ?? null
    if (requestedOutput === undefined && explicitPrimary === undefined && screens.length > 1) {
      for (const screen of screens) {
        if (
          primary === null ||
          screen.x < primary.x ||
          (screen.x === primary.x && screen.y < primary.y)
        ) {
          primary = screen
        }
      }
    }
    if (!og || !primary) return null
    const targetCss = layoutScreenCssRect(primary, co)
    const width = Math.max(320, Math.min(704, targetCss.width - 24))
    const height = Math.max(240, Math.min(608, targetCss.height - 24))
    return { targetCss, width, height }
  }

  const programsMenuPlacement = createMemo(() => {
    const metrics = programsMenuMetrics(programsMenuOutputName())
    if (!metrics) return null
    const stripHeight = Math.max(1, args.canvasCss().h - shellMenuAtlasTop())
    return {
      left: '50%',
      top: `${Math.max(8, Math.round((stripHeight - metrics.height) / 2))}px`,
      width: `${Math.round(metrics.width)}px`,
      'max-height': `${Math.round(metrics.height)}px`,
      transform: 'translateX(-50%)',
    } as const satisfies JSX.CSSProperties
  })

  async function refreshProgramsMenuItems() {
    if (programsMenuRefreshPromise) return programsMenuRefreshPromise
    const run = (async () => {
      setProgramsMenuBusy(true)
      const base = shellHttpBase()
      if (!base) {
        if (!programsCatalog.loaded) setProgramsMenuErr('Programs list needs cef_host (no shell HTTP).')
        return
      }
      setProgramsMenuErr(null)
      try {
        const res = await fetch(`${base}/desktop_applications`)
        const text = await res.text()
        if (!res.ok) {
          if (!programsCatalog.loaded) {
            setProgramsMenuErr(
              `Failed to load (${res.status}): ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`,
            )
          }
          return
        }
        const list = parseDesktopApplicationsResponse(text)
        setProgramsCatalog('items', list)
        setProgramsCatalog('loaded', true)
        setProgramsMenuErr(null)
      } catch (error) {
        if (!programsCatalog.loaded) setProgramsMenuErr(`Network error: ${error}`)
      } finally {
        setProgramsMenuBusy(false)
        programsMenuRefreshPromise = null
      }
    })()
    programsMenuRefreshPromise = run
    return run
  }

  async function warmProgramsMenuItems() {
    const startedAt = Date.now()
    let base = shellHttpBase()
    while (!base && Date.now() - startedAt < 4000) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 50))
      base = shellHttpBase()
    }
    if (!base) return
    await refreshProgramsMenuItems()
  }

  function anchorProgramsMenuToCenter(outputName?: string | null) {
    const main = args.mainEl()
    const og = args.outputGeom()
    const metrics = programsMenuMetrics(outputName)
    if (main && og && metrics) {
      const center = canvasRectToClientCss(
        metrics.targetCss.x + metrics.targetCss.width / 2,
        metrics.targetCss.y + metrics.targetCss.height / 2,
        0,
        0,
        main.getBoundingClientRect(),
        og.w,
        og.h,
      )
      const left = Math.round(center.left - metrics.width / 2)
      const top = Math.round(center.top - metrics.height / 2)
      setCtxMenuAnchor({ x: left, y: top, alignAboveY: top })
      return
    }
    const v = args.viewportCss()
    setCtxMenuAnchor({
      x: Math.round(v.w / 2 - 352),
      y: Math.round(v.h / 2 - 240),
      alignAboveY: Math.round(v.h / 2 - 240),
    })
  }

  function openProgramsMenu(outputName?: string | null) {
    args.closeAllAtlasSelects()
    anchorProgramsMenuToCenter(outputName)
    setCtxMenuKind('programs')
    setProgramsMenuBusy(!programsCatalog.loaded)
    setProgramsMenuErr(null)
    setCtxMenuOpen(true)
    setProgramsMenuQuery('')
    setProgramsMenuHighlightIdx(0)
    setProgramsMenuOutputName(outputName ?? null)
    queueMicrotask(() => programsMenuSearchRef?.focus())
    void refreshProgramsMenuItems()
  }

  function toggleProgramsMenuMeta(outputName?: string | null) {
    if (ctxMenuOpen() && ctxMenuKind() === 'programs') {
      hideContextMenu()
      return
    }
    if (ctxMenuOpen() && ctxMenuKind() === 'power') hideContextMenu()
    openProgramsMenu(outputName)
  }

  function onProgramsMenuClick(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    e.preventDefault()
    if (ctxMenuOpen() && ctxMenuKind() === 'programs') {
      hideContextMenu()
      return
    }
    const monitorName =
      e.currentTarget.closest('[data-shell-taskbar-monitor]')?.getAttribute('data-shell-taskbar-monitor') ??
      null
    openProgramsMenu(monitorName)
  }

  function onPowerMenuClick(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    e.preventDefault()
    if (ctxMenuOpen() && ctxMenuKind() === 'power') {
      hideContextMenu()
      return
    }
    args.closeAllAtlasSelects()
    const rect = e.currentTarget.getBoundingClientRect()
    setCtxMenuAnchor({ x: rect.left, y: rect.bottom, alignAboveY: rect.top })
    setCtxMenuKind('power')
    setPowerMenuHighlightIdx(0)
    setCtxMenuOpen(true)
  }

  const powerMenuListItems = createMemo((): ShellContextMenuItem[] => {
    if (!powerMenuOpen()) return []
    const http = shellHttpBase() !== null
    const sysTitle = http ? undefined : 'Needs shell HTTP (cef_host control server) for system power'
    return [
      {
        label: 'Suspend',
        disabled: !http,
        title: sysTitle,
        action: () => void args.postSessionPower('suspend'),
      },
      {
        label: 'Restart',
        disabled: !http,
        title: sysTitle,
        action: () => void args.postSessionPower('reboot'),
      },
      {
        label: 'Shut down',
        disabled: !http,
        title: sysTitle,
        action: () => void args.postSessionPower('poweroff'),
      },
      {
        label: 'Exit session',
        disabled: !args.canSessionControl(),
        title: args.canSessionControl()
          ? 'Tell compositor to exit (ends session)'
          : 'Needs cef_host control server or wire',
        action: args.exitSession,
      },
    ]
  })

  const programsMenuListItems = createMemo((): ShellContextMenuItem[] => {
    if (!programsMenuOpen()) return []
    if (programsMenuBusy() && !programsCatalog.loaded) return [{ label: 'Loading…', action: () => {} }]
    const err = programsMenuErr()
    if (err && !programsCatalog.loaded) return [{ label: err, action: () => {} }]
    const q = programsMenuQuery().trim()
    const raw = programsCatalog.items
    if (programsCatalog.loaded && raw.length === 0) {
      return [{ label: 'No applications found.', action: () => {} }]
    }
    if (raw.length === 0) return [{ label: 'Loading…', action: () => {} }]
    return searchDesktopApplications(raw, q).map((app) => ({
      label: app.name,
      badge: app.terminal ? 'tty' : undefined,
      action: () => {
        void args.spawnInCompositor(app.exec)
      },
    }))
  })

  const menuListItems = createMemo(() => {
    if (ctxMenuKind() === 'programs') return programsMenuListItems()
    if (ctxMenuKind() === 'power') return powerMenuListItems()
    return []
  })

  function activateProgramsMenuSelection() {
    if (!programsMenuOpen()) return
    const items = programsMenuListItems()
    const item = items[programsMenuHighlightIdx()]
    if (!item || items.length === 0) return
    item.action()
    hideContextMenu()
  }

  function movePowerMenuHighlight(delta: number) {
    const items = powerMenuListItems()
    const n = items.length
    if (n === 0) return
    let idx = powerMenuHighlightIdx()
    for (let step = 0; step < n; step++) {
      idx = (idx + delta + n) % n
      if (!items[idx]?.disabled) {
        setPowerMenuHighlightIdx(idx)
        return
      }
    }
  }

  function activatePowerMenuSelection() {
    if (!powerMenuOpen()) return
    const item = powerMenuListItems()[powerMenuHighlightIdx()]
    if (!item || item.disabled) return
    item.action()
    hideContextMenu()
  }

  createEffect(() => {
    if (!programsMenuOpen()) return
    const list = programsMenuListItems()
    const n = list.length
    const idx = programsMenuHighlightIdx()
    if (n === 0) {
      if (idx !== 0) setProgramsMenuHighlightIdx(0)
      return
    }
    if (idx >= n) setProgramsMenuHighlightIdx(n - 1)
    if (idx < 0) setProgramsMenuHighlightIdx(0)
  })

  createEffect(() => {
    if (!programsMenuOpen()) return
    const idx = programsMenuHighlightIdx()
    void programsMenuListItems().length
    queueMicrotask(() => {
      const panel = menuPanelRef
      if (!panel) return
      const el = panel.querySelector(`[data-programs-menu-idx="${idx}"]`)
      if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' })
    })
  })

  createEffect(() => {
    if (!powerMenuOpen()) return
    const list = powerMenuListItems()
    const n = list.length
    const idx = powerMenuHighlightIdx()
    if (n === 0) {
      if (idx !== 0) setPowerMenuHighlightIdx(0)
      return
    }
    if (idx >= n) setPowerMenuHighlightIdx(n - 1)
    if (idx < 0) setPowerMenuHighlightIdx(0)
    if (list[idx]?.disabled) movePowerMenuHighlight(1)
  })

  createEffect(() => {
    if (!powerMenuOpen()) return
    const idx = powerMenuHighlightIdx()
    void powerMenuListItems().length
    queueMicrotask(() => {
      const panel = menuPanelRef
      if (!panel) return
      const el = panel.querySelector(`[data-power-menu-idx="${idx}"]`)
      if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' })
    })
  })

  createEffect(() => {
    if (!ctxMenuOpen()) {
      args.dismissFloatingWire()
      return
    }
    void menuListItems().length
    void args.screenDraftRows().length
    const anchor = ctxMenuAnchor()
    const rid = requestAnimationFrame(() => {
      const main = args.mainEl()
      const atlas = menuAtlasHostRef
      const panel = menuPanelRef
      const og = args.outputGeom()
      const ph = args.outputPhysical()
      if (!main || !atlas || !panel || !og || !ph) return
      pushShellFloatingWireFromDom({
        main,
        atlasHost: atlas,
        panel,
        anchor: { x: anchor.x, y: anchor.y, alignAboveY: anchor.alignAboveY },
        canvasW: og.w,
        canvasH: og.h,
        physicalW: ph.w,
        physicalH: ph.h,
        contextMenuAtlasBufferH: args.contextMenuAtlasBufferH(),
        screens: args.screenDraftRows(),
        layoutOrigin: args.layoutCanvasOrigin(),
      })
    })
    onCleanup(() => cancelAnimationFrame(rid))
  })

  const onCtxKeyDown = (e: KeyboardEvent) => {
    if (args.screenshotMode() && e.key === 'Escape') {
      e.preventDefault()
      args.stopScreenshotMode()
      return
    }
    if (e.key === 'Escape') {
      if (args.closeAllAtlasSelects()) {
        e.preventDefault()
        return
      }
      hideContextMenu()
      return
    }
    if (!e.repeat && (e.key === 'Meta' || e.code === 'MetaLeft' || e.code === 'MetaRight')) {
      e.preventDefault()
      toggleProgramsMenuMeta()
      return
    }
    if (programsMenuOpen()) {
      const items = programsMenuListItems()
      const n = items.length
      if (e.key === 'ArrowDown') {
        if (n > 0) {
          e.preventDefault()
          setProgramsMenuHighlightIdx((i) => (i + 1) % n)
        }
        return
      }
      if (e.key === 'ArrowUp') {
        if (n > 0) {
          e.preventDefault()
          setProgramsMenuHighlightIdx((i) => (i - 1 + n) % n)
        }
        return
      }
      if (!e.repeat && !e.isComposing && e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        activateProgramsMenuSelection()
        return
      }
      if (e.key === 'Home' && n > 0) {
        e.preventDefault()
        setProgramsMenuHighlightIdx(0)
        return
      }
      if (e.key === 'End' && n > 0) {
        e.preventDefault()
        setProgramsMenuHighlightIdx(n - 1)
        return
      }
    }
    if (powerMenuOpen()) {
      const items = powerMenuListItems()
      const n = items.filter((item) => !item.disabled).length
      if (e.key === 'ArrowDown') {
        if (n > 0) {
          e.preventDefault()
          movePowerMenuHighlight(1)
        }
        return
      }
      if (e.key === 'ArrowUp') {
        if (n > 0) {
          e.preventDefault()
          movePowerMenuHighlight(-1)
        }
        return
      }
      if (!e.repeat && !e.isComposing && e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        activatePowerMenuSelection()
        return
      }
      if (e.key === 'Home' && n > 0) {
        e.preventDefault()
        const first = items.findIndex((item) => !item.disabled)
        if (first >= 0) setPowerMenuHighlightIdx(first)
        return
      }
      if (e.key === 'End' && n > 0) {
        e.preventDefault()
        let last = -1
        for (let i = items.length - 1; i >= 0; i--) {
          if (!items[i]?.disabled) {
            last = i
            break
          }
        }
        if (last >= 0) setPowerMenuHighlightIdx(last)
      }
    }
  }

  const onCtxPointerDown = (e: PointerEvent) => {
    if (!ctxMenuOpen()) return
    const target = e.target
    if (target instanceof Element && target.closest('[data-shell-programs-toggle]')) return
    if (target instanceof Element && target.closest('[data-shell-settings-toggle]')) return
    if (target instanceof Element && target.closest('[data-shell-power-toggle]')) return
    const panel = menuPanelRef
    if (panel && target instanceof Node && panel.contains(target)) return
    hideContextMenu()
  }

  document.addEventListener('keydown', onCtxKeyDown, true)
  document.addEventListener('pointerdown', onCtxPointerDown, true)
  onCleanup(() => {
    document.removeEventListener('keydown', onCtxKeyDown, true)
    document.removeEventListener('pointerdown', onCtxPointerDown, true)
  })

  return {
    ctxMenuOpen,
    programsMenuOpen,
    powerMenuOpen,
    shellMenuAtlasTop,
    onProgramsMenuClick,
    onPowerMenuClick,
    hideContextMenu,
    toggleProgramsMenuMeta,
    warmProgramsMenuItems,
    setMenuAtlasHostRef(el: HTMLDivElement) {
      menuAtlasHostRef = el
    },
    atlasHostEl: () => menuAtlasHostRef,
    programsMenuProps: {
      placement: programsMenuPlacement,
      query: programsMenuQuery,
      setQuery(value: string) {
        setProgramsMenuQuery(value)
        setProgramsMenuHighlightIdx(0)
      },
      highlightIdx: programsMenuHighlightIdx,
      items: programsMenuListItems,
      setSearchRef(el: HTMLInputElement) {
        programsMenuSearchRef = el
      },
      setPanelRef(el: HTMLDivElement) {
        menuPanelRef = el
      },
      activateSelection: activateProgramsMenuSelection,
      closeContextMenu: hideContextMenu,
    },
    powerMenuProps: {
      items: powerMenuListItems,
      highlightIdx: powerMenuHighlightIdx,
      setPanelRef(el: HTMLDivElement) {
        menuPanelRef = el
      },
      closeContextMenu: hideContextMenu,
    },
  }
}
