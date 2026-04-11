export type LayoutScreen = {
  name: string
  x: number
  y: number
  width: number
  height: number
  transform: number
  refresh_milli_hz: number
}

export type ExclusionHudZone = {
  label: string
  x: number
  y: number
  w: number
  h: number
}

export type AssistOverlayState = {
  shape: import('../assistGrid').AssistGridShape
  gutterPx: number
  hoverSpan: import('../assistGrid').AssistGridSpan | null
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
