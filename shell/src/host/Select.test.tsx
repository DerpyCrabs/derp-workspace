import { describe, expect, it } from 'vitest'
import { resolveSelectBehavior } from '@/lib/selectBehavior'

describe('resolveSelectBehavior', () => {
  it('defaults to a floating select that dismisses parent menus', () => {
    expect(resolveSelectBehavior({})).toEqual({
      placement: 'floating',
      preserveContextMenu: false,
      floatingPlacement: true,
      dismissContextMenusOnOpen: true,
      registerNestedSurface: false,
    })
  })

  it('supports inline nested selects inside context menus', () => {
    expect(
      resolveSelectBehavior({
        placement: 'inline',
        contextMenuPolicy: 'preserve',
      }),
    ).toEqual({
      placement: 'inline',
      preserveContextMenu: true,
      floatingPlacement: false,
      dismissContextMenusOnOpen: false,
      registerNestedSurface: false,
    })
  })

  it('keeps nested floating selects registered as child surfaces', () => {
    expect(
      resolveSelectBehavior({
        placement: 'floating',
        contextMenuPolicy: 'preserve',
      }),
    ).toEqual({
      placement: 'floating',
      preserveContextMenu: true,
      floatingPlacement: true,
      dismissContextMenusOnOpen: false,
      registerNestedSurface: true,
    })
  })
})
