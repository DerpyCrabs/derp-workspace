import { describe, expect, it } from 'vitest'
import {
  customLayoutSlotRules,
  listCustomLayoutMergePreviewZoneIds,
  listCustomLayoutZones,
  mergeCustomLayoutZones,
  setCustomLayoutSlotRules,
  type CustomLayout,
} from './customLayouts'

const fourZoneMergeLayout: CustomLayout = {
  id: 'layout-1',
  name: 'Layout 1',
  root: {
    kind: 'split',
    axis: 'vertical',
    ratio: 0.4,
    first: {
      kind: 'leaf',
      zoneId: '1',
    },
    second: {
      kind: 'split',
      axis: 'vertical',
      ratio: 0.6,
      first: {
        kind: 'split',
        axis: 'horizontal',
        ratio: 0.5,
        first: {
          kind: 'leaf',
          zoneId: '2',
        },
        second: {
          kind: 'leaf',
          zoneId: '3',
        },
      },
      second: {
        kind: 'leaf',
        zoneId: '4',
      },
    },
  },
}

const currentScreenshotMergeLayout: CustomLayout = {
  id: 'layout-2',
  name: 'Layout 2',
  root: {
    kind: 'split',
    axis: 'vertical',
    ratio: 0.5,
    first: {
      kind: 'split',
      axis: 'horizontal',
      ratio: 0.294,
      first: {
        kind: 'leaf',
        zoneId: '1',
      },
      second: {
        kind: 'split',
        axis: 'horizontal',
        ratio: 0.575070821529745,
        first: {
          kind: 'leaf',
          zoneId: '2',
        },
        second: {
          kind: 'leaf',
          zoneId: '3',
        },
      },
    },
    second: {
      kind: 'split',
      axis: 'vertical',
      ratio: 0.88,
      first: {
        kind: 'split',
        axis: 'horizontal',
        ratio: 0.355,
        first: {
          kind: 'leaf',
          zoneId: '4',
        },
        second: {
          kind: 'leaf',
          zoneId: '5',
        },
      },
      second: {
        kind: 'leaf',
        zoneId: '6',
      },
    },
  },
}

describe('customLayouts merge', () => {
  it('stores slot rules and drops them when their zone disappears', () => {
    const withRule = setCustomLayoutSlotRules(fourZoneMergeLayout, '2', [
      { field: 'app_id', op: 'equals', value: 'org.desktop.telegram' },
    ])

    expect(customLayoutSlotRules(withRule, '2')).toEqual([
      { field: 'app_id', op: 'equals', value: 'org.desktop.telegram' },
    ])

    const merged = mergeCustomLayoutZones(withRule, '1', '3').layout
    expect(listCustomLayoutZones(merged).map((zone) => zone.zoneId)).toEqual(['1', '4'])
    expect(customLayoutSlotRules(merged, '2')).toEqual([])
  })

  it('previews only zones that share the source edge toward the target', () => {
    expect(listCustomLayoutMergePreviewZoneIds(fourZoneMergeLayout, '1', '3')).toEqual(['1', '2', '3'])
  })

  it('merges only the rectangular run next to the source zone', () => {
    const merged = mergeCustomLayoutZones(fourZoneMergeLayout, '1', '3').layout
    const zones = listCustomLayoutZones(merged)
    expect(zones.map((zone) => zone.zoneId)).toEqual(['1', '4'])
    const mergedZone = zones.find((zone) => zone.zoneId === '1')
    const remainingZone = zones.find((zone) => zone.zoneId === '4')
    expect(mergedZone).toBeTruthy()
    expect(remainingZone).toBeTruthy()
    expect(mergedZone!.x).toBeCloseTo(0)
    expect(mergedZone!.y).toBeCloseTo(0)
    expect(mergedZone!.width).toBeCloseTo(0.76)
    expect(mergedZone!.height).toBeCloseTo(1)
    expect(remainingZone!.x).toBeCloseTo(0.76)
    expect(remainingZone!.y).toBeCloseTo(0)
    expect(remainingZone!.width).toBeCloseTo(0.24)
    expect(remainingZone!.height).toBeCloseTo(1)
  })

  it('merges through intermediate zones to the smallest filled rectangle', () => {
    expect(listCustomLayoutMergePreviewZoneIds(currentScreenshotMergeLayout, '1', '3')).toEqual(['1', '2', '3'])
    const merged = mergeCustomLayoutZones(currentScreenshotMergeLayout, '1', '3').layout
    const zones = listCustomLayoutZones(merged)
    expect(zones.map((zone) => zone.zoneId)).toEqual(['1', '4', '5', '6'])
    const mergedZone = zones.find((zone) => zone.zoneId === '1')
    expect(mergedZone).toBeTruthy()
    expect(mergedZone!.x).toBeCloseTo(0)
    expect(mergedZone!.y).toBeCloseTo(0)
    expect(mergedZone!.width).toBeCloseTo(0.5)
    expect(mergedZone!.height).toBeCloseTo(1)
  })
})
