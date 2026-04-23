import type { Rect } from './tileZones'

export type CustomLayoutSplitAxis = 'horizontal' | 'vertical'
export type CustomLayoutSplitPlacement = 'first' | 'second'

export type CustomLayoutNode =
  | {
      kind: 'leaf'
      zoneId: string
    }
  | {
      kind: 'split'
      axis: CustomLayoutSplitAxis
      ratio: number
      first: CustomLayoutNode
      second: CustomLayoutNode
    }

export type CustomLayout = {
  id: string
  name: string
  root: CustomLayoutNode
  slotRules?: Record<string, CustomLayoutSlotRule[]>
}

export type CustomLayoutSlotRuleField = 'app_id' | 'title' | 'x11_class' | 'x11_instance' | 'kind'
export type CustomLayoutSlotRuleOp = 'equals' | 'contains' | 'starts_with'

export type CustomLayoutSlotRule = {
  field: CustomLayoutSlotRuleField
  op: CustomLayoutSlotRuleOp
  value: string
}

export type CustomLayoutZoneRect = {
  zoneId: string
  x: number
  y: number
  width: number
  height: number
}

export type CustomLayoutSplitHandleRect = {
  path: string
  axis: CustomLayoutSplitAxis
  ratio: number
  x: number
  y: number
  width: number
  height: number
  parentX: number
  parentY: number
  parentWidth: number
  parentHeight: number
}

const CUSTOM_LAYOUT_ID_PREFIX = 'custom-layout-'
const CUSTOM_ZONE_ID_PREFIX = 'zone-'
const CUSTOM_SNAP_ZONE_PREFIX = 'custom:'
const CUSTOM_LAYOUT_EPSILON = 0.0001
const CUSTOM_LAYOUT_RULE_FIELDS: CustomLayoutSlotRuleField[] = ['app_id', 'title', 'x11_class', 'x11_instance', 'kind']
const CUSTOM_LAYOUT_RULE_OPS: CustomLayoutSlotRuleOp[] = ['equals', 'contains', 'starts_with']

