import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerCompositorBridgeRuntime } from './compositorBridgeRuntime'
import type { CompositorApplyResult } from './compositorModel'
import type { DerpShellDetail } from '@/host/appWindowState'

const DOMAIN_COUNT = 13
const SNAPSHOT_DOMAIN_KEYBOARD = 1 << 3

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
  const payload = [...domainRevisions(revisions), ...u32(0x4452444d), ...u32(0), ...packets]
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

function options(overrides: Partial<Parameters<typeof registerCompositorBridgeRuntime>[0]> = {}) {
  const applyModelCompositorDetail = vi.fn((detail: DerpShellDetail): CompositorApplyResult => ({
    kind: detail.type === 'window_geometry' ? 'window_geometry' : 'ignored',
    detailType: detail.type,
  }))
  return {
    setKeyboardLayoutLabel: vi.fn(),
    setVolumeOverlay: vi.fn(),
    setTrayVolumeState: vi.fn(),
    setTrayReservedPx: vi.fn(),
    setTrayIconSlotPx: vi.fn(),
    setSniTrayItems: vi.fn(),
    setOutputTopology: vi.fn(),
    setCompositorSnapshotSequence: vi.fn(),
    setCompositorInteractionState: vi.fn(),
    setNativeDragPreview: vi.fn(),
    getNativeDragPreview: () => null,
    markHasSeenCompositorWindowSync: vi.fn(),
    clearWindowSyncRecoveryPending: vi.fn(),
    scheduleExclusionZonesSync: vi.fn(),
    scheduleCompositorFollowup: vi.fn(),
    applyModelCompositorSnapshot: vi.fn(),
    applyModelCompositorDetails: vi.fn((details: readonly DerpShellDetail[]) =>
      details.map((detail) => applyModelCompositorDetail(detail)),
    ),
    applyModelCompositorDetail,
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
  vi.unstubAllGlobals()
})

describe('registerCompositorBridgeRuntime', () => {
  it('drops stale hot window details after a newer snapshot epoch', async () => {
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
        snapshot_epoch: 8,
      } satisfies DerpShellDetail,
    ])

    expect(runtimeOptions.applyModelCompositorDetail).not.toHaveBeenCalled()
    dispose()
  })

  it('keeps newer hot window details live while snapshot catchup is pending', async () => {
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

    expect(runtimeOptions.applyModelCompositorDetail).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('applies newer interaction state details immediately while snapshot catchup is pending', async () => {
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

    expect(runtimeOptions.setCompositorInteractionState).toHaveBeenCalledWith({
      pointer_x: 42,
      pointer_y: 64,
      move_window_id: 7,
      resize_window_id: null,
      move_proxy_window_id: null,
      move_capture_window_id: null,
      move_rect: {
        x: 11,
        y: 12,
        width: 640,
        height: 480,
        maximized: false,
        fullscreen: false,
      },
      resize_rect: null,
    })
    expect(runtimeOptions.requestCompositorSync).not.toHaveBeenCalled()
    dispose()
  })

  it('keeps interaction state when a partial snapshot omits the interaction domain', async () => {
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

    expect(runtimeOptions.setCompositorInteractionState).toHaveBeenNthCalledWith(1, {
      pointer_x: 42,
      pointer_y: 64,
      move_window_id: 7,
      resize_window_id: null,
      move_proxy_window_id: null,
      move_capture_window_id: null,
      move_rect: {
        x: 11,
        y: 12,
        width: 640,
        height: 480,
        maximized: false,
        fullscreen: false,
      },
      resize_rect: null,
    })
    expect(runtimeOptions.setCompositorInteractionState).not.toHaveBeenCalledWith(null)
    dispose()
  })
})
