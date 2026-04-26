import artifactsGroup from './artifacts.spec.ts'
import customHotkeysGroup from './custom-hotkeys.spec.ts'
import externalControlGroup from './external-control.spec.ts'
import fileBrowserGroup from './file-browser.spec.ts'
import launcherMultimonitorGroup from './launcher-multimonitor.spec.ts'
import nativeWindowsGroup from './native-windows.spec.ts'
import notificationsGroup from './notifications.spec.ts'
import restartInputGroup from './restart-input.spec.ts'
import perfSmokeGroup from './perf-smoke.spec.ts'
import restartPersistenceGroup from './restart-persistence.spec.ts'
import screenCaptureGroup from './screen-capture.spec.ts'
import shellChromeGroup from './shell-chrome.spec.ts'
import shellChromeSessionGroup from './shell-chrome-session.spec.ts'
import softwareRenderingGroup from './software-rendering.spec.ts'
import snapAssistGroup from './snap-assist.spec.ts'
import scratchpadsGroup from './scratchpads.spec.ts'
import tabGroupsGroup from './tab-groups.spec.ts'
import taskbarPinsGroup from './taskbar-pins.spec.ts'
import taskbarMinimizeGroup from './taskbar-minimize.spec.ts'
import taskbarCloseGroup from './taskbar-close.spec.ts'
import textEditorGroup from './text-editor.spec.ts'
import waylandProtocolsGroup from './wayland-protocols.spec.ts'
import windowParityGroup from './window-parity.spec.ts'
import x11WindowsGroup from './x11-windows.spec.ts'
import xdgActivationGroup from './xdg-activation.spec.ts'

export const defaultGroups = [
  shellChromeGroup,
  perfSmokeGroup,
  nativeWindowsGroup,
  waylandProtocolsGroup,
  notificationsGroup,
  windowParityGroup,
  x11WindowsGroup,
  xdgActivationGroup,
  screenCaptureGroup,
  snapAssistGroup,
  tabGroupsGroup,
  launcherMultimonitorGroup,
  fileBrowserGroup,
  textEditorGroup,
  taskbarPinsGroup,
  taskbarMinimizeGroup,
  taskbarCloseGroup,
  externalControlGroup,
  artifactsGroup,
  customHotkeysGroup,
  scratchpadsGroup,
]

export const sessionRestoreGroups = [restartPersistenceGroup, restartInputGroup, shellChromeSessionGroup]

export const allGroups = [...defaultGroups, softwareRenderingGroup, ...sessionRestoreGroups]
