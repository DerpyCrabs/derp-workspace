export type FileBrowserPrefs = {
  showHidden: boolean
}

export const FILE_BROWSER_PREFS_STORAGE_KEY = 'derp-file-browser-prefs-v1'

export const DEFAULT_FILE_BROWSER_PREFS: FileBrowserPrefs = {
  showHidden: false,
}

function sanitizeFileBrowserPrefs(value: unknown): FileBrowserPrefs {
  if (!value || typeof value !== 'object') return DEFAULT_FILE_BROWSER_PREFS
  const row = value as Record<string, unknown>
  return {
    showHidden: row.showHidden === true,
  }
}

export function loadFileBrowserPrefs(): FileBrowserPrefs {
  if (typeof localStorage === 'undefined') return DEFAULT_FILE_BROWSER_PREFS
  try {
    return sanitizeFileBrowserPrefs(JSON.parse(localStorage.getItem(FILE_BROWSER_PREFS_STORAGE_KEY) ?? 'null'))
  } catch {
    return DEFAULT_FILE_BROWSER_PREFS
  }
}

export function saveFileBrowserPrefs(prefs: FileBrowserPrefs): void {
  if (typeof localStorage === 'undefined') return
  const json = JSON.stringify(prefs)
  if (localStorage.getItem(FILE_BROWSER_PREFS_STORAGE_KEY) === json) return
  localStorage.setItem(FILE_BROWSER_PREFS_STORAGE_KEY, json)
}

export function setFileBrowserShowHidden(showHidden: boolean): FileBrowserPrefs {
  const next = { ...loadFileBrowserPrefs(), showHidden }
  saveFileBrowserPrefs(next)
  return next
}
