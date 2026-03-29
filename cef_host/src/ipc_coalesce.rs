use std::sync::mpsc::Receiver;

use shell_wire::DecodedCompositorToShellMessage;
use shell_wire::DecodedCompositorToShellMessage::*;

const DRAIN_CAP: usize = 4096;

pub fn fold_pointer_moves(msgs: Vec<DecodedCompositorToShellMessage>) -> Vec<DecodedCompositorToShellMessage> {
    let mut out = Vec::with_capacity(msgs.len());
    let mut run: Option<(i32, i32, u32)> = None;
    for m in msgs {
        match m {
            PointerMove { x, y, modifiers } => run = Some((x, y, modifiers)),
            other => {
                if let Some((x, y, modifiers)) = run.take() {
                    out.push(PointerMove {
                        x,
                        y,
                        modifiers,
                    });
                }
                out.push(other);
            }
        }
    }
    if let Some((x, y, modifiers)) = run {
        out.push(PointerMove {
            x,
            y,
            modifiers,
        });
    }
    out
}

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
