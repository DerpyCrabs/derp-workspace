export function shellHttpBase(): string | null {
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
