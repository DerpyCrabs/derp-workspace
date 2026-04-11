import { getShellJson, postShellJson } from '../shellBridge'

export type ShellAudioDevice = {
  id: number
  label: string
  subtitle: string
  name: string
  volume_percent: number
  volume_known: boolean
  muted: boolean
  is_default: boolean
}

export type ShellAudioStream = {
  id: number
  label: string
  subtitle: string
  name: string
  app_name: string
  volume_percent: number
  volume_known: boolean
  muted: boolean
}

export type ShellAudioState = {
  backend: 'pipewire'
  sinks: ShellAudioDevice[]
  sources: ShellAudioDevice[]
  playback_streams: ShellAudioStream[]
  capture_streams: ShellAudioStream[]
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

function asAudioDevice(value: unknown): ShellAudioDevice | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const id = asInteger(row.id)
  if (id < 1) return null
  return {
    id,
    label: asString(row.label) || asString(row.name) || `Device ${id}`,
    subtitle: asString(row.subtitle),
    name: asString(row.name),
    volume_percent: Math.max(0, asInteger(row.volume_percent)),
    volume_known: row.volume_known === true,
    muted: row.muted === true,
    is_default: row.is_default === true,
  }
}

function asAudioStream(value: unknown): ShellAudioStream | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const id = asInteger(row.id)
  if (id < 1) return null
  return {
    id,
    label: asString(row.label) || asString(row.app_name) || asString(row.name) || `Stream ${id}`,
    subtitle: asString(row.subtitle),
    name: asString(row.name),
    app_name: asString(row.app_name),
    volume_percent: Math.max(0, asInteger(row.volume_percent)),
    volume_known: row.volume_known === true,
    muted: row.muted === true,
  }
}

function asAudioDeviceList(value: unknown): ShellAudioDevice[] {
  if (!Array.isArray(value)) return []
  return value.map(asAudioDevice).filter((row): row is ShellAudioDevice => row !== null)
}

function asAudioStreamList(value: unknown): ShellAudioStream[] {
  if (!Array.isArray(value)) return []
  return value.map(asAudioStream).filter((row): row is ShellAudioStream => row !== null)
}

export function sanitizeShellAudioState(value: unknown): ShellAudioState {
  if (!value || typeof value !== 'object') {
    return {
      backend: 'pipewire',
      sinks: [],
      sources: [],
      playback_streams: [],
      capture_streams: [],
    }
  }
  const row = value as Record<string, unknown>
  return {
    backend: 'pipewire',
    sinks: asAudioDeviceList(row.sinks),
    sources: asAudioDeviceList(row.sources),
    playback_streams: asAudioStreamList(row.playback_streams),
    capture_streams: asAudioStreamList(row.capture_streams),
  }
}

export async function loadShellAudioState(base: string | null): Promise<ShellAudioState> {
  return sanitizeShellAudioState(await getShellJson('/audio_state', base))
}

export async function setShellAudioDefault(id: number, base: string | null): Promise<void> {
  await postShellJson('/audio_default', { id }, base)
}

export async function setShellAudioVolume(
  id: number,
  volume_percent: number,
  base: string | null,
): Promise<void> {
  await postShellJson(
    '/audio_volume',
    {
      id,
      volume_percent: Math.max(0, Math.min(200, Math.round(volume_percent))),
    },
    base,
  )
}

export async function setShellAudioMute(
  id: number,
  muted: boolean,
  base: string | null,
): Promise<void> {
  await postShellJson('/audio_mute', { id, muted }, base)
}
