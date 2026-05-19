use super::*;

#[cfg(test)]
mod output_name_pick_tests {
    use super::{
        pick_output_name_for_global_window_center_first,
        pick_output_name_for_global_window_rect_from_output_rects, Logical, Point, Rectangle, Size,
    };

    fn rect(x: i32, y: i32, w: i32, h: i32) -> Rectangle<i32, Logical> {
        Rectangle::new(Point::from((x, y)), Size::from((w, h)))
    }

    #[test]
    fn center_first_follows_integer_center_half_open_rects() {
        let pairs = vec![
            ("HDMI-A-1".to_string(), rect(0, 0, 1920, 1080)),
            ("DP-1".to_string(), rect(1920, 0, 1920, 1080)),
        ];
        assert_eq!(
            pick_output_name_for_global_window_center_first(&pairs, 400, 0, 1600, 1080).unwrap(),
            "HDMI-A-1"
        );
        assert_eq!(
            pick_output_name_for_global_window_center_first(&pairs, 1400, 0, 1600, 1080).unwrap(),
            "DP-1"
        );
    }

    #[test]
    fn wide_window_bottom_band_picks_more_overlap() {
        let pairs = vec![
            ("HDMI-A-1".to_string(), rect(0, 0, 1920, 1080)),
            ("DP-1".to_string(), rect(1920, 0, 1920, 1080)),
        ];
        let got =
            pick_output_name_for_global_window_rect_from_output_rects(&pairs, 200, 680, 3500, 400)
                .unwrap();
        assert_eq!(got, "DP-1");
    }

    #[test]
    fn single_output_unchanged() {
        let pairs = vec![("ONLY".to_string(), rect(0, 0, 800, 600))];
        let got =
            pick_output_name_for_global_window_rect_from_output_rects(&pairs, 10, 10, 400, 300)
                .unwrap();
        assert_eq!(got, "ONLY");
    }
}

#[cfg(test)]
mod taskbar_work_area_tests {
    use super::{
        apply_taskbar_reserve_to_global_rect, Logical, Point, Rectangle, ShellTaskbarSide, Size,
    };

    fn rect(x: i32, y: i32, w: i32, h: i32) -> Rectangle<i32, Logical> {
        Rectangle::new(Point::from((x, y)), Size::from((w, h)))
    }

    #[test]
    fn taskbar_reserve_applies_to_each_edge() {
        let input = rect(100, 200, 800, 600);
        assert_eq!(
            apply_taskbar_reserve_to_global_rect(input, ShellTaskbarSide::Bottom, 44),
            rect(100, 200, 800, 556)
        );
        assert_eq!(
            apply_taskbar_reserve_to_global_rect(input, ShellTaskbarSide::Top, 44),
            rect(100, 244, 800, 556)
        );
        assert_eq!(
            apply_taskbar_reserve_to_global_rect(input, ShellTaskbarSide::Left, 44),
            rect(144, 200, 756, 600)
        );
        assert_eq!(
            apply_taskbar_reserve_to_global_rect(input, ShellTaskbarSide::Right, 44),
            rect(100, 200, 756, 600)
        );
    }

    #[test]
    fn taskbar_reserve_keeps_minimum_size() {
        assert_eq!(
            apply_taskbar_reserve_to_global_rect(rect(10, 20, 8, 7), ShellTaskbarSide::Left, 44),
            rect(54, 20, 1, 7)
        );
        assert_eq!(
            apply_taskbar_reserve_to_global_rect(rect(10, 20, 8, 7), ShellTaskbarSide::Top, 44),
            rect(10, 64, 8, 1)
        );
    }
}

#[cfg(test)]
mod output_identity_tests {
    use super::OutputTopologyState;
    use smithay::output::{Output, PhysicalProperties, Subpixel};

    fn output(name: &str, serial_number: &str) -> Output {
        Output::new(
            name.to_string(),
            PhysicalProperties {
                size: (530, 300).into(),
                subpixel: Subpixel::Unknown,
                make: "derp-workspace".into(),
                model: "DRM".into(),
                serial_number: serial_number.into(),
            },
        )
    }

    #[test]
    fn drm_output_identity_uses_serialized_monitor_connector_identity() {
        let first =
            OutputTopologyState::shell_output_identity(&output("DP-1", "m3412-abcd-12345678@DP-1"));
        let second =
            OutputTopologyState::shell_output_identity(&output("DP-2", "m3412-abcd-12345678@DP-2"));

        assert_ne!(first, second);
        assert!(first.contains("m3412-abcd-12345678@DP-1"));
        assert!(second.contains("m3412-abcd-12345678@DP-2"));
    }
}

#[cfg(test)]
mod state_invariant_tests {
    use super::{rect_contains_rect, Logical, Point, Rectangle, Size};

    fn rect(x: i32, y: i32, w: i32, h: i32) -> Rectangle<i32, Logical> {
        Rectangle::new(Point::from((x, y)), Size::from((w, h)))
    }

    #[test]
    fn frame_contains_client_edges() {
        assert!(rect_contains_rect(
            rect(10, 10, 120, 90),
            rect(14, 36, 100, 50)
        ));
        assert!(rect_contains_rect(
            rect(10, 10, 120, 90),
            rect(10, 10, 120, 90)
        ));
        assert!(!rect_contains_rect(
            rect(10, 10, 120, 90),
            rect(9, 36, 100, 50)
        ));
        assert!(!rect_contains_rect(
            rect(10, 10, 120, 90),
            rect(14, 36, 130, 50)
        ));
        assert!(!rect_contains_rect(
            rect(10, 10, 120, 90),
            rect(14, 36, 100, 0)
        ));
    }
}

