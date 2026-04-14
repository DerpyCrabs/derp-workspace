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
  const fn = window.__derpShellWireSend as ((op: 'floating_layers', json: string) => void) | undefined
  if (typeof fn !== 'function') return false
  fn(
    'floating_layers',
    JSON.stringify({
      layers: layers.map((layer) => ({
        id: layer.id,
        bx: layer.bx,
        by: layer.by,
        bw: layer.bw,
        bh: layer.bh,
        gx: layer.gx,
        gy: layer.gy,
        gw: layer.gw,
        gh: layer.gh,
        z: layer.z,
      })),
    }),
  )
  return true
}

export function hideShellFloatingWire(): void {
  if (shellFloatingLayersWire([])) return
  shellContextMenuWire(false, 0, 0, 0, 0, 0, 0, 0, 0)
}
