import FileText from 'lucide-solid/icons/file-text'
import X from 'lucide-solid/icons/x'
import { For, Show } from 'solid-js'
import type { TabMergeTarget } from './tabGroupOps'
import { windowLabel } from './tabGroupOps'

export type WorkspaceTabStripTab = {
  window_id: number
  title: string
  app_id: string
  active: boolean
  pinned: boolean
}

type WorkspaceTabStripProps = {
  groupId: string
  tabs: WorkspaceTabStripTab[]
  dragWindowId: number | null
  dropTarget: TabMergeTarget | null
  suppressClickWindowId: number | null
  onSelectTab: (windowId: number) => void
  onConsumeSuppressedClick: (windowId: number) => void
  onCloseTab: (windowId: number) => void
  onTabPointerDown: (
    windowId: number,
    pointerId: number,
    clientX: number,
    clientY: number,
    button: number,
  ) => void
  onTabContextMenu: (windowId: number, clientX: number, clientY: number) => void
}

export function WorkspaceTabStrip(props: WorkspaceTabStripProps) {
  const dropActive = (insertIndex: number) =>
    props.dragWindowId !== null &&
    props.dropTarget?.groupId === props.groupId &&
    props.dropTarget.insertIndex === insertIndex

  return (
    <div
      class="flex min-w-0 flex-1 items-stretch overflow-hidden"
      data-workspace-tab-strip={props.groupId}
    >
      <For each={props.tabs}>
        {(tab, index) => (
          <>
            <div
              class="h-full w-1.5 shrink-0 bg-transparent transition-all"
              classList={{
                'bg-(--shell-accent)': dropActive(index()),
              }}
              data-tab-drop-slot={`${props.groupId}:${index()}`}
              data-tab-drop-active={dropActive(index()) ? 'true' : 'false'}
            />
            <div
              class="group flex min-w-0 max-w-[240px] flex-[0_1_auto] items-center overflow-hidden border-r border-(--shell-border) transition-colors"
              classList={{
                'bg-(--shell-control-muted-bg) text-(--shell-text)': tab.active,
                'bg-transparent text-(--shell-text-muted) hover:bg-[color-mix(in_srgb,var(--shell-control-muted-bg)_42%,transparent)] hover:text-(--shell-text)':
                  !tab.active,
                'bg-[color-mix(in_srgb,var(--shell-control-muted-bg)_88%,transparent)] text-(--shell-text) opacity-72':
                  props.dragWindowId === tab.window_id,
              }}
            >
              <button
                type="button"
                class="flex min-w-0 flex-1 cursor-grab items-center gap-1.5 truncate px-2.5 py-1.5 text-left text-[11px] font-medium active:cursor-grabbing"
                classList={{
                  'pr-2': tab.pinned,
                }}
                data-workspace-tab={tab.window_id}
                data-workspace-tab-group={props.groupId}
                data-workspace-tab-pinned={tab.pinned ? 'true' : 'false'}
                aria-pressed={tab.active}
                title={windowLabel(tab)}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  props.onTabPointerDown(
                    tab.window_id,
                    event.pointerId,
                    event.clientX,
                    event.clientY,
                    event.button,
                  )
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  props.onTabContextMenu(tab.window_id, event.clientX, event.clientY)
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  if (props.suppressClickWindowId === tab.window_id) {
                    props.onConsumeSuppressedClick(tab.window_id)
                    return
                  }
                  props.onSelectTab(tab.window_id)
                }}
              >
                <span
                  class="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-(--shell-text-dim) transition-colors"
                  classList={{
                    'text-(--shell-text-muted)': !tab.active,
                    'text-(--shell-text)': tab.active || props.dragWindowId === tab.window_id,
                  }}
                  data-workspace-tab-handle={tab.window_id}
                  aria-hidden="true"
                >
                  <FileText class="h-3 w-3" stroke-width={2} />
                </span>
                <span class="flex min-w-0 items-center gap-1">
                  <Show when={tab.pinned}>
                    <span
                      class="h-1.5 w-1.5 shrink-0 rounded-full bg-(--shell-accent)"
                      aria-label="Pinned tab"
                    />
                  </Show>
                  <span class="min-w-0 truncate">{windowLabel(tab)}</span>
                </span>
              </button>
              <Show when={props.tabs.length > 1}>
                <button
                  type="button"
                  class="mr-1 flex h-4.5 w-4.5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-(--shell-text-dim) opacity-70 transition-opacity hover:text-(--shell-text) hover:opacity-100"
                  data-workspace-tab-close={tab.window_id}
                  aria-label={`Close ${windowLabel(tab)}`}
                  title={`Close ${windowLabel(tab)}`}
                  onPointerDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    props.onCloseTab(tab.window_id)
                  }}
                >
                  <X class="h-3.5 w-3.5" stroke-width={2} />
                </button>
              </Show>
            </div>
          </>
        )}
      </For>
      <div
        class="h-full w-1.5 shrink-0 bg-transparent transition-all"
        classList={{
          'bg-(--shell-accent)': dropActive(props.tabs.length),
        }}
        data-tab-drop-slot={`${props.groupId}:${props.tabs.length}`}
        data-tab-drop-active={dropActive(props.tabs.length) ? 'true' : 'false'}
      />
    </div>
  )
}
