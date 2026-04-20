import { createRoot } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { createFloatingLayerStore } from './floatingLayers'
import { createShellOverlayRegistry } from './shellOverlay'

function withOverlayRegistry<T>(fn: (registry: ReturnType<typeof createShellOverlayRegistry>) => T): T {
  return createRoot((dispose) => {
    try {
      return fn(createShellOverlayRegistry(createFloatingLayerStore()))
    } finally {
      dispose()
    }
  })
}

describe('shellOverlay', () => {
  it('places below-end overlays from the anchor edge', () => {
    withOverlayRegistry((registry) => {
      registry.openOverlay({
        id: 'menu',
        kind: 'context_menu',
        anchor: { x: 100, y: 50, w: 40, h: 20 },
        placement: 'below-end',
        size: { w: 120, h: 80 },
      })

      expect(registry.overlayLayers()[0]?.placement).toEqual({
        bx: 20,
        by: 70,
        bw: 120,
        bh: 80,
        gx: 20,
        gy: 70,
        gw: 120,
        gh: 80,
      })
    })
  })

  it('places above-start overlays above the anchor', () => {
    withOverlayRegistry((registry) => {
      registry.openOverlay({
        id: 'tooltip',
        kind: 'tooltip',
        anchor: { x: 12.4, y: 32.6, w: 80, h: 16 },
        placement: 'above-start',
        size: { w: 40, h: 10 },
      })

      expect(registry.overlayLayers()[0]?.placement).toMatchObject({
        bx: 12,
        by: 23,
        gx: 12,
        gy: 23,
        gw: 40,
        gh: 10,
      })
    })
  })

  it('uses point placement and anchor size by default', () => {
    withOverlayRegistry((registry) => {
      registry.openOverlay({
        id: 'point',
        kind: 'dropdown',
        anchor: { x: 8, y: 9, w: 22, h: 11 },
      })

      expect(registry.overlayLayers()[0]?.placement).toEqual({
        bx: 8,
        by: 9,
        bw: 22,
        bh: 11,
        gx: 8,
        gy: 9,
        gw: 22,
        gh: 11,
      })
    })
  })

  it('keeps child overlays topmost and closes the branch together', () => {
    withOverlayRegistry((registry) => {
      registry.openOverlay({
        id: 'root',
        kind: 'context_menu',
        anchor: { x: 0, y: 0 },
      })
      registry.openOverlay({
        id: 'child',
        parentId: 'root',
        kind: 'context_menu',
        anchor: { x: 10, y: 10 },
      })

      expect(registry.overlayLayers().map((layer) => [layer.id, layer.parentId])).toEqual([
        ['root', null],
        ['child', 'root'],
      ])
      expect(registry.topmostOverlayKind()).toBe('context_menu')
      expect(registry.closeOverlayBranch('root')).toBe(true)
      expect(registry.overlayLayers()).toEqual([])
    })
  })

  it('replaces an overlay id without keeping stale placement or close handlers', () => {
    withOverlayRegistry((registry) => {
      const closed: string[] = []
      registry.openOverlay({
        id: 'menu',
        kind: 'dropdown',
        anchor: { x: 0, y: 0, w: 10, h: 10 },
        placement: 'below-start',
        size: { w: 50, h: 20 },
        onClose: () => closed.push('first'),
      })
      registry.openOverlay({
        id: 'menu',
        kind: 'dropdown',
        anchor: { x: 100, y: 80, w: 30, h: 10 },
        placement: 'above-end',
        size: { w: 40, h: 30 },
        onClose: () => closed.push('second'),
      })

      expect(registry.overlayLayers()).toHaveLength(1)
      expect(registry.overlayLayers()[0]?.placement).toMatchObject({
        gx: 90,
        gy: 50,
        gw: 40,
        gh: 30,
      })
      expect(registry.closeOverlayBranch('menu')).toBe(true)
      expect(closed).toEqual(['second'])
    })
  })
})
