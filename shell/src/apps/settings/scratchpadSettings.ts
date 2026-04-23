import { getShellJson, postShellJson } from '@/features/bridge/shellBridge'

export type ScratchpadRuleField = 'app_id' | 'title' | 'x11_class' | 'x11_instance' | 'kind'
export type ScratchpadRuleOp = 'equals' | 'contains' | 'starts_with'

export type ScratchpadRule = {
  field: ScratchpadRuleField
  op: ScratchpadRuleOp
  value: string
}

export type ScratchpadPlacement = {
  monitor: string
  width_percent: number
  height_percent: number
}

export type ScratchpadItem = {
  id: string
  name: string
  hotkey: string
  default_visible: boolean
  placement: ScratchpadPlacement
  rules: ScratchpadRule[]
}

export type ScratchpadSettings = {
  items: ScratchpadItem[]
}

const FALLBACK: ScratchpadSettings = { items: [] }

const FIELDS: ScratchpadRuleField[] = ['app_id', 'title', 'x11_class', 'x11_instance', 'kind']
const OPS: ScratchpadRuleOp[] = ['equals', 'contains', 'starts_with']

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function intValue(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.trunc(value)))
    : fallback
}

function sanitizeRule(value: unknown): ScratchpadRule | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const field = stringValue(row.field) as ScratchpadRuleField
  const op = stringValue(row.op) as ScratchpadRuleOp
  const rule = {
    field: FIELDS.includes(field) ? field : 'app_id',
    op: OPS.includes(op) ? op : 'equals',
    value: stringValue(row.value).trim(),
  }
  return rule.value ? rule : null
}

function sanitizeItem(value: unknown): ScratchpadItem | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const placement = row.placement && typeof row.placement === 'object' ? row.placement as Record<string, unknown> : {}
  const id = stringValue(row.id).trim()
  const rules = Array.isArray(row.rules)
    ? row.rules.map(sanitizeRule).filter((rule): rule is ScratchpadRule => rule !== null)
    : []
  if (!id || rules.length === 0) return null
  return {
    id,
    name: stringValue(row.name).trim() || 'Scratchpad',
    hotkey: stringValue(row.hotkey).trim(),
    default_visible: !!row.default_visible,
    placement: {
      monitor: stringValue(placement.monitor).trim() || 'focused',
      width_percent: intValue(placement.width_percent, 80, 20, 100),
      height_percent: intValue(placement.height_percent, 70, 20, 100),
    },
    rules,
  }
}

export function sanitizeScratchpadSettings(value: unknown): ScratchpadSettings {
  if (!value || typeof value !== 'object') return FALLBACK
  const row = value as Record<string, unknown>
  return {
    items: Array.isArray(row.items)
      ? row.items.map(sanitizeItem).filter((item): item is ScratchpadItem => item !== null)
      : [],
  }
}

export async function loadScratchpadSettings(base: string | null): Promise<ScratchpadSettings> {
  return sanitizeScratchpadSettings(await getShellJson('/settings_scratchpads', base))
}

export async function saveScratchpadSettings(settings: ScratchpadSettings, base: string | null): Promise<void> {
  await postShellJson('/settings_scratchpads', settings, base)
}

export function createDefaultScratchpad(seq: number): ScratchpadItem {
  return {
    id: `scratchpad-${seq}`,
    name: `Scratchpad ${seq}`,
    hotkey: 'Super+grave',
    default_visible: false,
    placement: {
      monitor: 'focused',
      width_percent: 80,
      height_percent: 70,
    },
    rules: [{ field: 'app_id', op: 'equals', value: '' }],
  }
}
