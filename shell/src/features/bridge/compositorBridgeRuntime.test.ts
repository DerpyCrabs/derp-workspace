import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerCompositorBridgeRuntime } from './compositorBridgeRuntime'
import type { DerpShellDetail } from '@/host/appWindowState'
import { SHELL_WINDOW_FLAG_SHELL_HOSTED } from '@/features/shell-ui/shellUiWindows'

const DOMAIN_COUNT = 14
const SNAPSHOT_DOMAIN_OUTPUTS = 1 << 0
const SNAPSHOT_DOMAIN_WINDOWS = 1 << 1
const SNAPSHOT_DOMAIN_FOCUS = 1 << 2
const SNAPSHOT_DOMAIN_KEYBOARD = 1 << 3
const SNAPSHOT_DOMAIN_WORKSPACE = 1 << 4
const SNAPSHOT_DOMAIN_SHELL_HOSTED_APPS = 1 << 5
const SNAPSHOT_DOMAIN_INTERACTION = 1 << 6
const SNAPSHOT_DOMAIN_NATIVE_DRAG_PREVIEW = 1 << 7
const SNAPSHOT_DOMAIN_TRAY = 1 << 8
const SNAPSHOT_DOMAIN_WINDOW_ORDER = 1 << 9
const SNAPSHOT_DOMAIN_COMMAND_PALETTE = 1 << 13

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

function u64(value: bigint): number[] {
  return [
    Number(value & 0xffn),
    Number((value >> 8n) & 0xffn),
    Number((value >> 16n) & 0xffn),
    Number((value >> 24n) & 0xffn),
    Number((value >> 32n) & 0xffn),
    Number((value >> 40n) & 0xffn),
    Number((value >> 48n) & 0xffn),
    Number((value >> 56n) & 0xffn),
  ]
}

function domainRevisions(overrides: Partial<Record<number, bigint>> = {}): number[] {
  const out: number[] = []
  for (let index = 0; index < DOMAIN_COUNT; index += 1) out.push(...u64(overrides[index] ?? 1n))
  return out
}

function snapshot(sequence: bigint, domainFlags = 0, revisions: Partial<Record<number, bigint>> = {}, packets: number[] = []): ArrayBuffer {
  const chunks = packets.length > 0 ? [...u32(domainFlags), ...u32(packets.length), ...packets] : []
  const payload = [...domainRevisions(revisions), ...u32(0x4452444d), ...u32(packets.length > 0 ? 1 : 0), ...chunks]
  return new Uint8Array([
    ...u32(0x44525053),
    ...u32(0),
    ...u32(payload.length),
    ...u32(domainFlags),
    ...u64(sequence),
    ...u64(0n),
    ...payload,
  ]).buffer
}

function emptySnapshot(sequence: bigint): ArrayBuffer {
  return snapshot(sequence)
}

function packet(msgType: number, body: number[]): number[] {
  return [...u32(4 + body.length), ...u32(msgType), ...body]
}

function utf8Bytes(text: string): number[] {
  return [...new TextEncoder().encode(text)]
}

function keyboardLayoutSnapshot(sequence: bigint, label: string, revision: bigint): ArrayBuffer {
  const body = [...u64(revision), ...u32(label.length), ...utf8Bytes(label)]
  return snapshot(sequence, SNAPSHOT_DOMAIN_KEYBOARD, { 3: revision }, [ ...packet(52, body) ])
}

function emptyWindowListSnapshot(sequence: bigint, revision = 2n): ArrayBuffer {
  return snapshot(sequence, SNAPSHOT_DOMAIN_WINDOWS, { 1: revision }, [
    ...packet(11, [
      ...u64(revision),
      ...u32(0),
    ]),
  ])
}

