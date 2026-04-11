import X from 'lucide-solid/icons/x'
import { For, Show } from 'solid-js'
import { windowLabel } from './tabGroupOps'

export type WorkspaceTabStripTab = {
  window_id: number
  title: string
  app_id: string
  active: boolean
}

type WorkspaceTabStripProps = {
  groupId: string
  tabs: WorkspaceTabStripTab[]
  onSelectTab: (windowId: number) => void
  onCloseTab: (windowId: number) => void
}

export function WorkspaceTabStrip(props: WorkspaceTabStripProps) {
  return (
    <div
      class="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
      data-workspace-tab-strip={props.groupId}
    >
      <For each={props.tabs}>
        {(tab) => (
          <div
            class="flex min-w-0 max-w-[220px] flex-[0_1_auto] items-center overflow-hidden rounded-sm border border-(--shell-border)"
            classList={{
              'bg-(--shell-surface-panel) text-(--shell-text)': tab.active,
              'bg-(--shell-control-muted-bg) text-(--shell-text-muted)': !tab.active,
            }}
          >
            <button
              type="button"
              class="min-w-0 flex-1 cursor-pointer truncate px-2 py-1 text-left text-[11px] font-medium"
              data-workspace-tab={tab.window_id}
              data-workspace-tab-group={props.groupId}
              aria-pressed={tab.active}
              title={windowLabel(tab)}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                props.onSelectTab(tab.window_id)
              }}
            >
              {windowLabel(tab)}
            </button>
            <Show when={props.tabs.length > 1}>
              <button
                type="button"
                class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center hover:bg-(--shell-control-muted-hover)"
                data-workspace-tab-close={tab.window_id}
                aria-label={`Close ${windowLabel(tab)}`}
                title={`Close ${windowLabel(tab)}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  props.onCloseTab(tab.window_id)
                }}
              >
                <X class="h-3.5 w-3.5" stroke-width={2} />
              </button>
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}
