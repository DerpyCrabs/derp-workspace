import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseDesktopApplicationsResponse,
  postShellJson,
  ShellHttpError,
  spawnViaShellHttp,
} from './shellBridge'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseDesktopApplicationsResponse', () => {
  it('parses valid application rows', () => {
    expect(
      parseDesktopApplicationsResponse(
        JSON.stringify({
          apps: [
            {
              name: 'Foot',
              exec: 'foot',
              executable: 'foot',
              generic_name: 'Terminal',
              full_name: 'GNOME Console',
              keywords: ['tty', 'shell'],
              icon: 'org.gnome.Console',
              terminal: true,
              desktop_id: 'foot.desktop',
            },
            { name: 'Files', exec: 'nautilus' },
          ],
        }),
      ),
    ).toEqual([
      {
        name: 'Foot',
        exec: 'foot',
        executable: 'foot',
        generic_name: 'Terminal',
        full_name: 'GNOME Console',
        keywords: ['tty', 'shell'],
        icon: 'org.gnome.Console',
        terminal: true,
        desktop_id: 'foot.desktop',
      },
      { name: 'Files', exec: 'nautilus', keywords: [], terminal: false, desktop_id: '' },
    ])
  })

  it('rejects malformed payloads', () => {
    expect(() => parseDesktopApplicationsResponse('{"apps":[{"name":"Bad"}]}')).toThrow(
      'Invalid applications response: bad application row.',
    )
  })
})

describe('shell HTTP helpers', () => {
  it('throws a structured error for non-ok shell responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: vi.fn().mockResolvedValue('service unavailable'),
      }),
    )

    await expect(postShellJson('/session_power', { action: 'reboot' }, 'http://127.0.0.1:7')).rejects.toMatchObject({
      name: 'ShellHttpError',
      status: 503,
    })
  })

  it('rejects spawn requests when the HTTP bridge is missing', async () => {
    await expect(spawnViaShellHttp('foot', undefined)).rejects.toThrow(
      'Shell spawn bridge is unavailable.',
    )
  })

  it('throws ShellHttpError for failed spawn responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue('spawn failed'),
      }),
    )

    await expect(spawnViaShellHttp('foot', 'http://127.0.0.1:7/spawn')).rejects.toBeInstanceOf(
      ShellHttpError,
    )
  })
})
