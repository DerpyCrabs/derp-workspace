import { createMemo, createSignal, type Accessor, type Component } from 'solid-js'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { LayoutType } from './layouts'
import { getMonitorLayout, setMonitorLayout } from './tilingConfig'

const OPTIONS: LayoutType[] = ['manual-snap', 'master-stack', 'columns', 'grid']

export const LayoutTypePicker: Component<{
  outputName: string
  revision: Accessor<number>
  onPersisted: () => void
}> = (props) => {
  const [open, setOpen] = createSignal(false)
  let suppressClick = false

  const value = createMemo(() => {
    props.revision()
    return getMonitorLayout(props.outputName).layout.type
  })

  const selectOption = (option: LayoutType) => {
    if (value() !== option) {
      setMonitorLayout(props.outputName, option)
      props.onPersisted()
    }
    setOpen(false)
  }

  return (
    <DropdownMenu open={open()} onOpenChange={setOpen}>
      <div class="relative flex flex-col gap-[0.15rem] text-[0.7rem] tracking-wide text-(--shell-text-muted)">
        <span>tiling layout</span>
        <DropdownMenuTrigger
          data-settings-tiling-layout-trigger
          class="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) flex h-9 min-w-[11rem] max-w-[14rem] items-center justify-between gap-3 cursor-pointer rounded-lg px-3 py-2 text-left text-[0.78rem]"
          onMouseUp={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            suppressClick = true
            setOpen(!open())
          }}
          onClick={(event) => {
            if (!suppressClick) return
            suppressClick = false
            event.preventDefault()
          }}
        >
          <span class="min-w-0 flex-1 truncate">{String(value())}</span>
          <span class="shrink-0 text-[0.68rem] text-(--shell-text-dim)">{open() ? '▴' : '▾'}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent class="border border-(--shell-border) bg-(--shell-surface-panel) absolute top-[calc(100%+0.35rem)] left-0 z-90000 min-w-[11rem] rounded-lg py-1 shadow-2xl">
          {OPTIONS.map((option) => (
            <DropdownMenuItem
              data-settings-tiling-layout-option={option}
              classList={{
                'bg-[color-mix(in_srgb,var(--shell-overlay-active)_78%,var(--shell-accent-soft)_22%)] text-(--shell-text) shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]':
                  value() === option,
              }}
              onPointerDown={(event) => {
                if (!event.isPrimary || event.button !== 0) return
                event.preventDefault()
                event.stopPropagation()
                selectOption(option)
              }}
              onMouseDown={(event) => {
                event.preventDefault()
              }}
              onClick={(event) => {
                if (event.detail !== 0) return
                selectOption(option)
              }}
            >
              {String(option)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </div>
    </DropdownMenu>
  )
}
