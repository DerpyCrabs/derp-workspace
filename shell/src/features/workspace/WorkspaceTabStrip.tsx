import FileText from 'lucide-solid/icons/file-text'
import X from 'lucide-solid/icons/x'
import { For, Show, createEffect, createMemo, onCleanup, onMount } from 'solid-js'
import type { TabMergeTarget } from '@/features/workspace/tabGroupOps'
import { windowLabel } from '@/features/workspace/tabGroupOps'

export type WorkspaceTabStripTab = {
  window_id: number
  title: string
  app_id: string
  active: boolean
  pinned: boolean
}

export type WorkspaceTabStripRect = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export type WorkspaceTabStripLayout = {
  groupId: string
  strip: WorkspaceTabStripRect
  slots: Array<{ insertIndex: number; rect: WorkspaceTabStripRect }>
  tabs: Array<{ windowId: number; splitLeft: boolean; rect: WorkspaceTabStripRect }>
}

type WorkspaceTabStripProps = {
  groupId: string
  tabs: WorkspaceTabStripTab[]
  splitLeftWindowId: number | null
  dragWindowId: number | null
  dropTarget: TabMergeTarget | null
  suppressClickWindowId: number | null
  layoutKey?: string | number
  onSelectTab: (windowId: number) => void
  onConsumeSuppressedClick: (windowId: number) => void
  onCloseTab: (windowId: number) => void
  onLayout?: (groupId: string, layout: WorkspaceTabStripLayout | null) => void
  onTabPointerDown: (
    windowId: number,
    pointerId: number,
    clientX: number,
    clientY: number,
    button: number,
  ) => void
  onTabContextMenu: (windowId: number, clientX: number, clientY: number) => void
}

function rectSnapshot(rect: DOMRect): WorkspaceTabStripRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  }
}

