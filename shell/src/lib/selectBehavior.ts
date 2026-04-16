export function resolveSelectBehavior(args: {
  placement?: 'floating' | 'inline'
  contextMenuPolicy?: 'dismiss' | 'preserve'
}) {
  const placement = args.placement ?? 'floating'
  const preserveContextMenu = (args.contextMenuPolicy ?? 'dismiss') === 'preserve'
  return {
    placement,
    preserveContextMenu,
    floatingPlacement: placement === 'floating',
    dismissContextMenusOnOpen: !preserveContextMenu,
    registerNestedSurface: preserveContextMenu && placement === 'floating',
  }
}
