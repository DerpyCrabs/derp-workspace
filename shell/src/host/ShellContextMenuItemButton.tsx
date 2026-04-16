import { Show, type JSX } from 'solid-js'
import type { ShellContextMenuItem } from '@/host/contextMenu'

type ShellContextMenuItemButtonProps = {
  item: ShellContextMenuItem
  highlighted: boolean
  itemIndex: number
  itemIndexDataAttr?: string
  itemActionDataAttr?: string
  onPointerDown?: JSX.EventHandlerUnion<HTMLButtonElement, PointerEvent>
  onMouseDown?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>
}

export function ShellContextMenuItemButton(props: ShellContextMenuItemButtonProps) {
  const dataAttrs = () => ({
    ...(props.itemIndexDataAttr ? { [props.itemIndexDataAttr]: props.itemIndex } : {}),
    ...(props.itemActionDataAttr && props.item.actionId
      ? { [props.itemActionDataAttr]: props.item.actionId }
      : {}),
  })

  return (
    <button
      type="button"
      class="bg-transparent hover:bg-(--shell-overlay-hover) flex w-full cursor-pointer items-center justify-between gap-2 border-0 px-3 py-[0.45rem] text-left font-inherit text-inherit"
      classList={{
        'bg-[color-mix(in_srgb,var(--shell-overlay-active)_78%,var(--shell-accent-soft)_22%)] text-inherit shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]':
          props.highlighted,
        'cursor-not-allowed text-(--shell-text-dim)': !!props.item.disabled,
      }}
      role="menuitem"
      tabIndex={-1}
      title={props.item.title}
      onPointerDown={props.onPointerDown}
      onMouseDown={props.onMouseDown}
      onClick={props.onClick}
      {...dataAttrs()}
    >
      <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {props.item.label}
      </span>
      <Show when={props.item.badge} keyed>
        {(badge) => (
          <span class="border border-(--shell-accent-soft-border) bg-(--shell-accent-soft) text-(--shell-accent-soft-text) shrink-0 rounded px-[0.35rem] py-[0.15rem] text-[0.65rem] tracking-wide uppercase">
            {badge}
          </span>
        )}
      </Show>
    </button>
  )
}
