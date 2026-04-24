import { createSignal, type Accessor } from 'solid-js'
import { getShellJson, postShellJson } from '@/features/bridge/shellBridge'
import { shellHttpBase, waitForShellHttpBase } from '@/features/bridge/shellHttp'

export type FileBrowserViewMode = 'list' | 'grid'
export type FileBrowserDefaultOpenTarget = 'window' | 'tab' | 'split' | 'ask'

export type FileBrowserFilesSettings = {
  view_modes: Record<string, FileBrowserViewMode>
  favorites: string[]
  custom_icons: Record<string, string>
  default_open_target: FileBrowserDefaultOpenTarget
}

export type FileBrowserFilesSettingsController = {
  settings: Accessor<FileBrowserFilesSettings>
  loaded: Accessor<boolean>
  busy: Accessor<boolean>
  err: Accessor<string | null>
  refresh: () => Promise<void>
  warm: () => Promise<void>
  setViewMode: (path: string, mode: FileBrowserViewMode) => Promise<void>
  setFavorite: (path: string, favorite: boolean) => Promise<void>
  setCustomIcon: (path: string, icon: string | null) => Promise<void>
  setDefaultOpenTarget: (target: FileBrowserDefaultOpenTarget) => Promise<void>
}

export const FILE_BROWSER_FAVORITES_PATH = 'derp:favorites'

const DEFAULT_FILES_SETTINGS: FileBrowserFilesSettings = {
  view_modes: {},
  favorites: [],
  custom_icons: {},
  default_open_target: 'window',
}

const [settings, setSettings] = createSignal<FileBrowserFilesSettings>(DEFAULT_FILES_SETTINGS)
const [loaded, setLoaded] = createSignal(false)
const [busy, setBusy] = createSignal(false)
const [err, setErr] = createSignal<string | null>(null)
let refreshPromise: Promise<void> | null = null
let settingsRevision = 0

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/')
}

function isViewMode(value: unknown): value is FileBrowserViewMode {
  return value === 'list' || value === 'grid'
}

function isOpenTarget(value: unknown): value is FileBrowserDefaultOpenTarget {
  return value === 'window' || value === 'tab' || value === 'split' || value === 'ask'
}

function sanitizeRecord(value: unknown, allowValue: (value: unknown) => string | null): Record<string, string> {
  if (!isObject(value)) return {}
  const out: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizePath(rawKey)
    const next = allowValue(rawValue)
    if (!key || !next) continue
    out[key] = next
  }
  return out
}

function sanitizeSettings(value: unknown): FileBrowserFilesSettings {
  if (!isObject(value)) return DEFAULT_FILES_SETTINGS
  const rawFav = Array.isArray(value.favorites) ? value.favorites : []
  const fav: string[] = []
  for (const row of rawFav) {
    if (typeof row !== 'string') continue
    const path = normalizePath(row)
    if (path && !fav.includes(path)) fav.push(path)
  }
  return {
    view_modes: sanitizeRecord(value.view_modes, (row) => (isViewMode(row) ? row : null)) as Record<string, FileBrowserViewMode>,
    favorites: fav,
    custom_icons: sanitizeRecord(value.custom_icons, (row) => (typeof row === 'string' && row.trim() ? row.trim() : null)),
    default_open_target: isOpenTarget(value.default_open_target) ? value.default_open_target : 'window',
  }
}

async function persist(next: FileBrowserFilesSettings): Promise<void> {
  settingsRevision += 1
  setSettings(next)
  await postShellJson('/settings_files', next, shellHttpBase())
}

async function refresh(): Promise<void> {
  if (refreshPromise) return refreshPromise
  const refreshRevision = settingsRevision
  refreshPromise = (async () => {
    const base = shellHttpBase()
    setBusy(true)
    if (!base) {
      if (!loaded()) setErr('Files settings need cef_host (no shell HTTP).')
      setBusy(false)
      refreshPromise = null
      return
    }
    setErr(null)
    try {
      const next = sanitizeSettings(await getShellJson('/settings_files', base))
      if (refreshRevision === settingsRevision) setSettings(next)
      setLoaded(true)
      setErr(null)
    } catch (error) {
      if (!loaded()) setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
      refreshPromise = null
    }
  })()
  return refreshPromise
}

async function warm(): Promise<void> {
  const base = await waitForShellHttpBase(4000)
  if (!base) return
  await refresh()
}

async function setViewMode(path: string, mode: FileBrowserViewMode): Promise<void> {
  const key = normalizePath(path)
  if (!key || key === FILE_BROWSER_FAVORITES_PATH) return
  await persist({ ...settings(), view_modes: { ...settings().view_modes, [key]: mode } })
}

async function setFavorite(path: string, favorite: boolean): Promise<void> {
  const key = normalizePath(path)
  if (!key || key === FILE_BROWSER_FAVORITES_PATH) return
  const cur = settings().favorites
  const nextFav = favorite ? (cur.includes(key) ? cur : [...cur, key]) : cur.filter((row) => row !== key)
  await persist({ ...settings(), favorites: nextFav })
}

async function setCustomIcon(path: string, icon: string | null): Promise<void> {
  const key = normalizePath(path)
  if (!key) return
  const next = { ...settings().custom_icons }
  if (icon) next[key] = icon
  else delete next[key]
  await persist({ ...settings(), custom_icons: next })
}

async function setDefaultOpenTarget(target: FileBrowserDefaultOpenTarget): Promise<void> {
  await persist({ ...settings(), default_open_target: target })
}

const controller: FileBrowserFilesSettingsController = {
  settings,
  loaded,
  busy,
  err,
  refresh,
  warm,
  setViewMode,
  setFavorite,
  setCustomIcon,
  setDefaultOpenTarget,
}

export function useFileBrowserFilesSettings(): FileBrowserFilesSettingsController {
  return controller
}
