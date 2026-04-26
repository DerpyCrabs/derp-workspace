import { describe, expect, it } from 'vitest'
import {
  hotkeyBindingFromDesktopApp,
  hotkeyConflict,
  normalizeHotkeyChord,
  sanitizeHotkeySettings,
} from './hotkeySettings'

describe('hotkeySettings', () => {
  it('normalizes super chords', () => {
    expect(normalizeHotkeyChord('win + shift + enter')).toBe('Super+Shift+Return')
    expect(normalizeHotkeyChord('Super+Ctrl+s')).toBe('Super+Ctrl+S')
    expect(normalizeHotkeyChord('Ctrl+S')).toBeNull()
  })

  it('sanitizes launch and builtin bindings', () => {
    expect(
      sanitizeHotkeySettings({
        bindings: [
          {
            id: 'term',
            enabled: true,
            chord: 'win+return',
            action: 'launch',
            command: 'foot',
          },
          {
            id: 'bad',
            chord: 'Super+B',
            action: 'launch',
            command: '',
          },
          {
            id: 'settings',
            chord: 'Super+,',
            action: 'builtin',
            builtin: 'open_settings',
          },
        ],
      }),
    ).toEqual({
      bindings: [
        {
          id: 'term',
          enabled: true,
          chord: 'Super+Return',
          action: 'launch',
          builtin: '',
          command: 'foot',
          desktop_id: '',
          app_name: '',
          scratchpad_id: '',
        },
        {
          id: 'settings',
          enabled: true,
          chord: 'Super+Comma',
          action: 'builtin',
          builtin: 'open_settings',
          command: '',
          desktop_id: '',
          app_name: '',
          scratchpad_id: '',
        },
      ],
    })
  })

  it('finds duplicate active chords', () => {
    const conflict = hotkeyConflict({
      bindings: [
        {
          id: 'one',
          enabled: true,
          chord: 'Super+B',
          action: 'launch',
          builtin: '',
          command: 'foot',
          desktop_id: '',
          app_name: '',
          scratchpad_id: '',
        },
        {
          id: 'two',
          enabled: true,
          chord: 'Win+b',
          action: 'builtin',
          builtin: 'open_settings',
          command: '',
          desktop_id: '',
          app_name: '',
          scratchpad_id: '',
        },
      ],
    })
    expect(conflict).toContain('Super+B')
  })

  it('fills launch metadata from desktop apps', () => {
    expect(
      hotkeyBindingFromDesktopApp(
        {
          name: 'Files',
          exec: 'nautilus',
          executable: 'nautilus',
          desktop_id: 'org.gnome.Nautilus.desktop',
          terminal: false,
          keywords: [],
          mime_types: [],
        },
        {
          id: 'files',
          enabled: true,
          chord: 'Super+E',
          action: 'launch',
          builtin: '',
          command: '',
          desktop_id: '',
          app_name: '',
          scratchpad_id: '',
        },
      ),
    ).toMatchObject({
      command: 'nautilus',
      desktop_id: 'org.gnome.Nautilus.desktop',
      app_name: 'Files',
    })
  })
})
