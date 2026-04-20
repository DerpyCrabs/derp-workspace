export type TaskbarTooltipWindow = {
  window_id: number
  title: string
  app_id: string
  minimized: boolean
  tab_count: number
  app_display_name?: string | null
}

export function taskbarWindowLabel(w: TaskbarTooltipWindow) {
  const label = w.title || w.app_id || `Window ${w.window_id}`
  return w.tab_count > 1 ? `${label} (+${w.tab_count - 1})` : label
}

export function taskbarRowTooltip(w: TaskbarTooltipWindow) {
  const entry = `${taskbarWindowLabel(w)}${w.minimized ? ' (minimized)' : ''}`
  const app = (w.app_display_name ?? '').trim()
  if (!app) return entry
  const el = entry.toLowerCase()
  const al = app.toLowerCase()
  if (el.includes(al)) return entry
  return `${app} — ${entry}`
}
