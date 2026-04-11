import artifactsGroup from './artifacts.spec.ts'
import launcherMultimonitorGroup from './launcher-multimonitor.spec.ts'
import nativeWindowsGroup from './native-windows.spec.ts'
import shellChromeGroup from './shell-chrome.spec.ts'
import snapAssistGroup from './snap-assist.spec.ts'

export const groups = [
  shellChromeGroup,
  nativeWindowsGroup,
  snapAssistGroup,
  launcherMultimonitorGroup,
  artifactsGroup,
]
