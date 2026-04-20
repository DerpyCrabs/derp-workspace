import {
  getDesktopAppUsageCounts,
  recordDesktopAppLaunch,
  refreshDesktopAppUsageFromRemote,
} from '@/features/desktop/desktopAppUsage'
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
  type JSX,
} from 'solid-js'
import { type ShellContextMenuItem } from '@/host/contextMenu'
import { useDesktopApplicationsState } from '@/features/desktop/desktopApplicationsState'
import { searchDesktopApplications } from '@/features/desktop/desktopAppSearch'
import type { createFloatingLayerStore } from '@/features/floating/floatingLayers'
import { shellHttpBase } from '@/features/bridge/shellHttp'
import { canvasRectToClientCss, clientRectToGlobalLogical } from '@/lib/shellCoords'
import { shellMenuPlacementWarn } from '@/host/shellMenuPlacementWarn'
import type { BackedShellWindowKind } from '@/features/shell-ui/backedShellWindows'
import {
  shellHostedProgramsBuiltinMatchesQuery,
  shellHostedProgramsMenuDefinitions,
} from '@/features/shell-ui/shellHostedAppsRegistry'
import { screensListForLayout } from './appLayout'
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
  screenshotMode: Accessor<boolean>
  stopScreenshotMode: () => void
  closeAllAtlasSelects: () => boolean
  openShellHostedApp: (kind: BackedShellWindowKind) => boolean
  spawnInCompositor: (
    cmd: string,
    launch?: { command: string; desktopId: string | null; appName: string | null } | null,
  ) => Promise<void>
  saveSessionSnapshot: () => void
  restoreSessionSnapshot: () => void
  canSaveSessionSnapshot: () => boolean
  canRestoreSessionSnapshot: () => boolean
  postSessionPower: (action: string) => Promise<void>
  canSessionControl: () => boolean
  exitSession: () => void
  tabMenuItems: (windowId: number) => ShellContextMenuItem[]
  tabMenuWindowAvailable: (windowId: number) => boolean
  onTraySniMenuPick: (notifierId: string, menuPath: string, dbusmenuId: number) => void
}

