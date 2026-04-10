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
