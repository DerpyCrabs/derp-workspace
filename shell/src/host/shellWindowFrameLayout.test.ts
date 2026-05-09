import { describe, expect, it } from 'vitest'
import { CHROME_BORDER_PX, CHROME_TITLEBAR_PX } from '@/lib/chromeConstants'
import { shellWindowFrameLayout } from './shellWindowFrameLayout'

describe('shellWindowFrameLayout', () => {
  it('uses compositor-authored native frame and client rects', () => {
    const layout = shellWindowFrameLayout({
      x: 104,
      y: 126,
      width: 512,
      height: 251,
      client_x: 104,
      client_y: 126,
      client_width: 512,
      client_height: 251,
      frame_x: 100,
      frame_y: 100,
      frame_width: 520,
      frame_height: 281,
      maximized: false,
      fullscreen: false,
    })
    expect(layout.ox).toBe(100)
    expect(layout.oy).toBe(100)
    expect(layout.ow).toBe(520)
    expect(layout.oh).toBe(281)
    expect(layout.contentLeft).toBe(4)
    expect(layout.contentTop).toBe(26)
    expect(layout.contentW).toBe(512)
    expect(layout.contentH).toBe(251)
    expect(layout.showBorderChrome).toBe(true)
  })

  it('falls back to local legacy frame math only when compositor frame fields are absent', () => {
    const layout = shellWindowFrameLayout({
      x: 104,
      y: 126,
      width: 512,
      height: 251,
      maximized: false,
      fullscreen: false,
    })
    expect(layout.ox).toBe(104 - CHROME_BORDER_PX)
    expect(layout.oy).toBe(126 - CHROME_TITLEBAR_PX)
    expect(layout.contentLeft).toBe(CHROME_BORDER_PX)
    expect(layout.contentTop).toBe(CHROME_TITLEBAR_PX)
    expect(layout.showBorderChrome).toBe(true)
  })

  it('keeps maximized compositor frames borderless while retaining titlebar placement', () => {
    const layout = shellWindowFrameLayout({
      x: 0,
      y: 26,
      width: 1280,
      height: 674,
      client_x: 0,
      client_y: 26,
      client_width: 1280,
      client_height: 674,
      frame_x: 0,
      frame_y: 0,
      frame_width: 1280,
      frame_height: 700,
      maximized: true,
      fullscreen: false,
    })
    expect(layout.contentLeft).toBe(0)
    expect(layout.contentTop).toBe(CHROME_TITLEBAR_PX)
    expect(layout.showBorderChrome).toBe(false)
  })

  it('uses compositor-authored frameless native rects without shell chrome', () => {
    const layout = shellWindowFrameLayout({
      x: 120,
      y: 180,
      width: 420,
      height: 96,
      client_x: 120,
      client_y: 180,
      client_width: 420,
      client_height: 96,
      frame_x: 120,
      frame_y: 180,
      frame_width: 420,
      frame_height: 96,
      maximized: false,
      fullscreen: false,
    })
    expect(layout.th).toBe(0)
    expect(layout.contentLeft).toBe(0)
    expect(layout.contentTop).toBe(0)
    expect(layout.showBorderChrome).toBe(false)
  })
})
