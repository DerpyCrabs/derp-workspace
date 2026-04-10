import type { Component } from 'solid-js'
import { Select } from './Select'

const OPTIONS = [
  { v: 0, l: '0°' },
  { v: 1, l: '90°' },
  { v: 2, l: '180°' },
  { v: 3, l: '270°' },
  { v: 4, l: 'flip' },
  { v: 5, l: 'flip 90°' },
  { v: 6, l: 'flip 180°' },
  { v: 7, l: 'flip 270°' },
] as const

const VALUES = OPTIONS.map((o) => o.v)

const TRIGGER_CLASS =
  'shell-btn-muted min-w-[6.5rem] cursor-pointer rounded py-0.5 px-[0.45rem] text-left font-inherit text-[0.78rem]'

export const TransformPicker: Component<{
  value: number
  rowIndex: number
  openIndex: () => number | null
  setOpenIndex: (v: number | null) => void
  onChange: (v: number) => void
}> = (props) => {
  return (
    <Select
      options={VALUES}
      value={props.value}
      onChange={(v) => props.onChange(v as number)}
      itemLabel={(v) => OPTIONS.find((o) => o.v === v)?.l ?? String(v)}
      equals={(a, b) => a === b}
      triggerClass={TRIGGER_CLASS}
      minMenuWidthPx={104}
      open={() => props.openIndex() === props.rowIndex}
      setOpen={(on) => props.setOpenIndex(on ? props.rowIndex : null)}
    />
  )
}
