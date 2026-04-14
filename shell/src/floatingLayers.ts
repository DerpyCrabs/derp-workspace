import { createMemo, createSignal, type Accessor } from 'solid-js'

export type FloatingLayerKind = 'context_menu' | 'select'

export type FloatingLayerPlacement = {
  bx: number
  by: number
  bw: number
  bh: number
  gx: number
  gy: number
  gw: number
  gh: number
}

export type FloatingLayerSpec = {
  id: string
  parentId?: string | null
  kind: FloatingLayerKind
  closeOnOutside?: boolean
  closeOnEscape?: boolean
}

export type FloatingLayerRecord = {
  id: string
  parentId: string | null
  kind: FloatingLayerKind
  order: number
  closeOnOutside: boolean
  closeOnEscape: boolean
}

export type FloatingLayerModel = {
  nextOrder: number
  layers: FloatingLayerRecord[]
}

export function createFloatingLayerModel(): FloatingLayerModel {
  return {
    nextOrder: 1,
    layers: [],
  }
}

function normalizeLayerSpec(
  model: FloatingLayerModel,
  spec: FloatingLayerSpec,
): { model: FloatingLayerModel; layer: FloatingLayerRecord } {
  const order = model.nextOrder
  return {
    model: {
      nextOrder: order + 1,
      layers: model.layers,
    },
    layer: {
      id: spec.id,
      parentId: spec.parentId ?? null,
      kind: spec.kind,
      order,
      closeOnOutside: spec.closeOnOutside ?? true,
      closeOnEscape: spec.closeOnEscape ?? true,
    },
  }
}

function descendantIds(layers: readonly FloatingLayerRecord[], id: string): Set<string> {
  const descendants = new Set<string>()
  const queue = [id]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const layer of layers) {
      if (layer.parentId !== current || descendants.has(layer.id)) continue
      descendants.add(layer.id)
      queue.push(layer.id)
    }
  }
  return descendants
}

export function floatingLayerBranchIds(model: FloatingLayerModel, id: string): Set<string> {
  const keep = new Set<string>()
  let current = model.layers.find((layer) => layer.id === id) ?? null
  while (current) {
    keep.add(current.id)
    current = current.parentId ? (model.layers.find((layer) => layer.id === current!.parentId) ?? null) : null
  }
  return keep
}

function closeIdsFromModel(
  model: FloatingLayerModel,
  ids: ReadonlySet<string>,
): { model: FloatingLayerModel; closedIds: string[] } {
  if (ids.size === 0) return { model, closedIds: [] }
  const closedIds = model.layers
    .filter((layer) => ids.has(layer.id))
    .sort((a, b) => b.order - a.order)
    .map((layer) => layer.id)
  return {
    model: {
      nextOrder: model.nextOrder,
      layers: model.layers.filter((layer) => !ids.has(layer.id)),
    },
    closedIds,
  }
}

export function openFloatingLayerModel(
  model: FloatingLayerModel,
  spec: FloatingLayerSpec,
): FloatingLayerModel {
  const normalized = normalizeLayerSpec(model, spec)
  return {
    nextOrder: normalized.model.nextOrder,
    layers: [
      ...normalized.model.layers.filter((layer) => layer.id !== spec.id),
      normalized.layer,
    ],
  }
}

export function closeFloatingLayerBranchModel(
  model: FloatingLayerModel,
  id: string,
): { model: FloatingLayerModel; closedIds: string[] } {
  if (!model.layers.some((layer) => layer.id === id)) return { model, closedIds: [] }
  const ids = descendantIds(model.layers, id)
  ids.add(id)
  return closeIdsFromModel(model, ids)
}

export function closeFloatingLayersByKindModel(
  model: FloatingLayerModel,
  kind: FloatingLayerKind,
): { model: FloatingLayerModel; closedIds: string[] } {
  const ids = new Set(model.layers.filter((layer) => layer.kind === kind).map((layer) => layer.id))
  return closeIdsFromModel(model, ids)
}

export function closeAllFloatingLayersModel(
  model: FloatingLayerModel,
  predicate?: (layer: FloatingLayerRecord) => boolean,
): { model: FloatingLayerModel; closedIds: string[] } {
  const ids = new Set(
    model.layers.filter((layer) => (predicate ? predicate(layer) : true)).map((layer) => layer.id),
  )
  return closeIdsFromModel(model, ids)
}

export function closeFloatingLayersForOutsideModel(
  model: FloatingLayerModel,
  keepLeafId: string | null,
): { model: FloatingLayerModel; closedIds: string[] } {
  const keep = keepLeafId ? floatingLayerBranchIds(model, keepLeafId) : new Set<string>()
  return closeAllFloatingLayersModel(model, (layer) => layer.closeOnOutside && !keep.has(layer.id))
}

export function topmostFloatingLayerModel(model: FloatingLayerModel): FloatingLayerRecord | null {
  let top: FloatingLayerRecord | null = null
  for (const layer of model.layers) {
    if (!top || layer.order > top.order) top = layer
  }
  return top
}

export function closeTopmostEscapableFloatingLayerModel(
  model: FloatingLayerModel,
): { model: FloatingLayerModel; closedIds: string[] } {
  const top = [...model.layers]
    .filter((layer) => layer.closeOnEscape)
    .sort((a, b) => b.order - a.order)[0]
  if (!top) return { model, closedIds: [] }
  return closeFloatingLayerBranchModel(model, top.id)
}

