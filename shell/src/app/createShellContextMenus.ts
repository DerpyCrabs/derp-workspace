import {
  getDesktopAppUsageCounts,
  recordDesktopAppLaunch,
  refreshDesktopAppUsageFromRemote,
} from '../desktopAppUsage'
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
import type { createFloatingLayerStore } from '../floatingLayers'
import { measureShellFloatingPlacementFromDom } from '../shellFloatingPlacement'
import { shellHttpBase } from '../shellHttp'
import { canvasRectToClientCss } from '../shellCoords'
import { parseDesktopApplicationsResponse, type DesktopAppEntry } from '../shellBridge'
import type { LayoutScreen } from './types'

const ROOT_CONTEXT_MENU_LAYER_ID = 'shell-context-menu-root'

export type TraySniMenuEntry = {
  dbusmenu_id: number
  label: string
  separator: boolean
  enabled: boolean
}

type CreateShellContextMenusArgs = {
  floatingLayers: ReturnType<typeof createFloatingLayerStore>
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
  openFileBrowser: (path?: string | null) => void
  spawnInCompositor: (cmd: string) => Promise<void>
  postSessionPower: (action: string) => Promise<void>
  canSessionControl: () => boolean
  exitSession: () => void
  clearShellActionIssue: () => void
  reportShellActionIssue: (message: string) => void
  describeError: (error: unknown) => string
  tabMenuItems: (windowId: number) => ShellContextMenuItem[]
  tabMenuWindowAvailable: (windowId: number) => boolean
  onTraySniMenuPick: (notifierId: string, menuPath: string, dbusmenuId: number) => void
}

export function shouldHandleContextMenuNavigationKey(nestedInteractiveFocus: boolean): boolean {
  if (!nestedInteractiveFocus) return true
  return false
}

