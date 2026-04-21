import { For, createMemo, splitProps, type JSX } from 'solid-js'
import {
  customSnapZoneId,
  listCustomLayoutZones,
  type CustomLayout,
} from './customLayouts'

export type CustomLayoutPreviewProps = {
  layout: CustomLayout
  selectedZoneId?: string | null
  pickMode?: boolean
  fill?: boolean
  square?: boolean
  class?: string
  style?: JSX.CSSProperties
  onZoneClick?: (zone: { zoneId: string; zone: string }) => void
  onZoneHover?: (zone: { zoneId: string; zone: string } | null) => void
  zoneAttrs?: (zoneId: string) => Record<string, string | undefined>
}

export function CustomLayoutPreview(props: CustomLayoutPreviewProps) {
  const [local, rest] = splitProps(props, [
    'layout',
    'selectedZoneId',
    'pickMode',
    'fill',
    'square',
    'class',
    'style',
    'onZoneClick',
    'onZoneHover',
    'zoneAttrs',
  ])
  const zones = createMemo(() => listCustomLayoutZones(local.layout))

  return (
    <div
      {...rest}
      data-custom-layout-preview={local.layout.id}
      class={`relative w-full overflow-hidden ${local.square ? '' : 'rounded-xl'} border border-(--shell-border) bg-(--shell-surface-inset) ${
        local.fill ? 'h-full' : `aspect-[16/10] ${local.pickMode ? '' : 'min-h-[6rem]'}`
      }${local.class ? ` ${local.class}` : ''}`}
      style={local.style}
      onPointerLeave={() => local.onZoneHover?.(null)}
    >
      <For each={zones()}>
        {(zone, index) => {
          const zoneKey = customSnapZoneId(local.layout.id, zone.zoneId)
          const attrs = local.zoneAttrs?.(zone.zoneId) ?? {}
          return (
            <button
              {...attrs}
              type="button"
              data-custom-layout-zone={zone.zoneId}
              data-custom-layout-zone-key={zoneKey}
              class={`absolute overflow-hidden ${local.square ? '' : 'rounded-lg'} border text-left ${
                local.selectedZoneId === zone.zoneId
                  ? 'border-(--shell-accent-border) bg-(--shell-accent-soft) shadow-[inset_0_0_0_1px_var(--shell-accent-soft-border)]'
                  : 'border-(--shell-border) bg-(--shell-surface-elevated) hover:bg-(--shell-surface)'
              } ${local.pickMode ? 'cursor-pointer' : 'cursor-pointer'}`}
              style={{
                left: `${zone.x * 100}%`,
                top: `${zone.y * 100}%`,
                width: `${zone.width * 100}%`,
                height: `${zone.height * 100}%`,
              }}
              onPointerDown={(event) => {
                if (!local.pickMode) return
                event.preventDefault()
                event.stopPropagation()
                local.onZoneClick?.({ zoneId: zone.zoneId, zone: zoneKey })
              }}
              onPointerEnter={() => local.onZoneHover?.({ zoneId: zone.zoneId, zone: zoneKey })}
              onFocus={() => local.onZoneHover?.({ zoneId: zone.zoneId, zone: zoneKey })}
              onClick={(event) => {
                if (local.pickMode && event.detail !== 0) return
                local.onZoneClick?.({ zoneId: zone.zoneId, zone: zoneKey })
              }}
            >
              <span class="pointer-events-none absolute left-2 top-1.5 text-[0.62rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
                {index() + 1}
              </span>
            </button>
          )
        }}
      </For>
    </div>
  )
}
