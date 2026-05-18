import { getShellJson, postShellJson } from '@/features/bridge/shellBridge'

export type ShellLockScreenSettings = {
  enabled: boolean
}

export const DEFAULT_SHELL_LOCK_SCREEN_SETTINGS: ShellLockScreenSettings = {
  enabled: false,
}

export function sanitizeShellLockScreenSettings(value: unknown): ShellLockScreenSettings {
  if (!value || typeof value !== 'object') return DEFAULT_SHELL_LOCK_SCREEN_SETTINGS
  return {
    enabled: (value as { enabled?: unknown }).enabled === true,
  }
}

export async function loadShellLockScreenSettings(base: string): Promise<ShellLockScreenSettings> {
  return sanitizeShellLockScreenSettings(await getShellJson('/settings_lock_screen', base))
}

export async function saveShellLockScreenSettings(
  settings: ShellLockScreenSettings,
  base: string,
): Promise<void> {
  await postShellJson('/settings_lock_screen', sanitizeShellLockScreenSettings(settings), base)
}
