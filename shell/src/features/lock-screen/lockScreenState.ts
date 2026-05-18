export type ShellLockScreenState = {
  enabled: boolean
  locked: boolean
  phase: 'unlocked' | 'locking' | 'locked' | 'unlocking'
  origin: 'builtin_shell' | 'external_protocol' | null
  authenticating: boolean
  failed_attempts: number
  error: string
}

export const DEFAULT_SHELL_LOCK_SCREEN_STATE: ShellLockScreenState = {
  enabled: false,
  locked: false,
  phase: 'unlocked',
  origin: null,
  authenticating: false,
  failed_attempts: 0,
  error: '',
}

export function sanitizeShellLockScreenState(value: unknown): ShellLockScreenState {
  if (!value || typeof value !== 'object') return DEFAULT_SHELL_LOCK_SCREEN_STATE
  const row = value as Record<string, unknown>
  const phase =
    row.phase === 'locking' || row.phase === 'locked' || row.phase === 'unlocking'
      ? row.phase
      : 'unlocked'
  const origin =
    row.origin === 'builtin_shell' || row.origin === 'external_protocol'
      ? row.origin
      : null
  const failed = typeof row.failed_attempts === 'number' && Number.isFinite(row.failed_attempts)
    ? Math.max(0, Math.trunc(row.failed_attempts))
    : 0
  return {
    enabled: row.enabled === true,
    locked: row.locked === true,
    phase,
    origin,
    authenticating: row.authenticating === true,
    failed_attempts: failed,
    error: typeof row.error === 'string' ? row.error : '',
  }
}
