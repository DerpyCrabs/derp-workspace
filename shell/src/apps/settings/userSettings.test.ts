import { describe, expect, it } from 'vitest'
import { sanitizeShellUserSettings } from './userSettings'

describe('userSettings', () => {
  it('sanitizes malformed payloads', () => {
    expect(
      sanitizeShellUserSettings({
        current_user: 'alice',
        enabled: true,
        configured_user: '',
      }),
    ).toEqual({
      current_user: 'alice',
      enabled: true,
      configured_user: null,
      config_path: '/etc/gdm/custom.conf',
    })
  })
})
