import { createSignal } from 'solid-js'
import { loadSessionPersistenceSettings } from './sessionPersistenceSettings'
import { createSessionPersistenceBridge } from './sessionPersistenceBridge'

type SessionPersistenceRuntimeOptions = Omit<
  Parameters<typeof createSessionPersistenceBridge>[0],
  | 'sessionAutoSaveEnabled'
  | 'sessionPersistenceReady'
  | 'savedSessionAvailable'
  | 'hasSeenCompositorWindowSync'
  | 'shellWindowStateRev'
  | 'setSessionAutoSaveEnabled'
  | 'setSavedSessionAvailable'
  | 'setSessionPersistenceReady'
  | 'setHasSeenCompositorWindowSync'
>

export function createSessionPersistenceRuntime(options: SessionPersistenceRuntimeOptions) {
  const [sessionAutoSaveEnabled, setSessionAutoSaveEnabled] = createSignal(
    loadSessionPersistenceSettings().autoSave,
  )
  const [savedSessionAvailable, setSavedSessionAvailable] = createSignal(false)
  const [sessionPersistenceReady, setSessionPersistenceReady] = createSignal(false)
  const [hasSeenCompositorWindowSync, setHasSeenCompositorWindowSync] = createSignal(false)
  const [shellWindowStateRev, setShellWindowStateRev] = createSignal(0)

  const bridge = createSessionPersistenceBridge({
    ...options,
    sessionAutoSaveEnabled,
    sessionPersistenceReady,
    savedSessionAvailable,
    hasSeenCompositorWindowSync,
    shellWindowStateRev,
    setSessionAutoSaveEnabled,
    setSavedSessionAvailable,
    setSessionPersistenceReady,
    setHasSeenCompositorWindowSync,
  })

  return {
    ...bridge,
    sessionAutoSaveEnabled,
    savedSessionAvailable,
    sessionPersistenceReady,
    hasSeenCompositorWindowSync,
    shellWindowStateRev,
    markHasSeenCompositorWindowSync: () => setHasSeenCompositorWindowSync(true),
    bumpShellWindowStateRev: () => setShellWindowStateRev((n) => n + 1),
  }
}
