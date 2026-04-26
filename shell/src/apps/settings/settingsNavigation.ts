import { createSignal } from 'solid-js'

export type SettingsPageId =
  | 'user'
  | 'displays'
  | 'tiling'
  | 'scratchpads'
  | 'keyboard'
  | 'notifications'
  | 'sound'
  | 'wifi'
  | 'bluetooth'
  | 'appearance'
  | 'default-applications'

export type SettingsNavItem = {
  id: SettingsPageId
  label: string
  keywords: string[]
}

export const SETTINGS_NAV: SettingsNavItem[] = [
  { id: 'user', label: 'User', keywords: ['account', 'login', 'autologin', 'session'] },
  { id: 'displays', label: 'Displays', keywords: ['monitor', 'screen', 'output', 'resolution', 'scale', 'vrr', 'primary'] },
  { id: 'tiling', label: 'Tiling', keywords: ['layout', 'snap', 'grid', 'columns', 'workspace', 'autosave'] },
  { id: 'scratchpads', label: 'Scratchpads', keywords: ['scratchpad', 'rules', 'window'] },
  { id: 'keyboard', label: 'Keyboard', keywords: ['hotkey', 'shortcut', 'layout', 'keybind'] },
  { id: 'notifications', label: 'Notifications', keywords: ['banner', 'history', 'notify'] },
  { id: 'sound', label: 'Sound', keywords: ['audio', 'volume', 'input', 'output', 'microphone'] },
  { id: 'wifi', label: 'Wi-Fi', keywords: ['wireless', 'network', 'internet'] },
  { id: 'bluetooth', label: 'Bluetooth', keywords: ['device', 'pairing'] },
  { id: 'appearance', label: 'Appearance', keywords: ['theme', 'wallpaper', 'background', 'dark', 'light', 'palette'] },
  { id: 'default-applications', label: 'Default apps', keywords: ['default', 'application', 'open with', 'file type'] },
]

const [activeSettingsPage, setActiveSettingsPageSignal] = createSignal<SettingsPageId>('displays')

export const settingsActivePage = activeSettingsPage
export const setSettingsActivePage = setActiveSettingsPageSignal