#[cfg(test)]
mod shell_shared_state_tests {
    use super::{shell_shared_state_payload_stale_reason, ShellSharedStateStaleReason};

    fn payload(snapshot_epoch: u64, output_layout_revision: u64) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&snapshot_epoch.to_le_bytes());
        out.extend_from_slice(&output_layout_revision.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
        out
    }

    #[test]
    fn rejects_payload_from_old_output_layout_revision() {
        assert_eq!(
            shell_shared_state_payload_stale_reason(&payload(20, 3), 4, 20),
            Some(ShellSharedStateStaleReason::OutputLayoutRevision {
                payload_revision: 3,
                current_revision: 4,
            })
        );
    }

    #[test]
    fn allows_lagged_snapshot_epoch_payloads() {
        assert_eq!(
            shell_shared_state_payload_stale_reason(&payload(18, 4), 4, 20),
            None
        );
        assert_eq!(
            shell_shared_state_payload_stale_reason(&payload(16, 4), 4, 20),
            None
        );
    }

    #[test]
    fn allows_startup_epoch_zero_payloads() {
        assert_eq!(
            shell_shared_state_payload_stale_reason(&payload(0, 4), 4, 20),
            None
        );
    }

    #[test]
    fn allows_current_payloads() {
        assert_eq!(
            shell_shared_state_payload_stale_reason(&payload(20, 4), 4, 20),
            None
        );
    }
}

#[cfg(test)]
mod shell_authoritative_snapshot_tests {
    use super::ShellOsrState;

    fn focus(window_id: Option<u32>) -> shell_wire::DecodedCompositorToShellMessage {
        shell_wire::DecodedCompositorToShellMessage::FocusChanged {
            surface_id: window_id.map(|id| id + 100),
            window_id,
        }
    }

    fn window_list() -> shell_wire::DecodedCompositorToShellMessage {
        shell_wire::DecodedCompositorToShellMessage::WindowList {
            revision: 1,
            windows: Vec::new(),
        }
    }

    fn window_order() -> shell_wire::DecodedCompositorToShellMessage {
        shell_wire::DecodedCompositorToShellMessage::WindowOrder {
            revision: 1,
            windows: Vec::new(),
        }
    }

    fn workspace() -> shell_wire::DecodedCompositorToShellMessage {
        shell_wire::DecodedCompositorToShellMessage::WorkspaceState {
            revision: 1,
            state_json: "{}".to_string(),
        }
    }

    fn messages_for(
        msg: &shell_wire::DecodedCompositorToShellMessage,
        workspace_changed: bool,
    ) -> Vec<shell_wire::DecodedCompositorToShellMessage> {
        let dummy = focus(None);
        ShellOsrState::shell_authoritative_snapshot_messages(
            msg,
            false,
            workspace_changed,
            None,
            window_list(),
            window_order(),
            focus(Some(7)),
            Some(workspace()),
            dummy.clone(),
            dummy.clone(),
            dummy.clone(),
            None,
            dummy.clone(),
            dummy.clone(),
            dummy,
        )
        .unwrap()
    }

    #[test]
    fn partial_focus_snapshot_publishes_current_window_order() {
        let messages = messages_for(&focus(Some(3)), false);

        assert_eq!(messages.len(), 2);
        assert!(matches!(
            messages[0],
            shell_wire::DecodedCompositorToShellMessage::FocusChanged { .. }
        ));
        assert!(matches!(
            messages[1],
            shell_wire::DecodedCompositorToShellMessage::WindowOrder { .. }
        ));
    }

    #[test]
    fn partial_workspace_side_effect_publishes_only_workspace_extra_domain() {
        let msg = shell_wire::DecodedCompositorToShellMessage::KeyboardLayout {
            label: "us".to_string(),
        };
        let messages = messages_for(&msg, true);

        assert_eq!(messages.len(), 2);
        assert!(matches!(
            messages[0],
            shell_wire::DecodedCompositorToShellMessage::KeyboardLayout { .. }
        ));
        assert!(matches!(
            messages[1],
            shell_wire::DecodedCompositorToShellMessage::WorkspaceState { .. }
        ));
    }
}

#[cfg(test)]
mod programs_menu_super_tests {
    use super::CompositorState;

    #[test]
    fn super_press_without_active_pointer_interaction_is_not_a_chord() {
        assert!(!CompositorState::programs_menu_super_press_chord(
            false, false, false, false
        ));
    }

    #[test]
    fn super_press_with_pressed_pointer_button_is_a_chord() {
        assert!(CompositorState::programs_menu_super_press_chord(
            true, false, false, false
        ));
    }

    #[test]
    fn super_press_with_active_move_or_resize_is_a_chord() {
        assert!(CompositorState::programs_menu_super_press_chord(
            false, true, false, false
        ));
        assert!(CompositorState::programs_menu_super_press_chord(
            false, false, true, false
        ));
        assert!(CompositorState::programs_menu_super_press_chord(
            false, false, false, true
        ));
    }
}
