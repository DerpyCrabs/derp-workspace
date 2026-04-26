import type { Rect, SnapZone } from '@/features/tiling/tileZones'

export const WORKSPACE_PROTOCOL_VERSION = 1

export const WORKSPACE_STATE_FIELDS = [
  'groups',
  'activeTabByGroupId',
  'pinnedWindowIds',
  'splitByGroupId',
  'monitorTiles',
  'monitorLayouts',
  'preTileGeometry',
  'taskbarPins',
  'nextGroupSeq',
] as const

export const WORKSPACE_DERIVED_FIELDS = [
] as const

export const WORKSPACE_MONITOR_LAYOUT_TYPES = [
  'manual-snap',
  'master-stack',
  'columns',
  'grid',
  'custom-auto',
] as const

export const WORKSPACE_SLOT_RULE_FIELDS = ['app_id', 'title', 'x11_class', 'x11_instance', 'kind'] as const
export const WORKSPACE_SLOT_RULE_OPS = ['equals', 'contains', 'starts_with'] as const

export const WORKSPACE_MUTATION_TYPES = [
  'select_tab',
  'select_window_tab',
  'move_window_to_group',
  'move_window_to_window',
  'move_group_to_group',
  'move_group_to_window',
  'split_window_to_own_group',
  'set_window_pinned',
  'enter_split',
  'exit_split',
  'set_split_fraction',
  'set_monitor_tile',
  'remove_monitor_tile',
  'clear_monitor_tiles',
  'set_pre_tile_geometry',
  'set_monitor_layout',
  'set_monitor_layouts',
  'clear_pre_tile_geometry',
  'restore_session_workspace',
] as const

export type WorkspaceMonitorLayoutType = (typeof WORKSPACE_MONITOR_LAYOUT_TYPES)[number]
export type WorkspaceSlotRuleField = (typeof WORKSPACE_SLOT_RULE_FIELDS)[number]
export type WorkspaceSlotRuleOp = (typeof WORKSPACE_SLOT_RULE_OPS)[number]
export type WorkspaceMutationType = (typeof WORKSPACE_MUTATION_TYPES)[number]

export type WorkspaceGroupState = {
  id: string
  windowIds: number[]
}

export type WorkspaceGroupSplitState = {
  leftWindowId: number
  leftPaneFraction: number
}

export type WorkspaceMonitorTileEntry = {
  windowId: number
  zone: SnapZone
  bounds: Rect
}

export type WorkspaceMonitorTileState = {
  outputId?: string
  outputName: string
  entries: WorkspaceMonitorTileEntry[]
}

export type WorkspacePreTileGeometry = {
  windowId: number
  bounds: Rect
}

export type WorkspaceTaskbarPin =
  | {
      kind: 'app'
      id: string
      label: string
      command: string
      desktopId?: string | null
      appName?: string | null
      desktopIcon?: string | null
    }
  | {
      kind: 'folder'
      id: string
      label: string
      path: string
    }

export type WorkspaceTaskbarPinMonitor = {
  outputId?: string
  outputName: string
  pins: WorkspaceTaskbarPin[]
}

export type WorkspaceSlotRule = {
  field: WorkspaceSlotRuleField
  op: WorkspaceSlotRuleOp
  value: string
}

export type WorkspaceCustomAutoSlot = {
  slotId: string
  x: number
  y: number
  width: number
  height: number
  rules?: WorkspaceSlotRule[]
}

export type WorkspaceMonitorLayoutParams = {
  masterRatio?: number
  maxColumns?: number
  customLayoutId?: string
  customSlots?: WorkspaceCustomAutoSlot[]
}

export type WorkspaceMonitorLayoutState = {
  outputId?: string
  outputName: string
  layout: WorkspaceMonitorLayoutType
  params: WorkspaceMonitorLayoutParams
}

export type WorkspaceState = {
  groups: WorkspaceGroupState[]
  activeTabByGroupId: Record<string, number>
  pinnedWindowIds: number[]
  splitByGroupId: Record<string, WorkspaceGroupSplitState>
  monitorTiles: WorkspaceMonitorTileState[]
  monitorLayouts: WorkspaceMonitorLayoutState[]
  preTileGeometry: WorkspacePreTileGeometry[]
  taskbarPins: WorkspaceTaskbarPinMonitor[]
  nextGroupSeq: number
}

export type WorkspaceSnapshot = WorkspaceState

export type WorkspaceRestoreGroup = {
  id: string
  windowIds: number[]
  activeWindowId: number
  splitLeftWindowId?: number | null
  leftPaneFraction?: number | null
}

export type WorkspaceMutation =
  | { type: 'select_tab'; groupId: string; windowId: number }
  | { type: 'select_window_tab'; windowId: number }
  | {
      type: 'move_window_to_group'
      windowId: number
      targetGroupId: string
      insertIndex: number
      targetWindowId?: number
    }
  | {
      type: 'move_window_to_window'
      windowId: number
      targetWindowId: number
      insertIndex: number
    }
  | {
      type: 'move_group_to_group'
      sourceGroupId: string
      targetGroupId: string
      insertIndex: number
      sourceWindowId?: number
      targetWindowId?: number
    }
  | {
      type: 'move_group_to_window'
      sourceWindowId: number
      targetWindowId: number
      insertIndex: number
    }
  | { type: 'split_window_to_own_group'; windowId: number }
  | { type: 'set_window_pinned'; windowId: number; pinned: boolean }
  | { type: 'enter_split'; groupId: string; leftWindowId: number; leftPaneFraction: number }
  | { type: 'exit_split'; groupId: string }
  | { type: 'set_split_fraction'; groupId: string; leftPaneFraction: number }
  | {
      type: 'set_monitor_tile'
      outputId?: string | null
      outputName: string
      windowId: number
      zone: SnapZone
      bounds: Rect
    }
  | { type: 'remove_monitor_tile'; windowId: number }
  | { type: 'clear_monitor_tiles'; outputId?: string | null; outputName: string }
  | { type: 'set_pre_tile_geometry'; windowId: number; bounds: Rect }
  | {
      type: 'set_monitor_layout'
      outputId?: string | null
      outputName: string
      layout: WorkspaceMonitorLayoutType
      params: WorkspaceMonitorLayoutParams
    }
  | { type: 'set_monitor_layouts'; layouts: WorkspaceMonitorLayoutState[] }
  | { type: 'clear_pre_tile_geometry'; windowId: number }
  | {
      type: 'restore_session_workspace'
      groups: WorkspaceRestoreGroup[]
      pinnedWindowIds?: number[]
      monitorTiles?: WorkspaceMonitorTileState[]
      preTileGeometry?: WorkspacePreTileGeometry[]
      nextGroupSeq?: number
    }
