import { createMemo, type Accessor, type Component } from 'solid-js'
import type { LayoutType } from './layouts'
import { getMonitorLayout, setMonitorLayout } from './tilingConfig'
import { Select } from '@/host/Select'

const OPTIONS: LayoutType[] = ['manual-snap', 'master-stack', 'columns', 'grid']

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
        onChange={(v) => {
          setMonitorLayout(props.outputName, v as LayoutType)
          props.onPersisted()
        }}
        itemLabel={(v) => String(v)}
        equals={(a, b) => a === b}
        triggerClass="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) min-w-[7.5rem] max-w-[12rem] cursor-pointer rounded px-[0.45rem] py-0.5 text-left font-inherit text-[0.78rem]"
      />
    </div>
  )
}
