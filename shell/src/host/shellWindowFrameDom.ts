const shellWindowFrames = new Map<number, HTMLDivElement>()

export function registerShellWindowFrame(windowId: number, element: HTMLDivElement) {
  shellWindowFrames.set(windowId, element)
  return () => {
    if (shellWindowFrames.get(windowId) === element) {
      shellWindowFrames.delete(windowId)
    }
  }
}

export function applyShellWindowFrameGeometry(windowId: number, x: number, y: number) {
  const element = shellWindowFrames.get(windowId)
  if (!element) return false
  const inset = Number(element.dataset.shellFrameInset ?? '0') || 0
  const titlebar = Number(element.dataset.shellFrameTitlebar ?? '0') || 0
  element.style.transform = `translate3d(${x - inset}px, ${y - titlebar - inset}px, 0)`
  return true
}
