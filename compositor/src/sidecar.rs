//! Optional `--command` child (e.g. `cef_host`): own process group so we can tear down the tree.

use std::{io, process::Child, thread, time::Duration};

/// Run `sh -c` in a **new process group** (Unix) so `terminate_sidecar` can signal the whole tree.
pub fn spawn_shell_command_line(cmd: &str) -> io::Result<Child> {
    let mut command = std::process::Command::new("/bin/sh");
    command.arg("-c").arg(cmd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    command.spawn()
}

/// Stop `spawn_shell_command_line` and typical descendants (`cef_host`, many Chromium subprocesses).
///
/// Uses `SIGTERM` on the process group, waits briefly, then `SIGKILL` on the same group, then
/// `wait` on the direct child to reap zombies. Subprocesses that leave the group (rare) are not
/// guaranteed to exit — this is best-effort.
pub fn terminate_sidecar(child: &mut Option<Child>) {
    let Some(mut c) = child.take() else {
        return;
    };
    #[cfg(unix)]
    {
        let pid = c.id() as libc::pid_t;
        unsafe {
            let _ = libc::kill(-pid, libc::SIGTERM);
        }
        for _ in 0..80 {
            match c.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        unsafe {
            let _ = libc::kill(-pid, libc::SIGKILL);
        }
        let _ = c.wait();
    }
    #[cfg(not(unix))]
    {
        let _ = c.kill();
        let _ = c.wait();
    }
}
