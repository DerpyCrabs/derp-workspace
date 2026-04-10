import { describe, expect, it } from 'vitest'
import { searchDesktopApplications } from './desktopAppSearch'
import type { DesktopAppEntry } from './shellBridge'

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
})
