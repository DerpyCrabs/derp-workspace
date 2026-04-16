import { describe, expect, it } from 'vitest'
import {
  closeAllFloatingLayersModel,
  closeFloatingLayerBranchModel,
  closeFloatingLayersForOutsideModel,
  closeTopmostEscapableFloatingLayerModel,
  createFloatingLayerModel,
  floatingLayerBranchIds,
  openFloatingLayerModel,
  topmostFloatingLayerModel,
  type FloatingLayerModel,
} from './floatingLayers'

function withLayers(
  specs: Array<{
    id: string
    parentId?: string | null
    kind?: 'context_menu' | 'select'
    closeOnOutside?: boolean
    closeOnEscape?: boolean
  }>,
): FloatingLayerModel {
  let model = createFloatingLayerModel()
  for (const spec of specs) {
    model = openFloatingLayerModel(model, {
      id: spec.id,
      parentId: spec.parentId,
      kind: spec.kind ?? 'context_menu',
      closeOnOutside: spec.closeOnOutside,
      closeOnEscape: spec.closeOnEscape,
    })
  }
  return model
}

describe('floatingLayers', () => {
  it('keeps ancestry when dismissing from an inner layer', () => {
    const model = withLayers([
      { id: 'root' },
      { id: 'child-a', parentId: 'root' },
      { id: 'child-b', parentId: 'root' },
      { id: 'grandchild', parentId: 'child-b' },
    ])
    const result = closeFloatingLayersForOutsideModel(model, 'grandchild')
    expect(result.model.layers.map((layer) => layer.id)).toEqual(['root', 'child-b', 'grandchild'])
    expect(result.closedIds).toEqual(['child-a'])
  })

  it('supports opening a context menu from another context menu', () => {
    const model = withLayers([
      { id: 'root-menu', kind: 'context_menu' },
      { id: 'child-menu', parentId: 'root-menu', kind: 'context_menu' },
    ])
    expect(topmostFloatingLayerModel(model)?.id).toBe('child-menu')
    const result = closeFloatingLayerBranchModel(model, 'root-menu')
    expect(result.model.layers).toEqual([])
    expect(result.closedIds).toEqual(['child-menu', 'root-menu'])
  })

  it('closes an entire branch when a parent closes', () => {
    const model = withLayers([
      { id: 'root' },
      { id: 'child', parentId: 'root' },
      { id: 'grandchild', parentId: 'child' },
    ])
    const result = closeFloatingLayerBranchModel(model, 'child')
    expect(result.model.layers.map((layer) => layer.id)).toEqual(['root'])
    expect(result.closedIds).toEqual(['grandchild', 'child'])
  })

  it('closes all outside-dismissible layers on an outside click', () => {
    const model = withLayers([
      { id: 'root' },
      { id: 'sticky', kind: 'select', closeOnOutside: false },
      { id: 'child', parentId: 'root' },
    ])
    const result = closeFloatingLayersForOutsideModel(model, null)
    expect(result.model.layers.map((layer) => layer.id)).toEqual(['sticky'])
    expect(result.closedIds).toEqual(['child', 'root'])
  })

  it('closes the topmost escapable branch on escape', () => {
    const model = withLayers([
      { id: 'root' },
      { id: 'child', parentId: 'root', closeOnEscape: false },
      { id: 'select', parentId: 'child', kind: 'select' },
    ])
    const result = closeTopmostEscapableFloatingLayerModel(model)
    expect(result.model.layers.map((layer) => layer.id)).toEqual(['root', 'child'])
    expect(result.closedIds).toEqual(['select'])
  })

  it('tracks the most recently opened layer as topmost', () => {
    const model = withLayers([
      { id: 'root' },
      { id: 'select', kind: 'select' },
      { id: 'submenu', parentId: 'root' },
    ])
    expect(topmostFloatingLayerModel(model)?.id).toBe('submenu')
  })

  it('computes branch ancestry for nested layers', () => {
    const model = withLayers([
      { id: 'root' },
      { id: 'submenu', parentId: 'root' },
      { id: 'select', parentId: 'submenu', kind: 'select' },
    ])
    expect([...floatingLayerBranchIds(model, 'select')]).toEqual(['select', 'submenu', 'root'])
  })

  it('can close every layer in one pass', () => {
    const model = withLayers([
      { id: 'root' },
      { id: 'submenu', parentId: 'root' },
      { id: 'select', kind: 'select' },
    ])
    const result = closeAllFloatingLayersModel(model)
    expect(result.model.layers).toEqual([])
    expect(result.closedIds).toEqual(['select', 'submenu', 'root'])
  })
})
