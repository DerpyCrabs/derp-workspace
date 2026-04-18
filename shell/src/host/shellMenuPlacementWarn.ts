export function shellMenuPlacementWarn(kind: string, detail: Record<string, unknown>) {
  if (typeof window === 'undefined') return
  const w = window as Window & { __DERP_E2E_REQUEST_SNAPSHOT?: (requestId: number) => void }
  if (typeof w.__DERP_E2E_REQUEST_SNAPSHOT !== 'function') return
  console.warn(`[shell-menu-placement] ${kind}`, detail)
}