export function shouldHandleContextMenuNavigationKey(nestedInteractiveFocus: boolean): boolean {
  return !nestedInteractiveFocus
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
  const [programsUsageCounts, setProgramsUsageCounts] = createSignal(getDesktopAppUsageCounts())
  const desktopApps = useDesktopApplicationsState()

  const [menuLayerHost, setMenuLayerHost] = createSignal<HTMLElement | undefined>(undefined)
  let menuPanelRef: HTMLElement | undefined
  let programsMenuSearchRef: HTMLInputElement | undefined
  function setMenuPanelRef(el: HTMLDivElement) {
    menuPanelRef = el
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
    if (ctxMenuOpen() && activeMenuTrigger() !== trigger) {
      hideContextMenu()
    }
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
    void args.viewportCss().w
    void args.viewportCss().h
    void args.canvasCss().w
    void args.canvasCss().h
    const outputName = programsMenuOutputName()
    const metrics = programsMenuMetrics(outputName)
    const main = args.mainEl()
    const og = args.outputGeom()
    if (!metrics || !main || !og) return null
    const mainRect = main.getBoundingClientRect()
    const scr = canvasRectToClientCss(
      metrics.targetCss.x,
      metrics.targetCss.y,
      metrics.targetCss.width,
      metrics.targetCss.height,
      mainRect,
      og.w,
      og.h,
    )
    const left = Math.round(scr.left + (scr.width - metrics.width) / 2)
    const top = Math.round(scr.top + (scr.height - metrics.height) / 2)
    shellMenuPlacementWarn('programs_menu', {
      output_name: outputName,
      target_canvas: {
        x: metrics.targetCss.x,
        y: metrics.targetCss.y,
        w: metrics.targetCss.width,
        h: metrics.targetCss.height,
      },
      main_rect: { left: mainRect.left, top: mainRect.top, w: mainRect.width, h: mainRect.height },
      og,
      client_rect: scr,
      placement_px: { left, top, w: metrics.width, h: metrics.height },
    })
    return {
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.round(metrics.width)}px`,
      'max-height': `${Math.round(metrics.height)}px`,
    } as const satisfies JSX.CSSProperties
  })

  async function warmProgramsMenuItems() {
    await desktopApps.warm()
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

  function focusProgramsMenuSearch() {
    queueMicrotask(() => programsMenuSearchRef?.focus())
    requestAnimationFrame(() => {
      programsMenuSearchRef?.focus()
      requestAnimationFrame(() => programsMenuSearchRef?.focus())
    })
  }

  function openProgramsMenu(outputName?: string | null) {
    args.closeAllAtlasSelects()
    setProgramsMenuOutputName(outputName ?? null)
    anchorProgramsMenuToCenter(outputName)
    openRootContextMenu(programsMenuTrigger)
    setProgramsMenuQuery('')
    setProgramsMenuHighlightIdx(0)
    focusProgramsMenuSearch()
    void desktopApps.refresh()
    void refreshDesktopAppUsageFromRemote().then((counts) => setProgramsUsageCounts(counts))
  }

  function toggleProgramsMenuMeta(outputName?: string | null) {
    if (triggerIsOpen(programsMenuTrigger)) {
      hideContextMenu()
      return
    }
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
        actionId: 'save-session',
        label: 'Save workspace',
        badge: 'session',
        disabled: !args.canSaveSessionSnapshot(),
        title: args.canSaveSessionSnapshot()
          ? 'Persist the current workspace snapshot now'
          : 'Needs shell HTTP and an idle session restore state',
        action: args.saveSessionSnapshot,
      },
      {
        actionId: 'restore-session',
        label: 'Restore workspace',
        badge: 'session',
        disabled: !args.canRestoreSessionSnapshot(),
        title: args.canRestoreSessionSnapshot()
          ? 'Apply the last saved workspace snapshot now'
          : 'Needs a saved workspace snapshot and an idle session restore state',
        action: args.restoreSessionSnapshot,
      },
      {
        actionId: 'suspend',
        label: 'Suspend',
        disabled: !http,
        title: sysTitle,
        action: () => void args.postSessionPower('suspend'),
      },
      {
        actionId: 'restart',
        label: 'Restart',
        disabled: !http,
        title: sysTitle,
        action: () => void args.postSessionPower('reboot'),
      },
      {
        actionId: 'shutdown',
        label: 'Shut down',
        disabled: !http,
        title: sysTitle,
        action: () => void args.postSessionPower('poweroff'),
      },
      {
        actionId: 'exit-session',
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
    const builtins: ShellContextMenuItem[] = []
    for (const def of shellHostedProgramsMenuDefinitions()) {
      if (!shellHostedProgramsBuiltinMatchesQuery(query, def.matchTokens)) continue
      builtins.push({
        label: def.label,
        badge: def.badge,
        title: def.title,
        action: () => {
          void args.openShellHostedApp(def.kind)
        },
      })
    }
    if (desktopApps.busy() && !desktopApps.loaded()) {
      return builtins.length > 0 ? [...builtins, { label: 'Loading…', action: () => {} }] : [{ label: 'Loading…', action: () => {} }]
    }
    const err = desktopApps.err()
    if (err && !desktopApps.loaded()) {
      return builtins.length > 0 ? [...builtins, { label: err, action: () => {} }] : [{ label: err, action: () => {} }]
    }
    const q = programsMenuQuery().trim()
    const raw = desktopApps.items()
    if (desktopApps.loaded() && raw.length === 0) {
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
          void args.spawnInCompositor(app.exec, {
            command: app.exec,
            desktopId: app.desktop_id.trim() || null,
            appName: app.name.trim() || null,
          })
        },
      })),
    ]
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
    hideContextMenu()
    queueMicrotask(() => {
      item.action()
    })
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
    if (!ctxMenuOpen()) return
    const hit = (target: Node) => menuPanelRef?.contains(target) === true
    args.floatingLayers.registerSurface(ROOT_CONTEXT_MENU_LAYER_ID, hit)
    onCleanup(() => args.floatingLayers.unregisterSurface(ROOT_CONTEXT_MENU_LAYER_ID, hit))
  })

  function projectCurrentMenuElementRect(el: Element | null) {
    if (!(el instanceof HTMLElement)) return null
    const main = args.mainEl()
    const panel = menuPanelRef
    const og = args.outputGeom()
    if (!main || !panel || !og || !panel.contains(el)) return null
    const mainRect = main.getBoundingClientRect()
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const z = clientRectToGlobalLogical(mainRect, rect, og.w, og.h, args.layoutCanvasOrigin())
    const origin = args.layoutCanvasOrigin()
    const ox = origin?.x ?? 0
    const oy = origin?.y ?? 0
    return {
      x: z.x - ox,
      y: z.y - oy,
      width: z.w,
      height: z.h,
      global_x: z.x,
      global_y: z.y,
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
    onProgramsMenuClick,
    onPowerMenuClick,
    onVolumeMenuClick,
    openTabMenu,
    openTraySniMenu,
    applyTraySniMenuDetail,
    hideContextMenu,
    toggleProgramsMenuMeta,
    warmProgramsMenuItems,
    setMenuLayerHostRef(el: HTMLDivElement | undefined) {
      setMenuLayerHost(el)
    },
    menuLayerHostEl: menuLayerHost,
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
      bounds: volumeMenuBounds,
      setPanelRef: setMenuPanelRef,
      closeContextMenu: hideContextMenu,
    },
    tabMenuProps: {
      anchor: ctxMenuAnchor,
      items: tabMenuListItems,
      highlightIdx: tabMenuHighlightIdx,
      setPanelRef: setMenuPanelRef,
      closeContextMenu: hideContextMenu,
    },
    traySniMenuProps: {
      anchor: ctxMenuAnchor,
      items: traySniMenuListItems,
      highlightIdx: traySniHighlightIdx,
      setPanelRef: setMenuPanelRef,
      closeContextMenu: hideContextMenu,
    },
  }
}
