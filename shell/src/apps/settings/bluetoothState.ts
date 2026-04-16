import { getShellJson, postShellJson } from '@/features/bridge/shellBridge'

export type ShellBluetoothController = {
  address: string
  name: string
  alias: string
  powered: boolean
  pairable: boolean
  discoverable: boolean
  discovering: boolean
}

export type ShellBluetoothDevice = {
  address: string
  name: string
  paired: boolean
  bonded: boolean
  trusted: boolean
  connected: boolean
}

export type ShellBluetoothState = {
  backend: 'bluez'
  soft_blocked: boolean
  hard_blocked: boolean
  controller: ShellBluetoothController | null
  devices: ShellBluetoothDevice[]
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asBluetoothController(value: unknown): ShellBluetoothController | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const address = asString(row.address).trim()
  if (!address) return null
  const name = asString(row.name).trim()
  const alias = asString(row.alias).trim()
  return {
    address,
    name: name || alias || address,
    alias: alias || name || address,
    powered: row.powered === true,
    pairable: row.pairable === true,
    discoverable: row.discoverable === true,
    discovering: row.discovering === true,
  }
}

function asBluetoothDevice(value: unknown): ShellBluetoothDevice | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const address = asString(row.address).trim()
  if (!address) return null
  const name = asString(row.name).trim()
  return {
    address,
    name: name || address,
    paired: row.paired === true,
    bonded: row.bonded === true,
    trusted: row.trusted === true,
    connected: row.connected === true,
  }
}

function asBluetoothDeviceList(value: unknown): ShellBluetoothDevice[] {
  if (!Array.isArray(value)) return []
  return value.map(asBluetoothDevice).filter((row): row is ShellBluetoothDevice => row !== null)
}

export function sanitizeShellBluetoothState(value: unknown): ShellBluetoothState {
  if (!value || typeof value !== 'object') {
    return {
      backend: 'bluez',
      soft_blocked: false,
      hard_blocked: false,
      controller: null,
      devices: [],
    }
  }
  const row = value as Record<string, unknown>
  return {
    backend: 'bluez',
    soft_blocked: row.soft_blocked === true,
    hard_blocked: row.hard_blocked === true,
    controller: asBluetoothController(row.controller),
    devices: asBluetoothDeviceList(row.devices),
  }
}

export async function loadShellBluetoothState(base: string | null): Promise<ShellBluetoothState> {
  return sanitizeShellBluetoothState(await getShellJson('/bluetooth_state', base))
}

export async function scanShellBluetooth(base: string | null): Promise<void> {
  await postShellJson('/bluetooth_scan', {}, base)
}

export async function setShellBluetoothRadio(
  enabled: boolean,
  base: string | null,
): Promise<void> {
  await postShellJson('/bluetooth_radio', { enabled }, base)
}

export async function setShellBluetoothPairable(
  enabled: boolean,
  base: string | null,
): Promise<void> {
  await postShellJson('/bluetooth_pairable', { enabled }, base)
}

export async function setShellBluetoothDiscoverable(
  enabled: boolean,
  base: string | null,
): Promise<void> {
  await postShellJson('/bluetooth_discoverable', { enabled }, base)
}

export async function pairAndConnectShellBluetoothDevice(
  address: string,
  base: string | null,
): Promise<void> {
  await postShellJson('/bluetooth_pair_connect', { address }, base)
}

export async function setShellBluetoothTrust(
  address: string,
  trusted: boolean,
  base: string | null,
): Promise<void> {
  await postShellJson('/bluetooth_trust', { address, trusted }, base)
}

export async function connectShellBluetoothDevice(
  address: string,
  base: string | null,
): Promise<void> {
  await postShellJson('/bluetooth_connect', { address }, base)
}

export async function disconnectShellBluetoothDevice(
  address: string,
  base: string | null,
): Promise<void> {
  await postShellJson('/bluetooth_disconnect', { address }, base)
}

export async function forgetShellBluetoothDevice(
  address: string,
  base: string | null,
): Promise<void> {
  await postShellJson('/bluetooth_forget', { address }, base)
}
