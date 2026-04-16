import { describe, expect, it } from 'vitest'
import { matchNativeSessionWindow, scoreNativeSessionMatch } from './nativeSessionMatch'
import { nativeWindowRef, type SavedNativeWindow } from './sessionSnapshot'

const saved = (overrides: Partial<SavedNativeWindow>): SavedNativeWindow => ({
  windowRef: nativeWindowRef(1),
  title: 'Foot',
  appId: 'foot',
  outputName: 'DP-1',
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  minimized: false,
  maximized: false,
  fullscreen: false,
  launch: { command: 'foot', desktopId: 'foot.desktop', appName: 'Foot' },
  ...overrides,
})

describe('nativeSessionMatch', () => {
  it('scores exact metadata matches highest', () => {
    expect(
      scoreNativeSessionMatch(
        {
          title: 'Foot',
          appId: 'foot',
          outputName: 'DP-1',
          maximized: false,
          fullscreen: false,
        },
        saved({}),
      ),
    ).toBeGreaterThan(90)
  })

  it('rejects ambiguous matches', () => {
    const match = matchNativeSessionWindow(
      {
        title: 'Foot',
        appId: 'foot',
        outputName: 'DP-1',
        maximized: false,
        fullscreen: false,
      },
      [
        saved({ windowRef: nativeWindowRef(1) }),
        saved({ windowRef: nativeWindowRef(2), outputName: 'DP-2' }),
      ],
    )
    expect(match).toBeNull()
  })

  it('picks a single strong candidate', () => {
    const match = matchNativeSessionWindow(
      {
        title: 'Foot',
        appId: 'foot',
        outputName: 'DP-1',
        maximized: false,
        fullscreen: false,
      },
      [
        saved({ windowRef: nativeWindowRef(1) }),
        saved({ windowRef: nativeWindowRef(2), title: 'Files', appId: 'org.gnome.Nautilus' }),
      ],
    )
    expect(match?.windowRef).toBe(nativeWindowRef(1))
  })
})
