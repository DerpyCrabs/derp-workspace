import { createLayout, type LayoutParams, type LayoutType, type TilingLayout } from './layouts'

export type MonitorTilingEntry = {
  layout: LayoutType
  params?: LayoutParams
}

export type TilingConfig = {
  monitors: Record<string, MonitorTilingEntry>
}

const STORAGE_KEY = 'derp-tiling-config'

function defaultConfig(): TilingConfig {
  return { monitors: {} }
}

function isLayoutType(v: unknown): v is LayoutType {
  return (
    v === 'manual-snap' ||
    v === 'master-stack' ||
    v === 'columns' ||
    v === 'grid'
  )
}

function parseConfig(raw: string | null): TilingConfig {
  if (!raw) return defaultConfig()
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object') return defaultConfig()
    const monitors = (v as { monitors?: unknown }).monitors
    if (!monitors || typeof monitors !== 'object' || Array.isArray(monitors)) {
      return defaultConfig()
    }
    const out: TilingConfig = { monitors: {} }
    for (const [k, entry] of Object.entries(monitors as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const el = entry as { layout?: unknown; params?: unknown }
      if (!isLayoutType(el.layout)) continue
      const cleaned: MonitorTilingEntry = { layout: el.layout }
      if (el.params && typeof el.params === 'object' && !Array.isArray(el.params)) {
        const p = el.params as Record<string, unknown>
        const lp: LayoutParams = {}
        if (typeof p.masterRatio === 'number' && Number.isFinite(p.masterRatio)) {
          lp.masterRatio = p.masterRatio
        }
        if (typeof p.maxColumns === 'number' && Number.isFinite(p.maxColumns)) {
          lp.maxColumns = Math.max(1, Math.floor(p.maxColumns))
        }
        if (Object.keys(lp).length > 0) cleaned.params = lp
      }
      out.monitors[k] = cleaned
    }
    return out
  } catch {
    return defaultConfig()
  }
}

export function loadTilingConfig(): TilingConfig {
  if (typeof localStorage === 'undefined') return defaultConfig()
  return parseConfig(localStorage.getItem(STORAGE_KEY))
}

export function saveTilingConfig(cfg: TilingConfig): void {
  if (typeof localStorage === 'undefined') return
  const json = JSON.stringify(cfg)
  if (localStorage.getItem(STORAGE_KEY) === json) return
  localStorage.setItem(STORAGE_KEY, json)
}

export function getMonitorLayout(outputName: string): {
  layout: TilingLayout
  params: LayoutParams
} {
  const cfg = loadTilingConfig()
  const entry = cfg.monitors[outputName]
  const layoutType: LayoutType = entry?.layout ?? 'manual-snap'
  const params: LayoutParams = entry?.params ?? {}
  return { layout: createLayout(layoutType), params }
}

export function setMonitorLayout(
  outputName: string,
  layoutType: LayoutType,
  params?: LayoutParams,
): void {
  const cfg = loadTilingConfig()
  const prev = cfg.monitors[outputName]
  const nextParams = params !== undefined ? params : (prev?.params ?? {})
  const next: MonitorTilingEntry = { layout: layoutType }
  if (Object.keys(nextParams).length > 0) {
    next.params = nextParams
  }
  cfg.monitors[outputName] = next
  saveTilingConfig(cfg)
}
