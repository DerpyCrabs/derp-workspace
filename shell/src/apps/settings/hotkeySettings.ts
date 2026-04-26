import { getShellJson, postShellJson, type DesktopAppEntry } from '@/features/bridge/shellBridge'

export type HotkeyAction = 'builtin' | 'launch' | 'scratchpad'

export type HotkeyBinding = {
  id: string
  enabled: boolean
  chord: string
  action: HotkeyAction
  builtin: string
  command: string
  desktop_id: string
  app_name: string
  scratchpad_id: string
}

export type HotkeySettings = {
  bindings: HotkeyBinding[]
}

export const BUILTIN_HOTKEY_ACTIONS = [
  { value: 'cycle_keyboard_layout', label: 'Cycle keyboard layout' },
  { value: 'open_settings', label: 'Open settings' },
  { value: 'close_focused', label: 'Close focused window' },
  { value: 'toggle_programs_menu', label: 'Toggle programs menu' },
  { value: 'toggle_fullscreen', label: 'Toggle fullscreen' },
  { value: 'toggle_maximize', label: 'Toggle maximize' },
  { value: 'tab_previous', label: 'Previous tab' },
  { value: 'tab_next', label: 'Next tab' },
  { value: 'tile_left', label: 'Tile left' },
  { value: 'tile_right', label: 'Tile right' },
  { value: 'tile_up', label: 'Tile up' },
  { value: 'tile_down', label: 'Tile down' },
  { value: 'move_monitor_left', label: 'Move to monitor left' },
  { value: 'move_monitor_right', label: 'Move to monitor right' },
  { value: 'screenshot_current_output', label: 'Screenshot current output' },
  { value: 'screenshot_region', label: 'Screenshot region' },
  { value: 'launch_terminal', label: 'Launch terminal' },
] as const

const VALID_BUILTINS = new Set<string>(BUILTIN_HOTKEY_ACTIONS.map((entry) => entry.value))
const FALLBACK: HotkeySettings = { bindings: [] }

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeKeyToken(value: string): string | null {
  const t = value.trim().toLowerCase()
  if (t === '`' || t === 'grave' || t === 'backquote') return 'Grave'
  if (t === 'space') return 'Space'
  if (t === 'return' || t === 'enter') return 'Return'
  if (t === 'tab') return 'Tab'
  if (t === 'left') return 'Left'
  if (t === 'right') return 'Right'
  if (t === 'up') return 'Up'
  if (t === 'down') return 'Down'
  if (t === ',' || t === 'comma') return 'Comma'
  if (t === '.' || t === 'period') return 'Period'
  if (t === '/' || t === 'slash') return 'Slash'
  if (t === ';' || t === 'semicolon') return 'Semicolon'
  if (t === "'" || t === 'apostrophe') return 'Apostrophe'
  if (t === '[' || t === 'bracketleft') return 'BracketLeft'
  if (t === ']' || t === 'bracketright') return 'BracketRight'
  if (/^[a-z0-9]$/.test(t)) return t.toUpperCase()
  return null
}

export function normalizeHotkeyChord(value: string): string | null {
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2) return null
  let hasSuper = false
  let ctrl = false
  let alt = false
  let shift = false
  let key: string | null = null
  for (const part of parts) {
    const t = part.toLowerCase()
    if (t === 'super' || t === 'win' || t === 'meta' || t === 'mod4') {
      hasSuper = true
    } else if (t === 'ctrl' || t === 'control') {
      ctrl = true
    } else if (t === 'alt') {
      alt = true
    } else if (t === 'shift') {
      shift = true
    } else {
      if (key !== null) return null
      key = normalizeKeyToken(part)
    }
  }
  if (!hasSuper || key === null) return null
  return ['Super', ctrl ? 'Ctrl' : '', alt ? 'Alt' : '', shift ? 'Shift' : '', key].filter(Boolean).join('+')
}

function sanitizeAction(value: unknown): HotkeyAction {
  return value === 'launch' || value === 'scratchpad' ? value : 'builtin'
}

function sanitizeBinding(value: unknown): HotkeyBinding | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const id = text(row.id).trim()
  const chord = normalizeHotkeyChord(text(row.chord))
  const action = sanitizeAction(row.action)
  const builtin = text(row.builtin).trim()
  const command = text(row.command).trim()
  const scratchpadId = text(row.scratchpad_id).trim()
  if (!id || !chord) return null
  if (action === 'builtin' && !VALID_BUILTINS.has(builtin)) return null
  if (action === 'launch' && !command) return null
  if (action === 'scratchpad' && !scratchpadId) return null
  return {
    id,
    enabled: row.enabled !== false,
    chord,
    action,
    builtin,
    command,
    desktop_id: text(row.desktop_id).trim(),
    app_name: text(row.app_name).trim(),
    scratchpad_id: scratchpadId,
  }
}

export function sanitizeHotkeySettings(value: unknown): HotkeySettings {
  if (!value || typeof value !== 'object') return FALLBACK
  const raw = (value as { bindings?: unknown }).bindings
  if (!Array.isArray(raw)) return FALLBACK
  return {
    bindings: raw.map(sanitizeBinding).filter((binding): binding is HotkeyBinding => binding !== null),
  }
}

export function hotkeyConflict(settings: HotkeySettings): string | null {
  const seen = new Map<string, string>()
  for (const binding of settings.bindings) {
    if (!binding.enabled) continue
    const chord = normalizeHotkeyChord(binding.chord)
    if (!chord) return `Invalid shortcut: ${binding.chord || binding.id}`
    const existing = seen.get(chord)
    if (existing) return `${chord} is used by ${existing} and ${binding.id}.`
    seen.set(chord, binding.id)
  }
  return null
}

export function hotkeyLaunchLabel(binding: HotkeyBinding): string {
  return binding.app_name || binding.desktop_id || binding.command
}

export function hotkeyBindingFromDesktopApp(app: DesktopAppEntry, current: HotkeyBinding): HotkeyBinding {
  return {
    ...current,
    action: 'launch',
    command: app.exec,
    desktop_id: app.desktop_id,
    app_name: app.name,
  }
}

export async function loadHotkeySettings(base: string | null): Promise<HotkeySettings> {
  return sanitizeHotkeySettings(await getShellJson('/settings_hotkeys', base))
}

export async function saveHotkeySettings(settings: HotkeySettings, base: string | null): Promise<void> {
  await postShellJson('/settings_hotkeys', settings, base)
}
