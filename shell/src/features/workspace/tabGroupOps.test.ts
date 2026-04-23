import { describe, expect, it } from 'vitest'
import {
  clampTabInsertIndex,
  findMergeTarget,
  groupTaskbarLabel,
  insertIndexAfterAllRightTabs,
  leadingPinnedTabCount,
  mergeInsertIndexToRightStripSlot,
  mergeTargetFromElement,
  nextActiveWindowAfterRemoval,
  rightStripIndexToGroupInsertIndex,
  resolveGroupVisibleWindowId,
  tabsInGroup,
} from './tabGroupOps'
import {
  createEmptyWorkspaceState,
  enterWorkspaceSplitView,
  groupIdForWindow,
  mergeWorkspaceGroups,
  reconcileWorkspaceState,
  setWorkspaceActiveTab,
  setWorkspaceWindowPinned,
} from '@/features/workspace/workspaceState'

function makeWindow(window_id: number, title = `Window ${window_id}`, minimized = false) {
  return {
    window_id,
    title,
    app_id: `app.${window_id}`,
    minimized,
  }
}

const OrigElement = globalThis.Element

function asElem(props: Record<string, unknown>): Element {
  return Object.assign(
    Object.create((globalThis as unknown as { Element: { prototype: object } }).Element.prototype),
    props,
  ) as unknown as Element
}

