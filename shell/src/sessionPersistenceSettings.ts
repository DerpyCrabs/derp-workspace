export type SessionPersistenceSettings = {
  autoSave: boolean
}

export const SESSION_PERSISTENCE_SETTINGS_STORAGE_KEY = 'derp-session-persistence-settings-v1'

export const DEFAULT_SESSION_PERSISTENCE_SETTINGS: SessionPersistenceSettings = {
  autoSave: true,
}

function sanitizeSessionPersistenceSettings(value: unknown): SessionPersistenceSettings {
  if (!value || typeof value !== 'object') return DEFAULT_SESSION_PERSISTENCE_SETTINGS
  const row = value as Record<string, unknown>
  return {
    autoSave: row.autoSave !== false,
  }
}

export function loadSessionPersistenceSettings(): SessionPersistenceSettings {
  if (typeof localStorage === 'undefined') return DEFAULT_SESSION_PERSISTENCE_SETTINGS
  try {
    return sanitizeSessionPersistenceSettings(
      JSON.parse(localStorage.getItem(SESSION_PERSISTENCE_SETTINGS_STORAGE_KEY) ?? 'null'),
    )
  } catch {
    return DEFAULT_SESSION_PERSISTENCE_SETTINGS
  }
}

export function saveSessionPersistenceSettings(settings: SessionPersistenceSettings): void {
  if (typeof localStorage === 'undefined') return
  const json = JSON.stringify(settings)
  if (localStorage.getItem(SESSION_PERSISTENCE_SETTINGS_STORAGE_KEY) === json) return
  localStorage.setItem(SESSION_PERSISTENCE_SETTINGS_STORAGE_KEY, json)
}

export function setSessionAutoSaveEnabled(autoSave: boolean): SessionPersistenceSettings {
  const next = { ...loadSessionPersistenceSettings(), autoSave }
  saveSessionPersistenceSettings(next)
  return next
}
