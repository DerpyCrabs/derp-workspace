type GroupWindowLike = {
  window_id: number
  title: string
  app_id: string
  minimized: boolean
  output_name: string
}

export type TaskbarGroupRow = {
  group_id: string
  window_id: number
  title: string
  app_id: string
  minimized: boolean
  output_name: string
  tab_count: number
}

export type TaskbarGroupLike = {
  id: string
  visibleWindow: GroupWindowLike
  members: GroupWindowLike[]
}

export function buildTaskbarGroupRows(groups: readonly TaskbarGroupLike[]): TaskbarGroupRow[] {
  return groups.map((group) => ({
    group_id: group.id,
    window_id: group.visibleWindow.window_id,
    title: group.visibleWindow.title,
    app_id: group.visibleWindow.app_id,
    minimized: group.visibleWindow.minimized,
    output_name: group.visibleWindow.output_name,
    tab_count: group.members.length,
  }))
}