type FloatingLayerSurfaceHit = (target: Node) => boolean

type OpenFloatingLayerSpec = FloatingLayerSpec & {
  onClose?: () => void
}

export type FloatingLayerStoreRecord = FloatingLayerRecord & {
  placement: FloatingLayerPlacement | null
}

export function createFloatingLayerStore() {
  const [model, setModel] = createSignal<FloatingLayerModel>(createFloatingLayerModel())
  const [placementVersion, setPlacementVersion] = createSignal(0)
  const surfaceHits = new Map<string, Set<FloatingLayerSurfaceHit>>()
  const placements = new Map<string, FloatingLayerPlacement>()
  const onClose = new Map<string, () => void>()
  const closing = new Set<string>()

  const layers = createMemo<FloatingLayerStoreRecord[]>(() => {
    void placementVersion()
    return model().layers
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((layer) => ({
        ...layer,
        placement: placements.get(layer.id) ?? null,
      }))
  })

  const topmostLayer = createMemo(() => topmostFloatingLayerModel(model()))

  function finalizeClosed(closedIds: readonly string[]) {
    if (closedIds.length === 0) return false
    const callbacks: Array<() => void> = []
    let placementChanged = false
    for (const id of closedIds) {
      surfaceHits.delete(id)
      if (placements.delete(id)) placementChanged = true
      const cb = onClose.get(id)
      onClose.delete(id)
      if (cb) callbacks.push(cb)
    }
    if (placementChanged) setPlacementVersion((value) => value + 1)
    for (const id of closedIds) {
      closing.add(id)
    }
    try {
      for (const cb of callbacks) cb()
    } finally {
      for (const id of closedIds) {
        closing.delete(id)
      }
    }
    return true
  }

  function applyClose(
    result: { model: FloatingLayerModel; closedIds: string[] },
  ) {
    if (result.closedIds.length === 0) return false
    setModel(result.model)
    return finalizeClosed(result.closedIds)
  }

  function openLayer(spec: OpenFloatingLayerSpec) {
    if (spec.onClose) onClose.set(spec.id, spec.onClose)
    else onClose.delete(spec.id)
    setModel((current) => openFloatingLayerModel(current, spec))
  }

  function closeBranch(id: string) {
    return applyClose(closeFloatingLayerBranchModel(model(), id))
  }

  function closeAll(predicate?: (layer: FloatingLayerRecord) => boolean) {
    return applyClose(closeAllFloatingLayersModel(model(), predicate))
  }

  function closeByKind(kind: FloatingLayerKind) {
    return applyClose(closeFloatingLayersByKindModel(model(), kind))
  }

  function closeTopmostEscapable() {
    return applyClose(closeTopmostEscapableFloatingLayerModel(model()))
  }

  function registerSurface(id: string, hit: FloatingLayerSurfaceHit) {
    const set = surfaceHits.get(id) ?? new Set<FloatingLayerSurfaceHit>()
    set.add(hit)
    surfaceHits.set(id, set)
  }

  function unregisterSurface(id: string, hit: FloatingLayerSurfaceHit) {
    const set = surfaceHits.get(id)
    if (!set) return
    set.delete(hit)
    if (set.size === 0) surfaceHits.delete(id)
  }

  function dismissPointerDown(target: Node | null) {
    const currentLayers = model().layers.slice().sort((a, b) => b.order - a.order)
    let hitLayerId: string | null = null
    if (target) {
      for (const layer of currentLayers) {
        const hits = surfaceHits.get(layer.id)
        if (!hits) continue
        for (const hit of hits) {
          if (hit(target)) {
            hitLayerId = layer.id
            break
          }
        }
        if (hitLayerId) break
      }
    }
    return applyClose(closeFloatingLayersForOutsideModel(model(), hitLayerId))
  }

  function setLayerPlacement(id: string, placement: FloatingLayerPlacement) {
    if (!model().layers.some((layer) => layer.id === id)) return
    const prev = placements.get(id)
    if (
      prev &&
      prev.bx === placement.bx &&
      prev.by === placement.by &&
      prev.bw === placement.bw &&
      prev.bh === placement.bh &&
      prev.gx === placement.gx &&
      prev.gy === placement.gy &&
      prev.gw === placement.gw &&
      prev.gh === placement.gh
    ) {
      return
    }
    placements.set(id, placement)
    setPlacementVersion((value) => value + 1)
  }

  function clearLayerPlacement(id: string) {
    if (!placements.delete(id)) return
    setPlacementVersion((value) => value + 1)
  }

  function hasOpenKind(kind: FloatingLayerKind) {
    return model().layers.some((layer) => layer.kind === kind)
  }

  function hasLayer(id: string) {
    return model().layers.some((layer) => layer.id === id)
  }

  function anyOpen() {
    return model().layers.length > 0
  }

  function topmostLayerKind(): FloatingLayerKind | null {
    return topmostLayer()?.kind ?? null
  }

  return {
    model: model as Accessor<FloatingLayerModel>,
    layers,
    topmostLayer,
    openLayer,
    closeBranch,
    closeAll,
    closeByKind,
    closeTopmostEscapable,
    registerSurface,
    unregisterSurface,
    dismissPointerDown,
    setLayerPlacement,
    clearLayerPlacement,
    hasOpenKind,
    hasLayer,
    anyOpen,
    topmostLayerKind,
    isClosing(id: string) {
      return closing.has(id)
    },
  }
}
