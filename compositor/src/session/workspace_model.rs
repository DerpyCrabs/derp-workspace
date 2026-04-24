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
    #[serde(default, rename = "outputId", skip_serializing_if = "String::is_empty")]
    pub output_id: String,
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
    CustomAuto,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceSlotRuleField {
    #[default]
    AppId,
    Title,
    X11Class,
    X11Instance,
    Kind,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceSlotRuleOp {
    #[default]
    Equals,
    Contains,
    StartsWith,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceSlotRule {
    pub field: WorkspaceSlotRuleField,
    pub op: WorkspaceSlotRuleOp,
    pub value: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceCustomAutoSlot {
    #[serde(rename = "slotId")]
    pub slot_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<WorkspaceSlotRule>,
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
    #[serde(
        default,
        rename = "customLayoutId",
        skip_serializing_if = "Option::is_none"
    )]
    pub custom_layout_id: Option<String>,
    #[serde(default, rename = "customSlots", skip_serializing_if = "Vec::is_empty")]
    pub custom_slots: Vec<WorkspaceCustomAutoSlot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceMonitorLayoutState {
    #[serde(default, rename = "outputId", skip_serializing_if = "String::is_empty")]
    pub output_id: String,
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
pub struct WorkspaceRestoreGroup {
    pub id: String,
    #[serde(rename = "windowIds")]
    pub window_ids: Vec<u32>,
    #[serde(rename = "activeWindowId")]
    pub active_window_id: u32,
    #[serde(default, rename = "splitLeftWindowId")]
    pub split_left_window_id: Option<u32>,
    #[serde(default, rename = "leftPaneFraction")]
    pub left_pane_fraction: Option<f64>,
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
    SelectWindowTab {
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
        #[serde(default, rename = "targetWindowId")]
        target_window_id: Option<u32>,
    },
    MoveWindowToWindow {
        #[serde(rename = "windowId")]
        window_id: u32,
        #[serde(rename = "targetWindowId")]
        target_window_id: u32,
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
        #[serde(default, rename = "sourceWindowId")]
        source_window_id: Option<u32>,
        #[serde(default, rename = "targetWindowId")]
        target_window_id: Option<u32>,
    },
    MoveGroupToWindow {
        #[serde(rename = "sourceWindowId")]
        source_window_id: u32,
        #[serde(rename = "targetWindowId")]
        target_window_id: u32,
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
        #[serde(default, rename = "outputId")]
        output_id: Option<String>,
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
        #[serde(default, rename = "outputId")]
        output_id: Option<String>,
        #[serde(rename = "outputName")]
        output_name: String,
    },
    SetPreTileGeometry {
        #[serde(rename = "windowId")]
        window_id: u32,
        bounds: WorkspaceRect,
    },
    SetMonitorLayout {
        #[serde(default, rename = "outputId")]
        output_id: Option<String>,
        #[serde(rename = "outputName")]
        output_name: String,
        layout: WorkspaceMonitorLayoutType,
        #[serde(default)]
        params: WorkspaceMonitorLayoutParams,
    },
    SetMonitorLayouts {
        layouts: Vec<WorkspaceMonitorLayoutState>,
    },
    ClearPreTileGeometry {
        #[serde(rename = "windowId")]
        window_id: u32,
    },
    RestoreSessionWorkspace {
        groups: Vec<WorkspaceRestoreGroup>,
        #[serde(default, rename = "pinnedWindowIds")]
        pinned_window_ids: Vec<u32>,
        #[serde(default, rename = "monitorTiles")]
        monitor_tiles: Vec<WorkspaceMonitorTileState>,
        #[serde(default, rename = "preTileGeometry")]
        pre_tile_geometry: Vec<WorkspacePreTileGeometry>,
        #[serde(default, rename = "nextGroupSeq")]
        next_group_seq: Option<u32>,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn group(id: &str, window_ids: &[u32]) -> WorkspaceGroupState {
        WorkspaceGroupState {
            id: id.to_string(),
            window_ids: window_ids.to_vec(),
        }
    }

    #[test]
    fn restore_session_workspace_resolves_groups_in_compositor() {
        let mut state = WorkspaceState {
            groups: vec![group("group-1", &[1, 2]), group("group-2", &[3])],
            active_tab_by_group_id: HashMap::from([
                ("group-1".to_string(), 1),
                ("group-2".to_string(), 3),
            ]),
            pinned_window_ids: vec![1, 3],
            split_by_group_id: HashMap::new(),
            monitor_tiles: vec![WorkspaceMonitorTileState {
                output_id: "old-id".to_string(),
                output_name: "DP-1".to_string(),
                entries: vec![WorkspaceMonitorTileEntry {
                    window_id: 1,
                    zone: "left".to_string(),
                    bounds: WorkspaceRect {
                        x: 0,
                        y: 0,
                        width: 100,
                        height: 100,
                    },
                }],
            }],
            monitor_layouts: vec![WorkspaceMonitorLayoutState {
                output_id: "layout-id".to_string(),
                output_name: "DP-1".to_string(),
                layout: WorkspaceMonitorLayoutType::Columns,
                params: WorkspaceMonitorLayoutParams::default(),
            }],
            pre_tile_geometry: Vec::new(),
            next_group_seq: 3,
        };
        let mutation = WorkspaceMutation::RestoreSessionWorkspace {
            groups: vec![WorkspaceRestoreGroup {
                id: "saved-group".to_string(),
                window_ids: vec![2, 1],
                active_window_id: 1,
                split_left_window_id: Some(2),
                left_pane_fraction: Some(0.65),
            }],
            pinned_window_ids: vec![2],
            monitor_tiles: vec![WorkspaceMonitorTileState {
                output_id: "new-id".to_string(),
                output_name: "DP-1".to_string(),
                entries: vec![WorkspaceMonitorTileEntry {
                    window_id: 2,
                    zone: "right".to_string(),
                    bounds: WorkspaceRect {
                        x: 10,
                        y: 20,
                        width: 300,
                        height: 400,
                    },
                }],
            }],
            pre_tile_geometry: vec![WorkspacePreTileGeometry {
                window_id: 2,
                bounds: WorkspaceRect {
                    x: 5,
                    y: 6,
                    width: 700,
                    height: 800,
                },
            }],
            next_group_seq: Some(9),
        };
        state = state
            .apply_mutation(&mutation)
            .expect("restore changes state");
        assert_eq!(
            state.groups,
            vec![group("saved-group", &[2, 1]), group("group-2", &[3])]
        );
        assert_eq!(state.active_tab_by_group_id["saved-group"], 1);
        assert_eq!(state.pinned_window_ids, vec![3, 2]);
        assert_eq!(
            state.split_by_group_id["saved-group"],
            WorkspaceGroupSplitState {
                left_window_id: 2,
                left_pane_fraction: 0.65,
            }
        );
        assert_eq!(state.monitor_tiles[0].output_id, "new-id");
        assert_eq!(state.monitor_tiles[0].entries[0].window_id, 2);
        assert_eq!(state.pre_tile_geometry[0].window_id, 2);
        assert_eq!(state.monitor_layouts[0].output_id, "layout-id");
        assert_eq!(state.next_group_seq, 9);
    }

    #[test]
    fn restore_session_workspace_filters_stale_and_duplicate_windows() {
        let state = WorkspaceState {
            groups: vec![group("group-1", &[1]), group("group-2", &[2])],
            active_tab_by_group_id: HashMap::from([
                ("group-1".to_string(), 1),
                ("group-2".to_string(), 2),
            ]),
            pinned_window_ids: Vec::new(),
            split_by_group_id: HashMap::new(),
            monitor_tiles: Vec::new(),
            monitor_layouts: Vec::new(),
            pre_tile_geometry: Vec::new(),
            next_group_seq: 3,
        };
        let next = state
            .apply_mutation(&WorkspaceMutation::RestoreSessionWorkspace {
                groups: vec![WorkspaceRestoreGroup {
                    id: "restored".to_string(),
                    window_ids: vec![2, 2, 99],
                    active_window_id: 99,
                    split_left_window_id: Some(99),
                    left_pane_fraction: Some(0.1),
                }],
                pinned_window_ids: vec![2, 99],
                monitor_tiles: vec![WorkspaceMonitorTileState {
                    output_id: "id".to_string(),
                    output_name: "DP-1".to_string(),
                    entries: vec![
                        WorkspaceMonitorTileEntry {
                            window_id: 2,
                            zone: "left".to_string(),
                            bounds: WorkspaceRect {
                                x: 0,
                                y: 0,
                                width: 10,
                                height: 10,
                            },
                        },
                        WorkspaceMonitorTileEntry {
                            window_id: 99,
                            zone: "right".to_string(),
                            bounds: WorkspaceRect {
                                x: 0,
                                y: 0,
                                width: 10,
                                height: 10,
                            },
                        },
                    ],
                }],
                pre_tile_geometry: vec![WorkspacePreTileGeometry {
                    window_id: 99,
                    bounds: WorkspaceRect {
                        x: 0,
                        y: 0,
                        width: 10,
                        height: 10,
                    },
                }],
                next_group_seq: None,
            })
            .expect("restore changes state");
        assert_eq!(
            next.groups,
            vec![group("restored", &[2]), group("group-1", &[1])]
        );
        assert_eq!(next.active_tab_by_group_id["restored"], 2);
        assert!(!next.split_by_group_id.contains_key("restored"));
        assert_eq!(next.pinned_window_ids, vec![2]);
        assert_eq!(next.monitor_tiles[0].entries.len(), 1);
        assert!(next.pre_tile_geometry.is_empty());
    }

    #[test]
    fn set_monitor_layouts_replaces_layouts_and_clears_manual_tiles() {
        let state = WorkspaceState {
            groups: vec![group("group-1", &[1])],
            active_tab_by_group_id: HashMap::from([("group-1".to_string(), 1)]),
            pinned_window_ids: Vec::new(),
            split_by_group_id: HashMap::new(),
            monitor_tiles: vec![
                WorkspaceMonitorTileState {
                    output_id: "manual-id".to_string(),
                    output_name: "DP-1".to_string(),
                    entries: vec![WorkspaceMonitorTileEntry {
                        window_id: 1,
                        zone: "left".to_string(),
                        bounds: WorkspaceRect {
                            x: 0,
                            y: 0,
                            width: 100,
                            height: 100,
                        },
                    }],
                },
                WorkspaceMonitorTileState {
                    output_id: "auto-id".to_string(),
                    output_name: "DP-2".to_string(),
                    entries: vec![WorkspaceMonitorTileEntry {
                        window_id: 1,
                        zone: "right".to_string(),
                        bounds: WorkspaceRect {
                            x: 100,
                            y: 0,
                            width: 100,
                            height: 100,
                        },
                    }],
                },
            ],
            monitor_layouts: vec![WorkspaceMonitorLayoutState {
                output_id: "old-id".to_string(),
                output_name: "HDMI-A-1".to_string(),
                layout: WorkspaceMonitorLayoutType::Grid,
                params: WorkspaceMonitorLayoutParams::default(),
            }],
            pre_tile_geometry: Vec::new(),
            next_group_seq: 2,
        };
        let next = state
            .apply_mutation(&WorkspaceMutation::SetMonitorLayouts {
                layouts: vec![
                    WorkspaceMonitorLayoutState {
                        output_id: "manual-id".to_string(),
                        output_name: "DP-1".to_string(),
                        layout: WorkspaceMonitorLayoutType::ManualSnap,
                        params: WorkspaceMonitorLayoutParams::default(),
                    },
                    WorkspaceMonitorLayoutState {
                        output_id: "auto-id".to_string(),
                        output_name: "DP-2".to_string(),
                        layout: WorkspaceMonitorLayoutType::Columns,
                        params: WorkspaceMonitorLayoutParams {
                            max_columns: Some(2),
                            ..WorkspaceMonitorLayoutParams::default()
                        },
                    },
                    WorkspaceMonitorLayoutState {
                        output_id: "auto-id".to_string(),
                        output_name: "DP-2-renamed".to_string(),
                        layout: WorkspaceMonitorLayoutType::Grid,
                        params: WorkspaceMonitorLayoutParams::default(),
                    },
                ],
            })
            .expect("layout set changes state");
        assert_eq!(next.monitor_layouts.len(), 2);
        assert_eq!(next.monitor_layouts[0].output_id, "manual-id");
        assert_eq!(next.monitor_layouts[1].output_id, "auto-id");
        assert_eq!(
            next.monitor_layouts[1].layout,
            WorkspaceMonitorLayoutType::Columns
        );
        assert_eq!(next.monitor_tiles.len(), 1);
        assert_eq!(next.monitor_tiles[0].output_id, "auto-id");
    }

    #[test]
    fn move_window_to_group_prefers_target_window_anchor_over_stale_group_id() {
        let state = WorkspaceState {
            groups: vec![group("stale-target", &[1]), group("actual-target", &[2])],
            active_tab_by_group_id: HashMap::from([
                ("stale-target".to_string(), 1),
                ("actual-target".to_string(), 2),
            ]),
            ..WorkspaceState::default()
        };
        let next = state
            .apply_mutation(&WorkspaceMutation::MoveWindowToGroup {
                window_id: 1,
                target_group_id: "stale-target".to_string(),
                insert_index: 1,
                target_window_id: Some(2),
            })
            .expect("anchored target changes state");
        assert_eq!(group_id_for_window(&next, 1), Some("actual-target"));
        assert_eq!(next.groups.len(), 1);
        assert_eq!(next.groups[0].window_ids, vec![2, 1]);
    }

    #[test]
    fn move_group_to_group_prefers_window_anchors_over_stale_group_ids() {
        let state = WorkspaceState {
            groups: vec![
                group("stale-source", &[1]),
                group("actual-source", &[2, 3]),
                group("actual-target", &[4]),
            ],
            active_tab_by_group_id: HashMap::from([
                ("stale-source".to_string(), 1),
                ("actual-source".to_string(), 2),
                ("actual-target".to_string(), 4),
            ]),
            ..WorkspaceState::default()
        };
        let next = state
            .apply_mutation(&WorkspaceMutation::MoveGroupToGroup {
                source_group_id: "stale-source".to_string(),
                target_group_id: "stale-source".to_string(),
                insert_index: 1,
                source_window_id: Some(2),
                target_window_id: Some(4),
            })
            .expect("anchored groups change state");
        assert_eq!(group_id_for_window(&next, 2), Some("actual-target"));
        assert_eq!(group_id_for_window(&next, 3), Some("actual-target"));
        assert_eq!(next.groups.len(), 2);
        assert_eq!(next.groups[1].window_ids, vec![4, 2, 3]);
    }

    #[test]
    fn workspace_protocol_manifest_matches_rust_model() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../resources/workspace-protocol.json"))
                .expect("workspace protocol manifest json");
        assert_eq!(
            manifest,
            json!({
                "version": 1,
                "workspaceStateFields": [
                    "groups",
                    "activeTabByGroupId",
                    "pinnedWindowIds",
                    "splitByGroupId",
                    "monitorTiles",
                    "monitorLayouts",
                    "preTileGeometry",
                    "nextGroupSeq"
                ],
                "workspaceDerivedFields": [
                    "groupIdByWindowId",
                    "visibleWindowIdByGroupId",
                    "monitorNameByWindowId",
                    "monitorIdByWindowId"
                ],
                "monitorLayoutTypes": [
                    "manual-snap",
                    "master-stack",
                    "columns",
                    "grid",
                    "custom-auto"
                ],
                "slotRuleFields": [
                    "app_id",
                    "title",
                    "x11_class",
                    "x11_instance",
                    "kind"
                ],
                "slotRuleOps": [
                    "equals",
                    "contains",
                    "starts_with"
                ],
                "mutationTypes": [
                    "select_tab",
                    "select_window_tab",
                    "move_window_to_group",
                    "move_window_to_window",
                    "move_group_to_group",
                    "move_group_to_window",
                    "split_window_to_own_group",
                    "set_window_pinned",
                    "enter_split",
                    "exit_split",
                    "set_split_fraction",
                    "set_monitor_tile",
                    "remove_monitor_tile",
                    "clear_monitor_tiles",
                    "set_pre_tile_geometry",
                    "set_monitor_layout",
                    "set_monitor_layouts",
                    "clear_pre_tile_geometry",
                    "restore_session_workspace"
                ]
            })
        );
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

fn output_matches(
    stored_name: &str,
    stored_id: &str,
    requested_name: &str,
    requested_id: Option<&str>,
) -> bool {
    if !stored_id.is_empty() {
        if let Some(requested_id) = requested_id {
            if !requested_id.is_empty() {
                return stored_id == requested_id;
            }
        }
    } else if let Some(requested_id) = requested_id {
        if !requested_id.is_empty() && stored_name != requested_name {
            return stored_id == requested_id;
        }
    }
    stored_name == requested_name
}

fn output_key(output_name: &str, output_id: &str) -> String {
    if output_id.is_empty() {
        format!("name:{output_name}")
    } else {
        format!("id:{output_id}")
    }
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
            output_id: monitor.output_id.clone(),
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

fn workspace_group_seq_floor(state: &WorkspaceState) -> u32 {
    let mut next_group_seq = state.next_group_seq.max(1);
    for group in &state.groups {
        let Some(suffix) = group.id.strip_prefix("group-") else {
            continue;
        };
        if let Ok(seq) = suffix.parse::<u32>() {
            next_group_seq = next_group_seq.max(seq.saturating_add(1));
        }
    }
    next_group_seq
}

fn next_unique_workspace_group_id(used: &HashSet<String>, next_group_seq: &mut u32) -> String {
    loop {
        let group_id = format!("group-{}", *next_group_seq);
        *next_group_seq = next_group_seq.saturating_add(1);
        if !used.contains(&group_id) {
            return group_id;
        }
    }
}

fn restore_session_workspace_state(
    current: &WorkspaceState,
    groups: &[WorkspaceRestoreGroup],
    pinned_window_ids: &[u32],
    monitor_tiles: &[WorkspaceMonitorTileState],
    pre_tile_geometry: &[WorkspacePreTileGeometry],
    requested_next_group_seq: Option<u32>,
) -> WorkspaceState {
    let live_window_ids = all_workspace_window_ids(current);
    let live: HashSet<u32> = live_window_ids.iter().copied().collect();
    let mut next_group_seq = workspace_group_seq_floor(current);
    if let Some(requested_next_group_seq) = requested_next_group_seq {
        next_group_seq = next_group_seq.max(requested_next_group_seq.max(1));
    }
    let mut next = WorkspaceState {
        groups: Vec::new(),
        active_tab_by_group_id: HashMap::new(),
        pinned_window_ids: Vec::new(),
        split_by_group_id: HashMap::new(),
        monitor_tiles: Vec::new(),
        monitor_layouts: current.monitor_layouts.clone(),
        pre_tile_geometry: Vec::new(),
        next_group_seq,
    };
    let mut assigned = HashSet::new();
    let mut used_group_ids = HashSet::new();
    for group in groups {
        let mut window_ids = Vec::new();
        for window_id in &group.window_ids {
            if *window_id > 0 && live.contains(window_id) && assigned.insert(*window_id) {
                window_ids.push(*window_id);
            }
        }
        if window_ids.is_empty() {
            continue;
        }
        let group_id = if group.id.is_empty() || used_group_ids.contains(&group.id) {
            next_unique_workspace_group_id(&used_group_ids, &mut next.next_group_seq)
        } else {
            group.id.clone()
        };
        used_group_ids.insert(group_id.clone());
        let active_window_id = if window_ids.contains(&group.active_window_id) {
            group.active_window_id
        } else {
            window_ids[0]
        };
        if let Some(split_left_window_id) = group.split_left_window_id {
            if window_ids.contains(&split_left_window_id)
                && window_ids
                    .iter()
                    .any(|window_id| *window_id != split_left_window_id)
            {
                next.split_by_group_id.insert(
                    group_id.clone(),
                    WorkspaceGroupSplitState {
                        left_window_id: split_left_window_id,
                        left_pane_fraction: clamp_workspace_split_pane_fraction(
                            group
                                .left_pane_fraction
                                .unwrap_or(WORKSPACE_SPLIT_PANE_FRACTION_DEFAULT),
                        ),
                    },
                );
            }
        }
        next.active_tab_by_group_id
            .insert(group_id.clone(), active_window_id);
        next.groups.push(WorkspaceGroupState {
            id: group_id,
            window_ids,
        });
    }
    for group in &current.groups {
        let window_ids: Vec<u32> = group
            .window_ids
            .iter()
            .copied()
            .filter(|window_id| live.contains(window_id) && assigned.insert(*window_id))
            .collect();
        if window_ids.is_empty() {
            continue;
        }
        let group_id = if group.id.is_empty() || used_group_ids.contains(&group.id) {
            next_unique_workspace_group_id(&used_group_ids, &mut next.next_group_seq)
        } else {
            group.id.clone()
        };
        used_group_ids.insert(group_id.clone());
        let active_window_id = current
            .active_tab_by_group_id
            .get(&group.id)
            .copied()
            .filter(|window_id| window_ids.contains(window_id))
            .unwrap_or(window_ids[0]);
        if let Some(split) = current.split_by_group_id.get(&group.id) {
            if window_ids.contains(&split.left_window_id)
                && window_ids
                    .iter()
                    .any(|window_id| *window_id != split.left_window_id)
            {
                next.split_by_group_id.insert(
                    group_id.clone(),
                    WorkspaceGroupSplitState {
                        left_window_id: split.left_window_id,
                        left_pane_fraction: clamp_workspace_split_pane_fraction(
                            split.left_pane_fraction,
                        ),
                    },
                );
            }
        }
        next.active_tab_by_group_id
            .insert(group_id.clone(), active_window_id);
        next.groups.push(WorkspaceGroupState {
            id: group_id,
            window_ids,
        });
    }
    let restored_window_ids: HashSet<u32> = groups
        .iter()
        .flat_map(|group| group.window_ids.iter().copied())
        .filter(|window_id| live.contains(window_id))
        .collect();
    let desired_pinned: HashSet<u32> = pinned_window_ids
        .iter()
        .copied()
        .filter(|window_id| live.contains(window_id))
        .collect();
    let mut seen_pinned = HashSet::new();
    for window_id in &current.pinned_window_ids {
        if !restored_window_ids.contains(window_id) && live.contains(window_id) {
            seen_pinned.insert(*window_id);
            next.pinned_window_ids.push(*window_id);
        }
    }
    for window_id in pinned_window_ids {
        if desired_pinned.contains(window_id) && seen_pinned.insert(*window_id) {
            next.pinned_window_ids.push(*window_id);
        }
    }
    let mut tiled_windows = HashSet::new();
    for monitor in monitor_tiles {
        let entries: Vec<WorkspaceMonitorTileEntry> = monitor
            .entries
            .iter()
            .filter(|entry| {
                live.contains(&entry.window_id) && tiled_windows.insert(entry.window_id)
            })
            .cloned()
            .collect();
        if entries.is_empty() {
            continue;
        }
        next.monitor_tiles.push(WorkspaceMonitorTileState {
            output_id: monitor.output_id.clone(),
            output_name: monitor.output_name.clone(),
            entries,
        });
    }
    let mut pre_tile_windows = HashSet::new();
    next.pre_tile_geometry = pre_tile_geometry
        .iter()
        .filter(|entry| live.contains(&entry.window_id) && pre_tile_windows.insert(entry.window_id))
        .cloned()
        .collect();
    reconcile_workspace_state(&next, &live_window_ids)
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
            WorkspaceMutation::SelectWindowTab { window_id } => {
                let group_id = group_id_for_window(self, *window_id)?.to_string();
                self.apply_mutation(&WorkspaceMutation::SelectTab {
                    group_id,
                    window_id: *window_id,
                })
            }
            WorkspaceMutation::MoveWindowToWindow {
                window_id,
                target_window_id,
                insert_index,
            } => {
                let target_group_id = group_id_for_window(self, *target_window_id)?.to_string();
                self.apply_mutation(&WorkspaceMutation::MoveWindowToGroup {
                    window_id: *window_id,
                    target_group_id,
                    insert_index: *insert_index,
                    target_window_id: Some(*target_window_id),
                })
            }
            WorkspaceMutation::MoveWindowToGroup {
                window_id,
                target_group_id,
                insert_index,
                target_window_id,
            } => {
                let source_group_id = group_id_for_window(self, *window_id)?.to_string();
                let requested_target_group = self
                    .groups
                    .iter()
                    .find(|group| group.id == *target_group_id);
                let resolved_target_group_id = if let Some(target_window_id) = target_window_id {
                    if requested_target_group
                        .is_none_or(|group| !group.window_ids.contains(target_window_id))
                    {
                        group_id_for_window(self, *target_window_id).unwrap_or(target_group_id)
                    } else {
                        target_group_id.as_str()
                    }
                } else if requested_target_group.is_some() {
                    target_group_id.as_str()
                } else {
                    target_group_id
                };
                if source_group_id == resolved_target_group_id {
                    let mut next = self.clone();
                    let snapshot = next.clone();
                    let group = next
                        .groups
                        .iter_mut()
                        .find(|group| group.id == resolved_target_group_id)?;
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
                    .position(|group| group.id == resolved_target_group_id)?;
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
                    without_group_split(&next.split_by_group_id, resolved_target_group_id);
                if let Some(target_group) = next
                    .groups
                    .iter()
                    .find(|group| group.id == resolved_target_group_id)
                {
                    next.active_tab_by_group_id.insert(
                        resolved_target_group_id.to_string(),
                        if target_group.window_ids.contains(window_id) {
                            *window_id
                        } else {
                            target_group.window_ids[0]
                        },
                    );
                }
                ensure_valid_split_state(&mut next);
                Some(next)
            }
            WorkspaceMutation::MoveGroupToWindow {
                source_window_id,
                target_window_id,
                insert_index,
            } => {
                let source_group_id = group_id_for_window(self, *source_window_id)?.to_string();
                let target_group_id = group_id_for_window(self, *target_window_id)?.to_string();
                self.apply_mutation(&WorkspaceMutation::MoveGroupToGroup {
                    source_group_id,
                    target_group_id,
                    insert_index: *insert_index,
                    source_window_id: Some(*source_window_id),
                    target_window_id: Some(*target_window_id),
                })
            }
            WorkspaceMutation::MoveGroupToGroup {
                source_group_id,
                target_group_id,
                insert_index,
                source_window_id,
                target_window_id,
            } => {
                let requested_source_group = self
                    .groups
                    .iter()
                    .find(|group| group.id == *source_group_id);
                let resolved_source_group_id = if let Some(source_window_id) = source_window_id {
                    if requested_source_group
                        .is_none_or(|group| !group.window_ids.contains(source_window_id))
                    {
                        group_id_for_window(self, *source_window_id).unwrap_or(source_group_id)
                    } else {
                        source_group_id.as_str()
                    }
                } else if requested_source_group.is_some() {
                    source_group_id.as_str()
                } else {
                    source_group_id
                };
                let requested_target_group = self
                    .groups
                    .iter()
                    .find(|group| group.id == *target_group_id);
                let resolved_target_group_id = if let Some(target_window_id) = target_window_id {
                    if requested_target_group
                        .is_none_or(|group| !group.window_ids.contains(target_window_id))
                    {
                        group_id_for_window(self, *target_window_id).unwrap_or(target_group_id)
                    } else {
                        target_group_id.as_str()
                    }
                } else if requested_target_group.is_some() {
                    target_group_id.as_str()
                } else {
                    target_group_id
                };
                if resolved_source_group_id == resolved_target_group_id {
                    return None;
                }
                let source_group = self
                    .groups
                    .iter()
                    .find(|group| group.id == resolved_source_group_id)?;
                let target_group = self
                    .groups
                    .iter()
                    .find(|group| group.id == resolved_target_group_id)?;
                if source_group.window_ids.is_empty() || target_group.window_ids.is_empty() {
                    return None;
                }
                let moving_window_ids = source_group.window_ids.clone();
                let source_visible_window_id = self
                    .visible_window_id_for_group(resolved_source_group_id)
                    .or_else(|| source_group.window_ids.first().copied())?;
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
                    .position(|group| group.id == resolved_source_group_id)?;
                let target_index = next
                    .groups
                    .iter()
                    .position(|group| group.id == resolved_target_group_id)?;
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
                next.groups
                    .retain(|group| group.id != resolved_source_group_id);
                next.active_tab_by_group_id.remove(resolved_source_group_id);
                next.split_by_group_id =
                    without_group_split(&next.split_by_group_id, resolved_source_group_id);
                next.split_by_group_id =
                    without_group_split(&next.split_by_group_id, resolved_target_group_id);
                if let Some(target_group) = next
                    .groups
                    .iter()
                    .find(|group| group.id == resolved_target_group_id)
                {
                    next.active_tab_by_group_id.insert(
                        resolved_target_group_id.to_string(),
                        if target_group.window_ids.contains(&source_visible_window_id) {
                            source_visible_window_id
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
                output_id,
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
                if let Some(monitor) = next.monitor_tiles.iter_mut().find(|monitor| {
                    output_matches(
                        &monitor.output_name,
                        &monitor.output_id,
                        output_name,
                        output_id.as_deref(),
                    )
                }) {
                    monitor.output_id = output_id
                        .clone()
                        .unwrap_or_else(|| monitor.output_id.clone());
                    monitor.output_name = output_name.clone();
                    monitor.entries.push(WorkspaceMonitorTileEntry {
                        window_id: *window_id,
                        zone: zone.clone(),
                        bounds: bounds.clone(),
                    });
                } else {
                    next.monitor_tiles.push(WorkspaceMonitorTileState {
                        output_id: output_id.clone().unwrap_or_default(),
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
            WorkspaceMutation::ClearMonitorTiles {
                output_id,
                output_name,
            } => {
                let mut next = self.clone();
                next.monitor_tiles.retain(|monitor| {
                    !output_matches(
                        &monitor.output_name,
                        &monitor.output_id,
                        output_name,
                        output_id.as_deref(),
                    )
                });
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
                output_id,
                output_name,
                layout,
                params,
            } => {
                let mut next = self.clone();
                next.monitor_layouts.retain(|entry| {
                    !output_matches(
                        &entry.output_name,
                        &entry.output_id,
                        output_name,
                        output_id.as_deref(),
                    )
                });
                next.monitor_layouts.push(WorkspaceMonitorLayoutState {
                    output_id: output_id.clone().unwrap_or_default(),
                    output_name: output_name.clone(),
                    layout: layout.clone(),
                    params: params.clone(),
                });
                if *layout == WorkspaceMonitorLayoutType::ManualSnap {
                    next.monitor_tiles.retain(|monitor| {
                        !output_matches(
                            &monitor.output_name,
                            &monitor.output_id,
                            output_name,
                            output_id.as_deref(),
                        )
                    });
                }
                if next == *self {
                    return None;
                }
                Some(next)
            }
            WorkspaceMutation::SetMonitorLayouts { layouts } => {
                let mut next = self.clone();
                let mut seen = HashSet::new();
                next.monitor_layouts = layouts
                    .iter()
                    .filter(|entry| {
                        if entry.output_name.is_empty() && entry.output_id.is_empty() {
                            return false;
                        }
                        seen.insert(output_key(&entry.output_name, &entry.output_id))
                    })
                    .cloned()
                    .collect();
                for layout in &next.monitor_layouts {
                    if layout.layout != WorkspaceMonitorLayoutType::ManualSnap {
                        continue;
                    }
                    next.monitor_tiles.retain(|monitor| {
                        !output_matches(
                            &monitor.output_name,
                            &monitor.output_id,
                            &layout.output_name,
                            Some(&layout.output_id),
                        )
                    });
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
            WorkspaceMutation::RestoreSessionWorkspace {
                groups,
                pinned_window_ids,
                monitor_tiles,
                pre_tile_geometry,
                next_group_seq,
            } => {
                let next = restore_session_workspace_state(
                    self,
                    groups,
                    pinned_window_ids,
                    monitor_tiles,
                    pre_tile_geometry,
                    *next_group_seq,
                );
                if next == *self {
                    return None;
                }
                Some(next)
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

    pub fn invariant_warnings(&self, live_window_ids: &[u32]) -> Vec<String> {
        let live: HashSet<u32> = live_window_ids.iter().copied().collect();
        let mut warnings = Vec::new();
        let mut group_ids = HashSet::new();
        let mut assigned_windows = HashSet::new();
        for group in &self.groups {
            if group.id.is_empty() {
                warnings.push("empty group id".to_string());
            }
            if !group_ids.insert(group.id.clone()) {
                warnings.push(format!("duplicate group id {}", group.id));
            }
            if group.window_ids.is_empty() {
                warnings.push(format!("empty group {}", group.id));
            }
            for window_id in &group.window_ids {
                if !live.contains(window_id) {
                    warnings.push(format!(
                        "group {} contains stale window {}",
                        group.id, window_id
                    ));
                }
                if !assigned_windows.insert(*window_id) {
                    warnings.push(format!("window {} assigned more than once", window_id));
                }
            }
            let active = self.active_tab_by_group_id.get(&group.id).copied();
            if active.is_none_or(|window_id| !group.window_ids.contains(&window_id)) {
                warnings.push(format!("group {} active tab invalid", group.id));
            }
        }
        for group_id in self.active_tab_by_group_id.keys() {
            if !group_ids.contains(group_id) {
                warnings.push(format!("active tab references missing group {}", group_id));
            }
        }
        for window_id in &self.pinned_window_ids {
            if !assigned_windows.contains(window_id) {
                warnings.push(format!("pinned window {} missing from groups", window_id));
            }
        }
        for (group_id, split) in &self.split_by_group_id {
            let Some(group) = self.groups.iter().find(|group| group.id == *group_id) else {
                warnings.push(format!("split references missing group {}", group_id));
                continue;
            };
            if !group.window_ids.contains(&split.left_window_id) {
                warnings.push(format!("split {} left window missing", group_id));
            }
            if first_right_window_id(group, split.left_window_id).is_none() {
                warnings.push(format!("split {} has no right window", group_id));
            }
        }
        let mut tiled_windows = HashSet::new();
        for monitor in &self.monitor_tiles {
            if monitor.output_id.is_empty() && monitor.output_name.is_empty() {
                warnings.push("monitor tile without output identity".to_string());
            }
            for entry in &monitor.entries {
                if !live.contains(&entry.window_id) {
                    warnings.push(format!("tile references stale window {}", entry.window_id));
                }
                if !tiled_windows.insert(entry.window_id) {
                    warnings.push(format!("window {} tiled more than once", entry.window_id));
                }
                if entry.bounds.width <= 0 || entry.bounds.height <= 0 {
                    warnings.push(format!(
                        "tile window {} has invalid bounds",
                        entry.window_id
                    ));
                }
            }
        }
        let mut pre_tile_windows = HashSet::new();
        for entry in &self.pre_tile_geometry {
            if !live.contains(&entry.window_id) {
                warnings.push(format!(
                    "pre-tile references stale window {}",
                    entry.window_id
                ));
            }
            if !pre_tile_windows.insert(entry.window_id) {
                warnings.push(format!(
                    "window {} has duplicate pre-tile geometry",
                    entry.window_id
                ));
            }
            if entry.bounds.width <= 0 || entry.bounds.height <= 0 {
                warnings.push(format!(
                    "pre-tile window {} has invalid bounds",
                    entry.window_id
                ));
            }
        }
        warnings
    }

    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|error| format!("serialize workspace state: {error}"))
    }
}
