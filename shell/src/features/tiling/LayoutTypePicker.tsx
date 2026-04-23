import { createMemo, type Accessor, type Component } from 'solid-js'
import { Select } from '@/host/Select'
import type { LayoutType } from './layouts'
import { getMonitorLayout, setMonitorLayout } from './tilingConfig'

const OPTIONS: LayoutType[] = ['manual-snap', 'custom-auto', 'master-stack', 'columns', 'grid']

export const LayoutTypePicker: Component<{
  outputName: string
  revision: Accessor<number>
  onPersisted: () => void
}> = (props) => {
  const value = createMemo(() => {
    props.revision()
    return getMonitorLayout(props.outputName).layout.type
  })

  return (
    <div class="flex flex-col gap-[0.15rem] text-[0.7rem] tracking-wide text-(--shell-text-muted)">
      <span>tiling layout</span>
      <Select
        options={OPTIONS}
        value={value()}
        onChange={(option) => {
          if (value() === option) return
          setMonitorLayout(props.outputName, option as LayoutType)
          props.onPersisted()
        }}
        itemLabel={(option) => String(option)}
        equals={(a, b) => a === b}
        triggerClass="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) min-w-[11rem] max-w-[14rem] cursor-pointer rounded-lg px-3 py-2 text-left font-inherit text-[0.78rem]"
        triggerAttrs={{ 'data-settings-tiling-layout-trigger': true }}
        optionAttrs={(option) => ({ 'data-settings-tiling-layout-option': String(option) })}
      />
    </div>
  )
}
