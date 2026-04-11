import { getShellJson, postShellJson } from '../shellBridge'

export type ShellWifiDevice = {
  device: string
  state: string
  connection: string
}

export type ShellWifiAccessPoint = {
  ssid: string
  signal_percent: number
  security: string
  bars: string
  in_use: boolean
  is_saved: boolean
  requires_password: boolean
}

export type ShellWifiState = {
  backend: 'networkmanager'
  wifi_enabled: boolean
  devices: ShellWifiDevice[]
  access_points: ShellWifiAccessPoint[]
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

function asWifiDevice(value: unknown): ShellWifiDevice | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const device = asString(row.device).trim()
  if (!device) return null
  return {
    device,
    state: asString(row.state),
    connection: asString(row.connection),
  }
}

function asWifiAccessPoint(value: unknown): ShellWifiAccessPoint | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const ssid = asString(row.ssid).trim()
  if (!ssid) return null
  return {
    ssid,
    signal_percent: Math.max(0, Math.min(100, asInteger(row.signal_percent))),
    security: asString(row.security),
    bars: asString(row.bars),
    in_use: row.in_use === true,
    is_saved: row.is_saved === true,
    requires_password: row.requires_password === true,
  }
}

function asWifiDeviceList(value: unknown): ShellWifiDevice[] {
  if (!Array.isArray(value)) return []
  return value.map(asWifiDevice).filter((row): row is ShellWifiDevice => row !== null)
}

function asWifiAccessPointList(value: unknown): ShellWifiAccessPoint[] {
  if (!Array.isArray(value)) return []
  return value.map(asWifiAccessPoint).filter((row): row is ShellWifiAccessPoint => row !== null)
}

export function sanitizeShellWifiState(value: unknown): ShellWifiState {
  if (!value || typeof value !== 'object') {
    return {
      backend: 'networkmanager',
      wifi_enabled: false,
      devices: [],
      access_points: [],
    }
  }
  const row = value as Record<string, unknown>
  return {
    backend: 'networkmanager',
    wifi_enabled: row.wifi_enabled === true,
    devices: asWifiDeviceList(row.devices),
    access_points: asWifiAccessPointList(row.access_points),
  }
}

export async function loadShellWifiState(base: string | null): Promise<ShellWifiState> {
  return sanitizeShellWifiState(await getShellJson('/wifi_state', base))
}

export async function scanShellWifi(base: string | null): Promise<void> {
  await postShellJson('/wifi_scan', {}, base)
}

export async function setShellWifiRadio(enabled: boolean, base: string | null): Promise<void> {
  await postShellJson('/wifi_radio', { enabled }, base)
}

export async function connectShellWifi(
  ssid: string,
  password: string | undefined,
  base: string | null,
): Promise<void> {
  await postShellJson('/wifi_connect', { ssid, password: password ?? null }, base)
}

export async function disconnectShellWifi(
  device: string | undefined,
  base: string | null,
): Promise<void> {
  await postShellJson('/wifi_disconnect', { device: device ?? null }, base)
}
