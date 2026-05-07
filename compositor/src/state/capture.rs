#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ShellSharedStateStaleReason {
    OutputLayoutRevision {
        payload_revision: u64,
        current_revision: u64,
    },
}

pub(super) fn shell_shared_state_payload_stale_reason(
    payload: &[u8],
    current_output_layout_revision: u64,
    _current_snapshot_epoch: u64,
) -> Option<ShellSharedStateStaleReason> {
    if payload.len() < 16 {
        return None;
    }
    let output_layout_revision = u64::from_le_bytes(payload[8..16].try_into().unwrap());
    if output_layout_revision > 0 && output_layout_revision < current_output_layout_revision {
        return Some(ShellSharedStateStaleReason::OutputLayoutRevision {
            payload_revision: output_layout_revision,
            current_revision: current_output_layout_revision,
        });
    }
    None
}
