import { describe, expect, it } from 'vitest'
import { pickScreenForPointerSnap, pickScreenForWindow } from './shellCoords'

describe('shellCoords', () => {
  describe('monitor pick for maximized drag-unmaximize', () => {
    const origin = { x: 0, y: 0 }
    const monitors = [
      { name: 'left', x: 0, y: 0, width: 1920, height: 1080 },
      { name: 'right', x: 1920, y: 0, width: 1920, height: 1080 },
    ]

    it('uses window placement so a secondary-monitor window is not tied to a pointer on the primary', () => {
      const win = { x: 2100, y: 120, width: 900, height: 700 }
      expect(pickScreenForWindow(win, monitors, origin)?.name).toBe('right')
      expect(pickScreenForPointerSnap(80, 80, monitors)?.name).toBe('left')
    })
  })
})
