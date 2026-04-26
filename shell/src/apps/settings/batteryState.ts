import { getShellJson } from '@/features/bridge/shellBridge'

export type ShellBatteryState = {
  backend: 'upower'
  is_present: boolean
  percentage: number
  state: string
  time_to_empty_seconds: number
  time_to_full_seconds: number
  icon_name: string
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asInteger(value: unknown): number {
  const next = Math.round(asNumber(value))
  return Number.isSafeInteger(next) ? next : 0
}

export function sanitizeShellBatteryState(value: unknown): ShellBatteryState {
  if (!value || typeof value !== 'object') {
    return {
      backend: 'upower',
      is_present: false,
      percentage: 0,
      state: 'unknown',
      time_to_empty_seconds: 0,
      time_to_full_seconds: 0,
      icon_name: '',
    }
  }
  const row = value as Record<string, unknown>
  return {
    backend: 'upower',
    is_present: row.is_present === true,
    percentage: Math.max(0, Math.min(100, asInteger(row.percentage))),
    state: asString(row.state) || 'unknown',
    time_to_empty_seconds: Math.max(0, asInteger(row.time_to_empty_seconds)),
    time_to_full_seconds: Math.max(0, asInteger(row.time_to_full_seconds)),
    icon_name: asString(row.icon_name),
  }
}

export async function loadShellBatteryState(base: string | null): Promise<ShellBatteryState> {
  return sanitizeShellBatteryState(await getShellJson('/battery_state', base))
}
