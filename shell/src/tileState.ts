import type { Rect, SnapZone } from './tileZones'
import { snapZoneToBoundsWithOccupied } from './tileZones'

export type TiledWindowEntry = { zone: SnapZone; bounds: Rect }

export class MonitorTileState {
  tiledWindows = new Map<number, TiledWindowEntry>()

  getOccupiedZones(excludeWindowId?: number): { zone: SnapZone; bounds: Rect }[] {
    const out: { zone: SnapZone; bounds: Rect }[] = []
    for (const [wid, e] of this.tiledWindows) {
      if (excludeWindowId !== undefined && wid === excludeWindowId) continue
      out.push({ zone: e.zone, bounds: e.bounds })
    }
    return out
  }

  tileWindow(windowId: number, zone: SnapZone, workArea: Rect, otherOccupied: { zone: SnapZone; bounds: Rect }[]): Rect {
    const bounds = snapZoneToBoundsWithOccupied(zone, workArea, otherOccupied)
    this.tiledWindows.set(windowId, { zone, bounds })
    return bounds
  }

  untileWindow(windowId: number): void {
    this.tiledWindows.delete(windowId)
  }

  has(windowId: number): boolean {
    return this.tiledWindows.has(windowId)
  }

  getZone(windowId: number): SnapZone | undefined {
    return this.tiledWindows.get(windowId)?.zone
  }
}

export class PerMonitorTileStates {
  private monitors = new Map<string, MonitorTileState>()
  preTileGeometry = new Map<number, { x: number; y: number; w: number; h: number }>()

  stateFor(outputName: string): MonitorTileState {
    let s = this.monitors.get(outputName)
    if (!s) {
      s = new MonitorTileState()
      this.monitors.set(outputName, s)
    }
    return s
  }

  isTiled(windowId: number): boolean {
    for (const st of this.monitors.values()) {
      if (st.has(windowId)) return true
    }
    return false
  }

  findMonitorForTiledWindow(windowId: number): string | null {
    for (const [name, st] of this.monitors) {
      if (st.has(windowId)) return name
    }
    return null
  }

  untileWindowEverywhere(windowId: number): void {
    for (const st of this.monitors.values()) {
      st.untileWindow(windowId)
    }
  }

  getTiledZone(windowId: number): SnapZone | undefined {
    for (const st of this.monitors.values()) {
      const z = st.getZone(windowId)
      if (z !== undefined) return z
    }
    return undefined
  }

  moveTiledWindowToMonitor(
    windowId: number,
    fromOutput: string,
    toOutput: string,
    zone: SnapZone,
    workArea: Rect,
    otherOccupiedOnDestination: { zone: SnapZone; bounds: Rect }[],
  ): Rect {
    this.stateFor(fromOutput).untileWindow(windowId)
    return this.stateFor(toOutput).tileWindow(windowId, zone, workArea, otherOccupiedOnDestination)
  }
}
