use super::*;
use serde::Serialize;
use smithay::backend::renderer::sync::SyncPoint;
use smithay::reexports::calloop::{
    generic::Generic, Interest, Mode, PostAction,
};
use smithay::wayland::drm_syncobj::{DrmSyncPoint, DrmSyncobjCachedState};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ExplicitSyncSurfaceKey {
    client_id: Option<ClientId>,
    surface_id: u32,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ExplicitSyncCommitKey {
    surface: ExplicitSyncSurfaceKey,
    generation: u64,
}

struct ExplicitSyncCommit {
    release_point: DrmSyncPoint,
    sampled: bool,
}

#[derive(Default)]
pub(crate) struct ExplicitSyncState {
    next_generation: u64,
    active_by_surface: HashMap<ExplicitSyncSurfaceKey, ExplicitSyncCommitKey>,
    commits: HashMap<ExplicitSyncCommitKey, ExplicitSyncCommit>,
    output_sampled: HashSet<ExplicitSyncCommitKey>,
    frame_sampled: HashMap<ExplicitSyncCommitKey, Vec<SyncPoint>>,
    pending_releases: usize,
    release_signaled: u64,
    release_wait_threads: u64,
    release_eventfds: u64,
}

#[derive(Clone, Serialize)]
pub(crate) struct ExplicitSyncSnapshot {
    pub(crate) tracked_commits: usize,
    pub(crate) pending_releases: usize,
    pub(crate) current_output_sampled: usize,
    pub(crate) release_signaled: u64,
    pub(crate) release_wait_threads: u64,
    pub(crate) release_eventfds: u64,
}

fn explicit_sync_surface_key(surface: &WlSurface) -> ExplicitSyncSurfaceKey {
    ExplicitSyncSurfaceKey {
        client_id: surface.client().map(|client| client.id()),
        surface_id: surface.id().protocol_id(),
    }
}

fn signal_release_points(points: Vec<DrmSyncPoint>) {
    for point in points {
        if let Err(error) = point.signal() {
            tracing::warn!(?error, "explicit sync release signal failed");
        }
    }
}

fn wait_thread(
    syncs: Vec<SyncPoint>,
    releases: Vec<DrmSyncPoint>,
    done_tx: channel::Sender<crate::cef::compositor_tx::CefToCompositor>,
) {
    let _ = std::thread::Builder::new()
        .name("derp-explicit-sync-release".to_string())
        .spawn(move || {
            for sync in syncs {
                if let Err(error) = sync.wait() {
                    tracing::warn!(?error, "explicit sync render wait failed");
                }
            }
            let count = releases.len();
            signal_release_points(releases);
            let _ = done_tx.send(crate::cef::compositor_tx::CefToCompositor::Run(Box::new(
                move |state| {
                    if let Ok(mut sync) = state.explicit_sync.lock() {
                        sync.note_release_complete(count);
                    }
                },
            )));
        });
}

impl ExplicitSyncState {
    fn next_key(&mut self, surface: ExplicitSyncSurfaceKey) -> ExplicitSyncCommitKey {
        self.next_generation = self.next_generation.saturating_add(1);
        ExplicitSyncCommitKey {
            surface,
            generation: self.next_generation,
        }
    }

    fn retire_commit(&mut self, key: ExplicitSyncCommitKey) {
        if let Some(commit) = self.commits.remove(&key) {
            signal_release_points(vec![commit.release_point]);
            self.release_signaled = self.release_signaled.saturating_add(1);
        }
    }

    pub(crate) fn capture_surface_commit(&mut self, surface: &WlSurface) {
        let surface_key = explicit_sync_surface_key(surface);
        let release_point = smithay::wayland::compositor::with_states(surface, |states| {
            states
                .cached_state
                .get::<DrmSyncobjCachedState>()
                .current()
                .release_point
                .clone()
        });
        let Some(release_point) = release_point else {
            return;
        };
        if let Some(old_key) = self.active_by_surface.remove(&surface_key) {
            if self
                .commits
                .get(&old_key)
                .is_some_and(|commit| !commit.sampled)
            {
                self.retire_commit(old_key);
            }
        }
        let key = self.next_key(surface_key.clone());
        self.active_by_surface.insert(surface_key, key.clone());
        self.commits.insert(
            key,
            ExplicitSyncCommit {
                release_point,
                sampled: false,
            },
        );
    }

    pub(crate) fn surface_destroyed(&mut self, surface: &WlSurface) {
        let surface_key = explicit_sync_surface_key(surface);
        if let Some(active) = self.active_by_surface.remove(&surface_key) {
            self.retire_commit(active);
        }
        let stale: Vec<_> = self
            .commits
            .keys()
            .filter(|key| key.surface == surface_key)
            .cloned()
            .collect();
        for key in stale {
            self.retire_commit(key);
        }
    }

    pub(crate) fn begin_output_sample(&mut self) {
        self.output_sampled.clear();
    }

    pub(crate) fn mark_surface_sampled(&mut self, surface: &WlSurface) {
        let surface_key = explicit_sync_surface_key(surface);
        let Some(key) = self.active_by_surface.get(&surface_key).cloned() else {
            return;
        };
        if let Some(commit) = self.commits.get_mut(&key) {
            commit.sampled = true;
            self.output_sampled.insert(key);
        }
    }

    pub(crate) fn finish_output_sample(&mut self, sync_point: SyncPoint) {
        let keys: Vec<_> = self.output_sampled.drain().collect();
        for key in keys {
            if self.commits.contains_key(&key) {
                self.frame_sampled
                    .entry(key)
                    .or_default()
                    .push(sync_point.clone());
            }
        }
    }

    pub(crate) fn take_frame_sampled_releases(&mut self) -> Vec<(Vec<SyncPoint>, Vec<DrmSyncPoint>)> {
        let sampled: Vec<_> = self.frame_sampled.drain().collect();
        let mut out = Vec::new();
        for (key, syncs) in sampled {
            if self.active_by_surface.get(&key.surface) == Some(&key) {
                self.active_by_surface.remove(&key.surface);
            }
            if let Some(commit) = self.commits.remove(&key) {
                self.pending_releases = self.pending_releases.saturating_add(1);
                out.push((syncs, vec![commit.release_point]));
            }
        }
        out
    }

    pub(crate) fn note_release_scheduled(&mut self, count: usize, eventfd: bool) {
        if eventfd {
            self.release_eventfds = self.release_eventfds.saturating_add(count as u64);
        } else {
            self.release_wait_threads = self.release_wait_threads.saturating_add(1);
        }
    }

    pub(crate) fn note_release_complete(&mut self, count: usize) {
        self.pending_releases = self.pending_releases.saturating_sub(count);
        self.release_signaled = self.release_signaled.saturating_add(count as u64);
    }

    pub(crate) fn snapshot(&self) -> ExplicitSyncSnapshot {
        ExplicitSyncSnapshot {
            tracked_commits: self.commits.len(),
            pending_releases: self.pending_releases,
            current_output_sampled: self.output_sampled.len(),
            release_signaled: self.release_signaled,
            release_wait_threads: self.release_wait_threads,
            release_eventfds: self.release_eventfds,
        }
    }
}

impl CompositorState {
    pub(crate) fn explicit_sync_capture_surface_commit(&self, surface: &WlSurface) {
        if let Ok(mut sync) = self.explicit_sync.lock() {
            sync.capture_surface_commit(surface);
        }
    }

    pub(crate) fn explicit_sync_surface_destroyed(&self, surface: &WlSurface) {
        if let Ok(mut sync) = self.explicit_sync.lock() {
            sync.surface_destroyed(surface);
        }
    }

    pub(crate) fn explicit_sync_begin_output_sample(&self) {
        if let Ok(mut sync) = self.explicit_sync.lock() {
            sync.begin_output_sample();
        }
    }

    pub(crate) fn explicit_sync_finish_output_sample(&self, sync_point: SyncPoint) {
        if let Ok(mut sync) = self.explicit_sync.lock() {
            sync.finish_output_sample(sync_point);
        }
    }

    pub(crate) fn explicit_sync_mark_surface_sampled(&self, surface: &WlSurface) {
        if let Ok(mut sync) = self.explicit_sync.lock() {
            sync.mark_surface_sampled(surface);
        }
    }

    pub(crate) fn explicit_sync_mark_surface_tree_sampled(&self, surface: &WlSurface) {
        with_surfaces_surface_tree(surface, |surface, _| {
            self.explicit_sync_mark_surface_sampled(surface);
        });
    }

    pub(crate) fn explicit_sync_schedule_frame_releases(&mut self) {
        let batches = if let Ok(mut sync) = self.explicit_sync.lock() {
            sync.take_frame_sampled_releases()
        } else {
            Vec::new()
        };
        let done_tx = self.cef_to_compositor_tx();
        for (syncs, releases) in batches {
            if releases.is_empty() {
                continue;
            }
            if syncs.iter().all(|sync| sync.is_reached()) {
                let count = releases.len();
                signal_release_points(releases);
                if let Ok(mut sync) = self.explicit_sync.lock() {
                    sync.note_release_complete(count);
                }
                continue;
            }
            let count = releases.len();
            let exported: Option<Vec<_>> = syncs.iter().map(|sync| sync.export()).collect();
            if let Some(fds) = exported {
                let fd_count = fds.len().max(1);
                let shared_releases = Arc::new(Mutex::new(Some(releases)));
                let shared_count = Arc::new(std::sync::atomic::AtomicUsize::new(fd_count));
                let mut all_inserted = true;
                for fd in fds {
                    let releases_for_cb = shared_releases.clone();
                    let count_for_cb = shared_count.clone();
                    let loop_handle = self.core.loop_handle.clone();
                    let inserted = loop_handle.insert_source(
                        Generic::new(fd, Interest::READ, Mode::Level),
                        move |_, _, data: &mut crate::CalloopData| {
                            if count_for_cb.fetch_sub(1, Ordering::AcqRel) == 1 {
                                let points = releases_for_cb
                                    .lock()
                                    .ok()
                                    .and_then(|mut guard| guard.take())
                                    .unwrap_or_default();
                                let count = points.len();
                                signal_release_points(points);
                                if let Ok(mut sync) = data.state.explicit_sync.lock() {
                                    sync.note_release_complete(count);
                                }
                            }
                            Ok(PostAction::Remove)
                        },
                    );
                    if inserted.is_err() {
                        all_inserted = false;
                        break;
                    }
                }
                if all_inserted {
                    if let Ok(mut sync) = self.explicit_sync.lock() {
                        sync.note_release_scheduled(count, true);
                    }
                    continue;
                }
                let fallback_releases = shared_releases
                    .lock()
                    .ok()
                    .and_then(|mut guard| guard.take())
                    .unwrap_or_default();
                if !fallback_releases.is_empty() {
                    wait_thread(syncs, fallback_releases, done_tx.clone());
                    if let Ok(mut sync) = self.explicit_sync.lock() {
                        sync.note_release_scheduled(count, false);
                    }
                }
                continue;
            }
            wait_thread(syncs, releases, done_tx.clone());
            if let Ok(mut sync) = self.explicit_sync.lock() {
                sync.note_release_scheduled(count, false);
            }
        }
    }

    pub(crate) fn explicit_sync_snapshot(&self) -> ExplicitSyncSnapshot {
        self.explicit_sync
            .lock()
            .map(|sync| sync.snapshot())
            .unwrap_or(ExplicitSyncSnapshot {
                tracked_commits: 0,
                pending_releases: 0,
                current_output_sampled: 0,
                release_signaled: 0,
                release_wait_threads: 0,
                release_eventfds: 0,
            })
    }
}
