export const DERP_SHELL_HTTP_READY_EVENT = 'derp-shell-http-ready'

let shellHttpReadyPromise: Promise<string | null> | null = null

export function shellHttpBase(): string | null {
  if (typeof window === 'undefined') return null
  const u = window.__DERP_SHELL_HTTP
  if (u && u.startsWith('http://127.0.0.1:')) return u.replace(/\/$/, '')
  const spawnUrl = window.__DERP_SPAWN_URL
  if (spawnUrl && spawnUrl.startsWith('http://127.0.0.1:')) {
    try {
      return new URL(spawnUrl).origin.replace(/\/$/, '')
    } catch {}
  }
  const origin = window.location?.origin
  if (origin && origin.startsWith('http://127.0.0.1:')) return origin.replace(/\/$/, '')
  return null
}

export function waitForShellHttpBase(): Promise<string | null> {
  const ready = shellHttpBase()
  if (ready || typeof window === 'undefined') return Promise.resolve(ready)
  if (!shellHttpReadyPromise) {
    shellHttpReadyPromise = new Promise((resolve) => {
      window.addEventListener(
        DERP_SHELL_HTTP_READY_EVENT,
        () => {
          resolve(shellHttpBase())
        },
        { once: true },
      )
    })
  }
  return shellHttpReadyPromise
}

export function __resetShellHttpReadyForTests() {
  shellHttpReadyPromise = null
}
