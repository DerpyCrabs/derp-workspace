export type SettingsLayoutScreen = {
  name: string
  x: number
  y: number
  width: number
  height: number
  transform: number
  refresh_milli_hz: number
  vrr_supported: boolean
  vrr_enabled: boolean
  taskbar_side: 'bottom' | 'top' | 'left' | 'right'
}
