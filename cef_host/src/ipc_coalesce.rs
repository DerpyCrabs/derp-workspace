//! Collapse bursts of compositor → shell IPC so pointer motion does not flood the CEF UI thread.

use std::sync::mpsc::Receiver;

use shell_wire::DecodedCompositorToShellMessage;
use shell_wire::DecodedCompositorToShellMessage::*;

/// Maximum messages drained per loop iteration (safety valve if the compositor spams non-pointer traffic).
const DRAIN_CAP: usize = 4096;

/// Combine consecutive [`PointerMove`] into the last position; preserve order vs buttons and other events.
pub fn fold_pointer_moves(msgs: Vec<DecodedCompositorToShellMessage>) -> Vec<DecodedCompositorToShellMessage> {
    let mut out = Vec::with_capacity(msgs.len());
    let mut run: Option<(i32, i32)> = None;
    for m in msgs {
        match m {
            PointerMove { x, y } => run = Some((x, y)),
            other => {
                if let Some((x, y)) = run.take() {
                    out.push(PointerMove { x, y });
                }
                out.push(other);
            }
        }
    }
    if let Some((x, y)) = run {
        out.push(PointerMove { x, y });
    }
    out
}

/// Drain the channel (non-blocking) and fold pointer runs.
pub fn recv_folded(rx: &Receiver<DecodedCompositorToShellMessage>) -> Vec<DecodedCompositorToShellMessage> {
    let mut raw = Vec::new();
    while raw.len() < DRAIN_CAP {
        match rx.try_recv() {
            Ok(m) => raw.push(m),
            Err(std::sync::mpsc::TryRecvError::Empty) => break,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
        }
    }
    fold_pointer_moves(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fold_three_moves_one() {
        let v = vec![
            PointerMove { x: 1, y: 2 },
            PointerMove { x: 3, y: 4 },
            PointerMove { x: 5, y: 6 },
        ];
        assert_eq!(
            fold_pointer_moves(v),
            vec![PointerMove { x: 5, y: 6 }]
        );
    }

    #[test]
    fn fold_preserves_button_between_moves() {
        let v = vec![
            PointerMove { x: 0, y: 0 },
            PointerMove { x: 1, y: 1 },
            PointerButton {
                x: 1,
                y: 1,
                button: 0,
                mouse_up: false,
            },
            PointerMove { x: 2, y: 2 },
        ];
        assert_eq!(
            fold_pointer_moves(v),
            vec![
                PointerMove { x: 1, y: 1 },
                PointerButton {
                    x: 1,
                    y: 1,
                    button: 0,
                    mouse_up: false,
                },
                PointerMove { x: 2, y: 2 },
            ]
        );
    }
}