describe('tabGroupOps', () => {
  it('counts leading pinned tabs and clamps inserts after them', () => {
    let state = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2, 3]), 1, 2)
    const groupId = state.groups.find((group) => group.windowIds.includes(2))!.id
    state = mergeWorkspaceGroups(state, 3, 1)
    state = setWorkspaceWindowPinned(state, 2, true)
    state = setWorkspaceWindowPinned(state, 1, true)
    expect(leadingPinnedTabCount(state, groupId)).toBe(2)
    expect(clampTabInsertIndex(state, groupId, 0, false)).toBe(2)
    expect(clampTabInsertIndex(state, groupId, 1, false)).toBe(2)
    expect(clampTabInsertIndex(state, groupId, 1, true)).toBe(1)
  })

  it('returns tabs in the persisted group order', () => {
    const state = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2]), 1, 2)
    const groupId = state.groups.find((group) => group.windowIds.includes(2))!.id
    expect(tabsInGroup([makeWindow(1), makeWindow(2)], state, groupId).map((window) => window.window_id)).toEqual([2, 1])
  })

  it('resolves the active group tab when it is present', () => {
    const merged = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2]), 1, 2)
    const groupId = merged.groups.find((group) => group.windowIds.includes(2))!.id
    const state = setWorkspaceActiveTab(merged, groupId, 1)
    expect(resolveGroupVisibleWindowId(state, groupId, [makeWindow(1), makeWindow(2)])).toBe(1)
  })

  it('skips minimized active tab in favor of first visible member', () => {
    const merged = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2]), 1, 2)
    const groupId = merged.groups.find((group) => group.windowIds.includes(2))!.id
    const state = setWorkspaceActiveTab(merged, groupId, 1)
    expect(
      resolveGroupVisibleWindowId(state, groupId, [
        makeWindow(1, 'One', true),
        makeWindow(2, 'Two', false),
      ]),
    ).toBe(2)
  })

  it('falls back to the first non-minimized member when the active tab is unavailable', () => {
    const state = {
      ...createEmptyWorkspaceState(),
      groups: [{ id: 'group-1', windowIds: [1, 2, 3] }],
      activeTabByGroupId: { 'group-1': 9 },
      nextGroupSeq: 2,
    }
    expect(
      resolveGroupVisibleWindowId(state, 'group-1', [
        makeWindow(1, 'One', true),
        makeWindow(2, 'Two', false),
        makeWindow(3, 'Three', true),
      ]),
    ).toBe(2)
  })

  it('resolves the right tab as visible when split view is active', () => {
    let state = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2]), 1, 2)
    const groupId = groupIdForWindow(state, 2)!
    state = enterWorkspaceSplitView(state, groupId, 2)
    expect(resolveGroupVisibleWindowId(state, groupId, [makeWindow(1), makeWindow(2)])).toBe(1)
  })

  it('picks the next sensible tab after removal', () => {
    const state = {
      ...createEmptyWorkspaceState(),
      groups: [{ id: 'group-1', windowIds: [10, 11, 12] }],
      activeTabByGroupId: { 'group-1': 11 },
      nextGroupSeq: 2,
    }
    expect(nextActiveWindowAfterRemoval(state, 'group-1', 11)).toBe(12)
    expect(nextActiveWindowAfterRemoval(state, 'group-1', 12)).toBe(11)
  })

  it('maps split right-strip indices back to group indices', () => {
    let state = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2, 3]), 1, 2)
    const groupId = groupIdForWindow(state, 2)!
    state = mergeWorkspaceGroups(state, 3, 1)
    state = enterWorkspaceSplitView(state, groupId, 2)
    expect(insertIndexAfterAllRightTabs(state, groupId)).toBe(3)
    expect(rightStripIndexToGroupInsertIndex(state, groupId, 0)).toBe(1)
    expect(rightStripIndexToGroupInsertIndex(state, groupId, 1)).toBe(2)
    expect(mergeInsertIndexToRightStripSlot(state, groupId, 2)).toBe(1)
  })

  it('builds taskbar labels with the hidden-tab count', () => {
    const merged = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2]), 1, 2)
    const groupId = merged.groups.find((group) => group.windowIds.includes(2))!.id
    expect(groupTaskbarLabel(merged, groupId, [makeWindow(1, 'Alpha'), makeWindow(2, 'Beta')])).toBe('Alpha (+1)')
  })

  it('parses tab drop slots from DOM attributes', () => {
    function ElementShim() {}
    ElementShim.prototype = Object.create(Object.getPrototypeOf(Object.prototype))
    globalThis.Element = ElementShim as unknown as typeof globalThis.Element
    try {
      const slot = asElem({
        closest(sel: string) {
          if (sel === '[data-tab-drop-slot]') return this as unknown as Element
          return null
        },
        getAttribute(name: string) {
          return name === 'data-tab-drop-slot' ? 'group-2:3' : null
        },
      })
      const state = reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2])
      expect(mergeTargetFromElement(slot, state, 1, 0)).toEqual({ groupId: 'group-2', insertIndex: 3 })
    } finally {
      globalThis.Element = OrigElement
    }
  })

  it('uses a 40/60 split when choosing before or after the hovered tab', () => {
    function ElementShim() {}
    ElementShim.prototype = Object.create(Object.getPrototypeOf(Object.prototype))
    globalThis.Element = ElementShim as unknown as typeof globalThis.Element
    try {
      const state = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2, 3]), 1, 2)
      const tab = asElem({
        closest(sel: string) {
          if (sel === '[data-workspace-tab]') return this as unknown as Element
          if (sel === '[data-tab-drop-slot]') return null
          return null
        },
        getAttribute(name: string) {
          if (name === 'data-workspace-tab') return '2'
          if (name === 'data-workspace-tab-group') return 'group-2'
          return null
        },
        getBoundingClientRect() {
          return {
            left: 100,
            width: 100,
            top: 0,
            right: 200,
            bottom: 40,
            height: 40,
            x: 100,
            y: 0,
          } as DOMRect
        },
      })
      expect(mergeTargetFromElement(tab, state, 3, 140)).toEqual({ groupId: 'group-2', insertIndex: 0 })
      expect(mergeTargetFromElement(tab, state, 3, 141)).toEqual({ groupId: 'group-2', insertIndex: 1 })
    } finally {
      globalThis.Element = OrigElement
    }
  })

  it('finds the first merge target from document.elementsFromPoint', () => {
    function ElementShim() {}
    ElementShim.prototype = Object.create(Object.getPrototypeOf(Object.prototype))
    globalThis.Element = ElementShim as unknown as typeof globalThis.Element
    const docHolder = globalThis as typeof globalThis & { document?: Document }
    if (!docHolder.document) docHolder.document = {} as Document
    const docAny = docHolder.document as Document & { elementsFromPoint?: (x: number, y: number) => Element[] }
    const orig = docAny.elementsFromPoint
    const slot = asElem({
      closest(sel: string) {
        if (sel === '[data-tab-drop-slot]') return this as unknown as Element
        return null
      },
      getAttribute(name: string) {
        return name === 'data-tab-drop-slot' ? 'group-2:1' : null
      },
    })
    docAny.elementsFromPoint = () => [slot]
    try {
      const state = reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2])
      expect(findMergeTarget(state, 1, 10, 10)).toEqual({ groupId: 'group-2', insertIndex: 1 })
    } finally {
      if (orig) docAny.elementsFromPoint = orig
      else docAny.elementsFromPoint = (() => []) as (x: number, y: number) => Element[]
      globalThis.Element = OrigElement
    }
  })

  it('falls back to drop slot geometry when elementsFromPoint misses', () => {
    function ElementShim() {}
    ElementShim.prototype = Object.create(Object.getPrototypeOf(Object.prototype))
    globalThis.Element = ElementShim as unknown as typeof globalThis.Element
    const docHolder = globalThis as typeof globalThis & { document?: Document }
    if (!docHolder.document) docHolder.document = {} as Document
    const docAny = docHolder.document as Document & {
      elementsFromPoint?: (x: number, y: number) => Element[]
      querySelectorAll?: Document['querySelectorAll']
    }
    const origElementsFromPoint = docAny.elementsFromPoint
    const origQuerySelectorAll = docAny.querySelectorAll
    const overlay = asElem({
      closest() {
        return null
      },
    })
    const slot = asElem({
      closest(sel: string) {
        if (sel === `[data-shell-window-frame="1"]`) return null
        return null
      },
      getAttribute(name: string) {
        return name === 'data-tab-drop-slot' ? 'group-2:1' : null
      },
      getBoundingClientRect() {
        return {
          left: 100,
          top: 20,
          right: 116,
          bottom: 60,
          width: 16,
          height: 40,
          x: 100,
          y: 20,
        } as DOMRect
      },
    })
    docAny.elementsFromPoint = () => [overlay]
    docAny.querySelectorAll = (() => [slot] as unknown as ReturnType<Document['querySelectorAll']>) as Document['querySelectorAll']
    try {
      const state = reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2])
      expect(findMergeTarget(state, 1, 108, 40)).toEqual({ groupId: 'group-2', insertIndex: 1 })
    } finally {
      if (origElementsFromPoint) docAny.elementsFromPoint = origElementsFromPoint
      else docAny.elementsFromPoint = (() => []) as (x: number, y: number) => Element[]
      if (origQuerySelectorAll) docAny.querySelectorAll = origQuerySelectorAll
      else {
        docAny.querySelectorAll = (() => [] as unknown as ReturnType<Document['querySelectorAll']>) as Document['querySelectorAll']
      }
      globalThis.Element = OrigElement
    }
  })

  it('falls back to tab geometry when elementsFromPoint misses', () => {
    function ElementShim() {}
    ElementShim.prototype = Object.create(Object.getPrototypeOf(Object.prototype))
    globalThis.Element = ElementShim as unknown as typeof globalThis.Element
    const docHolder = globalThis as typeof globalThis & { document?: Document }
    if (!docHolder.document) docHolder.document = {} as Document
    const docAny = docHolder.document as Document & {
      elementsFromPoint?: (x: number, y: number) => Element[]
      querySelectorAll?: Document['querySelectorAll']
    }
    const origElementsFromPoint = docAny.elementsFromPoint
    const origQuerySelectorAll = docAny.querySelectorAll
    const overlay = asElem({
      closest() {
        return null
      },
    })
    const tab = asElem({
      closest(sel: string) {
        if (sel === '[data-workspace-tab]') return this as unknown as Element
        if (sel === '[data-tab-drop-slot]') return null
        if (sel === `[data-shell-window-frame="3"]`) return null
        return null
      },
      getAttribute(name: string) {
        if (name === 'data-workspace-tab') return '2'
        if (name === 'data-workspace-tab-group') return 'group-2'
        return null
      },
      getBoundingClientRect() {
        return {
          left: 100,
          top: 20,
          right: 200,
          bottom: 60,
          width: 100,
          height: 40,
          x: 100,
          y: 20,
        } as DOMRect
      },
    })
    docAny.elementsFromPoint = () => [overlay]
    docAny.querySelectorAll = (() => [tab] as unknown as ReturnType<Document['querySelectorAll']>) as Document['querySelectorAll']
    try {
      const state = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2, 3]), 1, 2)
      expect(findMergeTarget(state, 3, 180, 40)).toEqual({ groupId: 'group-2', insertIndex: 1 })
    } finally {
      if (origElementsFromPoint) docAny.elementsFromPoint = origElementsFromPoint
      else docAny.elementsFromPoint = (() => []) as (x: number, y: number) => Element[]
      if (origQuerySelectorAll) docAny.querySelectorAll = origQuerySelectorAll
      else {
        docAny.querySelectorAll = (() => [] as unknown as ReturnType<Document['querySelectorAll']>) as Document['querySelectorAll']
      }
      globalThis.Element = OrigElement
    }
  })

  it('falls back to tab strip geometry when elementsFromPoint misses blank strip area', () => {
    function ElementShim() {}
    ElementShim.prototype = Object.create(Object.getPrototypeOf(Object.prototype))
    globalThis.Element = ElementShim as unknown as typeof globalThis.Element
    const docHolder = globalThis as typeof globalThis & { document?: Document }
    if (!docHolder.document) docHolder.document = {} as Document
    const docAny = docHolder.document as Document & {
      elementsFromPoint?: (x: number, y: number) => Element[]
      querySelectorAll?: Document['querySelectorAll']
    }
    const origElementsFromPoint = docAny.elementsFromPoint
    const origQuerySelectorAll = docAny.querySelectorAll
    const overlay = asElem({
      closest() {
        return null
      },
    })
    const firstTab = asElem({
      getAttribute(name: string) {
        return name === 'data-workspace-split-left-tab' ? null : null
      },
      getBoundingClientRect() {
        return {
          left: 120,
          top: 20,
          right: 180,
          bottom: 60,
          width: 60,
          height: 40,
          x: 120,
          y: 20,
        } as DOMRect
      },
    })
    const secondTab = asElem({
      getAttribute(name: string) {
        return name === 'data-workspace-split-left-tab' ? null : null
      },
      getBoundingClientRect() {
        return {
          left: 184,
          top: 20,
          right: 244,
          bottom: 60,
          width: 60,
          height: 40,
          x: 184,
          y: 20,
        } as DOMRect
      },
    })
    const strip = asElem({
      closest(sel: string) {
        if (sel === `[data-shell-window-frame="3"]`) return null
        return null
      },
      getAttribute(name: string) {
        if (name === 'data-workspace-tab-strip') return 'group-2'
        return null
      },
      getBoundingClientRect() {
        return {
          left: 100,
          top: 20,
          right: 320,
          bottom: 60,
          width: 220,
          height: 40,
          x: 100,
          y: 20,
        } as DOMRect
      },
      querySelectorAll(selector: string) {
        if (selector === '[data-workspace-tab]') {
          return [firstTab, secondTab] as unknown as ReturnType<Element['querySelectorAll']>
        }
        return [] as unknown as ReturnType<Element['querySelectorAll']>
      },
    })
    docAny.elementsFromPoint = () => [overlay]
    docAny.querySelectorAll = ((selector: string) => {
      if (selector === '[data-workspace-tab-strip]') {
        return [strip] as unknown as ReturnType<Document['querySelectorAll']>
      }
      return [] as unknown as ReturnType<Document['querySelectorAll']>
    }) as Document['querySelectorAll']
    try {
      const state = mergeWorkspaceGroups(reconcileWorkspaceState(createEmptyWorkspaceState(), [1, 2, 3]), 1, 2)
      expect(findMergeTarget(state, 3, 292, 40)).toEqual({ groupId: 'group-2', insertIndex: 2 })
    } finally {
      if (origElementsFromPoint) docAny.elementsFromPoint = origElementsFromPoint
      else docAny.elementsFromPoint = (() => []) as (x: number, y: number) => Element[]
      if (origQuerySelectorAll) docAny.querySelectorAll = origQuerySelectorAll
      else {
        docAny.querySelectorAll = (() => [] as unknown as ReturnType<Document['querySelectorAll']>) as Document['querySelectorAll']
      }
      globalThis.Element = OrigElement
    }
  })
})
