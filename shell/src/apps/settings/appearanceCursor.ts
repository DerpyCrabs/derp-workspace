export type CursorSettings = {
  theme: string
  size: number
}

export type CursorThemeChoice = {
  items?: string[]
}

export const DEFAULT_CURSOR_SETTINGS: CursorSettings = { theme: 'default', size: 24 }
export const CURSOR_SIZE_CHOICES = [16, 24, 32, 48, 64]

export function sanitizeCursorSettings(value: unknown): CursorSettings {
  if (!value || typeof value !== 'object') return DEFAULT_CURSOR_SETTINGS
  const row = value as Record<string, unknown>
  const theme = typeof row.theme === 'string' && row.theme.trim() ? row.theme.trim() : DEFAULT_CURSOR_SETTINGS.theme
  const rawSize = typeof row.size === 'number' ? row.size : Number(row.size)
  const size = Number.isFinite(rawSize) ? Math.max(8, Math.min(128, Math.round(rawSize))) : DEFAULT_CURSOR_SETTINGS.size
  return { theme, size }
}
