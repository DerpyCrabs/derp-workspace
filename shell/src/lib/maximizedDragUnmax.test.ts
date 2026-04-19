import { describe, expect, it } from 'vitest'
import { maximizedDragUnmaxCanvasPosition } from './maximizedDragUnmax'

describe('maximizedDragUnmaxCanvasPosition', () => {
  it('places restored frame so the grab point stays under the pointer on a wide maximized window', () => {
    const out = maximizedDragUnmaxCanvasPosition({
      pointerCanvasX: 2240,
      pointerCanvasY: 40,
      frameX: 1280,
      frameY: 28,
      frameW: 1920,
      frameH: 1208,
      restoreW: 480,
      restoreH: 320,
    })
    expect(out.rx).toBeCloseTo(0.5, 5)
    expect(out.ry).toBeCloseTo((40 - 28) / 1208, 5)
    expect(out.x).toBe(2000)
    expect(out.y).toBe(Math.round(40 - out.ry * 320))
  })

  it('matches left-edge grab to the maximized frame left', () => {
    const out = maximizedDragUnmaxCanvasPosition({
      pointerCanvasX: 1280,
      pointerCanvasY: 28,
      frameX: 1280,
      frameY: 28,
      frameW: 1920,
      frameH: 1208,
      restoreW: 480,
      restoreH: 320,
    })
    expect(out.rx).toBe(0)
    expect(out.x).toBe(1280)
  })
})
