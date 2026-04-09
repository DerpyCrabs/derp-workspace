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

export function hideShellFloatingWire(): void {
  shellContextMenuWire(false, 0, 0, 0, 0, 0, 0, 0, 0)
}
