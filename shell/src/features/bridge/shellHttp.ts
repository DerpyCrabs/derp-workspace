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

export async function waitForShellHttpBase(timeoutMs: number = 2000): Promise<string | null> {
  const ready = shellHttpBase()
  if (ready) return ready
  if (typeof window === 'undefined') return null
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50))
    const next = shellHttpBase()
    if (next) return next
  }
  return null
}
