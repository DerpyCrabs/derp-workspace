import { postShellJson } from '@/features/bridge/shellBridge'
import { shellHttpBase } from '@/features/bridge/shellHttp'

export type ThemePalette = 'default' | 'caffeine' | 'cosmic-night'
export type ThemeMode = 'light' | 'dark' | 'system'

export type ThemeSettings = {
  palette: ThemePalette
  mode: ThemeMode
}

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  palette: 'default',
  mode: 'system',
}

type ThemeListener = (theme: ThemeSettings) => void

const listeners = new Set<ThemeListener>()

let themeSettings = DEFAULT_THEME_SETTINGS
let initialized = false
let refreshPromise: Promise<ThemeSettings> | null = null
let pendingPersistTheme: ThemeSettings | null = null

function isThemePalette(value: unknown): value is ThemePalette {
  return value === 'default' || value === 'caffeine' || value === 'cosmic-night'
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system'
}

function sameTheme(a: ThemeSettings, b: ThemeSettings): boolean {
  return a.palette === b.palette && a.mode === b.mode
}

function sanitizeTheme(value: unknown): ThemeSettings {
  if (!value || typeof value !== 'object') return DEFAULT_THEME_SETTINGS
  const row = value as Record<string, unknown>
  return {
    palette: isThemePalette(row.palette) ? row.palette : DEFAULT_THEME_SETTINGS.palette,
    mode: isThemeMode(row.mode) ? row.mode : DEFAULT_THEME_SETTINGS.mode,
  }
}

export function parseThemeSettingsResponse(text: string): ThemeSettings {
  try {
    return sanitizeTheme(JSON.parse(text))
  } catch {
    return DEFAULT_THEME_SETTINGS
  }
}

function emitThemeSettings(next: ThemeSettings) {
  themeSettings = next
  for (const listener of listeners) {
    listener(themeSettings)
  }
}

function ensureThemeStore() {
  if (initialized) return
  initialized = true
}

async function readThemeSettingsViaShellHttp(base: string): Promise<ThemeSettings> {
  const res = await fetch(`${base}/settings_theme`)
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Theme settings load failed (${res.status}): ${text || 'empty response'}`)
  }
  return parseThemeSettingsResponse(text)
}

async function waitForShellHttpBase(timeoutMs: number = 2000): Promise<string | null> {
  const ready = shellHttpBase()
  if (ready) return ready
  if (typeof window === 'undefined') return null
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50))
    const next = shellHttpBase()
    if (next) return next
  }
  return null
}

async function persistThemeSettings(next: ThemeSettings): Promise<void> {
  const base = await waitForShellHttpBase()
  if (!base) {
    pendingPersistTheme = next
    return
  }
  await postShellJson('/settings_theme', next, base)
  if (pendingPersistTheme && sameTheme(pendingPersistTheme, next)) {
    pendingPersistTheme = null
  }
}

export async function refreshThemeSettingsFromRemote(): Promise<ThemeSettings> {
  ensureThemeStore()
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    try {
      const base = await waitForShellHttpBase()
      if (!base) return themeSettings
      const next = await readThemeSettingsViaShellHttp(base)
      if (!sameTheme(themeSettings, next)) {
        emitThemeSettings(next)
      }
      if (pendingPersistTheme && !sameTheme(pendingPersistTheme, next)) {
        const pending = pendingPersistTheme
        await persistThemeSettings(pending)
      }
      return next
    } catch (error) {
      console.warn('[derp-shell-theme] refresh failed', error)
      return themeSettings
    } finally {
      refreshPromise = null
    }
  })()
  return refreshPromise
}

export function getThemeSettings(): ThemeSettings {
  ensureThemeStore()
  return themeSettings
}

export function setTheme(palette: ThemePalette, mode: ThemeMode): ThemeSettings {
  ensureThemeStore()
  const next = { palette, mode }
  if (sameTheme(themeSettings, next)) return themeSettings
  emitThemeSettings(next)
  void persistThemeSettings(next).catch((error) => {
    console.warn('[derp-shell-theme] persist failed', error)
  })
  return next
}

export function setThemePalette(palette: ThemePalette): ThemeSettings {
  const current = getThemeSettings()
  return setTheme(palette, current.mode)
}

export function setThemeMode(mode: ThemeMode): ThemeSettings {
  const current = getThemeSettings()
  return setTheme(current.palette, mode)
}

export function subscribeThemeStore(listener: ThemeListener): () => void {
  ensureThemeStore()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function prefersDarkTheme(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveThemeMode(mode: ThemeMode, systemPrefersDark: boolean = prefersDarkTheme()): 'light' | 'dark' {
  if (mode === 'system') {
    return systemPrefersDark ? 'dark' : 'light'
  }
  return mode
}

export function __resetThemeStoreForTests() {
  listeners.clear()
  themeSettings = DEFAULT_THEME_SETTINGS
  initialized = false
  refreshPromise = null
  pendingPersistTheme = null
}
