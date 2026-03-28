//! Smithay `renderer_test` / `DummyRenderer` smoke tests (no GPU).

#[cfg(test)]
mod tests {
    use smithay::{
        backend::renderer::{
            test::{DummyFramebuffer, DummyRenderer},
            Renderer,
        },
        utils::{Physical, Size, Transform},
    };

    #[test]
    fn dummy_renderer_allocates_frame() {
        let mut renderer = DummyRenderer;
        let mut fb = DummyFramebuffer;
        let size = Size::<i32, Physical>::from((64, 48));
        let frame = renderer
            .render(&mut fb, size, Transform::Normal)
            .expect("dummy render");
        let _ = frame;
    }
}
