import { describe, expect, it } from 'vitest'
import { searchDesktopApplications } from './desktopAppSearch'
import { desktopAppUsageKey } from './desktopAppUsage'
import type { DesktopAppEntry } from '@/features/bridge/shellBridge'

const apps: DesktopAppEntry[] = [
  {
    name: 'Firefox Web Browser',
    exec: 'firefox %u',
    executable: 'firefox',
    generic_name: 'Web Browser',
    keywords: ['browser', 'web', 'internet'],
    terminal: false,
    desktop_id: 'firefox.desktop',
  },
  {
    name: 'Console',
    exec: 'kgx',
    executable: 'kgx',
    generic_name: 'Terminal',
    keywords: ['tty', 'shell'],
    terminal: true,
    desktop_id: 'org.gnome.Console.desktop',
  },
  {
    name: 'Signal Web',
    exec: 'signal-desktop',
    executable: 'signal-desktop',
    keywords: ['chat', 'web'],
    terminal: false,
    desktop_id: 'org.signal.Signal.desktop',
  },
  {
    name: 'Calculator',
    exec: 'gnome-calculator',
    executable: 'gnome-calculator',
    keywords: ['calc', 'math'],
    terminal: false,
    desktop_id: 'org.gnome.Calculator.desktop',
  },
  {
    name: 'LibreOffice Writer',
    exec: 'libreoffice --writer',
    executable: 'libreoffice',
    keywords: ['office', 'documents'],
    terminal: false,
    desktop_id: 'libreoffice-writer.desktop',
  },
]

describe('searchDesktopApplications', () => {
  it('matches generic names and keywords like gnome shell search', () => {
    expect(searchDesktopApplications(apps, 'browser').map((app) => app.desktop_id)).toEqual([
      'firefox.desktop',
    ])
    expect(searchDesktopApplications(apps, 'tty').map((app) => app.desktop_id)).toEqual([
      'org.gnome.Console.desktop',
    ])
  })

  it('prioritizes better ranked prefix matches ahead of substring matches', () => {
    expect(searchDesktopApplications(apps, 'calc').map((app) => app.desktop_id)).toEqual([
      'org.gnome.Calculator.desktop',
    ])
  })

  it('requires every query token to match somewhere on the app', () => {
    expect(searchDesktopApplications(apps, 'lib writer').map((app) => app.desktop_id)).toEqual([
      'libreoffice-writer.desktop',
    ])
    expect(searchDesktopApplications(apps, 'writer tty')).toEqual([])
  })

  it('prioritizes apps opened more often when match quality ties', () => {
    expect(
      searchDesktopApplications(apps, 'web', {
        [desktopAppUsageKey(apps[2])]: 4,
        [desktopAppUsageKey(apps[0])]: 1,
      }).map((app) => app.desktop_id),
    ).toEqual(['org.signal.Signal.desktop', 'firefox.desktop'])
  })

  it('uses launch history when the query is empty', () => {
    expect(
      searchDesktopApplications(apps, '', {
        [desktopAppUsageKey(apps[1])]: 5,
        [desktopAppUsageKey(apps[3])]: 2,
      }).map((app) => app.desktop_id),
    ).toEqual([
      'org.gnome.Console.desktop',
      'org.gnome.Calculator.desktop',
      'firefox.desktop',
      'org.signal.Signal.desktop',
      'libreoffice-writer.desktop',
    ])
  })
})
