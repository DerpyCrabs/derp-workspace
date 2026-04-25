import {
  DEFAULT_ASSIST_GRID_SHAPE,
  type AssistGridShape,
} from './assistGrid'
import {
  listCustomLayoutZones,
  sanitizeCustomLayouts,
  type CustomLayout,
  type CustomLayoutSlotRule,
} from './customLayouts'
import { createLayout, type CustomAutoSlotParam, type LayoutParams, type LayoutType, type TilingLayout } from './layouts'

const CUSTOM_SNAP_LAYOUT_PREFIX = 'custom:'

export type MonitorSnapLayout =
  | { kind: 'assist'; shape: AssistGridShape }
  | { kind: 'custom'; layoutId: string }

export type MonitorTilingEntry = {
  layout: LayoutType
  params?: LayoutParams
  snapLayout?: string
  customLayouts?: CustomLayout[]
}

export type TilingConfig = {
  monitors: Record<string, MonitorTilingEntry>
}

const STORAGE_KEY = 'derp-tiling-config'

function defaultConfig(): TilingConfig {
  return { monitors: {} }
}

function isAssistGridShape(v: unknown): v is AssistGridShape {
  return v === '2x2' || v === '3x2' || v === '2x3' || v === '3x3'
}

function isLayoutType(v: unknown): v is LayoutType {
  return (
    v === 'manual-snap' ||
    v === 'master-stack' ||
    v === 'columns' ||
    v === 'grid' ||
    v === 'custom-auto'
  )
}

function sanitizeCustomAutoSlots(value: unknown): CustomAutoSlotParam[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: CustomAutoSlotParam[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    const slotId = typeof row.slotId === 'string' ? row.slotId.trim() : ''
    if (!slotId || seen.has(slotId)) continue
    const x = typeof row.x === 'number' ? row.x : Number(row.x)
    const y = typeof row.y === 'number' ? row.y : Number(row.y)
    const width = typeof row.width === 'number' ? row.width : Number(row.width)
    const height = typeof row.height === 'number' ? row.height : Number(row.height)
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue
    const rules = Array.isArray(row.rules)
      ? row.rules
          .filter((rule): rule is CustomLayoutSlotRule =>
            !!rule &&
            typeof rule === 'object' &&
            !Array.isArray(rule) &&
            typeof (rule as Record<string, unknown>).value === 'string',
          )
          .slice(0, 16)
      : undefined
    seen.add(slotId)
    out.push({
      slotId,
      x,
      y,
      width,
      height,
      ...(rules && rules.length > 0 ? { rules } : {}),
    })
  }
  return out.length > 0 ? out : undefined
}

export function assistMonitorSnapLayout(shape: AssistGridShape): MonitorSnapLayout {
  return { kind: 'assist', shape }
}

export function customMonitorSnapLayout(layoutId: string): MonitorSnapLayout {
  return { kind: 'custom', layoutId }
}

export function monitorSnapLayoutEquals(a: MonitorSnapLayout, b: MonitorSnapLayout): boolean {
  if (a.kind === 'assist' && b.kind === 'assist') {
    return a.shape === b.shape
  }
  if (a.kind === 'custom' && b.kind === 'custom') {
    return a.layoutId === b.layoutId
  }
  return false
}

export function monitorSnapLayoutStorageKey(layout: MonitorSnapLayout): string {
  if (layout.kind === 'assist') {
    return layout.shape
  }
  return `${CUSTOM_SNAP_LAYOUT_PREFIX}${layout.layoutId}`
}

function parseMonitorSnapLayout(
  value: unknown,
  customLayouts: readonly CustomLayout[],
): MonitorSnapLayout | null {
  if (isAssistGridShape(value)) {
    return assistMonitorSnapLayout(value)
  }
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (isAssistGridShape(raw)) {
    return assistMonitorSnapLayout(raw)
  }
  if (!raw.startsWith(CUSTOM_SNAP_LAYOUT_PREFIX)) return null
  const layoutId = raw.slice(CUSTOM_SNAP_LAYOUT_PREFIX.length).trim()
  if (!layoutId || !customLayouts.some((layout) => layout.id === layoutId)) return null
  return customMonitorSnapLayout(layoutId)
}

function sanitizeStoredSnapLayout(
  value: unknown,
  customLayouts: readonly CustomLayout[],
): string | undefined {
  const parsed = parseMonitorSnapLayout(value, customLayouts)
  return parsed ? monitorSnapLayoutStorageKey(parsed) : undefined
}

