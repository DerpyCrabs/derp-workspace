import { postShellJson, postShellJsonReturnJson } from '@/features/bridge/shellBridge'
import { shellHttpBase } from '@/features/bridge/shellHttp'

export type ShellNotificationAction = {
  key: string
  label: string
}

export type ShellNotificationEntry = {
  id: number
  app_name: string
  app_icon: string
  summary: string
  body: string
  actions: ShellNotificationAction[]
  source: string
  urgency: 0 | 1 | 2
  created_at_ms: number
  updated_at_ms: number
  expires_at_ms: number | null
  closed_at_ms: number | null
  close_reason: number | null
  action_key: string | null
}

export type ShellNotificationsState = {
  revision: number
  enabled: boolean
  active: ShellNotificationEntry[]
  history: ShellNotificationEntry[]
}

export type ShellNotificationRequest = {
  app_name?: string
  app_icon?: string
  summary: string
  body?: string
  actions?: Array<{ key: string; label: string }>
  expire_timeout_ms?: number | null
  urgency?: 0 | 1 | 2 | null
}

export type ShellNotificationEvent = {
  notification_id: number
  event_type: string
  action_key: string | null
  close_reason: number | null
  source: string
}

function clampText(value: unknown, limit: number) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function asAction(value: unknown): ShellNotificationAction | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const key = clampText(row.key, 64)
  const label = clampText(row.label, 128)
  if (!key || !label) return null
  return { key, label }
}

function asEntry(value: unknown): ShellNotificationEntry | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const id = typeof row.id === 'number' && Number.isFinite(row.id) ? Math.trunc(row.id) : 0
  if (id < 1) return null
  const actions = Array.isArray(row.actions) ? row.actions.map(asAction).filter((item): item is ShellNotificationAction => item !== null) : []
  const urgencyRaw = typeof row.urgency === 'number' && Number.isFinite(row.urgency) ? Math.trunc(row.urgency) : 1
  const urgency: 0 | 1 | 2 = urgencyRaw <= 0 ? 0 : urgencyRaw >= 2 ? 2 : 1
  const asNumberOrNull = (input: unknown) =>
    typeof input === 'number' && Number.isFinite(input) ? Math.max(0, Math.trunc(input)) : null
  return {
    id,
    app_name: clampText(row.app_name, 128),
    app_icon: clampText(row.app_icon, 512),
    summary: clampText(row.summary, 256),
    body: clampText(row.body, 4096),
    actions,
    source: clampText(row.source, 32) || 'shell',
    urgency,
    created_at_ms: asNumberOrNull(row.created_at_ms) ?? 0,
    updated_at_ms: asNumberOrNull(row.updated_at_ms) ?? 0,
    expires_at_ms: asNumberOrNull(row.expires_at_ms),
    closed_at_ms: asNumberOrNull(row.closed_at_ms),
    close_reason: asNumberOrNull(row.close_reason),
    action_key: clampText(row.action_key, 64) || null,
  }
}

export function emptyNotificationsState(): ShellNotificationsState {
  return {
    revision: 0,
    enabled: true,
    active: [],
    history: [],
  }
}

export function sanitizeNotificationsState(value: unknown): ShellNotificationsState {
  if (!value || typeof value !== 'object') return emptyNotificationsState()
  const row = value as Record<string, unknown>
  const active = Array.isArray(row.active) ? row.active.map(asEntry).filter((item): item is ShellNotificationEntry => item !== null) : []
  const history = Array.isArray(row.history) ? row.history.map(asEntry).filter((item): item is ShellNotificationEntry => item !== null) : []
  return {
    revision: typeof row.revision === 'number' && Number.isFinite(row.revision) ? Math.max(0, Math.trunc(row.revision)) : 0,
    enabled: row.enabled !== false,
    active,
    history,
  }
}

export function sanitizeNotificationEvent(value: unknown): ShellNotificationEvent | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const notification_id =
    typeof row.notification_id === 'number' && Number.isFinite(row.notification_id)
      ? Math.trunc(row.notification_id)
      : 0
  if (notification_id < 1) return null
  return {
    notification_id,
    event_type: clampText(row.event_type, 32),
    action_key: clampText(row.action_key, 64) || null,
    close_reason:
      typeof row.close_reason === 'number' && Number.isFinite(row.close_reason)
        ? Math.max(0, Math.trunc(row.close_reason))
        : null,
    source: clampText(row.source, 32) || 'shell',
  }
}

export async function notifyViaShell(request: ShellNotificationRequest, base: string | null = shellHttpBase()) {
  const response = await postShellJsonReturnJson('/notifications_shell', request, base)
  const id =
    response && typeof response === 'object' && typeof (response as { id?: unknown }).id === 'number'
      ? Math.trunc((response as { id: number }).id)
      : 0
  if (id < 1) throw new Error('Shell notifications returned an invalid id.')
  return id
}

export async function closeViaShell(
  notificationId: number,
  options: { reason?: number; source?: string } = {},
  base: string | null = shellHttpBase(),
) {
  await postShellJson(
    '/notifications_close',
    {
      notification_id: notificationId,
      reason: options.reason ?? 3,
      source: options.source ?? 'shell',
    },
    base,
  )
}

export async function invokeNotificationActionViaShell(
  notificationId: number,
  actionKey: string,
  source: string = 'shell',
  base: string | null = shellHttpBase(),
) {
  await postShellJson(
    '/notifications_action',
    {
      notification_id: notificationId,
      action_key: actionKey,
      source,
    },
    base,
  )
}

export async function setNotificationsEnabledViaShell(enabled: boolean, base: string | null = shellHttpBase()) {
  await postShellJson('/settings_notifications', { enabled }, base)
}
