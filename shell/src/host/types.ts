import type { AssistGridShape, AssistGridSpan } from '@/features/tiling/assistGrid'
import type { CustomLayout } from '@/features/tiling/customLayouts'

export type LayoutScreen = {
  name: string
  identity?: string
  x: number
  y: number
  width: number
  height: number
  usable_x?: number
  usable_y?: number
  usable_width?: number
  usable_height?: number
  physical_width: number
  physical_height: number
  transform: number
  refresh_milli_hz: number
  vrr_supported: boolean
  vrr_enabled: boolean
  taskbar_side: TaskbarSide
  taskbar_programs: boolean
  taskbar_osk: boolean
  taskbar_keyboard_layout: boolean
  taskbar_clock: boolean
}

export type TaskbarSide = 'bottom' | 'top' | 'left' | 'right'

export type ExclusionHudZone = {
  label: string
  x: number
  y: number
  w: number
  h: number
}

export type AssistOverlayState =
  | {
      kind: 'assist'
      shape: AssistGridShape
      gutterPx: number
      hoverSpan: AssistGridSpan | null
      workCanvas: { x: number; y: number; w: number; h: number }
    }
  | {
      kind: 'custom'
      layout: CustomLayout
      selectedZoneId: string | null
      workCanvas: { x: number; y: number; w: number; h: number }
    }

export type SnapAssistPickerAnchorRect = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export type SnapAssistPickerSource = 'button' | 'strip'

export type SnapAssistPickerState = {
  windowId: number
  monitorName: string
  source: SnapAssistPickerSource
  anchorRect: SnapAssistPickerAnchorRect
  autoHover: boolean
}

export type SnapAssistStripState = {
  monitorName: string
  open: boolean
}