function nextId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`
}

export function createCustomLayout(name = 'Custom layout'): CustomLayout {
  return {
    id: nextId(CUSTOM_LAYOUT_ID_PREFIX),
    name,
    root: {
      kind: 'split',
      axis: 'vertical',
      ratio: 0.5,
      first: {
        kind: 'leaf',
        zoneId: nextId(CUSTOM_ZONE_ID_PREFIX),
      },
      second: {
        kind: 'leaf',
        zoneId: nextId(CUSTOM_ZONE_ID_PREFIX),
      },
    },
  }
}

export function clampCustomLayoutRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(0.9, Math.max(0.1, value))
}

export function renameCustomLayout(layout: CustomLayout, name: string): CustomLayout {
  const nextName = name.trim()
  return {
    ...layout,
    name: nextName.length > 0 ? nextName : layout.name,
  }
}

function sanitizeSlotRule(value: unknown): CustomLayoutSlotRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const field = typeof row.field === 'string' ? row.field : ''
  const op = typeof row.op === 'string' ? row.op : ''
  const rawValue = typeof row.value === 'string' ? row.value.trim() : ''
  return {
    field: CUSTOM_LAYOUT_RULE_FIELDS.includes(field as CustomLayoutSlotRuleField)
      ? field as CustomLayoutSlotRuleField
      : 'app_id',
    op: CUSTOM_LAYOUT_RULE_OPS.includes(op as CustomLayoutSlotRuleOp)
      ? op as CustomLayoutSlotRuleOp
      : 'equals',
    value: rawValue.slice(0, 256),
  }
}

export function sanitizeCustomLayoutSlotRules(
  value: unknown,
  zoneIds: readonly string[],
): Record<string, CustomLayoutSlotRule[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const zoneSet = new Set(zoneIds)
  const out: Record<string, CustomLayoutSlotRule[]> = {}
  for (const [zoneId, rawRules] of Object.entries(value as Record<string, unknown>)) {
    if (!zoneSet.has(zoneId) || !Array.isArray(rawRules)) continue
    const rules = rawRules
      .map(sanitizeSlotRule)
      .filter((rule): rule is CustomLayoutSlotRule => rule !== null)
      .slice(0, 16)
    if (rules.length > 0) out[zoneId] = rules
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function customLayoutSlotRules(
  layout: CustomLayout,
  zoneId: string,
): CustomLayoutSlotRule[] {
  return layout.slotRules?.[zoneId] ?? []
}

export function setCustomLayoutSlotRules(
  layout: CustomLayout,
  zoneId: string,
  rules: CustomLayoutSlotRule[],
): CustomLayout {
  if (!containsZoneId(layout.root, zoneId)) return layout
  const sanitized = sanitizeCustomLayoutSlotRules(
    { ...(layout.slotRules ?? {}), [zoneId]: rules },
    listCustomLayoutZones(layout).map((zone) => zone.zoneId),
  )
  return {
    ...layout,
    ...(sanitized ? { slotRules: sanitized } : { slotRules: undefined }),
  }
}

function splitLeafNode(
  node: CustomLayoutNode,
  zoneId: string,
  axis: CustomLayoutSplitAxis,
  ratio: number,
  placement: CustomLayoutSplitPlacement,
): { node: CustomLayoutNode; nextZoneId: string | null; changed: boolean } {
  if (node.kind === 'leaf') {
    if (node.zoneId !== zoneId) {
      return { node, nextZoneId: null, changed: false }
    }
    const nextZoneId = nextId(CUSTOM_ZONE_ID_PREFIX)
    const nextLeaf: CustomLayoutNode = {
      kind: 'leaf',
      zoneId: nextZoneId,
    }
    return {
      node: {
        kind: 'split',
        axis,
        ratio: clampCustomLayoutRatio(ratio),
        first: placement === 'first' ? nextLeaf : node,
        second: placement === 'first' ? node : nextLeaf,
      },
      nextZoneId,
      changed: true,
    }
  }
  const first = splitLeafNode(node.first, zoneId, axis, ratio, placement)
  if (first.changed) {
    return {
      node: {
        ...node,
        first: first.node,
      },
      nextZoneId: first.nextZoneId,
      changed: true,
    }
  }
  const second = splitLeafNode(node.second, zoneId, axis, ratio, placement)
  if (!second.changed) {
    return { node, nextZoneId: null, changed: false }
  }
  return {
    node: {
      ...node,
      second: second.node,
    },
    nextZoneId: second.nextZoneId,
    changed: true,
  }
}

export function splitCustomLayoutZone(
  layout: CustomLayout,
  zoneId: string,
  axis: CustomLayoutSplitAxis,
  ratio: number,
  placement: CustomLayoutSplitPlacement = 'second',
): { layout: CustomLayout; nextZoneId: string | null } {
  const next = splitLeafNode(layout.root, zoneId, axis, ratio, placement)
  if (!next.changed) return { layout, nextZoneId: null }
  return {
    layout: {
      ...layout,
      root: next.node,
    },
    nextZoneId: next.nextZoneId,
  }
}

function removeLeafNode(
  node: CustomLayoutNode,
  zoneId: string,
): { node: CustomLayoutNode | null; siblingZoneId: string | null; changed: boolean } {
  if (node.kind === 'leaf') {
    if (node.zoneId !== zoneId) return { node, siblingZoneId: null, changed: false }
    return { node: null, siblingZoneId: null, changed: true }
  }
  if (containsZoneId(node.first, zoneId)) {
    const first = removeLeafNode(node.first, zoneId)
    if (!first.changed) return { node, siblingZoneId: null, changed: false }
    if (first.node === null) {
      return {
        node: node.second,
        siblingZoneId: firstLeafZoneId(node.second),
        changed: true,
      }
    }
    return {
      node: {
        ...node,
        first: first.node,
      },
      siblingZoneId: first.siblingZoneId,
      changed: true,
    }
  }
  const second = removeLeafNode(node.second, zoneId)
  if (!second.changed) return { node, siblingZoneId: null, changed: false }
  if (second.node === null) {
    return {
      node: node.first,
      siblingZoneId: firstLeafZoneId(node.first),
      changed: true,
    }
  }
  return {
    node: {
      ...node,
      second: second.node,
    },
    siblingZoneId: second.siblingZoneId,
    changed: true,
  }
}

export function removeCustomLayoutZone(
  layout: CustomLayout,
  zoneId: string,
): { layout: CustomLayout; nextZoneId: string | null } {
  if (layout.root.kind === 'leaf') return { layout, nextZoneId: layout.root.zoneId }
  const next = removeLeafNode(layout.root, zoneId)
  if (!next.changed || next.node === null) {
    return { layout, nextZoneId: firstLeafZoneId(layout.root) }
  }
  const nextLayout = {
    ...layout,
    root: next.node,
  }
  const zoneIds = listCustomLayoutZones(nextLayout).map((zone) => zone.zoneId)
  return {
    layout: {
      ...nextLayout,
      slotRules: sanitizeCustomLayoutSlotRules(nextLayout.slotRules, zoneIds),
    },
    nextZoneId: next.siblingZoneId ?? firstLeafZoneId(next.node),
  }
}

export function customSnapZoneId(layoutId: string, zoneId: string): string {
  return `${CUSTOM_SNAP_ZONE_PREFIX}${layoutId}:${zoneId}`
}

export function parseCustomSnapZoneId(zone: string): { layoutId: string; zoneId: string } | null {
  if (!zone.startsWith(CUSTOM_SNAP_ZONE_PREFIX)) return null
  const payload = zone.slice(CUSTOM_SNAP_ZONE_PREFIX.length)
  const sep = payload.indexOf(':')
  if (sep <= 0 || sep >= payload.length - 1) return null
  const layoutId = payload.slice(0, sep).trim()
  const zoneId = payload.slice(sep + 1).trim()
  if (!layoutId || !zoneId) return null
  return { layoutId, zoneId }
}

export function isCustomSnapZoneId(zone: string): boolean {
  return parseCustomSnapZoneId(zone) !== null
}

export function containsZoneId(node: CustomLayoutNode, zoneId: string): boolean {
  if (node.kind === 'leaf') return node.zoneId === zoneId
  return containsZoneId(node.first, zoneId) || containsZoneId(node.second, zoneId)
}

export function firstLeafZoneId(node: CustomLayoutNode): string {
  return node.kind === 'leaf' ? node.zoneId : firstLeafZoneId(node.first)
}

export function listCustomLayoutZones(layout: CustomLayout): CustomLayoutZoneRect[] {
  const out: CustomLayoutZoneRect[] = []

  const visit = (node: CustomLayoutNode, x: number, y: number, width: number, height: number) => {
    if (node.kind === 'leaf') {
      out.push({ zoneId: node.zoneId, x, y, width, height })
      return
    }
    if (node.axis === 'vertical') {
      const firstWidth = width * clampCustomLayoutRatio(node.ratio)
      visit(node.first, x, y, firstWidth, height)
      visit(node.second, x + firstWidth, y, width - firstWidth, height)
      return
    }
    const firstHeight = height * clampCustomLayoutRatio(node.ratio)
    visit(node.first, x, y, width, firstHeight)
    visit(node.second, x, y + firstHeight, width, height - firstHeight)
  }

  visit(layout.root, 0, 0, 1, 1)
  return out
}

export function listCustomLayoutSplitHandles(layout: CustomLayout): CustomLayoutSplitHandleRect[] {
  const out: CustomLayoutSplitHandleRect[] = []

  const visit = (node: CustomLayoutNode, path: string, x: number, y: number, width: number, height: number) => {
    if (node.kind === 'leaf') return
    if (node.axis === 'vertical') {
      const firstWidth = width * clampCustomLayoutRatio(node.ratio)
      const secondWidth = width - firstWidth
      out.push({
        path,
        axis: node.axis,
        ratio: node.ratio,
        x: x + firstWidth,
        y,
        width: 0,
        height,
        parentX: x,
        parentY: y,
        parentWidth: width,
        parentHeight: height,
      })
      visit(node.first, `${path}f`, x, y, firstWidth, height)
      visit(node.second, `${path}s`, x + firstWidth, y, secondWidth, height)
      return
    }
    const firstHeight = height * clampCustomLayoutRatio(node.ratio)
    const secondHeight = height - firstHeight
    out.push({
      path,
      axis: node.axis,
      ratio: node.ratio,
      x,
      y: y + firstHeight,
      width,
      height: 0,
      parentX: x,
      parentY: y,
      parentWidth: width,
      parentHeight: height,
    })
    visit(node.first, `${path}f`, x, y, width, firstHeight)
    visit(node.second, `${path}s`, x, y + firstHeight, width, secondHeight)
  }

  visit(layout.root, '', 0, 0, 1, 1)
  return out
}

function updateSplitRatioAtPath(
  node: CustomLayoutNode,
  path: string,
  ratio: number,
): { node: CustomLayoutNode; changed: boolean } {
  if (node.kind === 'leaf') return { node, changed: false }
  if (path.length === 0) {
    const nextRatio = clampCustomLayoutRatio(ratio)
    if (Math.abs(nextRatio - node.ratio) < 0.0001) return { node, changed: false }
    return {
      node: {
        ...node,
        ratio: nextRatio,
      },
      changed: true,
    }
  }
  const branch = path[0]
  const rest = path.slice(1)
  if (branch === 'f') {
    const next = updateSplitRatioAtPath(node.first, rest, ratio)
    if (!next.changed) return { node, changed: false }
    return {
      node: {
        ...node,
        first: next.node,
      },
      changed: true,
    }
  }
  if (branch === 's') {
    const next = updateSplitRatioAtPath(node.second, rest, ratio)
    if (!next.changed) return { node, changed: false }
    return {
      node: {
        ...node,
        second: next.node,
      },
      changed: true,
    }
  }
  return { node, changed: false }
}

export function updateCustomLayoutSplitRatio(layout: CustomLayout, path: string, ratio: number): CustomLayout {
  const next = updateSplitRatioAtPath(layout.root, path, ratio)
  if (!next.changed) return layout
  return {
    ...layout,
    root: next.node,
  }
}

function approximatelyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= CUSTOM_LAYOUT_EPSILON
}

function zoneRectArea(rect: Pick<CustomLayoutZoneRect, 'width' | 'height'>): number {
  return rect.width * rect.height
}

function zoneRectBounds(rects: readonly CustomLayoutZoneRect[]): Omit<CustomLayoutZoneRect, 'zoneId'> | null {
  if (rects.length === 0) return null
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }
}

function buildCustomLayoutNodeFromRects(rects: readonly CustomLayoutZoneRect[]): CustomLayoutNode | null {
  if (rects.length === 0) return null
  if (rects.length === 1) {
    return {
      kind: 'leaf',
      zoneId: rects[0]!.zoneId,
    }
  }
  const bounds = zoneRectBounds(rects)
  if (!bounds) return null
  const right = bounds.x + bounds.width
  const bottom = bounds.y + bounds.height
  const verticalCuts = [...new Set(rects.flatMap((rect) => [rect.x, rect.x + rect.width]))]
    .filter((cut) => cut > bounds.x + CUSTOM_LAYOUT_EPSILON && cut < right - CUSTOM_LAYOUT_EPSILON)
    .sort((a, b) => a - b)
  for (const cut of verticalCuts) {
    const firstRects = rects.filter((rect) => rect.x + rect.width <= cut + CUSTOM_LAYOUT_EPSILON)
    const secondRects = rects.filter((rect) => rect.x >= cut - CUSTOM_LAYOUT_EPSILON)
    if (firstRects.length === 0 || secondRects.length === 0 || firstRects.length + secondRects.length !== rects.length) continue
    const first = buildCustomLayoutNodeFromRects(firstRects)
    const second = buildCustomLayoutNodeFromRects(secondRects)
    if (!first || !second) continue
    return {
      kind: 'split',
      axis: 'vertical',
      ratio: clampCustomLayoutRatio((cut - bounds.x) / bounds.width),
      first,
      second,
    }
  }
  const horizontalCuts = [...new Set(rects.flatMap((rect) => [rect.y, rect.y + rect.height]))]
    .filter((cut) => cut > bounds.y + CUSTOM_LAYOUT_EPSILON && cut < bottom - CUSTOM_LAYOUT_EPSILON)
    .sort((a, b) => a - b)
  for (const cut of horizontalCuts) {
    const firstRects = rects.filter((rect) => rect.y + rect.height <= cut + CUSTOM_LAYOUT_EPSILON)
    const secondRects = rects.filter((rect) => rect.y >= cut - CUSTOM_LAYOUT_EPSILON)
    if (firstRects.length === 0 || secondRects.length === 0 || firstRects.length + secondRects.length !== rects.length) continue
    const first = buildCustomLayoutNodeFromRects(firstRects)
    const second = buildCustomLayoutNodeFromRects(secondRects)
    if (!first || !second) continue
    return {
      kind: 'split',
      axis: 'horizontal',
      ratio: clampCustomLayoutRatio((cut - bounds.y) / bounds.height),
      first,
      second,
    }
  }
  return null
}

function resolveMinimalMergeZoneIds(
  layout: CustomLayout,
  firstZoneId: string,
  secondZoneId: string,
): string[] | null {
  const zones = listCustomLayoutZones(layout)
  const sourceIndex = zones.findIndex((zone) => zone.zoneId === firstZoneId)
  const targetIndex = zones.findIndex((zone) => zone.zoneId === secondZoneId)
  if (sourceIndex < 0 || targetIndex < 0) return null
  let best: { area: number; count: number; zoneIds: string[] } | null = null
  const zoneCount = zones.length
  const sourceBit = 1 << sourceIndex
  const targetBit = 1 << targetIndex
  for (let mask = 1; mask < 1 << zoneCount; mask += 1) {
    if ((mask & sourceBit) === 0 || (mask & targetBit) === 0) continue
    const subset = zones.filter((_, index) => (mask & (1 << index)) !== 0)
    const bounds = zoneRectBounds(subset)
    if (!bounds) continue
    const filledArea = subset.reduce((sum, zone) => sum + zoneRectArea(zone), 0)
    const boundsArea = zoneRectArea(bounds)
    if (Math.abs(filledArea - boundsArea) > CUSTOM_LAYOUT_EPSILON) continue
    if (
      !best ||
      boundsArea < best.area - CUSTOM_LAYOUT_EPSILON ||
      (approximatelyEqual(boundsArea, best.area) && subset.length < best.count)
    ) {
      best = {
        area: boundsArea,
        count: subset.length,
        zoneIds: subset.map((zone) => zone.zoneId),
      }
    }
  }
  return best?.zoneIds ?? null
}

function resolveMergePlan(
  layout: CustomLayout,
  firstZoneId: string,
  secondZoneId: string,
): { zoneIds: string[]; nextRoot: CustomLayoutNode } | null {
  const zones = listCustomLayoutZones(layout)
  const orderedZoneIds = resolveMinimalMergeZoneIds(layout, firstZoneId, secondZoneId)
  if (!orderedZoneIds) return null
  const mergedZones = zones.filter((zone) => orderedZoneIds.includes(zone.zoneId))
  const mergedBounds = zoneRectBounds(mergedZones)
  if (!mergedBounds) return null
  const mergedArea = mergedZones.reduce((sum, zone) => sum + zoneRectArea(zone), 0)
  if (Math.abs(mergedArea - zoneRectArea(mergedBounds)) > CUSTOM_LAYOUT_EPSILON) return null
  const nextRects = [
    ...zones.filter((zone) => !orderedZoneIds.includes(zone.zoneId)),
    {
      zoneId: firstZoneId,
      ...mergedBounds,
    },
  ]
  const nextRoot = buildCustomLayoutNodeFromRects(nextRects)
  if (!nextRoot) return null
  return {
    zoneIds: orderedZoneIds,
    nextRoot,
  }
}

export function mergeCustomLayoutZones(
  layout: CustomLayout,
  firstZoneId: string,
  secondZoneId: string,
): { layout: CustomLayout; nextZoneId: string | null } {
  if (firstZoneId === secondZoneId) return { layout, nextZoneId: firstZoneId }
  if (!containsZoneId(layout.root, firstZoneId) || !containsZoneId(layout.root, secondZoneId)) {
    return { layout, nextZoneId: firstZoneId }
  }
  const next = resolveMergePlan(layout, firstZoneId, secondZoneId)
  if (!next) return { layout, nextZoneId: firstZoneId }
  return {
    layout: {
      ...layout,
      root: next.nextRoot,
      slotRules: sanitizeCustomLayoutSlotRules(
        layout.slotRules,
        listCustomLayoutZones({ ...layout, root: next.nextRoot }).map((zone) => zone.zoneId),
      ),
    },
    nextZoneId: firstZoneId,
  }
}

export function listCustomLayoutMergePreviewZoneIds(
  layout: CustomLayout,
  firstZoneId: string,
  secondZoneId: string,
): string[] {
  if (firstZoneId === secondZoneId) return [firstZoneId]
  if (!containsZoneId(layout.root, firstZoneId) || !containsZoneId(layout.root, secondZoneId)) return []
  return resolveMergePlan(layout, firstZoneId, secondZoneId)?.zoneIds ?? []
}

function normalizedRectToBounds(rect: CustomLayoutZoneRect, workArea: Rect): Rect {
  const left = workArea.x + Math.round(rect.x * workArea.width)
  const top = workArea.y + Math.round(rect.y * workArea.height)
  const right = workArea.x + Math.round((rect.x + rect.width) * workArea.width)
  const bottom = workArea.y + Math.round((rect.y + rect.height) * workArea.height)
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  }
}

export function resolveCustomLayoutZoneBounds(
  layouts: readonly CustomLayout[],
  zone: string,
  workArea: Rect,
): Rect | null {
  const parsed = parseCustomSnapZoneId(zone)
  if (!parsed) return null
  const layout = layouts.find((entry) => entry.id === parsed.layoutId)
  if (!layout) return null
  const zoneRect = listCustomLayoutZones(layout).find((entry) => entry.zoneId === parsed.zoneId)
  if (!zoneRect) return null
  return normalizedRectToBounds(zoneRect, workArea)
}

export function resolveCustomLayoutZoneAtPoint(
  layout: CustomLayout,
  workArea: Rect,
  px: number,
  py: number,
): { zoneId: string; zone: string; bounds: Rect } | null {
  const zones = listCustomLayoutZones(layout)
  for (const zone of zones) {
    const bounds = normalizedRectToBounds(zone, workArea)
    if (
      px >= bounds.x &&
      px <= bounds.x + bounds.width &&
      py >= bounds.y &&
      py <= bounds.y + bounds.height
    ) {
      return {
        zoneId: zone.zoneId,
        zone: customSnapZoneId(layout.id, zone.zoneId),
        bounds,
      }
    }
  }
  return null
}

function sanitizeNode(value: unknown): CustomLayoutNode | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.kind === 'leaf') {
    const zoneId = typeof row.zoneId === 'string' ? row.zoneId.trim() : ''
    if (!zoneId) return null
    return {
      kind: 'leaf',
      zoneId,
    }
  }
  if (row.kind !== 'split') return null
  const axis = row.axis === 'horizontal' || row.axis === 'vertical' ? row.axis : null
  if (!axis) return null
  const first = sanitizeNode(row.first)
  const second = sanitizeNode(row.second)
  if (!first || !second) return null
  const ratio = clampCustomLayoutRatio(typeof row.ratio === 'number' ? row.ratio : Number(row.ratio))
  return {
    kind: 'split',
    axis,
    ratio,
    first,
    second,
  }
}

export function sanitizeCustomLayouts(value: unknown): CustomLayout[] {
  if (!Array.isArray(value)) return []
  const out: CustomLayout[] = []
  const seenLayoutIds = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    const root = sanitizeNode(row.root)
    if (!id || !name || !root || seenLayoutIds.has(id)) continue
    const zones = listCustomLayoutZones({ id, name, root })
    const zoneIds = new Set<string>()
    let valid = true
    for (const zone of zones) {
      if (zoneIds.has(zone.zoneId)) {
        valid = false
        break
      }
      zoneIds.add(zone.zoneId)
    }
    if (!valid || zones.length === 0) continue
    seenLayoutIds.add(id)
    const slotRules = sanitizeCustomLayoutSlotRules(row.slotRules, zones.map((zone) => zone.zoneId))
    out.push(slotRules ? { id, name, root, slotRules } : { id, name, root })
  }
  return out
}
