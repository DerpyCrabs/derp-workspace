use smithay::{
    desktop::{layer_map_for_output, LayerSurface as DesktopLayerSurface, PopupKind},
    reexports::wayland_server::protocol::{wl_output::WlOutput, wl_surface::WlSurface},
    wayland::shell::{
        wlr_layer::{
            Layer, LayerSurface as WlrLayerSurface, LayerSurfaceData, WlrLayerShellHandler,
            WlrLayerShellState,
        },
        xdg::PopupSurface,
    },
};

use crate::CompositorState;

impl CompositorState {
    fn layer_surface_target_output(
        &self,
        output: Option<&WlOutput>,
    ) -> Option<smithay::output::Output> {
        output
            .and_then(|wl_output| {
                self.space
                    .outputs()
                    .find(|output| output.owns(wl_output))
                    .cloned()
            })
            .or_else(|| self.shell_effective_primary_output())
            .or_else(|| self.space.outputs().next().cloned())
    }

    fn arrange_layer_output(&self, output: &smithay::output::Output) {
        layer_map_for_output(output).arrange();
    }

    fn desktop_layer_surface_configured(layer: &DesktopLayerSurface) -> bool {
        smithay::wayland::compositor::with_states(layer.wl_surface(), |states| {
            states
                .data_map
                .get::<LayerSurfaceData>()
                .map(|data| data.lock().unwrap().initial_configure_sent)
                .unwrap_or(false)
        })
    }
}

impl WlrLayerShellHandler for CompositorState {
    fn shell_state(&mut self) -> &mut WlrLayerShellState {
        &mut self.layer_shell_state
    }

    fn new_layer_surface(
        &mut self,
        surface: WlrLayerSurface,
        output: Option<WlOutput>,
        _layer: Layer,
        namespace: String,
    ) {
        let Some(output) = self.layer_surface_target_output(output.as_ref()) else {
            return;
        };
        let layer_surface = DesktopLayerSurface::new(surface, namespace);
        let _ = layer_map_for_output(&output).map_layer(&layer_surface);
        self.arrange_layer_output(&output);
    }

    fn new_popup(&mut self, _parent: WlrLayerSurface, popup: PopupSurface) {
        let _ = self.popups.track_popup(PopupKind::Xdg(popup));
    }

    fn layer_destroyed(&mut self, surface: WlrLayerSurface) {
        for output in self.space.outputs() {
            let layer = {
                let layer_map = layer_map_for_output(output);
                let layer = layer_map
                    .layers()
                    .find(|layer| layer.wl_surface() == surface.wl_surface())
                    .cloned();
                layer
            };
            let Some(layer) = layer else {
                continue;
            };
            layer_map_for_output(output).unmap_layer(&layer);
        }
    }
}

pub(crate) fn handle_commit(state: &CompositorState, root: &WlSurface) {
    let Some((output, layer)) = state.layer_surface_for_root(root) else {
        return;
    };
    state.arrange_layer_output(&output);
    if !CompositorState::desktop_layer_surface_configured(&layer) {
        layer.layer_surface().send_configure();
    }
}
