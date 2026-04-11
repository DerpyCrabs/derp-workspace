import { getShellJson, postShellJson } from '../shellBridge'

export type ShellUserSettings = {
  current_user: string
  enabled: boolean
  configured_user: string | null
  config_path: string
}

export const DEFAULT_SHELL_USER_SETTINGS: ShellUserSettings = {
  current_user: '',
  enabled: false,
  configured_user: null,
  config_path: '/etc/gdm/custom.conf',
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function sanitizeShellUserSettings(value: unknown): ShellUserSettings {
  if (!value || typeof value !== 'object') {
    return DEFAULT_SHELL_USER_SETTINGS
  }
  const row = value as Record<string, unknown>
  const currentUser = asString(row.current_user).trim()
  const configuredUser = asString(row.configured_user).trim()
  const configPath = asString(row.config_path).trim()
  return {
    current_user: currentUser,
    enabled: row.enabled === true,
    configured_user: configuredUser || null,
    config_path: configPath || DEFAULT_SHELL_USER_SETTINGS.config_path,
  }
}

export async function loadShellUserSettings(base: string | null): Promise<ShellUserSettings> {
  return sanitizeShellUserSettings(await getShellJson('/settings_user', base))
}

export async function saveShellUserSettings(enabled: boolean, base: string | null): Promise<void> {
  await postShellJson('/settings_user', { enabled }, base)
}
