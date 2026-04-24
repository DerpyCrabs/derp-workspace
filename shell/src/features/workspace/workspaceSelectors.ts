import { createMemo, type Accessor } from 'solid-js'
import { matchDesktopApplication, type DesktopAppMatchCandidate } from '@/features/desktop/desktopApplicationsState'
import { buildTaskbarGroupRows, type TaskbarGroupRow } from '@/features/taskbar/taskbarGroups'
import { resolveGroupVisibleWindowId } from '@/features/workspace/tabGroupOps'
import type { DerpWindow } from '@/host/appWindowState'
import { getWorkspaceGroupSplit, type WorkspaceSnapshot } from './workspaceSnapshot'

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

function sameGroupMap<T>(
  left: ReadonlyMap<T, WorkspaceGroupModel>,
  right: ReadonlyMap<T, WorkspaceGroupModel>,
): boolean {
  if (left.size !== right.size) return false
  for (const [key, group] of right) {
    if (left.get(key) !== group) return false
  }
  return true
}

function sameGroupIdMap<T>(left: ReadonlyMap<T, string>, right: ReadonlyMap<T, string>): boolean {
  if (left.size !== right.size) return false
  for (const [key, groupId] of right) {
    if (left.get(key) !== groupId) return false
  }
  return true
}

export function buildWorkspaceGroups(
  workspaceSnapshot: WorkspaceSnapshot,
  windowsById: ReadonlyMap<number, DerpWindow>,
  previous: WorkspaceGroupModel[] = [],
): WorkspaceGroupModel[] {
  const previousById = new Map(previous.map((group) => [group.id, group]))
  const groups: WorkspaceGroupModel[] = []
  for (const group of workspaceSnapshot.groups) {
    const members: DerpWindow[] = []
    for (const windowId of group.windowIds) {
      const window = windowsById.get(windowId)
      if (window) members.push(window)
    }
    if (members.length === 0) continue
    const resolvedVisibleWindowId = resolveGroupVisibleWindowId(workspaceSnapshot, group.id, members) ?? members[0]!.window_id
    const visibleWindowIds: number[] = []
    const visibleWindowIdSet = new Set<number>()
    let firstVisibleWindowId: number | null = null
    let resolvedVisibleWindow: DerpWindow | null = null
    let firstVisibleWindow: DerpWindow | null = null
    let firstUnminimizedWindow: DerpWindow | null = null
    for (const window of members) {
      if (window.window_id === resolvedVisibleWindowId) resolvedVisibleWindow = window
      if (!firstUnminimizedWindow && !window.minimized) firstUnminimizedWindow = window
      if (!window.workspace_visible) continue
      visibleWindowIds.push(window.window_id)
      visibleWindowIdSet.add(window.window_id)
      if (firstVisibleWindowId === null) {
        firstVisibleWindowId = window.window_id
        firstVisibleWindow = window
      }
    }
    const visibleWindowId = visibleWindowIdSet.has(resolvedVisibleWindowId)
      ? resolvedVisibleWindowId
      : firstVisibleWindowId ?? resolvedVisibleWindowId
    const visibleWindow = visibleWindowId === resolvedVisibleWindowId
      ? resolvedVisibleWindow ?? firstVisibleWindow ?? firstUnminimizedWindow ?? members[0]
      : firstVisibleWindow ?? resolvedVisibleWindow ?? firstUnminimizedWindow ?? members[0]
    if (!visibleWindow) continue
    const split = getWorkspaceGroupSplit(workspaceSnapshot, group.id)
    let splitLeftWindow: DerpWindow | null = null
    if (split) {
      for (const window of members) {
        if (window.window_id === split.leftWindowId) {
          splitLeftWindow = window
          break
        }
      }
    }
    if (visibleWindowIds.length === 0) {
      if (splitLeftWindow) {
        visibleWindowIds.push(splitLeftWindow.window_id)
        visibleWindowIdSet.add(splitLeftWindow.window_id)
      }
      if (!visibleWindowIdSet.has(visibleWindow.window_id)) {
        visibleWindowIds.push(visibleWindow.window_id)
        visibleWindowIdSet.add(visibleWindow.window_id)
      }
    }
    const hiddenWindowIds: number[] = []
    for (const window of members) {
      if (!visibleWindowIdSet.has(window.window_id)) hiddenWindowIds.push(window.window_id)
    }
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
    const key = window.output_id || window.output_name || fallbackMonitorKey
    const bucket = map.get(key)
    if (bucket) bucket.push(window)
    else map.set(key, [window])
  }
  return map
}

export function buildTaskbarRowsByMonitor(
  workspaceSnapshot: WorkspaceSnapshot,
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
  const monitorKeyByWindowId = new Map<number, string>()
  for (const monitor of workspaceSnapshot.monitorTiles) {
    const key = monitor.outputName || monitor.outputId || fallbackMonitorKey
    for (const entry of monitor.entries) monitorKeyByWindowId.set(entry.windowId, key)
  }
  const groupsByMonitor = new Map<string, WorkspaceGroupModel[]>()
  for (const workspaceGroup of workspaceSnapshot.groups) {
    const group = groupsById.get(workspaceGroup.id)
    if (!group) continue
    const key =
      group.visibleWindow.output_name ||
      group.visibleWindow.output_id ||
      monitorKeyByWindowId.get(group.visibleWindow.window_id) ||
      fallbackMonitorKey
    const bucket = groupsByMonitor.get(key)
    if (bucket) bucket.push(group)
    else groupsByMonitor.set(key, [group])
  }
  const rowsByMonitor = new Map<string, TaskbarWorkspaceRow[]>()
  const desktopMatchByKey = new Map<string, ReturnType<typeof matchDesktopApplication>>()
  for (const [monitorName, monitorGroups] of groupsByMonitor) {
    const rows = buildTaskbarGroupRows(monitorGroups).map((row) => {
      const matchKey = `${row.app_id}\u0000${row.title}`
      let match = desktopMatchByKey.get(matchKey)
      if (!desktopMatchByKey.has(matchKey)) {
        match = matchDesktopApplication(apps, {
          title: row.title,
          app_id: row.app_id,
        })
        desktopMatchByKey.set(matchKey, match)
      }
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
  workspaceSnapshot: Accessor<WorkspaceSnapshot>
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
      options.workspaceSnapshot(),
      options.windowsById(),
      previousWorkspaceGroups,
    )
    return previousWorkspaceGroups
  })

  const workspaceGroupsById = createMemo((previous: ReadonlyMap<string, WorkspaceGroupModel> = new Map()) => {
    const map = new Map<string, WorkspaceGroupModel>()
    for (const group of workspaceGroups()) {
      map.set(group.id, group)
    }
    return sameGroupMap(previous, map) ? previous : map
  })

  const workspaceGroupIdByWindowId = createMemo((previous: ReadonlyMap<number, string> = new Map()) => {
    const map = new Map<number, string>()
    for (const group of options.workspaceSnapshot().groups) {
      for (const windowId of group.windowIds) {
        map.set(windowId, group.id)
      }
    }
    return sameGroupIdMap(previous, map) ? previous : map
  })

  const workspaceGroupsByWindowId = createMemo((previous: ReadonlyMap<number, WorkspaceGroupModel> = new Map()) => {
    const map = new Map<number, WorkspaceGroupModel>()
    for (const group of workspaceGroups()) {
      for (const member of group.members) {
        map.set(member.window_id, group)
      }
    }
    return sameGroupMap(previous, map) ? previous : map
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
      options.workspaceSnapshot(),
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
