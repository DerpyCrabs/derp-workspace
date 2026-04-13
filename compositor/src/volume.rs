use std::process::{Command, Stdio};
use std::sync::OnceLock;

use smithay::backend::input::KeyState;
use smithay::input::keyboard::{keysyms, KeysymHandle};

static WPCTL_WARNED: OnceLock<()> = OnceLock::new();

pub(crate) enum VolumeKeyIntercept {
    ReleaseOnly,
    PressHud {
        volume_linear_percent_x100: u16,
        muted: bool,
        state_known: bool,
    },
}

fn sym_for_media_key(keysym: &KeysymHandle<'_>) -> u32 {
    let m = keysym.modified_sym().raw();
    if m != keysyms::KEY_NoSymbol {
        return m;
    }
    keysym.raw_syms().first().map(|k| k.raw()).unwrap_or(m)
}

#[allow(non_upper_case_globals)]
pub(crate) fn try_volume_key(
    keysym: &KeysymHandle<'_>,
    key_state: KeyState,
) -> Option<VolumeKeyIntercept> {
    use keysyms::*;
    let raw = sym_for_media_key(keysym);
    let is_vol = matches!(
        raw,
        KEY_XF86AudioRaiseVolume | KEY_XF86AudioLowerVolume | KEY_XF86AudioMute
    );
    if !is_vol {
        return None;
    }
    if key_state == KeyState::Released {
        return Some(VolumeKeyIntercept::ReleaseOnly);
    }
    if raw == KEY_XF86AudioRaiseVolume || raw == KEY_XF86AudioLowerVolume {
        run_wpctl_quiet(&["set-mute", "@DEFAULT_AUDIO_SINK@", "0"]);
    }
    let args: &[&str] = if raw == KEY_XF86AudioRaiseVolume {
        &["set-volume", "@DEFAULT_AUDIO_SINK@", "5%+", "-l", "1.0"]
    } else if raw == KEY_XF86AudioLowerVolume {
        &["set-volume", "@DEFAULT_AUDIO_SINK@", "5%-"]
    } else {
        &["set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"]
    };
    run_wpctl_quiet(args);
    let parsed = query_default_sink_volume_mute();
    Some(VolumeKeyIntercept::PressHud {
        volume_linear_percent_x100: parsed.map(|p| p.0).unwrap_or(0),
        muted: parsed.map(|p| p.1).unwrap_or(false),
        state_known: parsed.is_some(),
    })
}

fn run_wpctl_quiet(args: &[&str]) {
    let outcome = Command::new("wpctl")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| e.to_string())
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!("{status}"))
            }
        });
    if let Err(err) = outcome {
        if WPCTL_WARNED.get().is_none() {
            let _ = WPCTL_WARNED.set(());
            tracing::warn!(
                target: "derp_volume",
                %err,
                ?args,
                "wpctl failed; volume keys may be unavailable until audio stack works"
            );
        }
    }
}

fn query_default_sink_volume_mute() -> Option<(u16, bool)> {
    let out = Command::new("wpctl")
        .args(["get-volume", "@DEFAULT_AUDIO_SINK@"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_wpctl_get_volume(&String::from_utf8_lossy(&out.stdout))
}

fn parse_wpctl_get_volume(s: &str) -> Option<(u16, bool)> {
    let line = s.lines().next()?.trim();
    let muted = line.contains("[MUTED]");
    let rest = line.strip_prefix("Volume:")?.trim();
    let num = rest.split_whitespace().next()?;
    let v: f32 = num.parse().ok()?;
    let lin = (v * 10000.0_f32).round() as i64;
    let lin = lin.clamp(0, 65535) as u16;
    Some((lin, muted))
}
