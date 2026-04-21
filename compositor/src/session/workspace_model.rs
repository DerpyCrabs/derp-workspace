use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

pub const WORKSPACE_SPLIT_PANE_FRACTION_MIN: f64 = 0.3;
pub const WORKSPACE_SPLIT_PANE_FRACTION_MAX: f64 = 0.7;
pub const WORKSPACE_SPLIT_PANE_FRACTION_DEFAULT: f64 = 0.5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceGroupState {
    pub id: String,
    #[serde(rename = "windowIds")]
    pub window_ids: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceGroupSplitState {
    #[serde(rename = "leftWindowId")]
    pub left_window_id: u32,
    #[serde(rename = "leftPaneFraction")]
    pub left_pane_fraction: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceMonitorTileEntry {
    #[serde(rename = "windowId")]
    pub window_id: u32,
    pub zone: String,
    pub bounds: WorkspaceRect,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceMonitorTileState {
    #[serde(rename = "outputName")]
    pub output_name: String,
    pub entries: Vec<WorkspaceMonitorTileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspacePreTileGeometry {
    #[serde(rename = "windowId")]
    pub window_id: u32,
    pub bounds: WorkspaceRect,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceMonitorLayoutType {
    ManualSnap,
    MasterStack,
    Columns,
    Grid,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceMonitorLayoutParams {
    #[serde(
        default,
        rename = "masterRatio",
        skip_serializing_if = "Option::is_none"
    )]
    pub master_ratio: Option<f64>,
    #[serde(
        default,
        rename = "maxColumns",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_columns: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceMonitorLayoutState {
    #[serde(rename = "outputName")]
    pub output_name: String,
    pub layout: WorkspaceMonitorLayoutType,
    #[serde(default)]
    pub params: WorkspaceMonitorLayoutParams,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceState {
    pub groups: Vec<WorkspaceGroupState>,
    #[serde(rename = "activeTabByGroupId")]
    pub active_tab_by_group_id: HashMap<String, u32>,
    #[serde(rename = "pinnedWindowIds")]
    pub pinned_window_ids: Vec<u32>,
    #[serde(rename = "splitByGroupId")]
    pub split_by_group_id: HashMap<String, WorkspaceGroupSplitState>,
    #[serde(default, rename = "monitorTiles")]
    pub monitor_tiles: Vec<WorkspaceMonitorTileState>,
    #[serde(default, rename = "monitorLayouts")]
    pub monitor_layouts: Vec<WorkspaceMonitorLayoutState>,
    #[serde(default, rename = "preTileGeometry")]
    pub pre_tile_geometry: Vec<WorkspacePreTileGeometry>,
    #[serde(rename = "nextGroupSeq")]
    pub next_group_seq: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkspaceMutation {
    SelectTab {
        #[serde(rename = "groupId")]
        group_id: String,
        #[serde(rename = "windowId")]
        window_id: u32,
    },
    MoveWindowToGroup {
        #[serde(rename = "windowId")]
        window_id: u32,
        #[serde(rename = "targetGroupId")]
        target_group_id: String,
        #[serde(rename = "insertIndex")]
        insert_index: usize,
    },
    MoveGroupToGroup {
        #[serde(rename = "sourceGroupId")]
        source_group_id: String,
        #[serde(rename = "targetGroupId")]
        target_group_id: String,
        #[serde(rename = "insertIndex")]
        insert_index: usize,
    },
    SplitWindowToOwnGroup {
        #[serde(rename = "windowId")]
        window_id: u32,
    },
    SetWindowPinned {
        #[serde(rename = "windowId")]
        window_id: u32,
        pinned: bool,
    },
    EnterSplit {
        #[serde(rename = "groupId")]
        group_id: String,
        #[serde(rename = "leftWindowId")]
        left_window_id: u32,
        #[serde(rename = "leftPaneFraction")]
        left_pane_fraction: f64,
    },
    ExitSplit {
        #[serde(rename = "groupId")]
        group_id: String,
    },
    SetSplitFraction {
        #[serde(rename = "groupId")]
        group_id: String,
        #[serde(rename = "leftPaneFraction")]
        left_pane_fraction: f64,
    },
    SetMonitorTile {
        #[serde(rename = "outputName")]
        output_name: String,
        #[serde(rename = "windowId")]
        window_id: u32,
        zone: String,
        bounds: WorkspaceRect,
    },
    RemoveMonitorTile {
        #[serde(rename = "windowId")]
        window_id: u32,
    },
    ClearMonitorTiles {
        #[serde(rename = "outputName")]
        output_name: String,
    },
    SetPreTileGeometry {
        #[serde(rename = "windowId")]
        window_id: u32,
        bounds: WorkspaceRect,
    },
    SetMonitorLayout {
        #[serde(rename = "outputName")]
        output_name: String,
        layout: WorkspaceMonitorLayoutType,
        #[serde(default)]
        params: WorkspaceMonitorLayoutParams,
    },
    ClearPreTileGeometry {
        #[serde(rename = "windowId")]
        window_id: u32,
    },
    ReplaceState {
        state: WorkspaceState,
    },
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            groups: Vec::new(),
            active_tab_by_group_id: HashMap::new(),
            pinned_window_ids: Vec::new(),
            split_by_group_id: HashMap::new(),
            monitor_tiles: Vec::new(),
            monitor_layouts: Vec::new(),
            pre_tile_geometry: Vec::new(),
            next_group_seq: 1,
        }
    }
}

pub fn clamp_workspace_split_pane_fraction(value: f64) -> f64 {
    if !value.is_finite() {
        return WORKSPACE_SPLIT_PANE_FRACTION_DEFAULT;
    }
    value.clamp(
        WORKSPACE_SPLIT_PANE_FRACTION_MIN,
        WORKSPACE_SPLIT_PANE_FRACTION_MAX,
    )
}

fn first_right_window_id(group: &WorkspaceGroupState, left_window_id: u32) -> Option<u32> {
    group
        .window_ids
        .iter()
        .copied()
        .find(|window_id| *window_id != left_window_id)
}

fn all_workspace_window_ids(state: &WorkspaceState) -> Vec<u32> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for group in &state.groups {
        for window_id in &group.window_ids {
            if seen.insert(*window_id) {
                out.push(*window_id);
            }
        }
    }
    out
}

pub fn group_id_for_window(state: &WorkspaceState, window_id: u32) -> Option<&str> {
    state
        .groups
        .iter()
        .find(|group| group.window_ids.contains(&window_id))
        .map(|group| group.id.as_str())
}

fn without_group_split(
    split_by_group_id: &HashMap<String, WorkspaceGroupSplitState>,
    group_id: &str,
) -> HashMap<String, WorkspaceGroupSplitState> {
    if !split_by_group_id.contains_key(group_id) {
        return split_by_group_id.clone();
    }
    let mut next = split_by_group_id.clone();
    next.remove(group_id);
    next
}

fn normalized_requested_active_window_id(
    state: &WorkspaceState,
    group: &WorkspaceGroupState,
    window_id: u32,
) -> u32 {
    let Some(split) = state.split_by_group_id.get(&group.id) else {
        return window_id;
    };
    if split.left_window_id != window_id {
        return window_id;
    }
    first_right_window_id(group, split.left_window_id).unwrap_or(window_id)
}

fn leading_pinned_window_count(
    state: &WorkspaceState,
    group: &WorkspaceGroupState,
    exclude_window_id: Option<u32>,
) -> usize {
    let pinned: HashSet<u32> = state.pinned_window_ids.iter().copied().collect();
    let mut count = 0usize;
    for window_id in &group.window_ids {
        if Some(*window_id) == exclude_window_id {
            continue;
        }
        if !pinned.contains(window_id) {
            break;
        }
        count += 1;
    }
    count
}

fn insert_into_group(
    state: &WorkspaceState,
    group: &mut WorkspaceGroupState,
    window_id: u32,
    insert_index: usize,
) {
    group.window_ids.retain(|entry| *entry != window_id);
    let pinned = state.pinned_window_ids.contains(&window_id);
    let pinned_count = leading_pinned_window_count(state, group, None);
    let clamped = if pinned {
        insert_index.min(pinned_count)
    } else {
        insert_index.max(pinned_count).min(group.window_ids.len())
    };
    group.window_ids.insert(clamped, window_id);
}

fn ensure_pinned_window_ids(state: &mut WorkspaceState) {
    let live: HashSet<u32> = all_workspace_window_ids(state).into_iter().collect();
    state
        .pinned_window_ids
        .retain(|window_id| live.contains(window_id));
}

fn ensure_valid_split_state(state: &mut WorkspaceState) {
    let mut next = HashMap::new();
    for group in &state.groups {
        let Some(split) = state.split_by_group_id.get(&group.id) else {
            continue;
        };
        if !group.window_ids.contains(&split.left_window_id) {
            continue;
        }
        let Some(right_window_id) = first_right_window_id(group, split.left_window_id) else {
            continue;
        };
        let active_window_id = state
            .active_tab_by_group_id
            .get(&group.id)
            .copied()
            .unwrap_or(group.window_ids[0]);
        if active_window_id == split.left_window_id || !group.window_ids.contains(&active_window_id)
        {
            state
                .active_tab_by_group_id
                .insert(group.id.clone(), right_window_id);
        }
        next.insert(
            group.id.clone(),
            WorkspaceGroupSplitState {
                left_window_id: split.left_window_id,
                left_pane_fraction: clamp_workspace_split_pane_fraction(split.left_pane_fraction),
            },
        );
    }
    state.split_by_group_id = next;
}

pub fn reconcile_workspace_state(
    state: &WorkspaceState,
    live_window_ids: &[u32],
) -> WorkspaceState {
    let mut next = state.clone();
    let live: HashSet<u32> = live_window_ids
        .iter()
        .copied()
        .filter(|window_id| *window_id > 0)
        .collect();
    let mut filtered_groups = Vec::new();
    let mut active_tab_by_group_id = HashMap::new();
    let mut assigned = HashSet::new();
    for group in &next.groups {
        let window_ids: Vec<u32> = group
            .window_ids
            .iter()
            .copied()
            .filter(|window_id| live.contains(window_id) && assigned.insert(*window_id))
            .collect();
        if window_ids.is_empty() {
            continue;
        }
        let active = next.active_tab_by_group_id.get(&group.id).copied();
        active_tab_by_group_id.insert(
            group.id.clone(),
            if active.is_some_and(|active| window_ids.contains(&active)) {
                active.unwrap()
            } else {
                window_ids[0]
            },
        );
        filtered_groups.push(WorkspaceGroupState {
            id: group.id.clone(),
            window_ids,
        });
    }
    next.groups = filtered_groups;
    next.active_tab_by_group_id = active_tab_by_group_id;
    let mut missing: Vec<u32> = live
        .iter()
        .copied()
        .filter(|window_id| !assigned.contains(window_id))
        .collect();
    missing.sort_unstable();
    for window_id in missing {
        let group_id = format!("group-{}", next.next_group_seq);
        next.next_group_seq = next.next_group_seq.saturating_add(1);
        next.groups.push(WorkspaceGroupState {
            id: group_id.clone(),
            window_ids: vec![window_id],
        });
        next.active_tab_by_group_id.insert(group_id, window_id);
    }
    next.monitor_tiles = next
        .monitor_tiles
        .iter()
        .map(|monitor| WorkspaceMonitorTileState {
            output_name: monitor.output_name.clone(),
            entries: monitor
                .entries
                .iter()
                .filter(|entry| live.contains(&entry.window_id))
                .cloned()
                .collect(),
        })
        .filter(|monitor| !monitor.entries.is_empty())
        .collect();
    next.monitor_layouts = next.monitor_layouts.clone();
    next.pre_tile_geometry = next
        .pre_tile_geometry
        .iter()
        .filter(|entry| live.contains(&entry.window_id))
        .cloned()
        .collect();
    ensure_pinned_window_ids(&mut next);
    ensure_valid_split_state(&mut next);
    next
}

pub fn next_active_window_after_removal(
    state: &WorkspaceState,
    group_id: &str,
    removed_window_id: u32,
) -> Option<u32> {
    let group = state.groups.iter().find(|entry| entry.id == group_id)?;
    let remaining: Vec<u32> = group
        .window_ids
        .iter()
        .copied()
        .filter(|window_id| *window_id != removed_window_id)
        .collect();
    if remaining.is_empty() {
        return None;
    }
    let left_window_id = state
        .split_by_group_id
        .get(group_id)
        .map(|split| split.left_window_id);
    if let Some(left_window_id) = left_window_id {
        let right_tabs: Vec<u32> = remaining
            .iter()
            .copied()
            .filter(|window_id| *window_id != left_window_id)
            .collect();
        if removed_window_id == left_window_id {
            return right_tabs
                .first()
                .copied()
                .or_else(|| remaining.first().copied());
        }
        if !right_tabs.is_empty() {
            let right_index = right_tabs
                .iter()
                .position(|window_id| *window_id == removed_window_id);
            let next_index = right_index
                .unwrap_or(0)
                .min(right_tabs.len().saturating_sub(1));
            return right_tabs
                .get(next_index)
                .copied()
                .or_else(|| right_tabs.last().copied());
        }
    }
    let removed_index = group
        .window_ids
        .iter()
        .position(|window_id| *window_id == removed_window_id)
        .unwrap_or(0);
    let next_index = removed_index.min(remaining.len().saturating_sub(1));
    remaining
        .get(next_index)
        .copied()
        .or_else(|| remaining.last().copied())
}

impl WorkspaceState {
    pub fn apply_mutation(&self, mutation: &WorkspaceMutation) -> Option<WorkspaceState> {
        match mutation {
            WorkspaceMutation::SelectTab {
                group_id,
                window_id,
            } => {
                let group = self.groups.iter().find(|entry| entry.id == *group_id)?;
                if !group.window_ids.contains(window_id) {
                    return None;
                }
                let next_window_id = normalized_requested_active_window_id(self, group, *window_id);
                if self
                    .active_tab_by_group_id
                    .get(group_id)
                    .copied()
                    .unwrap_or(0)
                    == next_window_id
                {
                    return None;
                }
                let mut next = self.clone();
                next.active_tab_by_group_id
                    .insert(group_id.clone(), next_window_id);
                Some(next)
            }
            WorkspaceMutation::MoveWindowToGroup {
                window_id,
                target_group_id,
                insert_index,
            } => {
                let source_group_id = group_id_for_window(self, *window_id)?.to_string();
                if source_group_id == *target_group_id {
                    let mut next = self.clone();
                    let snapshot = next.clone();
                    let group = next
                        .groups
                        .iter_mut()
                        .find(|group| group.id == *target_group_id)?;
                    let before = group.window_ids.clone();
                    insert_into_group(&snapshot, group, *window_id, *insert_index);
                    if group.window_ids == before {
                        return None;
                    }
                    return Some(next);
                }
                let mut next = self.clone();
                let source_index = next
                    .groups
                    .iter()
                    .position(|group| group.id == source_group_id)?;
                let target_index = next
                    .groups
                    .iter()
                    .position(|group| group.id == *target_group_id)?;
                if !next.groups[source_index].window_ids.contains(window_id) {
                    return None;
                }
                next.groups[source_index]
                    .window_ids
                    .retain(|entry| *entry != *window_id);
                let snapshot = next.clone();
                insert_into_group(
                    &snapshot,
                    &mut next.groups[target_index],
                    *window_id,
                    *insert_index,
                );
                if next.groups[source_index].window_ids.is_empty() {
                    let removed_group_id = next.groups[source_index].id.clone();
                    next.groups.remove(source_index);
                    next.active_tab_by_group_id.remove(&removed_group_id);
                    next.split_by_group_id =
                        without_group_split(&next.split_by_group_id, &removed_group_id);
                } else {
                    let source_group =
                        &next.groups[source_index.min(next.groups.len().saturating_sub(1))];
                    let source_active = next
                        .active_tab_by_group_id
                        .get(&source_group_id)
                        .copied()
                        .unwrap_or(0);
                    next.active_tab_by_group_id.insert(
                        source_group_id.clone(),
                        if source_group.window_ids.contains(&source_active) {
                            source_active
                        } else {
                            source_group.window_ids[0]
                        },
                    );
                }
                next.split_by_group_id =
                    without_group_split(&next.split_by_group_id, target_group_id);
                if let Some(target_group) = next
                    .groups
                    .iter()
                    .find(|group| group.id == *target_group_id)
                {
                    let target_active = next
                        .active_tab_by_group_id
                        .get(target_group_id)
                        .copied()
                        .unwrap_or(0);
                    next.active_tab_by_group_id.insert(
                        target_group_id.clone(),
                        if target_group.window_ids.contains(&target_active) {
                            target_active
                        } else {
                            target_group.window_ids[0]
                        },
                    );
                }
                ensure_valid_split_state(&mut next);
                Some(next)
            }
            WorkspaceMutation::MoveGroupToGroup {
                source_group_id,
                target_group_id,
                insert_index,
            } => {
                if source_group_id == target_group_id {
                    return None;
                }
                let source_group = self
                    .groups
                    .iter()
                    .find(|group| group.id == *source_group_id)?;
                let target_group = self
                    .groups
                    .iter()
                    .find(|group| group.id == *target_group_id)?;
                if source_group.window_ids.is_empty() || target_group.window_ids.is_empty() {
                    return None;
                }
                let moving_window_ids = source_group.window_ids.clone();
                let moving_pinned_window_ids: Vec<u32> = moving_window_ids
                    .iter()
                    .copied()
                    .filter(|window_id| self.pinned_window_ids.contains(window_id))
                    .collect();
                let moving_unpinned_window_ids: Vec<u32> = moving_window_ids
                    .iter()
                    .copied()
                    .filter(|window_id| !self.pinned_window_ids.contains(window_id))
                    .collect();
                let mut next = self.clone();
                let source_index = next
                    .groups
                    .iter()
                    .position(|group| group.id == *source_group_id)?;
                let target_index = next
                    .groups
                    .iter()
                    .position(|group| group.id == *target_group_id)?;
                next.groups[source_index].window_ids.clear();
                let clamped_insert_index =
                    (*insert_index).min(next.groups[target_index].window_ids.len());
                let mut pinned_insert_index = clamped_insert_index.min(
                    leading_pinned_window_count(&next, &next.groups[target_index], None),
                );
                for window_id in moving_pinned_window_ids {
                    let snapshot = next.clone();
                    insert_into_group(
                        &snapshot,
                        &mut next.groups[target_index],
                        window_id,
                        pinned_insert_index,
                    );
                    pinned_insert_index = pinned_insert_index.saturating_add(1);
                }
                let mut unpinned_insert_index = (clamped_insert_index
                    + source_group
                        .window_ids
                        .iter()
                        .filter(|window_id| self.pinned_window_ids.contains(window_id))
                        .count())
                .max(leading_pinned_window_count(
                    &next,
                    &next.groups[target_index],
                    None,
                ));
                for window_id in moving_unpinned_window_ids {
                    let snapshot = next.clone();
                    insert_into_group(
                        &snapshot,
                        &mut next.groups[target_index],
                        window_id,
                        unpinned_insert_index,
                    );
                    unpinned_insert_index = unpinned_insert_index.saturating_add(1);
                }
                next.groups.retain(|group| group.id != *source_group_id);
                next.active_tab_by_group_id.remove(source_group_id);
                next.split_by_group_id =
                    without_group_split(&next.split_by_group_id, source_group_id);
                next.split_by_group_id =
                    without_group_split(&next.split_by_group_id, target_group_id);
                if let Some(target_group) = next
                    .groups
                    .iter()
                    .find(|group| group.id == *target_group_id)
                {
                    let target_active = next
                        .active_tab_by_group_id
                        .get(target_group_id)
                        .copied()
                        .unwrap_or(0);
                    next.active_tab_by_group_id.insert(
                        target_group_id.clone(),
                        if target_group.window_ids.contains(&target_active) {
                            target_active
                        } else {
                            target_group.window_ids[0]
                        },
                    );
                }
                ensure_valid_split_state(&mut next);
                Some(next)
            }
            WorkspaceMutation::SplitWindowToOwnGroup { window_id } => {
                let source_group_id = group_id_for_window(self, *window_id)?.to_string();
                let source_group = self
                    .groups
                    .iter()
                    .find(|group| group.id == source_group_id)?;
                if source_group.window_ids.len() < 2 || !source_group.window_ids.contains(window_id)
                {
                    return None;
                }
                let mut next = self.clone();
                let source_index = next
                    .groups
                    .iter()
                    .position(|group| group.id == source_group_id)?;
                next.groups[source_index]
                    .window_ids
                    .retain(|entry| *entry != *window_id);
                if next.groups[source_index].window_ids.is_empty() {
                    next.groups.remove(source_index);
                    next.active_tab_by_group_id.remove(&source_group_id);
                    next.split_by_group_id =
                        without_group_split(&next.split_by_group_id, &source_group_id);
                } else {
                    let source_active = next
                        .active_tab_by_group_id
                        .get(&source_group_id)
                        .copied()
                        .unwrap_or(0);
                    let source_group = &next.groups[source_index];
                    next.active_tab_by_group_id.insert(
                        source_group_id.clone(),
                        if source_group.window_ids.contains(&source_active) {
                            source_active
                        } else {
                            source_group.window_ids[0]
                        },
                    );
                }
                let new_group_id = format!("group-{}", next.next_group_seq);
                next.next_group_seq = next.next_group_seq.saturating_add(1);
                next.groups.insert(
                    source_index + 1,
                    WorkspaceGroupState {
                        id: new_group_id.clone(),
                        window_ids: vec![*window_id],
                    },
                );
                next.active_tab_by_group_id.insert(new_group_id, *window_id);
                for monitor in &mut next.monitor_tiles {
                    monitor
                        .entries
                        .retain(|entry| entry.window_id != *window_id);
                }
                next.monitor_tiles
                    .retain(|monitor| !monitor.entries.is_empty());
                next.pre_tile_geometry
                    .retain(|entry| entry.window_id != *window_id);
                ensure_valid_split_state(&mut next);
                Some(next)
            }
            WorkspaceMutation::SetWindowPinned { window_id, pinned } => {
                let group_id = group_id_for_window(self, *window_id)?.to_string();
                let current_pinned = self.pinned_window_ids.contains(window_id);
                if current_pinned == *pinned {
                    return None;
                }
                let mut next = self.clone();
                if *pinned {
                    if !next.pinned_window_ids.contains(window_id) {
                        next.pinned_window_ids.push(*window_id);
                    }
                } else {
                    next.pinned_window_ids.retain(|entry| *entry != *window_id);
                }
                let group_index = next.groups.iter().position(|entry| entry.id == group_id)?;
                let remaining: Vec<u32> = next.groups[group_index]
                    .window_ids
                    .iter()
                    .copied()
                    .filter(|entry| *entry != *window_id)
                    .collect();
                let snapshot_group = WorkspaceGroupState {
                    id: next.groups[group_index].id.clone(),
                    window_ids: remaining.clone(),
                };
                let pinned_count = leading_pinned_window_count(&next, &snapshot_group, None);
                let insert_index = if *pinned {
                    pinned_count
                } else {
                    pinned_count.min(remaining.len())
                };
                next.groups[group_index].window_ids = remaining;
                next.groups[group_index]
                    .window_ids
                    .insert(insert_index, *window_id);
                Some(next)
            }
            WorkspaceMutation::EnterSplit {
                group_id,
                left_window_id,
                left_pane_fraction,
            } => {
                let group = self.groups.iter().find(|entry| entry.id == *group_id)?;
                if !group.window_ids.contains(left_window_id) {
                    return None;
                }
                if group
                    .window_ids
                    .iter()
                    .copied()
                    .filter(|window_id| *window_id != *left_window_id)
                    .count()
                    == 0
                {
                    return None;
                }
                let mut next = self.clone();
                next.split_by_group_id.insert(
                    group_id.clone(),
                    WorkspaceGroupSplitState {
                        left_window_id: *left_window_id,
                        left_pane_fraction: clamp_workspace_split_pane_fraction(
                            *left_pane_fraction,
                        ),
                    },
                );
                ensure_valid_split_state(&mut next);
                if next == *self {
                    return None;
                }
                Some(next)
            }
            WorkspaceMutation::ExitSplit { group_id } => {
                if !self.split_by_group_id.contains_key(group_id) {
                    return None;
                }
                let mut next = self.clone();
                next.split_by_group_id = without_group_split(&next.split_by_group_id, group_id);
                Some(next)
            }
            WorkspaceMutation::SetSplitFraction {
                group_id,
                left_pane_fraction,
            } => {
                let split = self.split_by_group_id.get(group_id)?;
                let next_fraction = clamp_workspace_split_pane_fraction(*left_pane_fraction);
                if (split.left_pane_fraction - next_fraction).abs() < f64::EPSILON {
                    return None;
                }
                let mut next = self.clone();
                next.split_by_group_id.insert(
                    group_id.clone(),
                    WorkspaceGroupSplitState {
                        left_window_id: split.left_window_id,
                        left_pane_fraction: next_fraction,
                    },
                );
                Some(next)
            }
            WorkspaceMutation::SetMonitorTile {
                output_name,
                window_id,
                zone,
                bounds,
            } => {
                let mut next = self.clone();
                for monitor in &mut next.monitor_tiles {
                    monitor
                        .entries
                        .retain(|entry| entry.window_id != *window_id);
                }
                next.monitor_tiles
                    .retain(|monitor| !monitor.entries.is_empty());
                if let Some(monitor) = next
                    .monitor_tiles
                    .iter_mut()
                    .find(|monitor| monitor.output_name == *output_name)
                {
                    monitor.entries.push(WorkspaceMonitorTileEntry {
                        window_id: *window_id,
                        zone: zone.clone(),
                        bounds: bounds.clone(),
                    });
                } else {
                    next.monitor_tiles.push(WorkspaceMonitorTileState {
                        output_name: output_name.clone(),
                        entries: vec![WorkspaceMonitorTileEntry {
                            window_id: *window_id,
                            zone: zone.clone(),
                            bounds: bounds.clone(),
                        }],
                    });
                }
                if next == *self {
                    return None;
                }
                Some(next)
            }
            WorkspaceMutation::RemoveMonitorTile { window_id } => {
                let mut next = self.clone();
                for monitor in &mut next.monitor_tiles {
                    monitor
                        .entries
                        .retain(|entry| entry.window_id != *window_id);
                }
                next.monitor_tiles
                    .retain(|monitor| !monitor.entries.is_empty());
                if next == *self {
                    return None;
                }
                Some(next)
            }
            WorkspaceMutation::ClearMonitorTiles { output_name } => {
                let mut next = self.clone();
                next.monitor_tiles
                    .retain(|monitor| monitor.output_name != *output_name);
                if next == *self {
                    return None;
                }
                Some(next)
            }
            WorkspaceMutation::SetPreTileGeometry { window_id, bounds } => {
                let mut next = self.clone();
                next.pre_tile_geometry
                    .retain(|entry| entry.window_id != *window_id);
                next.pre_tile_geometry.push(WorkspacePreTileGeometry {
                    window_id: *window_id,
                    bounds: bounds.clone(),
                });
                if next == *self {
                    return None;
                }
                Some(next)
            }
            WorkspaceMutation::SetMonitorLayout {
                output_name,
                layout,
                params,
            } => {
                let mut next = self.clone();
                next.monitor_layouts
                    .retain(|entry| entry.output_name != *output_name);
                next.monitor_layouts.push(WorkspaceMonitorLayoutState {
                    output_name: output_name.clone(),
                    layout: layout.clone(),
                    params: params.clone(),
                });
                if *layout == WorkspaceMonitorLayoutType::ManualSnap {
                    next.monitor_tiles
                        .retain(|monitor| monitor.output_name != *output_name);
                }
                if next == *self {
                    return None;
                }
                Some(next)
            }
            WorkspaceMutation::ClearPreTileGeometry { window_id } => {
                let mut next = self.clone();
                next.pre_tile_geometry
                    .retain(|entry| entry.window_id != *window_id);
                if next == *self {
                    return None;
                }
                Some(next)
            }
            WorkspaceMutation::ReplaceState { state } => {
                if *state == *self {
                    return None;
                }
                Some(state.clone())
            }
        }
    }

    pub fn visible_window_id_for_group(&self, group_id: &str) -> Option<u32> {
        let group = self.groups.iter().find(|entry| entry.id == group_id)?;
        self.active_tab_by_group_id
            .get(group_id)
            .copied()
            .or_else(|| group.window_ids.first().copied())
            .map(|window_id| normalized_requested_active_window_id(self, group, window_id))
    }

    pub fn monitor_layout_for_output(
        &self,
        output_name: &str,
    ) -> Option<&WorkspaceMonitorLayoutState> {
        self.monitor_layouts
            .iter()
            .find(|entry| entry.output_name == output_name)
    }

    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|error| format!("serialize workspace state: {error}"))
    }
}
