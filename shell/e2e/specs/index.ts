import artifactsGroup from './artifacts.spec.ts'
import fileBrowserGroup from './file-browser.spec.ts'
import launcherMultimonitorGroup from './launcher-multimonitor.spec.ts'
import nativeWindowsGroup from './native-windows.spec.ts'
import shellChromeGroup from './shell-chrome.spec.ts'
import snapAssistGroup from './snap-assist.spec.ts'
import tabGroupsGroup from './tab-groups.spec.ts'

export const groups = [
  shellChromeGroup,
  nativeWindowsGroup,
  // x11WindowsGroup, disabled
  snapAssistGroup,
  tabGroupsGroup,
  launcherMultimonitorGroup,
  fileBrowserGroup,
  artifactsGroup,
]
