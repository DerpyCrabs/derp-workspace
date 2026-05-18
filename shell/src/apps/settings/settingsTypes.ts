export type SettingsLayoutScreen = {
  name: string
  x: number
  y: number
  width: number
  height: number
  physical_width: number
  physical_height: number
  transform: number
  refresh_milli_hz: number
  vrr_supported: boolean
  vrr_enabled: boolean
  taskbar_side: 'bottom' | 'top' | 'left' | 'right'
  taskbar_programs: boolean
  taskbar_osk: boolean
  taskbar_keyboard_layout: boolean
  taskbar_clock: boolean
}