function options(overrides: Partial<Parameters<typeof registerCompositorBridgeRuntime>[0]> = {}) {
  return {
    setKeyboardLayoutLabel: vi.fn(),
    setVolumeOverlay: vi.fn(),
    setTrayVolumeState: vi.fn(),
    setTrayReservedPx: vi.fn(),
    setTrayIconSlotPx: vi.fn(),
    setSniTrayItems: vi.fn(),
    setNotificationsState: vi.fn(),
    setOutputTopology: vi.fn(),
    setCompositorSnapshotSequence: vi.fn(),
    setCompositorInteractionState: vi.fn(),
    setNativeDragPreview: vi.fn(),
    getNativeDragPreview: () => null,
    markHasSeenCompositorWindowSync: vi.fn(),
    clearWindowSyncRecoveryPending: vi.fn(),
    scheduleExclusionZonesSync: vi.fn(),
    scheduleCompositorFollowup: vi.fn(),
    applyModelAuthoritativeSnapshotDetails: vi.fn(),
    clearModelAuthoritativeSnapshotDomains: vi.fn(),
    closeAllAtlasSelects: vi.fn(() => false),
    hideContextMenu: vi.fn(),
    toggleProgramsMenuMeta: vi.fn(),
    applyTraySniMenuDetail: vi.fn(),
    handleMutationAck: vi.fn(),
    shellWireSend: vi.fn(() => true),
    requestCompositorSync: vi.fn(),
    openSettingsShellWindow: vi.fn(),
    cycleFocusedWorkspaceGroup: vi.fn(),
    beginScreenshotMode: vi.fn(),
    toggleShellMaximizeForWindow: vi.fn(),
    spawnInCompositor: vi.fn(async () => {}),
    focusedWindowId: () => null,
    allWindowsMap: () => new Map(),
    windows: () => new Map(),
    layoutCanvasOrigin: () => null,
    screenDraftRows: () => [],
    outputGeom: () => null,
    reserveTaskbarForMon: () => false,
    workspaceSnapshot: () => ({
      groups: [],
      activeTabByGroupId: {},
      pinnedWindowIds: [],
      splitByGroupId: {},
      monitorTiles: [],
      monitorLayouts: [],
      preTileGeometry: [],
      taskbarPins: [],
      nextGroupSeq: 1,
    }),
    occupiedSnapZonesOnMonitor: () => [],
    sendSetMonitorTile: vi.fn(() => true),
    bumpSnapChrome: vi.fn(),
    sendSetPreTileGeometry: vi.fn(() => true),
    workspacePreTileSnapshot: () => null,
    sendRemoveMonitorTile: vi.fn(() => true),
    sendClearPreTileGeometry: vi.fn(() => true),
    fallbackMonitorKey: () => 'DP-1',
    requestWindowSyncRecovery: vi.fn(),
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('registerCompositorBridgeRuntime', () => {
  it('drops stale hot window details after a newer snapshot epoch', async () => {
    let snapshotBuffer = emptySnapshot(10n)
    vi.stubGlobal('window', {
      __DERP_COMPOSITOR_SNAPSHOT_PATH: '/tmp/snapshot',
      __derpCompositorSnapshotRead: vi.fn(() => snapshotBuffer),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const runtimeOptions = options()
    const dispose = registerCompositorBridgeRuntime(runtimeOptions)

    await Promise.resolve()
    window.__DERP_APPLY_COMPOSITOR_BATCH?.([
      {
        type: 'window_geometry',
        window_id: 7,
        surface_id: 70,
        x: 11,
        y: 12,
        width: 640,
        height: 480,
        snapshot_epoch: 8,
      } satisfies DerpShellDetail,
    ])

    expect(runtimeOptions.applyModelAuthoritativeSnapshotDetails).not.toHaveBeenCalled()
    dispose()
  })

  it('does not apply compositor state details directly while snapshot catchup is pending', async () => {
    vi.stubGlobal('window', {
      __DERP_COMPOSITOR_SNAPSHOT_PATH: '/tmp/snapshot',
      __derpCompositorSnapshotRead: vi.fn(() => emptySnapshot(10n)),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const runtimeOptions = options()
    const dispose = registerCompositorBridgeRuntime(runtimeOptions)

    await Promise.resolve()
    window.__DERP_APPLY_COMPOSITOR_BATCH?.([
      {
        type: 'window_geometry',
        window_id: 7,
        surface_id: 70,
        x: 11,
        y: 12,
        width: 640,
        height: 480,
        snapshot_epoch: 12,
      } satisfies DerpShellDetail,
    ])

    expect(runtimeOptions.applyModelAuthoritativeSnapshotDetails).not.toHaveBeenCalled()
    dispose()
  })

  it('uses compositor-owned incrementals only as snapshot wakeups and visual followups when no snapshot is readable', async () => {
    vi.stubGlobal('window', {
      __DERP_COMPOSITOR_SNAPSHOT_PATH: '/tmp/snapshot',
      __derpCompositorSnapshotRead: vi.fn(() => null),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const runtimeOptions = options()
    const dispose = registerCompositorBridgeRuntime(runtimeOptions)

    await Promise.resolve()
    window.__DERP_APPLY_COMPOSITOR_BATCH?.([
      {
        type: 'window_geometry',
        window_id: 7,
        surface_id: 70,
        x: 11,
        y: 12,
        width: 640,
        height: 480,
        snapshot_epoch: 12,
      } satisfies DerpShellDetail,
    ])

    expect(runtimeOptions.applyModelAuthoritativeSnapshotDetails).not.toHaveBeenCalled()
    expect(runtimeOptions.scheduleCompositorFollowup).toHaveBeenCalledWith(
      expect.objectContaining({ flushWindows: true, syncExclusion: true }),
    )
    expect(runtimeOptions.bumpSnapChrome).toHaveBeenCalledTimes(1)
    expect(runtimeOptions.shellWireSend).toHaveBeenCalledWith('invalidate_view')
    dispose()
  })

  it('does not apply focus details directly instead of snapshot replacement', async () => {
    vi.stubGlobal('window', {
      __DERP_COMPOSITOR_SNAPSHOT_PATH: '/tmp/snapshot',
      __derpCompositorSnapshotRead: vi.fn(() => emptySnapshot(10n)),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const runtimeOptions = options()
    const dispose = registerCompositorBridgeRuntime(runtimeOptions)

    await Promise.resolve()
    window.__DERP_APPLY_COMPOSITOR_BATCH?.([
      {
        type: 'focus_changed',
        surface_id: 70,
        window_id: 7,
        snapshot_epoch: 12,
      } satisfies DerpShellDetail,
    ])

    expect(runtimeOptions.applyModelAuthoritativeSnapshotDetails).not.toHaveBeenCalled()
    expect(runtimeOptions.requestCompositorSync).not.toHaveBeenCalled()
    dispose()
  })

  it('does not keep stale mapped details live when a snapshot only covered another domain', async () => {
    const readSnapshot = vi
      .fn()
      .mockReturnValueOnce(emptySnapshot(10n))
      .mockReturnValueOnce(keyboardLayoutSnapshot(12n, 'ENGLISH', 2n))
    vi.stubGlobal('window', {
      __DERP_COMPOSITOR_SNAPSHOT_PATH: '/tmp/snapshot',
      __derpCompositorSnapshotRead: readSnapshot,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const runtimeOptions = options()
    const dispose = registerCompositorBridgeRuntime(runtimeOptions)

    await Promise.resolve()
    window.__DERP_APPLY_COMPOSITOR_BATCH?.([
      {
        type: 'focus_changed',
        surface_id: 70,
        window_id: 7,
        snapshot_epoch: 12,
      } satisfies DerpShellDetail,
    ])

    vi.mocked(runtimeOptions.applyModelAuthoritativeSnapshotDetails).mockClear()
    window.__DERP_APPLY_COMPOSITOR_BATCH?.([
      {
        type: 'window_mapped',
        window_id: 7,
        surface_id: 70,
        stack_z: 1,
        x: 11,
        y: 12,
        width: 640,
        height: 480,
        minimized: false,
        maximized: false,
        fullscreen: false,
        title: 'Late Map',
        app_id: 'late.map',
        snapshot_epoch: 11,
      } satisfies DerpShellDetail,
    ])

    expect(runtimeOptions.applyModelAuthoritativeSnapshotDetails).not.toHaveBeenCalled()
    dispose()
  })

  it('drops stale mapped details when a newer snapshot covered the windows domain', async () => {
    const readSnapshot = vi
      .fn()
      .mockReturnValueOnce(emptySnapshot(10n))
      .mockReturnValueOnce(snapshot(12n, SNAPSHOT_DOMAIN_WINDOWS, { 1: 2n }, []))
    vi.stubGlobal('window', {
      __DERP_COMPOSITOR_SNAPSHOT_PATH: '/tmp/snapshot',
      __derpCompositorSnapshotRead: readSnapshot,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const runtimeOptions = options()
    const dispose = registerCompositorBridgeRuntime(runtimeOptions)

    await Promise.resolve()
    vi.mocked(runtimeOptions.applyModelAuthoritativeSnapshotDetails).mockClear()
    window.__DERP_APPLY_COMPOSITOR_BATCH?.([
      {
        type: 'window_mapped',
        window_id: 7,
        surface_id: 70,
        stack_z: 1,
        x: 11,
        y: 12,
        width: 640,
        height: 480,
        minimized: false,
        maximized: false,
        fullscreen: false,
        title: 'Late Map',
        app_id: 'late.map',
        snapshot_epoch: 11,
      } satisfies DerpShellDetail,
    ])

    expect(runtimeOptions.applyModelAuthoritativeSnapshotDetails).not.toHaveBeenCalled()
    dispose()
  })

  it('does not apply same-epoch geometry details directly after an unrelated snapshot', async () => {
    const readSnapshot = vi
      .fn()
      .mockReturnValueOnce(emptySnapshot(10n))
      .mockReturnValueOnce(keyboardLayoutSnapshot(12n, 'ENGLISH', 2n))
    vi.stubGlobal('window', {
      __DERP_COMPOSITOR_SNAPSHOT_PATH: '/tmp/snapshot',
      __derpCompositorSnapshotRead: readSnapshot,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const runtimeOptions = options()
    const dispose = registerCompositorBridgeRuntime(runtimeOptions)

    await Promise.resolve()
    window.__DERP_APPLY_COMPOSITOR_BATCH?.([
      {
        type: 'focus_changed',
        surface_id: 70,
        window_id: 7,
        snapshot_epoch: 12,
      } satisfies DerpShellDetail,
    ])

    vi.mocked(runtimeOptions.applyModelAuthoritativeSnapshotDetails).mockClear()
    window.__DERP_APPLY_COMPOSITOR_BATCH?.([
      {
        type: 'window_geometry',
        window_id: 7,
        surface_id: 70,
        x: 2160,
        y: 242,
        width: 900,
        height: 820,
        output_name: 'DP-4',
        maximized: false,
        fullscreen: false,
        snapshot_epoch: 12,
      } satisfies DerpShellDetail,
    ])

    expect(runtimeOptions.applyModelAuthoritativeSnapshotDetails).not.toHaveBeenCalled()
    expect(runtimeOptions.requestCompositorSync).not.toHaveBeenCalled()
    dispose()
  })

  it('does not apply interaction state details directly while snapshot catchup is pending', async () => {
    vi.stubGlobal('window', {
      __DERP_COMPOSITOR_SNAPSHOT_PATH: '/tmp/snapshot',
      __derpCompositorSnapshotRead: vi.fn(() => emptySnapshot(10n)),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const runtimeOptions = options()
    const dispose = registerCompositorBridgeRuntime(runtimeOptions)

    await Promise.resolve()
    window.__DERP_APPLY_COMPOSITOR_BATCH?.([
      {
        type: 'interaction_state',
        pointer_x: 42,
        pointer_y: 64,
        move_window_id: 7,
        resize_window_id: 0,
        move_proxy_window_id: 0,
        move_capture_window_id: 0,
        move_rect: {
          x: 11,
          y: 12,
          width: 640,
          height: 480,
          maximized: false,
          fullscreen: false,
        },
        resize_rect: null,
        snapshot_epoch: 12,
      } satisfies DerpShellDetail,
    ])

    expect(runtimeOptions.setCompositorInteractionState).not.toHaveBeenCalled()
    expect(runtimeOptions.requestCompositorSync).not.toHaveBeenCalled()
    dispose()
  })

  it('does not synthesize interaction state from direct details when snapshot omits the interaction domain', async () => {
    const readSnapshot = vi
      .fn()
      .mockReturnValueOnce(emptySnapshot(10n))
      .mockReturnValueOnce(keyboardLayoutSnapshot(12n, 'ENGLISH', 2n))
    vi.stubGlobal('window', {
      __DERP_COMPOSITOR_SNAPSHOT_PATH: '/tmp/snapshot',
      __derpCompositorSnapshotRead: readSnapshot,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const runtimeOptions = options()
    const dispose = registerCompositorBridgeRuntime(runtimeOptions)

    await Promise.resolve()
    window.__DERP_APPLY_COMPOSITOR_BATCH?.([
      {
        type: 'interaction_state',
        pointer_x: 42,
        pointer_y: 64,
        move_window_id: 7,
        resize_window_id: 0,
        move_proxy_window_id: 0,
        move_capture_window_id: 0,
        move_rect: {
          x: 11,
          y: 12,
          width: 640,
          height: 480,
          maximized: false,
          fullscreen: false,
        },
        resize_rect: null,
        snapshot_epoch: 12,
      } satisfies DerpShellDetail,
      {
        type: 'keyboard_layout',
        label: 'ENGLISH',
        snapshot_epoch: 12,
      } satisfies DerpShellDetail,
    ])

    expect(runtimeOptions.setCompositorInteractionState).not.toHaveBeenCalled()
    dispose()
  })

  it('does not request compositor sync when a shell-hosted interaction ends', async () => {
    vi.stubGlobal('window', {
      __DERP_COMPOSITOR_SNAPSHOT_PATH: '/tmp/snapshot',
      __derpCompositorSnapshotRead: vi.fn(() => emptySnapshot(10n)),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const runtimeOptions = options({
      allWindowsMap: () =>
        new Map([
          [7, {
            window_id: 7,
            surface_id: 70,
            stack_z: 1,
            x: 10,
            y: 20,
            width: 640,
            height: 480,
            title: 'Settings',
            app_id: 'derp.settings',
            output_id: '',
            output_name: 'DP-4',
            kind: 'settings',
            x11_class: '',
            x11_instance: '',
            minimized: false,
            maximized: false,
            fullscreen: false,
            shell_flags: SHELL_WINDOW_FLAG_SHELL_HOSTED,
            capture_identifier: '',
            workspace_visible: true,
          }],
        ]),
    })
    const dispose = registerCompositorBridgeRuntime(runtimeOptions)

    await Promise.resolve()
    window.__DERP_APPLY_COMPOSITOR_BATCH?.([
      {
        type: 'interaction_state',
        revision: 12,
        pointer_x: 42,
        pointer_y: 64,
        move_window_id: 7,
        resize_window_id: 0,
        move_proxy_window_id: 0,
        move_capture_window_id: 0,
        move_rect: {
          x: 11,
          y: 12,
          width: 640,
          height: 480,
          maximized: false,
          fullscreen: false,
        },
        resize_rect: null,
      } satisfies DerpShellDetail,
      {
        type: 'interaction_state',
        revision: 13,
        pointer_x: 44,
        pointer_y: 66,
        move_window_id: 0,
        resize_window_id: 0,
        move_proxy_window_id: 0,
        move_capture_window_id: 0,
        move_rect: null,
        resize_rect: null,
      } satisfies DerpShellDetail,
    ])

    await Promise.resolve()
    expect(runtimeOptions.requestCompositorSync).not.toHaveBeenCalled()
    dispose()
  })

  it('forces a shell repaint after window unmap', async () => {
    const readSnapshot = vi.fn().mockReturnValueOnce(emptySnapshot(10n)).mockReturnValueOnce(emptyWindowListSnapshot(12n))
    vi.stubGlobal('window', {
      __DERP_COMPOSITOR_SNAPSHOT_PATH: '/tmp/snapshot',
      __derpCompositorSnapshotRead: readSnapshot,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const runtimeOptions = options()
    const dispose = registerCompositorBridgeRuntime(runtimeOptions)

    await Promise.resolve()
    window.__DERP_APPLY_COMPOSITOR_BATCH?.([
      { type: 'window_unmapped', window_id: 7, snapshot_epoch: 12 } satisfies DerpShellDetail,
    ])

    expect(runtimeOptions.bumpSnapChrome).toHaveBeenCalledTimes(1)
    expect(runtimeOptions.shellWireSend).toHaveBeenCalledWith('invalidate_view')
    dispose()
  })

  it('flushes shared shell state and repaints for compositor chrome-affecting batches', async () => {
    const readSnapshot = vi.fn().mockReturnValueOnce(emptySnapshot(10n)).mockReturnValueOnce(emptyWindowListSnapshot(12n))
    vi.stubGlobal('window', {
      __DERP_COMPOSITOR_SNAPSHOT_PATH: '/tmp/snapshot',
      __derpCompositorSnapshotRead: readSnapshot,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const runtimeOptions = options()
    const dispose = registerCompositorBridgeRuntime(runtimeOptions)

    await Promise.resolve()
    vi.mocked(runtimeOptions.scheduleCompositorFollowup).mockClear()
    vi.mocked(runtimeOptions.bumpSnapChrome).mockClear()
    vi.mocked(runtimeOptions.shellWireSend).mockClear()
    window.__DERP_APPLY_COMPOSITOR_BATCH?.([
      {
        type: 'window_geometry',
        window_id: 7,
        surface_id: 70,
        x: 11,
        y: 12,
        width: 640,
        height: 480,
        output_name: 'DP-1',
        maximized: false,
        fullscreen: false,
      } satisfies DerpShellDetail,
      {
        type: 'window_metadata',
        window_id: 7,
        surface_id: 70,
        title: 'Fresh Title',
        app_id: 'fresh.app',
      } satisfies DerpShellDetail,
      {
        type: 'focus_changed',
        surface_id: 70,
        window_id: 7,
      } satisfies DerpShellDetail,
    ])

    expect(runtimeOptions.scheduleCompositorFollowup).toHaveBeenCalledWith(
      expect.objectContaining({ flushWindows: true, syncExclusion: true }),
    )
    expect(runtimeOptions.bumpSnapChrome).toHaveBeenCalledTimes(1)
    expect(runtimeOptions.shellWireSend).toHaveBeenCalledWith('invalidate_view')
    dispose()
  })

  it('flushes shared shell state and repaints for compositor chrome-affecting snapshots', async () => {
    const readSnapshot = vi.fn().mockReturnValueOnce(emptySnapshot(10n)).mockReturnValueOnce(emptyWindowListSnapshot(12n))
    vi.stubGlobal('window', {
      __DERP_COMPOSITOR_SNAPSHOT_PATH: '/tmp/snapshot',
      __derpCompositorSnapshotRead: readSnapshot,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const runtimeOptions = options()
    const dispose = registerCompositorBridgeRuntime(runtimeOptions)

    await Promise.resolve()
    vi.mocked(runtimeOptions.scheduleCompositorFollowup).mockClear()
    vi.mocked(runtimeOptions.bumpSnapChrome).mockClear()
    vi.mocked(runtimeOptions.shellWireSend).mockClear()
    window.__DERP_SYNC_COMPOSITOR_SNAPSHOT?.()

    expect(runtimeOptions.scheduleCompositorFollowup).toHaveBeenCalledWith(
      expect.objectContaining({ flushWindows: true, syncExclusion: true }),
    )
    expect(runtimeOptions.bumpSnapChrome).toHaveBeenCalledTimes(1)
    expect(runtimeOptions.shellWireSend).toHaveBeenCalledWith('invalidate_view')
    dispose()
  })

  it('flushes shared shell state and repaints for authoritative window list snapshots', async () => {
    const windowListSnapshot = emptyWindowListSnapshot(12n)
    const readSnapshot = vi.fn().mockReturnValueOnce(emptySnapshot(10n)).mockReturnValueOnce(windowListSnapshot)
    vi.stubGlobal('window', {
      __DERP_COMPOSITOR_SNAPSHOT_PATH: '/tmp/snapshot',
      __derpCompositorSnapshotRead: readSnapshot,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const runtimeOptions = options()
    const dispose = registerCompositorBridgeRuntime(runtimeOptions)

    await Promise.resolve()
    vi.mocked(runtimeOptions.scheduleCompositorFollowup).mockClear()
    vi.mocked(runtimeOptions.bumpSnapChrome).mockClear()
    vi.mocked(runtimeOptions.shellWireSend).mockClear()
    window.__DERP_SYNC_COMPOSITOR_SNAPSHOT?.()

    expect(runtimeOptions.scheduleCompositorFollowup).toHaveBeenCalledWith(
      expect.objectContaining({ flushWindows: true, syncExclusion: true }),
    )
    expect(runtimeOptions.bumpSnapChrome).toHaveBeenCalledTimes(1)
    expect(runtimeOptions.shellWireSend).toHaveBeenCalledWith('invalidate_view')
    dispose()
  })

  it('clears model domains when an authoritative snapshot flags empty domains', async () => {
    const flags =
      SNAPSHOT_DOMAIN_WINDOWS |
      SNAPSHOT_DOMAIN_WINDOW_ORDER |
      SNAPSHOT_DOMAIN_FOCUS |
      SNAPSHOT_DOMAIN_WORKSPACE |
      SNAPSHOT_DOMAIN_SHELL_HOSTED_APPS |
      SNAPSHOT_DOMAIN_COMMAND_PALETTE
    const readSnapshot = vi.fn().mockReturnValueOnce(emptySnapshot(10n)).mockReturnValueOnce(snapshot(12n, flags))
    vi.stubGlobal('window', {
      __DERP_COMPOSITOR_SNAPSHOT_PATH: '/tmp/snapshot',
      __derpCompositorSnapshotRead: readSnapshot,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const runtimeOptions = options()
    const dispose = registerCompositorBridgeRuntime(runtimeOptions)

    await Promise.resolve()
    window.__DERP_SYNC_COMPOSITOR_SNAPSHOT?.()

    expect(runtimeOptions.clearModelAuthoritativeSnapshotDomains).toHaveBeenCalledWith({
      windows: true,
      windowOrder: true,
      focus: true,
      workspace: true,
      shellHostedApps: true,
      commandPalette: true,
    })
    dispose()
  })

  it('clears visual snapshot domains when flags are present without details', async () => {
    const flags =
      SNAPSHOT_DOMAIN_OUTPUTS |
      SNAPSHOT_DOMAIN_KEYBOARD |
      SNAPSHOT_DOMAIN_TRAY |
      SNAPSHOT_DOMAIN_INTERACTION |
      SNAPSHOT_DOMAIN_NATIVE_DRAG_PREVIEW
    const readSnapshot = vi.fn().mockReturnValueOnce(emptySnapshot(10n)).mockReturnValueOnce(snapshot(12n, flags))
    vi.stubGlobal('window', {
      __DERP_COMPOSITOR_SNAPSHOT_PATH: '/tmp/snapshot',
      __derpCompositorSnapshotRead: readSnapshot,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const runtimeOptions = options()
    const dispose = registerCompositorBridgeRuntime(runtimeOptions)

    await Promise.resolve()
    window.__DERP_SYNC_COMPOSITOR_SNAPSHOT?.()

    expect(runtimeOptions.setOutputTopology).toHaveBeenCalledWith(null)
    expect(runtimeOptions.setKeyboardLayoutLabel).toHaveBeenCalledWith(null)
    expect(runtimeOptions.setTrayReservedPx).toHaveBeenCalledWith(0)
    expect(runtimeOptions.setTrayIconSlotPx).toHaveBeenCalledWith(36)
    expect(runtimeOptions.setSniTrayItems).toHaveBeenCalledWith([])
    expect(runtimeOptions.setCompositorInteractionState).toHaveBeenCalledWith(null)
    expect(runtimeOptions.setNativeDragPreview).toHaveBeenCalledWith(null)
    dispose()
  })
})
