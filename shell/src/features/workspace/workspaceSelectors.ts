import { createMemo, type Accessor } from 'solid-js'
import { matchDesktopApplication, type DesktopAppMatchCandidate } from '@/features/desktop/desktopApplicationsState'
import { buildTaskbarGroupRows, type TaskbarGroupRow } from '@/features/taskbar/taskbarGroups'
import { resolveGroupVisibleWindowId } from '@/features/workspace/tabGroupOps'
import type { DerpWindow } from '@/host/appWindowState'
import { getWorkspaceGroupSplit, type WorkspaceState } from './workspaceState'

export type WorkspaceGroupModel = {
  id: string
  members: DerpWindow[]
  visibleWindowId: number
  visibleWindow: DerpWindow
  splitLeftWindowId: number | null
  splitLeftWindow: DerpWindow | null
  splitPaneFraction: number | null
  visibleWindowIds: number[]
  hiddenWindowIds: number[]
}

export type TaskbarWorkspaceRow = TaskbarGroupRow & {
  desktop_id: string | null
  desktop_icon: string | null
  app_display_name: string | null
  shell_file_path: string | null
}

function sameWindowMembers(left: readonly DerpWindow[], right: readonly DerpWindow[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function sameWindowIds(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export function buildWorkspaceGroups(
  workspaceState: WorkspaceState,
  windowsById: ReadonlyMap<number, DerpWindow>,
  previous: WorkspaceGroupModel[] = [],
): WorkspaceGroupModel[] {
  const previousById = new Map(previous.map((group) => [group.id, group]))
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
    const split = getWorkspaceGroupSplit(workspaceState, group.id)
    const splitLeftWindow =
      split ? members.find((window) => window.window_id === split.leftWindowId) ?? null : null
    const visibleWindowIds = [
      ...(splitLeftWindow ? [splitLeftWindow.window_id] : []),
      visibleWindow.window_id,
    ].filter((windowId, index, all) => all.indexOf(windowId) === index)
    const hiddenWindowIds = members
      .map((window) => window.window_id)
      .filter((windowId) => !visibleWindowIds.includes(windowId))
    const previousGroup = previousById.get(group.id)
    if (
      previousGroup &&
      previousGroup.visibleWindowId === visibleWindow.window_id &&
      previousGroup.visibleWindow === visibleWindow &&
      previousGroup.splitLeftWindowId === (splitLeftWindow?.window_id ?? null) &&
      previousGroup.splitLeftWindow === splitLeftWindow &&
      previousGroup.splitPaneFraction === (split?.leftPaneFraction ?? null) &&
      sameWindowMembers(previousGroup.members, members) &&
      sameWindowIds(previousGroup.visibleWindowIds, visibleWindowIds) &&
      sameWindowIds(previousGroup.hiddenWindowIds, hiddenWindowIds)
    ) {
      groups.push(previousGroup)
      continue
    }
    groups.push({
      id: group.id,
      members,
      visibleWindowId: visibleWindow.window_id,
      visibleWindow,
      splitLeftWindowId: splitLeftWindow?.window_id ?? null,
      splitLeftWindow,
      splitPaneFraction: split?.leftPaneFraction ?? null,
      visibleWindowIds,
      hiddenWindowIds,
    })
  }
  groups.sort(
    (a, b) =>
      b.visibleWindow.stack_z - a.visibleWindow.stack_z || b.visibleWindow.window_id - a.visibleWindow.window_id,
  )
  if (
    previous.length === groups.length &&
    previous.every((group, index) => group === groups[index])
  ) {
    return previous
  }
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
  workspaceState: WorkspaceState,
  groups: readonly WorkspaceGroupModel[],
  apps: readonly DesktopAppMatchCandidate[],
  fallbackMonitorKey: string,
  previous: ReadonlyMap<string, readonly TaskbarWorkspaceRow[]> = new Map(),
  shellHostedAppByWindow: Readonly<Record<number, unknown>> = {},
): Map<string, TaskbarWorkspaceRow[]> {
  const previousRowsByGroupId = new Map<string, TaskbarWorkspaceRow>()
  for (const rows of previous.values()) {
    for (const row of rows) previousRowsByGroupId.set(row.group_id, row)
  }
  const groupsById = new Map(groups.map((group) => [group.id, group]))
  const groupsByMonitor = new Map<string, WorkspaceGroupModel[]>()
  for (const workspaceGroup of workspaceState.groups) {
    const group = groupsById.get(workspaceGroup.id)
    if (!group) continue
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
      const previousRow = previousRowsByGroupId.get(row.group_id)
      const appDisplayName = match?.full_name?.trim() || match?.name?.trim() || null
      const nextRow = {
        ...row,
        desktop_id: match?.desktop_id ?? null,
        desktop_icon: match?.icon ?? null,
        app_display_name: appDisplayName,
        shell_file_path: shellHostedFilePath(row, shellHostedAppByWindow),
      }
      if (
        previousRow &&
        previousRow.window_id === nextRow.window_id &&
        previousRow.title === nextRow.title &&
        previousRow.app_id === nextRow.app_id &&
        previousRow.minimized === nextRow.minimized &&
        previousRow.output_name === nextRow.output_name &&
        previousRow.tab_count === nextRow.tab_count &&
        previousRow.desktop_id === nextRow.desktop_id &&
        previousRow.desktop_icon === nextRow.desktop_icon &&
        previousRow.app_display_name === nextRow.app_display_name &&
        previousRow.shell_file_path === nextRow.shell_file_path
      ) {
        return previousRow
      }
      return nextRow
    })
    const previousRows = previous.get(monitorName)
    if (
      previousRows &&
      previousRows.length === rows.length &&
      previousRows.every((row, index) => row === rows[index])
    ) {
      rowsByMonitor.set(monitorName, previousRows as TaskbarWorkspaceRow[])
    } else {
      rowsByMonitor.set(monitorName, rows)
    }
  }
  if (
    previous.size === rowsByMonitor.size &&
    Array.from(rowsByMonitor.entries()).every(([monitorName, rows]) => previous.get(monitorName) === rows)
  ) {
    return previous as Map<string, TaskbarWorkspaceRow[]>
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
  shellHostedAppByWindow: Accessor<Readonly<Record<number, unknown>>>
}

function shellHostedFilePath(
  row: Pick<TaskbarGroupRow, 'window_id' | 'app_id'>,
  shellHostedAppByWindow: Readonly<Record<number, unknown>>,
): string | null {
  const state = shellHostedAppByWindow[row.window_id]
  if (!state || typeof state !== 'object') return null
  const rec = state as Record<string, unknown>
  const path = row.app_id === 'derp.files' ? rec.activePath : rec.viewingPath
  return typeof path === 'string' && path.length > 0 ? path : null
}

export function createWorkspaceSelectors(options: CreateWorkspaceSelectorsOptions) {
  let previousWorkspaceGroups: WorkspaceGroupModel[] = []
  const workspaceGroups = createMemo(() => {
    previousWorkspaceGroups = buildWorkspaceGroups(
      options.workspaceState(),
      options.windowsById(),
      previousWorkspaceGroups,
    )
    return previousWorkspaceGroups
  })

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

  let previousTaskbarRowsByMonitor: ReadonlyMap<string, readonly TaskbarWorkspaceRow[]> = new Map()
  const taskbarRowsByMonitor = createMemo(() => {
    previousTaskbarRowsByMonitor = buildTaskbarRowsByMonitor(
      options.workspaceState(),
      workspaceGroups(),
      options.desktopApps(),
      options.fallbackMonitorKey(),
      previousTaskbarRowsByMonitor,
      options.shellHostedAppByWindow(),
    )
    return previousTaskbarRowsByMonitor as Map<string, TaskbarWorkspaceRow[]>
  })

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
