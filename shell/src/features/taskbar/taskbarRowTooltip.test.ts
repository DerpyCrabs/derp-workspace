import { describe, expect, it } from 'vitest'
import { taskbarRowTooltip, taskbarWindowLabel } from '@/features/taskbar/taskbarRowTooltip'

describe('taskbarRowTooltip', () => {
  it('labels window from title with tab suffix', () => {
    expect(
      taskbarWindowLabel({
        window_id: 3,
        title: 'Alpha',
        app_id: 'app.alpha',
        minimized: false,
        tab_count: 3,
      }),
    ).toBe('Alpha (+2)')
  })

  it('falls back to app_id when title empty', () => {
    expect(
      taskbarWindowLabel({
        window_id: 9,
        title: '',
        app_id: 'foot',
        minimized: false,
        tab_count: 1,
      }),
    ).toBe('foot')
  })

  it('appends minimized suffix in tooltip', () => {
    expect(
      taskbarRowTooltip({
        window_id: 1,
        title: 'Doc',
        app_id: 'writer',
        minimized: true,
        tab_count: 1,
      }),
    ).toBe('Doc (minimized)')
  })

  it('prefixes desktop app name when not contained in title line', () => {
    expect(
      taskbarRowTooltip({
        window_id: 2,
        title: 'Notes.md',
        app_id: 'org.gnome.TextEditor',
        minimized: false,
        tab_count: 1,
        app_display_name: 'Text Editor',
      }),
    ).toBe('Text Editor — Notes.md')
  })

  it('skips redundant app prefix when title already contains name', () => {
    expect(
      taskbarRowTooltip({
        window_id: 2,
        title: 'Text Editor — Untitled',
        app_id: 'org.gnome.TextEditor',
        minimized: false,
        tab_count: 1,
        app_display_name: 'Text Editor',
      }),
    ).toBe('Text Editor — Untitled')
  })
})