function resolveMonitorSnapLayout(
  snapLayout: unknown,
  customLayouts: readonly CustomLayout[],
): MonitorSnapLayout {
  return parseMonitorSnapLayout(snapLayout, customLayouts) ?? assistMonitorSnapLayout(DEFAULT_ASSIST_GRID_SHAPE)
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
        if (typeof p.customLayoutId === 'string' && p.customLayoutId.trim()) {
          lp.customLayoutId = p.customLayoutId.trim()
        }
        const customSlots = sanitizeCustomAutoSlots(p.customSlots)
        if (customSlots) lp.customSlots = customSlots
        if (Object.keys(lp).length > 0) cleaned.params = lp
      }
      const customLayouts = sanitizeCustomLayouts((el as { customLayouts?: unknown }).customLayouts)
      if (customLayouts.length > 0) {
        cleaned.customLayouts = customLayouts
      }
      const snapLayout = sanitizeStoredSnapLayout(
        (el as { snapLayout?: unknown }).snapLayout,
        customLayouts,
      )
      if (snapLayout) {
        cleaned.snapLayout = snapLayout
      }
      out.monitors[k] = cleaned
    }
    return out
  } catch {
    return defaultConfig()
  }
}

export function customAutoLayoutParamsForMonitor(outputName: string): LayoutParams {
  const monitor = getMonitorLayout(outputName)
  const snapLayout = monitor.snapLayout
  const selectedLayout =
    snapLayout.kind === 'custom'
      ? monitor.customLayouts.find((layout) => layout.id === snapLayout.layoutId)
      : monitor.customLayouts[0]
  if (!selectedLayout) return {}
  const customSlots = listCustomLayoutZones(selectedLayout).map((zone) => ({
    slotId: zone.zoneId,
    x: zone.x,
    y: zone.y,
    width: zone.width,
    height: zone.height,
    ...(selectedLayout.slotRules?.[zone.zoneId]?.length
      ? { rules: selectedLayout.slotRules[zone.zoneId] }
      : {}),
  }))
  return {
    customLayoutId: selectedLayout.id,
    customSlots,
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

export function resetTilingConfig(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(STORAGE_KEY)
}

export function getMonitorLayout(outputName: string): {
  layout: TilingLayout
  params: LayoutParams
  snapLayout: MonitorSnapLayout
  customLayouts: CustomLayout[]
} {
  const cfg = loadTilingConfig()
  const entry = cfg.monitors[outputName]
  const layoutType: LayoutType = entry?.layout ?? 'manual-snap'
  const params: LayoutParams = entry?.params ?? {}
  const customLayouts = entry?.customLayouts ?? []
  return {
    layout: createLayout(layoutType),
    params,
    snapLayout: resolveMonitorSnapLayout(entry?.snapLayout, customLayouts),
    customLayouts,
  }
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
  const customLayouts = prev?.customLayouts ?? []
  const snapLayout = sanitizeStoredSnapLayout(prev?.snapLayout, customLayouts)
  if (snapLayout) {
    next.snapLayout = snapLayout
  }
  if (customLayouts.length > 0) {
    next.customLayouts = customLayouts
  }
  cfg.monitors[outputName] = next
  saveTilingConfig(cfg)
}

export function setMonitorSnapLayout(outputName: string, snapLayout: MonitorSnapLayout): void {
  const cfg = loadTilingConfig()
  const prev = cfg.monitors[outputName]
  const customLayouts = prev?.customLayouts ?? []
  const next: MonitorTilingEntry = {
    layout: prev?.layout ?? 'manual-snap',
    snapLayout: monitorSnapLayoutStorageKey(
      parseMonitorSnapLayout(monitorSnapLayoutStorageKey(snapLayout), customLayouts) ?? assistMonitorSnapLayout(DEFAULT_ASSIST_GRID_SHAPE),
    ),
  }
  if (prev?.params && Object.keys(prev.params).length > 0) {
    next.params = prev.params
  }
  if (customLayouts.length > 0) {
    next.customLayouts = customLayouts
  }
  cfg.monitors[outputName] = next
  saveTilingConfig(cfg)
}

export function setMonitorCustomLayouts(outputName: string, customLayouts: CustomLayout[]): void {
  const cfg = loadTilingConfig()
  const prev = cfg.monitors[outputName]
  const nextSnapLayout = sanitizeStoredSnapLayout(prev?.snapLayout, customLayouts)
  const next: MonitorTilingEntry = {
    layout: prev?.layout ?? 'manual-snap',
  }
  if (prev?.params && Object.keys(prev.params).length > 0) {
    next.params = prev.params
  }
  if (nextSnapLayout) {
    next.snapLayout = nextSnapLayout
  }
  if (customLayouts.length > 0) {
    next.customLayouts = customLayouts
  }
  cfg.monitors[outputName] = next
  saveTilingConfig(cfg)
}
