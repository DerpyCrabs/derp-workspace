type ShellWindowStateSource = () => unknown
type ShellWindowStateListener = () => void

const primedShellWindowStates = new Map<number, unknown>()
const primedShellWindowStateVersions = new Map<number, number>()
const shellWindowStateSources = new Map<number, ShellWindowStateSource>()
const shellWindowStateListeners = new Set<ShellWindowStateListener>()
let nextPrimedShellWindowStateVersion = 1

function emitShellWindowStateChanged() {
  for (const listener of shellWindowStateListeners) {
    listener()
  }
}

export function primeShellWindowState(windowId: number, value: unknown): void {
  primedShellWindowStates.set(windowId, value)
  primedShellWindowStateVersions.set(windowId, nextPrimedShellWindowStateVersion++)
  emitShellWindowStateChanged()
}

export function peekShellWindowState<T>(windowId: number): T | undefined {
  return primedShellWindowStates.get(windowId) as T | undefined
}

export function primedShellWindowStateVersion(windowId: number): number {
  return primedShellWindowStateVersions.get(windowId) ?? 0
}

export function consumeShellWindowState<T>(windowId: number): T | undefined {
  const value = primedShellWindowStates.get(windowId) as T | undefined
  primedShellWindowStates.delete(windowId)
  primedShellWindowStateVersions.delete(windowId)
  return value
}

export function registerShellWindowStateSource(windowId: number, source: ShellWindowStateSource): () => void {
  shellWindowStateSources.set(windowId, source)
  emitShellWindowStateChanged()
  return () => {
    if (shellWindowStateSources.get(windowId) === source) {
      shellWindowStateSources.delete(windowId)
      emitShellWindowStateChanged()
    }
  }
}

export function captureShellWindowState(windowId: number): unknown {
  return shellWindowStateSources.get(windowId)?.()
}

export function notifyShellWindowStateChanged(): void {
  emitShellWindowStateChanged()
}

export function subscribeShellWindowState(listener: ShellWindowStateListener): () => void {
  shellWindowStateListeners.add(listener)
  return () => {
    shellWindowStateListeners.delete(listener)
  }
}