export function WorkspaceTabStrip(props: WorkspaceTabStripProps) {
  let root: HTMLDivElement | undefined
  const tabsByWindowId = createMemo(() => {
    const map = new Map<number, WorkspaceTabStripTab>()
    for (const tab of props.tabs) map.set(tab.window_id, tab)
    return map
  })
  const leftTabId = () => props.splitLeftWindowId
  const rightTabIds = () =>
    props.splitLeftWindowId === null
      ? props.tabs.map((tab) => tab.window_id)
      : props.tabs.filter((tab) => tab.window_id !== props.splitLeftWindowId).map((tab) => tab.window_id)

  const insertIndexAfterAllRightTabs = () => {
    let lastRightIndex = -1
    for (let index = 0; index < props.tabs.length; index += 1) {
      if (props.tabs[index].window_id !== props.splitLeftWindowId) lastRightIndex = index
    }
    return lastRightIndex + 1
  }

  const rightStripIndexToInsertIndex = (rightStripIndex: number) => {
    if (props.splitLeftWindowId === null) return rightStripIndex
    const orderedRightTabIds = rightTabIds()
    if (rightStripIndex >= orderedRightTabIds.length) return insertIndexAfterAllRightTabs()
    const targetWindowId = orderedRightTabIds[rightStripIndex]
    const targetIndex = props.tabs.findIndex((tab) => tab.window_id === targetWindowId)
    return targetIndex < 0 ? props.tabs.length : targetIndex
  }

  const dropActive = (displayIndex: number) =>
    props.dragWindowId !== null &&
    props.dropTarget?.groupId === props.groupId &&
    props.dropTarget.insertIndex === rightStripIndexToInsertIndex(displayIndex)

  const publishLayout = () => {
    if (!root || !root.isConnected || !props.onLayout) return
    const slots: WorkspaceTabStripLayout['slots'] = []
    for (const slot of root.querySelectorAll('[data-tab-drop-slot]')) {
      if (!(slot instanceof HTMLElement)) continue
      const value = slot.getAttribute('data-tab-drop-slot')
      const split = value?.lastIndexOf(':') ?? -1
      if (!value || split < 0) continue
      const insertIndex = Number(value.slice(split + 1))
      if (!Number.isFinite(insertIndex)) continue
      slots.push({ insertIndex: Math.trunc(insertIndex), rect: rectSnapshot(slot.getBoundingClientRect()) })
    }
    const tabs: WorkspaceTabStripLayout['tabs'] = []
    for (const tab of root.querySelectorAll('[data-workspace-tab]')) {
      if (!(tab instanceof HTMLElement)) continue
      const windowId = Number(tab.getAttribute('data-workspace-tab'))
      if (!Number.isFinite(windowId)) continue
      tabs.push({
        windowId: Math.trunc(windowId),
        splitLeft: tab.getAttribute('data-workspace-split-left-tab') !== null,
        rect: rectSnapshot(tab.getBoundingClientRect()),
      })
    }
    props.onLayout(props.groupId, {
      groupId: props.groupId,
      strip: rectSnapshot(root.getBoundingClientRect()),
      slots,
      tabs,
    })
  }

  createEffect(() => {
    props.groupId
    props.splitLeftWindowId
    props.layoutKey
    props.tabs.map((tab) => `${tab.window_id}:${tab.title}:${tab.app_id}:${tab.pinned ? 1 : 0}`).join('|')
    publishLayout()
  })

  onMount(() => {
    publishLayout()
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && root ? new ResizeObserver(() => publishLayout()) : null
    if (root) resizeObserver?.observe(root)
    const mutationObserver =
      typeof MutationObserver !== 'undefined' && root
        ? new MutationObserver(() => publishLayout())
        : null
    mutationObserver?.observe(root!, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-tab-drop-slot',
        'data-workspace-tab',
        'data-workspace-tab-group',
        'data-workspace-split-left-tab',
      ],
    })
    onCleanup(() => {
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      props.onLayout?.(props.groupId, null)
    })
  })

  const renderTab = (tab: () => WorkspaceTabStripTab, displayIndex: number, splitLeft: boolean) => (
    <>
      <Show when={!splitLeft}>
        <div
          class="h-full w-1.5 shrink-0 bg-transparent transition-all"
          classList={{
            'bg-(--shell-accent)': dropActive(displayIndex),
          }}
          data-tab-drop-slot={`${props.groupId}:${rightStripIndexToInsertIndex(displayIndex)}`}
          data-tab-drop-active={dropActive(displayIndex) ? 'true' : 'false'}
        />
      </Show>
      <div
        class="group flex min-h-0 min-w-0 flex-[0_1_auto] items-stretch overflow-hidden border-r border-(--shell-border) transition-colors"
        draggable={false}
        style={{ '-webkit-user-drag': 'none' }}
        classList={{
          'bg-(--shell-control-muted-bg) text-(--shell-text)': tab().active,
          'bg-transparent text-(--shell-text-muted) hover:bg-[color-mix(in_srgb,var(--shell-control-muted-bg)_42%,transparent)] hover:text-(--shell-text)':
            !tab().active,
          'bg-[color-mix(in_srgb,var(--shell-control-muted-bg)_88%,transparent)] text-(--shell-text) opacity-72':
            props.dragWindowId === tab().window_id,
          'rounded-l-md border-l border-(--shell-border) bg-[color-mix(in_srgb,var(--shell-control-muted-bg)_55%,transparent)]':
            splitLeft,
          'max-w-[104px]': props.splitLeftWindowId !== null,
          'max-w-[240px]': props.splitLeftWindowId === null,
        }}
      >
        <button
          type="button"
          class="flex h-full min-h-0 min-w-0 flex-1 cursor-grab select-none items-center gap-1.5 truncate px-2.5 py-1 text-left text-[11px] font-medium active:cursor-grabbing"
          draggable={false}
          classList={{
            'cursor-pointer active:cursor-pointer': splitLeft,
            'pr-2': tab().pinned,
          }}
          data-workspace-tab={tab().window_id}
          data-workspace-tab-id={tab().window_id}
          data-workspace-tab-group={props.groupId}
          data-workspace-tab-pinned={tab().pinned ? 'true' : 'false'}
          data-workspace-split-left-tab={splitLeft ? '' : undefined}
          aria-pressed={tab().active}
          title={windowLabel(tab())}
          style={{ '-webkit-user-drag': 'none' }}
          onPointerDown={(event) => {
            if (event.button === 0) event.preventDefault()
            event.stopPropagation()
            if (splitLeft) return
            if (event.button !== 0) return
            props.onTabPointerDown(
              tab().window_id,
              event.pointerId,
              event.clientX,
              event.clientY,
              event.button,
            )
          }}
          onMouseDown={(event) => {
            if (event.button === 0) event.preventDefault()
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.onTabContextMenu(tab().window_id, event.clientX, event.clientY)
          }}
          onDragStart={(event) => {
            event.preventDefault()
          }}
          onClick={(event) => {
            event.stopPropagation()
            if (props.suppressClickWindowId === tab().window_id) {
              props.onConsumeSuppressedClick(tab().window_id)
              return
            }
            props.onSelectTab(tab().window_id)
          }}
        >
          <span
            class="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-(--shell-text-dim) transition-colors"
            draggable={false}
            classList={{
              'text-(--shell-text-muted)': !tab().active,
              'text-(--shell-text)': tab().active || props.dragWindowId === tab().window_id || splitLeft,
            }}
            data-workspace-tab-handle={tab().window_id}
            aria-hidden="true"
          >
            <FileText class="h-3 w-3" stroke-width={2} />
          </span>
          <span class="flex min-w-0 items-center gap-1">
            <Show when={tab().pinned}>
              <span
                class="h-1.5 w-1.5 shrink-0 rounded-full bg-(--shell-accent)"
                draggable={false}
                aria-label="Pinned tab"
              />
            </Show>
            <span class="min-w-0 truncate" draggable={false}>
              {windowLabel(tab())}
            </span>
          </span>
        </button>
        <Show when={props.tabs.length > 1}>
          <button
            type="button"
            class="mr-1 flex h-4.5 w-4.5 shrink-0 cursor-pointer items-center justify-center self-center rounded-sm text-(--shell-text-dim) opacity-70 transition-opacity hover:text-(--shell-text) hover:opacity-100"
            draggable={false}
            data-workspace-tab-close={tab().window_id}
            aria-label={`Close ${windowLabel(tab())}`}
            title={`Close ${windowLabel(tab())}`}
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              props.onCloseTab(tab().window_id)
            }}
            onDragStart={(event) => {
              event.preventDefault()
            }}
          >
            <X class="h-3.5 w-3.5" stroke-width={2} />
          </button>
        </Show>
      </div>
    </>
  )

  return (
    <div
      ref={(el) => {
        root = el
      }}
      class="flex min-w-0 flex-1 select-none items-stretch overflow-hidden"
      data-workspace-tab-strip={props.groupId}
      style={{ '-webkit-user-drag': 'none' }}
      onDragStart={(event) => {
        event.preventDefault()
      }}
    >
      <Show when={leftTabId()}>{(tabId) => renderTab(() => tabsByWindowId().get(tabId())!, 0, true)}</Show>
      <div class="flex min-w-0 flex-1 items-stretch overflow-hidden">
        <For each={rightTabIds()}>
          {(tabId, index) => renderTab(() => tabsByWindowId().get(tabId)!, index(), false)}
        </For>
        <div
          class="h-full w-1.5 shrink-0 bg-transparent transition-all"
          classList={{
            'bg-(--shell-accent)': dropActive(rightTabIds().length),
          }}
          data-tab-drop-slot={`${props.groupId}:${rightStripIndexToInsertIndex(rightTabIds().length)}`}
          data-tab-drop-active={dropActive(rightTabIds().length) ? 'true' : 'false'}
        />
      </div>
    </div>
  )
}
