import { For, Show } from 'solid-js'
import {
  closeViaShell,
  invokeNotificationActionViaShell,
  type ShellNotificationsState,
} from './notificationsState'

type ShellNotificationLayerProps = {
  notificationsState: () => ShellNotificationsState | null
}

function timeLabel(timestampMs: number | null) {
  if (!timestampMs) return ''
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestampMs) / 1000))
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`
  const deltaMinutes = Math.round(deltaSeconds / 60)
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`
  const deltaHours = Math.round(deltaMinutes / 60)
  if (deltaHours < 24) return `${deltaHours}h ago`
  const deltaDays = Math.round(deltaHours / 24)
  return `${deltaDays}d ago`
}

export function ShellNotificationLayer(props: ShellNotificationLayerProps) {
  return (
    <Show when={props.notificationsState()?.enabled !== false && (props.notificationsState()?.active.length ?? 0) > 0}>
      <div class="pointer-events-none fixed top-4 right-4 z-[470050] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
        <For each={props.notificationsState()?.active ?? []}>
          {(notification) => {
            const defaultAction = () => notification.actions.find((action) => action.key === 'default') ?? null
            return (
              <section
                data-shell-notification={notification.id}
                class="pointer-events-auto rounded-2xl border border-(--shell-border-strong) bg-(--shell-surface-elevated) p-3 text-(--shell-text) shadow-[0_20px_55px_rgba(0,0,0,0.24)] backdrop-blur"
              >
                <div
                  role={defaultAction() ? 'button' : undefined}
                  tabindex={defaultAction() ? 0 : undefined}
                  data-shell-notification-default={defaultAction()?.key ? notification.id : undefined}
                  class="block w-full cursor-pointer text-left"
                  onClick={() => {
                    const action = defaultAction()
                    if (!action) return
                    void invokeNotificationActionViaShell(notification.id, action.key, 'shell_ui')
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    const action = defaultAction()
                    if (!action) return
                    event.preventDefault()
                    void invokeNotificationActionViaShell(notification.id, action.key, 'shell_ui')
                  }}
                >
                  <div class="flex items-start gap-3">
                    <div class="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-(--shell-accent-soft) text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-(--shell-accent-soft-text)">
                      {(notification.app_name || notification.summary || '?').slice(0, 2).toUpperCase()}
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <p class="truncate text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-(--shell-text-dim)">
                            {notification.app_name || (notification.source === 'native' ? 'Native app' : 'Shell app')}
                          </p>
                          <p class="mt-1 line-clamp-2 text-[0.92rem] font-semibold text-(--shell-text)">
                            {notification.summary}
                          </p>
                        </div>
                        <button
                          type="button"
                          data-shell-notification-dismiss={notification.id}
                          class="cursor-pointer rounded-lg border border-(--shell-border) bg-(--shell-control-muted-bg) px-2 py-1 text-[0.72rem] font-medium text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover)"
                          onClick={(event) => {
                            event.stopPropagation()
                            void closeViaShell(notification.id, { reason: 2, source: 'shell_ui' })
                          }}
                        >
                          Dismiss
                        </button>
                      </div>
                      <Show when={notification.body}>
                        <p class="mt-2 whitespace-pre-wrap text-[0.82rem] leading-relaxed text-(--shell-text-muted)">
                          {notification.body}
                        </p>
                      </Show>
                      <div class="mt-3 flex flex-wrap items-center gap-2">
                        <For each={notification.actions.filter((action) => action.key !== 'default')}>
                          {(action) => (
                            <button
                              type="button"
                              data-shell-notification-action={`${notification.id}:${action.key}`}
                              class="cursor-pointer rounded-lg border border-(--shell-accent-border) bg-(--shell-accent) px-2.5 py-1.5 text-[0.74rem] font-medium text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover)"
                              onClick={(event) => {
                                event.stopPropagation()
                                void invokeNotificationActionViaShell(notification.id, action.key, 'shell_ui')
                              }}
                            >
                              {action.label}
                            </button>
                          )}
                        </For>
                        <span class="ml-auto text-[0.72rem] text-(--shell-text-dim)">
                          {timeLabel(notification.updated_at_ms)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
