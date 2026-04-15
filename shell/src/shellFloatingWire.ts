import { writeShellFloatingLayersState } from './sharedShellState'

const SHELL_SHARED_STATE_KIND_FLOATING_LAYERS = 3

export type ShellFloatingWireLayer = {
  id: number
  bx: number
  by: number
  bw: number
  bh: number
  gx: number
  gy: number
  gw: number
  gh: number
  z: number
}

export function shellContextMenuWire(
  visible: boolean,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  gx: number,
  gy: number,
  gw: number,
  gh: number,
): boolean {
  const fn = window.__derpShellWireSend as
    | ((
        op: 'context_menu',
        vis: number,
        bx: number,
        by: number,
        bw: number,
        bh: number,
        gx: number,
        gy: number,
        gw: number,
        gh: number,
      ) => void)
    | undefined
  if (typeof fn !== 'function') return false
  fn('context_menu', visible ? 1 : 0, bx, by, bw, bh, gx, gy, gw, gh)
  return true
}

export function shellFloatingLayersWire(layers: readonly ShellFloatingWireLayer[]): boolean {
  const ok = writeShellFloatingLayersState(layers)
  if (!ok) return false
  console.warn(
    `[derp-shell-launcher] shellFloatingLayersWire count=${layers.length} ids=${layers.map((layer) => layer.id).join(',')}`,
  )
  const fn = window.__derpShellWireSend as ((op: 'shared_state_sync', kind: number) => void) | undefined
  if (typeof fn === 'function') {
    console.warn(
      `[derp-shell-launcher] shellFloatingLayersWire shared_state_sync kind=${SHELL_SHARED_STATE_KIND_FLOATING_LAYERS}`,
    )
    fn('shared_state_sync', SHELL_SHARED_STATE_KIND_FLOATING_LAYERS)
  }
  return true
}

export function hideShellFloatingWire(): void {
  if (shellFloatingLayersWire([])) return
  shellContextMenuWire(false, 0, 0, 0, 0, 0, 0, 0, 0)
}
