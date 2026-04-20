import artifactsGroup from './artifacts.spec.ts'
import fileBrowserGroup from './file-browser.spec.ts'
import launcherMultimonitorGroup from './launcher-multimonitor.spec.ts'
import nativeWindowsGroup from './native-windows.spec.ts'
import restartInputGroup from './restart-input.spec.ts'
import perfSmokeGroup from './perf-smoke.spec.ts'
import restartPersistenceGroup from './restart-persistence.spec.ts'
import shellChromeGroup from './shell-chrome.spec.ts'
import shellChromeSessionGroup from './shell-chrome-session.spec.ts'
import snapAssistGroup from './snap-assist.spec.ts'
import tabGroupsGroup from './tab-groups.spec.ts'
import taskbarMinimizeGroup from './taskbar-minimize.spec.ts'
import taskbarCloseGroup from './taskbar-close.spec.ts'
import textEditorGroup from './text-editor.spec.ts'
import windowParityGroup from './window-parity.spec.ts'
import x11WindowsGroup from './x11-windows.spec.ts'

export const defaultGroups = [
  shellChromeGroup,
  perfSmokeGroup,
  nativeWindowsGroup,
  windowParityGroup,
  x11WindowsGroup,
  snapAssistGroup,
  tabGroupsGroup,
  launcherMultimonitorGroup,
  fileBrowserGroup,
  textEditorGroup,
  taskbarMinimizeGroup,
  taskbarCloseGroup,
  artifactsGroup,
]

export const sessionRestoreGroups = [restartPersistenceGroup, restartInputGroup, shellChromeSessionGroup]

export const allGroups = [...defaultGroups, ...sessionRestoreGroups]
