import { createMemo, type Accessor } from 'solid-js'
import { matchDesktopApplication, type DesktopAppMatchCandidate } from './desktopApplicationsState'
import { buildTaskbarGroupRows, type TaskbarGroupRow } from './taskbarGroups'
import { resolveGroupVisibleWindowId } from './tabGroupOps'
import type { DerpWindow } from './app/appWindowState'
import type { WorkspaceState } from './workspaceState'

export type WorkspaceGroupModel = {
  id: string
  members: DerpWindow[]
  visibleWindowId: number
  visibleWindow: DerpWindow
  hiddenWindowIds: number[]
}

export type TaskbarWorkspaceRow = TaskbarGroupRow & {
  desktop_id: string | null
  desktop_icon: string | null
}

export function buildWorkspaceGroups(
  workspaceState: WorkspaceState,
  windowsById: ReadonlyMap<number, DerpWindow>,
): WorkspaceGroupModel[] {
  const groups: WorkspaceGroupModel[] = []
  for (const group of workspaceState.groups) {
    const members = group.windowIds
      .map((windowId) => windowsById.get(windowId))
      .filter((window): window is DerpWindow => !!window)
    if (members.length === 0) continue
    const visibleWindowId = resolveGroupVisibleWindowId(workspaceState, group.id, members)
    const visibleWindow =
      members.find((window) => window.window_id === visibleWindowId) ??
      members.find((window) => !window.minimized) ??
      members[0]
    if (!visibleWindow) continue
    groups.push({
      id: group.id,
      members,
      visibleWindowId: visibleWindow.window_id,
      visibleWindow,
      hiddenWindowIds: members
        .map((window) => window.window_id)
        .filter((windowId) => windowId !== visibleWindow.window_id),
    })
  }
  groups.sort(
    (a, b) =>
      b.visibleWindow.stack_z - a.visibleWindow.stack_z || b.visibleWindow.window_id - a.visibleWindow.window_id,
  )
  return groups
}

export function buildWindowsByMonitor(
  windows: readonly DerpWindow[],
  fallbackMonitorKey: string,
): Map<string, DerpWindow[]> {
  const map = new Map<string, DerpWindow[]>()
  for (const window of windows) {
    const key = window.output_name || fallbackMonitorKey
    const bucket = map.get(key)
    if (bucket) bucket.push(window)
    else map.set(key, [window])
  }
  return map
}

export function buildTaskbarRowsByMonitor(
  groups: readonly WorkspaceGroupModel[],
  apps: readonly DesktopAppMatchCandidate[],
  fallbackMonitorKey: string,
): Map<string, TaskbarWorkspaceRow[]> {
  const groupsByMonitor = new Map<string, WorkspaceGroupModel[]>()
  for (const group of groups) {
    const key = group.visibleWindow.output_name || fallbackMonitorKey
    const bucket = groupsByMonitor.get(key)
    if (bucket) bucket.push(group)
    else groupsByMonitor.set(key, [group])
  }
  const rowsByMonitor = new Map<string, TaskbarWorkspaceRow[]>()
  for (const [monitorName, monitorGroups] of groupsByMonitor) {
    const rows = buildTaskbarGroupRows(monitorGroups).map((row) => {
      const match = matchDesktopApplication(apps, {
        title: row.title,
        app_id: row.app_id,
      })
      return {
        ...row,
        desktop_id: match?.desktop_id ?? null,
        desktop_icon: match?.icon ?? null,
      }
    })
    rowsByMonitor.set(monitorName, rows)
  }
  return rowsByMonitor
}

type CreateWorkspaceSelectorsOptions = {
  workspaceState: Accessor<WorkspaceState>
  windowsById: Accessor<ReadonlyMap<number, DerpWindow>>
  windowsList: Accessor<readonly DerpWindow[]>
  focusedWindowId: Accessor<number | null>
  fallbackMonitorKey: Accessor<string>
  desktopApps: Accessor<readonly DesktopAppMatchCandidate[]>
}

export function createWorkspaceSelectors(options: CreateWorkspaceSelectorsOptions) {
  const workspaceGroups = createMemo(() =>
    buildWorkspaceGroups(options.workspaceState(), options.windowsById()),
  )

  const workspaceGroupsById = createMemo(() => {
    const map = new Map<string, WorkspaceGroupModel>()
    for (const group of workspaceGroups()) {
      map.set(group.id, group)
    }
    return map
  })

  const workspaceGroupIdByWindowId = createMemo(() => {
    const map = new Map<number, string>()
    for (const group of options.workspaceState().groups) {
      for (const windowId of group.windowIds) {
        map.set(windowId, group.id)
      }
    }
    return map
  })

  const workspaceGroupsByWindowId = createMemo(() => {
    const map = new Map<number, WorkspaceGroupModel>()
    for (const group of workspaceGroups()) {
      for (const member of group.members) {
        map.set(member.window_id, group)
      }
    }
    return map
  })

  const activeWorkspaceGroupId = createMemo(() => {
    const focused = options.focusedWindowId()
    return focused == null ? null : workspaceGroupIdByWindowId().get(focused) ?? null
  })

  const focusedTaskbarWindowId = createMemo(() => {
    const groupId = activeWorkspaceGroupId()
    if (!groupId) return options.focusedWindowId()
    return workspaceGroupsById().get(groupId)?.visibleWindow.window_id ?? options.focusedWindowId()
  })

  const windowsByMonitor = createMemo(() =>
    buildWindowsByMonitor(options.windowsList(), options.fallbackMonitorKey()),
  )

  const taskbarRowsByMonitor = createMemo(() =>
    buildTaskbarRowsByMonitor(
      workspaceGroups(),
      options.desktopApps(),
      options.fallbackMonitorKey(),
    ),
  )

  const groupIdForWindow = (windowId: number | null | undefined) =>
    windowId == null ? null : workspaceGroupIdByWindowId().get(windowId) ?? null

  const groupForWindow = (windowId: number | null | undefined) =>
    windowId == null ? null : workspaceGroupsByWindowId().get(windowId) ?? null

  return {
    workspaceGroups,
    workspaceGroupsById,
    workspaceGroupIdByWindowId,
    workspaceGroupsByWindowId,
    activeWorkspaceGroupId,
    focusedTaskbarWindowId,
    windowsByMonitor,
    taskbarRowsByMonitor,
    groupIdForWindow,
    groupForWindow,
  }
}