export function shouldDismissContextMenuPointerDown(args: {
  target: EventTarget | null
}): boolean {
  const target = args.target
  if (target instanceof Element && target.closest('[data-shell-programs-toggle]')) return false
  if (target instanceof Element && target.closest('[data-shell-settings-toggle]')) return false
  if (target instanceof Element && target.closest('[data-shell-power-toggle]')) return false
  if (target instanceof Element && target.closest('[data-shell-volume-toggle]')) return false
  if (target instanceof Element && target.closest('[data-shell-tray-strip]')) return false
  return true
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
  const programsMenuTrigger = {}
  const powerMenuTrigger = {}
  const volumeMenuTrigger = {}
  const tabMenuTrigger = {}
  const traySniMenuTrigger = {}
  const [activeMenuTrigger, setActiveMenuTrigger] = createSignal<object | null>(null)
  const [ctxMenuAnchor, setCtxMenuAnchor] = createSignal<{
    x: number
    y: number
    alignAboveY?: number
  }>({ x: 0, y: 0 })
  const [programsMenuQuery, setProgramsMenuQuery] = createSignal('')
  const [programsMenuHighlightIdx, setProgramsMenuHighlightIdx] = createSignal(0)
  const [powerMenuHighlightIdx, setPowerMenuHighlightIdx] = createSignal(0)
  const [tabMenuHighlightIdx, setTabMenuHighlightIdx] = createSignal(0)
  const [traySniHighlightIdx, setTraySniHighlightIdx] = createSignal(0)
  const [traySniPendingSerial, setTraySniPendingSerial] = createSignal(0)
  const [traySniNotifierId, setTraySniNotifierId] = createSignal('')
  const [traySniMenuPath, setTraySniMenuPath] = createSignal('')
  const [traySniEntries, setTraySniEntries] = createSignal<TraySniMenuEntry[]>([])
  const [programsMenuOutputName, setProgramsMenuOutputName] = createSignal<string | null>(null)
  const [tabMenuWindowId, setTabMenuWindowId] = createSignal<number | null>(null)
  const [programsMenuBusy, setProgramsMenuBusy] = createSignal(false)
  const [programsMenuErr, setProgramsMenuErr] = createSignal<string | null>(null)
  const [programsUsageCounts, setProgramsUsageCounts] = createSignal(getDesktopAppUsageCounts())
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
  const [menuPanelRevision, setMenuPanelRevision] = createSignal(0)
  const [menuPanelLayoutRevision, setMenuPanelLayoutRevision] = createSignal(0)
  function setMenuPanelRef(el: HTMLDivElement) {
    menuPanelRef = el
    setMenuPanelRevision((value) => value + 1)
  }


  const triggerOpen = (token: object) => createMemo(() => ctxMenuOpen() && activeMenuTrigger() === token)
  const programsMenuOpen = triggerOpen(programsMenuTrigger)
  const powerMenuOpen = triggerOpen(powerMenuTrigger)
  const tabMenuOpen = triggerOpen(tabMenuTrigger)
  const traySniMenuOpen = triggerOpen(traySniMenuTrigger)
  const volumeMenuOpen = triggerOpen(volumeMenuTrigger)

  createEffect(() => {
    if (!ctxMenuOpen()) {
      setActiveMenuTrigger(null)
      setProgramsMenuQuery('')
      setProgramsMenuHighlightIdx(0)
      setProgramsMenuOutputName(null)
      setPowerMenuHighlightIdx(0)
      setTabMenuHighlightIdx(0)
      setTabMenuWindowId(null)
      setTraySniHighlightIdx(0)
      setTraySniPendingSerial(0)
      setTraySniNotifierId('')
      setTraySniMenuPath('')
      setTraySniEntries([])
    }
  })

  function resetContextMenuState() {
    setCtxMenuOpen(false)
    setActiveMenuTrigger(null)
    setProgramsMenuQuery('')
    setProgramsMenuHighlightIdx(0)
    setProgramsMenuOutputName(null)
    setPowerMenuHighlightIdx(0)
    setTabMenuHighlightIdx(0)
    setTabMenuWindowId(null)
    setTraySniHighlightIdx(0)
    setTraySniPendingSerial(0)
    setTraySniNotifierId('')
    setTraySniMenuPath('')
    setTraySniEntries([])
  }

  function hideContextMenu(skipStore = false) {
    resetContextMenuState()
    args.floatingLayers.clearLayerPlacement(ROOT_CONTEXT_MENU_LAYER_ID)
    if (!skipStore) {
      args.floatingLayers.closeBranch(ROOT_CONTEXT_MENU_LAYER_ID)
    }
  }

  function openRootContextMenu(trigger: object) {
    args.floatingLayers.openLayer({
      id: ROOT_CONTEXT_MENU_LAYER_ID,
      kind: 'context_menu',
      onClose: () => hideContextMenu(true),
    })
    setActiveMenuTrigger(trigger)
    setCtxMenuOpen(true)
  }

  function triggerIsOpen(trigger: object) {
    return ctxMenuOpen() && activeMenuTrigger() === trigger
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

  const volumeMenuBounds = createMemo(() => {
    const og = args.outputGeom()
    const screens = screensListForLayout(args.screenDraftRows(), og, args.layoutCanvasOrigin())
    const anchor = ctxMenuAnchor()
    const probeX = anchor.x - 1
    const probeY = (anchor.alignAboveY ?? anchor.y) + 1
    const matched =
      screens.find(
        (screen) =>
          probeX >= screen.x &&
          probeX < screen.x + screen.width &&
          probeY >= screen.y &&
          probeY < screen.y + screen.height,
      ) ?? screens[0]
    if (matched) {
      return {
        x: matched.x,
        y: matched.y,
        w: matched.width,
        h: matched.height,
      }
    }
    const canvas = args.canvasCss()
    return {
      x: 0,
      y: 0,
      w: canvas.w,
      h: canvas.h,
    }
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
    setProgramsUsageCounts(await refreshDesktopAppUsageFromRemote())
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
    setProgramsMenuBusy(!programsCatalog.loaded)
    setProgramsMenuErr(null)
    openRootContextMenu(programsMenuTrigger)
    setProgramsMenuQuery('')
    setProgramsMenuHighlightIdx(0)
    setProgramsMenuOutputName(outputName ?? null)
    queueMicrotask(() => programsMenuSearchRef?.focus())
    void refreshProgramsMenuItems()
    void refreshDesktopAppUsageFromRemote().then((counts) => setProgramsUsageCounts(counts))
  }

  function toggleProgramsMenuMeta(outputName?: string | null) {
    if (triggerIsOpen(programsMenuTrigger)) {
      hideContextMenu()
      return
    }
    if (triggerIsOpen(powerMenuTrigger)) hideContextMenu()
    openProgramsMenu(outputName)
  }

  function onProgramsMenuClick(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    e.preventDefault()
    if (triggerIsOpen(programsMenuTrigger)) {
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
    if (triggerIsOpen(powerMenuTrigger)) {
      hideContextMenu()
      return
    }
    args.closeAllAtlasSelects()
    const rect = e.currentTarget.getBoundingClientRect()
    setCtxMenuAnchor({ x: rect.right, y: rect.bottom, alignAboveY: rect.top })
    setPowerMenuHighlightIdx(0)
    openRootContextMenu(powerMenuTrigger)
  }

  function onVolumeMenuClick(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    e.preventDefault()
    if (triggerIsOpen(volumeMenuTrigger)) {
      hideContextMenu()
      return
    }
    args.closeAllAtlasSelects()
    const rect = e.currentTarget.getBoundingClientRect()
    setCtxMenuAnchor({ x: rect.right, y: rect.bottom, alignAboveY: rect.top })
    openRootContextMenu(volumeMenuTrigger)
  }

  function openTabMenu(windowId: number, clientX: number, clientY: number) {
    args.closeAllAtlasSelects()
    setCtxMenuAnchor({ x: Math.round(clientX), y: Math.round(clientY), alignAboveY: Math.round(clientY) })
    setTabMenuWindowId(windowId)
    setTabMenuHighlightIdx(0)
    openRootContextMenu(tabMenuTrigger)
  }

  function openTraySniMenu(notifierId: string, requestSerial: number, clientX: number, clientY: number) {
    args.closeAllAtlasSelects()
    setCtxMenuAnchor({ x: Math.round(clientX), y: Math.round(clientY), alignAboveY: Math.round(clientY) })
    setTraySniPendingSerial(requestSerial >>> 0)
    setTraySniNotifierId(notifierId)
    setTraySniMenuPath('')
    setTraySniEntries([
      { dbusmenu_id: -1, label: 'Loading…', separator: false, enabled: false },
    ])
    setTraySniHighlightIdx(0)
    openRootContextMenu(traySniMenuTrigger)
  }

  function applyTraySniMenuDetail(detail: {
    request_serial: number
    notifier_id: string
    menu_path: string
    entries: TraySniMenuEntry[]
  }) {
    if (!triggerIsOpen(traySniMenuTrigger)) return
    if ((detail.request_serial >>> 0) !== traySniPendingSerial()) return
    if (detail.notifier_id !== traySniNotifierId()) return
    setTraySniMenuPath(detail.menu_path)
    const next = detail.entries
    if (next.length === 0) {
      setTraySniEntries([
        {
          dbusmenu_id: -1,
          label: detail.menu_path ? 'Empty menu' : 'No menu for this icon',
          separator: false,
          enabled: false,
        },
      ])
    } else {
      setTraySniEntries(next)
    }
    setTraySniHighlightIdx(0)
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

  const tabMenuListItems = createMemo((): ShellContextMenuItem[] => {
    if (!tabMenuOpen()) return []
    const windowId = tabMenuWindowId()
    if (windowId == null) return []
    return args.tabMenuItems(windowId)
  })

  const traySniMenuListItems = createMemo((): ShellContextMenuItem[] => {
    if (!traySniMenuOpen()) return []
    const nid = traySniNotifierId()
    const path = traySniMenuPath()
    return traySniEntries().map((e) => ({
      label: e.label,
      separator: e.separator,
      disabled: e.separator ? true : !e.enabled,
      action: () => {
        if (e.separator || e.dbusmenu_id < 0 || !e.enabled) return
        args.onTraySniMenuPick(nid, path, e.dbusmenu_id)
      },
    }))
  })

  createEffect(() => {
    if (!tabMenuOpen()) return
    const windowId = tabMenuWindowId()
    if (windowId == null || !args.tabMenuWindowAvailable(windowId) || tabMenuListItems().length === 0) {
      hideContextMenu()
    }
  })

  const programsMenuListItems = createMemo((): ShellContextMenuItem[] => {
    if (!programsMenuOpen()) return []
    const query = programsMenuQuery().trim().toLocaleLowerCase()
    const builtins: ShellContextMenuItem[] =
      query.length === 0 || 'files browser folder shell'.split(' ').some((token) => token.includes(query) || query.includes(token))
        ? [
            {
              label: 'Files',
              badge: 'shell',
              title: 'Open the shell file browser',
              action: () => args.openFileBrowser(),
            },
          ]
        : []
    if (programsMenuBusy() && !programsCatalog.loaded) {
      return builtins.length > 0 ? [...builtins, { label: 'Loading…', action: () => {} }] : [{ label: 'Loading…', action: () => {} }]
    }
    const err = programsMenuErr()
    if (err && !programsCatalog.loaded) {
      return builtins.length > 0 ? [...builtins, { label: err, action: () => {} }] : [{ label: err, action: () => {} }]
    }
    const q = programsMenuQuery().trim()
    const raw = programsCatalog.items
    if (programsCatalog.loaded && raw.length === 0) {
      return builtins.length > 0 ? builtins : [{ label: 'No applications found.', action: () => {} }]
    }
    if (raw.length === 0) return builtins.length > 0 ? builtins : [{ label: 'Loading…', action: () => {} }]
    return [
      ...builtins,
      ...searchDesktopApplications(raw, q, programsUsageCounts()).map((app) => ({
        label: app.name,
        badge: app.terminal ? 'tty' : undefined,
        action: () => {
          setProgramsUsageCounts(recordDesktopAppLaunch(app))
          void args.spawnInCompositor(app.exec)
        },
      })),
    ]
  })

  const menuListItems = createMemo(() => {
    if (programsMenuOpen()) return programsMenuListItems()
    if (powerMenuOpen()) return powerMenuListItems()
    if (tabMenuOpen()) return tabMenuListItems()
    if (traySniMenuOpen()) return traySniMenuListItems()
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

  function moveTabMenuHighlight(delta: number) {
    const items = tabMenuListItems()
    const n = items.length
    if (n === 0) return
    let idx = tabMenuHighlightIdx()
    for (let step = 0; step < n; step++) {
      idx = (idx + delta + n) % n
      if (!items[idx]?.disabled) {
        setTabMenuHighlightIdx(idx)
        return
      }
    }
  }

  function activateTabMenuSelection() {
    if (!tabMenuOpen()) return
    const item = tabMenuListItems()[tabMenuHighlightIdx()]
    if (!item || item.disabled) return
    item.action()
    hideContextMenu()
  }

  function moveTraySniMenuHighlight(delta: number) {
    const items = traySniMenuListItems()
    const n = items.length
    if (n === 0) return
    let idx = traySniHighlightIdx()
    for (let step = 0; step < n; step++) {
      idx = (idx + delta + n) % n
      const it = items[idx]
      if (it && !it.separator && !it.disabled) {
        setTraySniHighlightIdx(idx)
        return
      }
    }
  }

  function activateTraySniMenuSelection() {
    if (!traySniMenuOpen()) return
    const item = traySniMenuListItems()[traySniHighlightIdx()]
    if (!item || item.disabled || item.separator) return
    item.action()
    hideContextMenu()
  }

  createEffect(() => {
    if (!traySniMenuOpen()) return
    const list = traySniMenuListItems()
    const n = list.length
    const idx = traySniHighlightIdx()
    if (n === 0) {
      if (idx !== 0) setTraySniHighlightIdx(0)
      return
    }
    if (idx >= n) setTraySniHighlightIdx(n - 1)
    if (idx < 0) setTraySniHighlightIdx(0)
    const cur = list[idx]
    if (cur?.separator || cur?.disabled) moveTraySniMenuHighlight(1)
  })

  createEffect(() => {
    if (!traySniMenuOpen()) return
    const idx = traySniHighlightIdx()
    void traySniMenuListItems().length
    queueMicrotask(() => {
      const panel = menuPanelRef
      if (!panel) return
      const el = panel.querySelector(`[data-tray-sni-menu-idx="${idx}"]`)
      if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' })
    })
  })

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
    void menuPanelRevision()
    const panel = menuPanelRef
    if (!panel) return
    setMenuPanelLayoutRevision((value) => value + 1)
    const observer = new ResizeObserver(() => {
      setMenuPanelLayoutRevision((value) => value + 1)
    })
    observer.observe(panel)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    if (!ctxMenuOpen()) return
    const hit = (target: Node) => menuPanelRef?.contains(target) === true
    args.floatingLayers.registerSurface(ROOT_CONTEXT_MENU_LAYER_ID, hit)
    onCleanup(() => args.floatingLayers.unregisterSurface(ROOT_CONTEXT_MENU_LAYER_ID, hit))
  })

  createEffect(() => {
    if (!ctxMenuOpen()) {
      args.floatingLayers.clearLayerPlacement(ROOT_CONTEXT_MENU_LAYER_ID)
      return
    }
    void menuListItems().length
    void menuPanelRevision()
    void menuPanelLayoutRevision()
    void args.screenDraftRows().length
    const anchor = ctxMenuAnchor()
    const rid = requestAnimationFrame(() => {
      const main = args.mainEl()
      const atlas = menuAtlasHostRef
      const panel = menuPanelRef
      const og = args.outputGeom()
      const ph = args.outputPhysical()
      if (!main || !atlas || !panel || !og || !ph) return
      const { placement } = measureShellFloatingPlacementFromDom({
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
      args.floatingLayers.setLayerPlacement(ROOT_CONTEXT_MENU_LAYER_ID, placement)
    })
    onCleanup(() => cancelAnimationFrame(rid))
  })

  function projectCurrentMenuElementRect(el: Element | null) {
    if (!(el instanceof HTMLElement)) return null
    const main = args.mainEl()
    const atlas = menuAtlasHostRef
    const panel = menuPanelRef
    const og = args.outputGeom()
    const ph = args.outputPhysical()
    if (!main || !atlas || !panel || !og || !ph || !panel.contains(el)) return null
    const anchor = ctxMenuAnchor()
    const { panelRect, placement } = measureShellFloatingPlacementFromDom({
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
    if (panelRect.width <= 0 || panelRect.height <= 0) return null
    const rect = el.getBoundingClientRect()
    const leftRatio = (rect.left - panelRect.left) / panelRect.width
    const topRatio = (rect.top - panelRect.top) / panelRect.height
    const rightRatio = (rect.right - panelRect.left) / panelRect.width
    const bottomRatio = (rect.bottom - panelRect.top) / panelRect.height
    const globalLeft = Math.round(placement.gx + leftRatio * placement.gw)
    const globalTop = Math.round(placement.gy + topRatio * placement.gh)
    const globalRight = Math.round(placement.gx + rightRatio * placement.gw)
    const globalBottom = Math.round(placement.gy + bottomRatio * placement.gh)
    const width = Math.max(1, globalRight - globalLeft)
    const height = Math.max(1, globalBottom - globalTop)
    const origin = args.layoutCanvasOrigin()
    const ox = origin?.x ?? 0
    const oy = origin?.y ?? 0
    return {
      x: globalLeft - ox,
      y: globalTop - oy,
      width,
      height,
      global_x: globalLeft,
      global_y: globalTop,
    }
  }

  const onCtxKeyDown = (e: KeyboardEvent) => {
    if (args.screenshotMode() && e.key === 'Escape') {
      e.preventDefault()
      args.stopScreenshotMode()
      return
    }
    if (e.key === 'Escape') {
      if (args.floatingLayers.closeTopmostEscapable()) {
        e.preventDefault()
        return
      }
      return
    }
    if (!e.repeat && (e.key === 'Meta' || e.code === 'MetaLeft' || e.code === 'MetaRight')) {
      e.preventDefault()
      toggleProgramsMenuMeta()
      return
    }
    if (
      !shouldHandleContextMenuNavigationKey(
        args.floatingLayers.hasOpenKind('context_menu') && args.floatingLayers.topmostLayerKind() !== 'context_menu',
      )
    ) {
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
    if (tabMenuOpen()) {
      const items = tabMenuListItems()
      const n = items.filter((item) => !item.disabled).length
      if (e.key === 'ArrowDown') {
        if (n > 0) {
          e.preventDefault()
          moveTabMenuHighlight(1)
        }
        return
      }
      if (e.key === 'ArrowUp') {
        if (n > 0) {
          e.preventDefault()
          moveTabMenuHighlight(-1)
        }
        return
      }
      if (!e.repeat && !e.isComposing && e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        activateTabMenuSelection()
        return
      }
      if (e.key === 'Home' && n > 0) {
        e.preventDefault()
        const first = items.findIndex((item) => !item.disabled)
        if (first >= 0) setTabMenuHighlightIdx(first)
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
        if (last >= 0) setTabMenuHighlightIdx(last)
      }
    }
    if (traySniMenuOpen()) {
      const items = traySniMenuListItems()
      const n = items.filter((item) => !item.disabled && !item.separator).length
      if (e.key === 'ArrowDown') {
        if (n > 0) {
          e.preventDefault()
          moveTraySniMenuHighlight(1)
        }
        return
      }
      if (e.key === 'ArrowUp') {
        if (n > 0) {
          e.preventDefault()
          moveTraySniMenuHighlight(-1)
        }
        return
      }
      if (!e.repeat && !e.isComposing && e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        activateTraySniMenuSelection()
        return
      }
      if (e.key === 'Home' && n > 0) {
        e.preventDefault()
        const first = items.findIndex((item) => !item.disabled && !item.separator)
        if (first >= 0) setTraySniHighlightIdx(first)
        return
      }
      if (e.key === 'End' && n > 0) {
        e.preventDefault()
        let last = -1
        for (let i = items.length - 1; i >= 0; i--) {
          if (!items[i]?.disabled && !items[i]?.separator) {
            last = i
            break
          }
        }
        if (last >= 0) setTraySniHighlightIdx(last)
      }
    }
  }

  const onCtxPointerDown = (e: PointerEvent) => {
    if (!args.floatingLayers.anyOpen()) return
    const shouldDismiss = shouldDismissContextMenuPointerDown({
      target: e.target,
    })
    if (!shouldDismiss) return
    args.floatingLayers.dismissPointerDown(e.target instanceof Node ? e.target : null)
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
    volumeMenuOpen,
    tabMenuOpen,
    traySniMenuOpen,
    shellMenuAtlasTop,
    onProgramsMenuClick,
    onPowerMenuClick,
    onVolumeMenuClick,
    openTabMenu,
    openTraySniMenu,
    applyTraySniMenuDetail,
    hideContextMenu,
    toggleProgramsMenuMeta,
    warmProgramsMenuItems,
    setMenuAtlasHostRef(el: HTMLDivElement) {
      menuAtlasHostRef = el
    },
    atlasHostEl: () => menuAtlasHostRef,
    projectCurrentMenuElementRect,
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
      setPanelRef: setMenuPanelRef,
      activateSelection: activateProgramsMenuSelection,
      closeContextMenu: hideContextMenu,
    },
    powerMenuProps: {
      anchor: ctxMenuAnchor,
      items: powerMenuListItems,
      highlightIdx: powerMenuHighlightIdx,
      setPanelRef: setMenuPanelRef,
      closeContextMenu: hideContextMenu,
    },
    volumeMenuProps: {
      anchor: ctxMenuAnchor,
      atlasTop: shellMenuAtlasTop,
      bounds: volumeMenuBounds,
      setPanelRef: setMenuPanelRef,
      closeContextMenu: hideContextMenu,
    },
    tabMenuProps: {
      items: tabMenuListItems,
      highlightIdx: tabMenuHighlightIdx,
      setPanelRef: setMenuPanelRef,
      closeContextMenu: hideContextMenu,
    },
    traySniMenuProps: {
      items: traySniMenuListItems,
      highlightIdx: traySniHighlightIdx,
      setPanelRef: setMenuPanelRef,
      closeContextMenu: hideContextMenu,
    },
  }
}
