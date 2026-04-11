import { getShellJson, postShellJson } from '../shellBridge'

export type ShellKeyboardLayoutEntry = {
  layout: string
  variant: string
}

export type ShellKeyboardSettings = {
  layouts: ShellKeyboardLayoutEntry[]
  repeat_rate: number
  repeat_delay_ms: number
}

export const DEFAULT_SHELL_KEYBOARD_SETTINGS: ShellKeyboardSettings = {
  layouts: [],
  repeat_rate: 25,
  repeat_delay_ms: 200,
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function sanitizeLayoutEntry(value: unknown): ShellKeyboardLayoutEntry | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const layout = asString(row.layout).trim()
  const variant = asString(row.variant).trim()
  if (!layout) return null
  return { layout, variant }
}

function sanitizeLayoutEntries(value: unknown): ShellKeyboardLayoutEntry[] {
  if (!Array.isArray(value)) return []
  return value.map(sanitizeLayoutEntry).filter((entry): entry is ShellKeyboardLayoutEntry => entry !== null)
}

function sanitizeRepeatRate(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.max(1, Math.min(60, value))
    : DEFAULT_SHELL_KEYBOARD_SETTINGS.repeat_rate
}

function sanitizeRepeatDelay(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.max(100, Math.min(1000, value))
    : DEFAULT_SHELL_KEYBOARD_SETTINGS.repeat_delay_ms
}

export function sanitizeShellKeyboardSettings(value: unknown): ShellKeyboardSettings {
  if (!value || typeof value !== 'object') {
    return DEFAULT_SHELL_KEYBOARD_SETTINGS
  }
  const row = value as Record<string, unknown>
  return {
    layouts: sanitizeLayoutEntries(row.layouts),
    repeat_rate: sanitizeRepeatRate(row.repeat_rate),
    repeat_delay_ms: sanitizeRepeatDelay(row.repeat_delay_ms),
  }
}

export async function loadShellKeyboardSettings(base: string | null): Promise<ShellKeyboardSettings> {
  return sanitizeShellKeyboardSettings(await getShellJson('/settings_keyboard', base))
}

export async function saveShellKeyboardSettings(
  settings: ShellKeyboardSettings,
  base: string | null,
): Promise<void> {
  await postShellJson('/settings_keyboard', settings, base)
}

export function parseKeyboardLayoutCsv(value: string): ShellKeyboardLayoutEntry[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((layout) => ({ layout, variant: '' }))
}

export function keyboardLayoutEntriesToCsv(layouts: ShellKeyboardLayoutEntry[]): string {
  return layouts.map((entry) => entry.layout).join(', ')
}

export function keyboardVariantEntriesToCsv(layouts: ShellKeyboardLayoutEntry[]): string {
  return layouts.map((entry) => entry.variant).join(', ')
}

export function mergeKeyboardLayoutAndVariantCsv(layoutCsv: string, variantCsv: string): ShellKeyboardLayoutEntry[] {
  const layouts = layoutCsv
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const variants = variantCsv.split(',').map((entry) => entry.trim())
  return layouts.map((layout, idx) => ({
    layout,
    variant: variants[idx] || '',
  }))
}
