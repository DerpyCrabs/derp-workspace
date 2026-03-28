//! Optional `--command` child (e.g. `cef_host`): own process group so we can tear down the tree.

use std::{io, process::Child, thread, time::Duration};

#[cfg(target_os = "linux")]
extern "C" {
    fn prctl(
        option: libc::c_int,
        arg2: libc::c_ulong,
        arg3: libc::c_ulong,
        arg4: libc::c_ulong,
        arg5: libc::c_ulong,
    ) -> libc::c_int;
}

#[cfg(target_os = "linux")]
const PR_SET_PDEATHSIG: libc::c_int = 1;

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
                #[cfg(target_os = "linux")]
                {
                    if prctl(PR_SET_PDEATHSIG, libc::SIGTERM as libc::c_ulong, 0, 0, 0) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
    }
    command.spawn()
}

#[cfg(target_os = "linux")]
fn linux_read_ppid(pid: libc::pid_t) -> Option<libc::pid_t> {
    let path = format!("/proc/{}/status", pid);
    let s = std::fs::read_to_string(&path).ok()?;
    s.lines().find_map(|line| {
        line.trim()
            .strip_prefix("PPid:")
            .and_then(|rest| rest.trim().parse().ok())
    })
}

/// All descendants of `root` (by tracing `PPid` in `/proc`), in post-order for signaling.
#[cfg(target_os = "linux")]
fn linux_subtree_postorder_kill_list(root: libc::pid_t) -> Vec<libc::pid_t> {
    use std::collections::{HashMap, HashSet};

    if root <= 0 {
        return Vec::new();
    }
    let mut set: HashSet<libc::pid_t> = HashSet::new();
    set.insert(root);
    loop {
        let mut added = false;
        let Ok(entries) = std::fs::read_dir("/proc") else {
            break;
        };
        for ent in entries.flatten() {
            let Ok(pid) = ent.file_name().to_string_lossy().parse::<libc::pid_t>() else {
                continue;
            };
            if pid <= 0 || set.contains(&pid) {
                continue;
            }
            if let Some(ppid) = linux_read_ppid(pid) {
                if set.contains(&ppid) {
                    set.insert(pid);
                    added = true;
                }
            }
        }
        if !added {
            break;
        }
    }
    let mut children: HashMap<libc::pid_t, Vec<libc::pid_t>> = HashMap::new();
    for &p in &set {
        if p == root {
            continue;
        }
        if let Some(ppid) = linux_read_ppid(p) {
            if set.contains(&ppid) {
                children.entry(ppid).or_default().push(p);
            }
        }
    }
    let mut out = Vec::new();
    let mut visited = HashSet::new();
    fn dfs(
        n: libc::pid_t,
        ch: &HashMap<libc::pid_t, Vec<libc::pid_t>>,
        visited: &mut HashSet<libc::pid_t>,
        out: &mut Vec<libc::pid_t>,
    ) {
        if !visited.insert(n) {
            return;
        }
        if let Some(subs) = ch.get(&n) {
            for &c in subs {
                dfs(c, ch, visited, out);
            }
        }
        out.push(n);
    }
    dfs(root, &children, &mut visited, &mut out);
    out
}

#[cfg(target_os = "linux")]
unsafe fn linux_signal_pids(pids: &[libc::pid_t], sig: libc::c_int) {
    for &p in pids {
        if p > 0 {
            let _ = libc::kill(p, sig);
        }
    }
}

/// Stop `spawn_shell_command_line` and CEF/Chromium descendants.
///
/// On Linux, walks `/proc/…/children` so **subprocesses that left the process group** (sandbox)
/// still get signalled. Elsewhere, uses `SIGTERM`/`SIGKILL` on the child’s process group.
pub fn terminate_sidecar(child: &mut Option<Child>) {
    let Some(mut c) = child.take() else {
        return;
    };
    #[cfg(target_os = "linux")]
    {
        let pid = c.id() as libc::pid_t;
        let order = linux_subtree_postorder_kill_list(pid);
        unsafe {
            linux_signal_pids(&order, libc::SIGTERM);
        }
        for _ in 0..80 {
            match c.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let order = linux_subtree_postorder_kill_list(pid);
        unsafe {
            linux_signal_pids(&order, libc::SIGKILL);
        }
        let _ = c.wait();
    }
    #[cfg(all(unix, not(target_os = "linux")))]
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
