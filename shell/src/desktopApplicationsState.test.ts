import { describe, expect, it } from 'vitest'
import { matchDesktopApplication, type DesktopAppMatchCandidate } from './desktopApplicationsState'

const apps: DesktopAppMatchCandidate[] = [
  {
    name: 'Firefox',
    exec: 'firefox',
    executable: 'firefox',
    desktop_id: 'firefox.desktop',
    icon: 'firefox',
  },
  {
    name: 'GNOME Console',
    exec: 'kgx',
    executable: 'kgx',
    generic_name: 'Terminal',
    full_name: 'Console',
    desktop_id: 'org.gnome.Console.desktop',
    icon: 'org.gnome.Console',
    keywords: ['shell', 'tty'],
  },
  {
    name: 'Files',
    exec: 'nautilus',
    executable: 'nautilus',
    desktop_id: 'org.gnome.Nautilus.desktop',
    icon: 'org.gnome.Nautilus',
  },
]

describe('matchDesktopApplication', () => {
  it('matches exact desktop id style app ids', () => {
    expect(
      matchDesktopApplication(apps, {
        title: 'Firefox',
        app_id: 'firefox',
      }),
    ).toMatchObject({ desktop_id: 'firefox.desktop' })
  })

  it('matches executable-like app ids', () => {
    expect(
      matchDesktopApplication(apps, {
        title: 'Derp X11 Xterm',
        app_id: 'kgx',
      }),
    ).toMatchObject({ desktop_id: 'org.gnome.Console.desktop' })
  })

  it('falls back to title and generic name hints', () => {
    expect(
      matchDesktopApplication(apps, {
        title: 'Files',
        app_id: 'unknown.app',
      }),
    ).toMatchObject({ desktop_id: 'org.gnome.Nautilus.desktop' })
  })

  it('returns null when there is no credible match', () => {
    expect(
      matchDesktopApplication(apps, {
        title: 'Completely Unknown Window',
        app_id: 'totally-unknown',
      }),
    ).toBeNull()
  })
})
