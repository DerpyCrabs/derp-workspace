use super::*;

pub(crate) struct DesktopWallpaperGpu {
    pub texture: smithay::backend::renderer::gles::GlesTexture,
    pub context_id:
        smithay::backend::renderer::ContextId<smithay::backend::renderer::gles::GlesTexture>,
    pub tex_w: i32,
    pub tex_h: i32,
}

pub(crate) struct DesktopWallpaperGpuEntry {
    pub gpu: DesktopWallpaperGpu,
    pub commit: CommitCounter,
}

pub(crate) struct BackdropWallpaperIdCache {
    pub key: String,
    pub ids: Vec<Id>,
}

pub(crate) struct CachedBackdropLayers {
    pub key: crate::render::backdrop_render::BackdropCacheKey,
    pub layers: crate::render::backdrop_render::BackdropLayers,
}

#[derive(Default)]
pub(crate) struct CachedShellRenderOutput {
    pub main: Option<
        crate::render::shell_render::CachedShellElement<
            crate::render::shell_render::ShellMainCacheKey,
        >,
    >,
}


impl CompositorState {
    pub(crate) fn apply_desktop_background_from_display_file(
        &mut self,
        cfg: &crate::controls::display_config::DisplayConfigFile,
    ) {
        self.desktop_background_config = cfg.desktop_background.clone();
        self.desktop_background_by_output_name = cfg.desktop_background_outputs.clone();
        self.backdrop_layers_by_output.clear();
        self.request_desktop_wallpaper_decode();
    }

    pub(crate) fn desktop_background_for_output(
        &self,
        output: &Output,
    ) -> &crate::controls::display_config::DesktopBackgroundConfig {
        let n = output.name();
        self.desktop_background_by_output_name
            .get(&n)
            .unwrap_or(&self.desktop_background_config)
    }

    fn collect_desktop_wallpaper_paths(&self) -> HashSet<PathBuf> {
        let mut s = HashSet::new();
        let mut add = |cfg: &crate::controls::display_config::DesktopBackgroundConfig| {
            if cfg.mode == "image" && !cfg.image_path.trim().is_empty() {
                let p =
                    crate::desktop::desktop_background::normalize_filesystem_path(&cfg.image_path);
                if !p.as_os_str().is_empty() {
                    s.insert(p);
                }
            }
        };
        add(&self.desktop_background_config);
        for c in self.desktop_background_by_output_name.values() {
            add(c);
        }
        s
    }

    fn prune_desktop_wallpaper_paths(&mut self, needed: &HashSet<PathBuf>) {
        self.desktop_wallpaper_cpu_by_path
            .retain(|k, _| needed.contains(k));
        self.desktop_wallpaper_gpu_by_path
            .retain(|k, _| needed.contains(k));
        self.wallpaper_decode_inflight
            .retain(|k| needed.contains(k));
    }

    pub fn apply_shell_desktop_background_json(&mut self, json: &str) {
        #[derive(serde::Deserialize)]
        struct ShellDesktopBg {
            #[serde(flatten)]
            default: crate::controls::display_config::DesktopBackgroundConfig,
            #[serde(default)]
            desktop_background_outputs:
                HashMap<String, crate::controls::display_config::DesktopBackgroundConfig>,
        }
        let (default, outs) = match serde_json::from_str::<ShellDesktopBg>(json) {
            Ok(w) => (w.default, w.desktop_background_outputs),
            Err(_) => {
                let cfg: crate::controls::display_config::DesktopBackgroundConfig =
                    match serde_json::from_str(json) {
                        Ok(c) => c,
                        Err(e) => {
                            tracing::warn!(target: "derp_wallpaper", ?e, "desktop background json");
                            return;
                        }
                    };
                (cfg, HashMap::new())
            }
        };
        self.desktop_background_config = default;
        self.desktop_background_by_output_name = outs;
        self.output_topology.display_config_save_pending = true;
        self.shell_osr.shell_exclusion_zones_need_full_damage = true;
        self.shell_osr.shell_dmabuf_dirty_force_full = true;
        self.request_desktop_wallpaper_decode();
    }

    fn request_desktop_wallpaper_decode(&mut self) {
        let needed = self.collect_desktop_wallpaper_paths();
        self.prune_desktop_wallpaper_paths(&needed);
        if needed.is_empty() {
            self.shell_osr.shell_exclusion_zones_need_full_damage = true;
            return;
        }
        for p in needed {
            if self.desktop_wallpaper_cpu_by_path.contains_key(&p) {
                continue;
            }
            if self.wallpaper_decode_inflight.contains(&p) {
                continue;
            }
            if self.wallpaper_req_tx.send(p.clone()).is_ok() {
                self.wallpaper_decode_inflight.insert(p);
            }
        }
    }

    pub(crate) fn sync_desktop_wallpaper_upload(&mut self, renderer: &mut GlesRenderer) {
        use smithay::backend::allocator::Fourcc;
        use smithay::backend::renderer::ImportMem;
        while let Ok(r) = self.wallpaper_done_rx.try_recv() {
            match r {
                Ok((path, cpu)) => {
                    self.wallpaper_decode_inflight.remove(&path);
                    self.desktop_wallpaper_cpu_by_path
                        .insert(path, Arc::new(cpu));
                }
                Err(e) => tracing::warn!(target: "derp_wallpaper", "{e}"),
            }
        }
        let needed = self.collect_desktop_wallpaper_paths();
        for path in needed {
            if self.desktop_wallpaper_gpu_by_path.contains_key(&path) {
                continue;
            }
            let Some(cpu) = self.desktop_wallpaper_cpu_by_path.get(&path) else {
                continue;
            };
            match renderer.import_memory(
                &cpu.bgra,
                Fourcc::Argb8888,
                Size::from((cpu.w, cpu.h)),
                false,
            ) {
                Ok(tex) => {
                    let ctx_id = renderer.context_id();
                    let mut commit = CommitCounter::default();
                    commit.increment();
                    self.desktop_wallpaper_gpu_by_path.insert(
                        path,
                        DesktopWallpaperGpuEntry {
                            gpu: DesktopWallpaperGpu {
                                texture: tex,
                                context_id: ctx_id,
                                tex_w: cpu.w,
                                tex_h: cpu.h,
                            },
                            commit,
                        },
                    );
                    self.shell_osr.shell_exclusion_zones_need_full_damage = true;
                }
                Err(e) => tracing::warn!(target: "derp_wallpaper", ?e, "wallpaper import_memory"),
            }
        }
    }
}
