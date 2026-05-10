fn write_json_bytes(bytes: &[u8]) {
    print!("[");
    for (index, byte) in bytes.iter().enumerate() {
        if index > 0 {
            print!(",");
        }
        print!("{byte}");
    }
    print!("]");
}

fn window() -> shell_wire::ShellWindowSnapshot {
    shell_wire::ShellWindowSnapshot {
        window_id: 42,
        surface_id: 84,
        stack_z: 3,
        x: 10,
        y: 20,
        w: 640,
        h: 480,
        client_x: 12,
        client_y: 24,
        client_w: 620,
        client_h: 440,
        frame_x: 8,
        frame_y: 16,
        frame_w: 648,
        frame_h: 512,
        restore_x: 100,
        restore_y: 120,
        restore_w: 500,
        restore_h: 360,
        minimized: 0,
        maximized: 1,
        fullscreen: 0,
        client_side_decoration: 1,
        workspace_visible: 1,
        shell_flags: shell_wire::SHELL_WINDOW_FLAG_SHELL_HOSTED,
        title: "Rust Terminal".to_string(),
        app_id: "foot".to_string(),
        output_id: "dp-1-id".to_string(),
        output_name: "DP-1".to_string(),
        capture_identifier: "capture-42".to_string(),
        kind: "native".to_string(),
        x11_class: "Foot".to_string(),
        x11_instance: "foot".to_string(),
        icon_name: "utilities-terminal".to_string(),
        icon_buffers: vec![shell_wire::ShellWindowIconBufferSnapshot {
            width: 32,
            height: 32,
            scale: 1,
        }],
    }
}

fn main() {
    let domain_flags = shell_wire::SHELL_SNAPSHOT_DOMAIN_OUTPUTS
        | shell_wire::SHELL_SNAPSHOT_DOMAIN_WINDOWS
        | shell_wire::SHELL_SNAPSHOT_DOMAIN_WINDOW_ORDER
        | shell_wire::SHELL_SNAPSHOT_DOMAIN_FOCUS
        | shell_wire::SHELL_SNAPSHOT_DOMAIN_KEYBOARD
        | shell_wire::SHELL_SNAPSHOT_DOMAIN_INTERACTION;
    let mut payload = Vec::new();
    for index in 0..shell_wire::SHELL_SNAPSHOT_DOMAIN_COUNT {
        payload.extend_from_slice(&(100u64 + index as u64).to_le_bytes());
    }
    payload.extend_from_slice(&shell_wire::encode_output_geometry(1920, 1080, 3840, 2160));
    payload.extend_from_slice(&shell_wire::encode_window_list(17, &[window()]).unwrap());
    payload.extend_from_slice(
        &shell_wire::encode_window_order(
            18,
            &[shell_wire::ShellWindowOrderEntry {
                window_id: 42,
                stack_z: 3,
            }],
        )
        .unwrap(),
    );
    payload.extend_from_slice(&shell_wire::encode_focus_changed(Some(84), Some(42)));
    payload.extend_from_slice(&shell_wire::encode_compositor_keyboard_layout("us").unwrap());
    payload.extend_from_slice(&shell_wire::encode_compositor_interaction_state(
        19,
        20,
        101,
        202,
        42,
        0,
        43,
        44,
        Some(shell_wire::CompositorInteractionVisual {
            x: 90,
            y: 100,
            width: 320,
            height: 240,
            maximized: true,
            fullscreen: false,
        }),
        None,
        42,
        false,
    ));
    let header_len = shell_wire::SHELL_SHARED_SNAPSHOT_HEADER_BYTES as usize;
    let mut snapshot = vec![0u8; header_len + payload.len()];
    shell_wire::write_shared_snapshot_header(
        &mut snapshot[..header_len],
        2,
        payload.len() as u32,
        domain_flags,
    )
    .unwrap();
    snapshot[header_len..].copy_from_slice(&payload);
    print!("{{\"snapshot\":");
    write_json_bytes(&snapshot);
    println!("}}");
}
