use crate::CompositorState;
use smithay::{
    desktop::Window,
    input::pointer::{
        AxisFrame, ButtonEvent, GestureHoldBeginEvent, GestureHoldEndEvent, GesturePinchBeginEvent,
        GesturePinchEndEvent, GesturePinchUpdateEvent, GestureSwipeBeginEvent,
        GestureSwipeEndEvent, GestureSwipeUpdateEvent, GrabStartData as PointerGrabStartData,
        MotionEvent, PointerGrab, PointerInnerHandle, RelativeMotionEvent,
    },
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    utils::{Logical, Point},
};

pub struct MoveSurfaceGrab {
    pub start_data: PointerGrabStartData<CompositorState>,
    pub window: Window,
    pub initial_window_location: Point<i32, Logical>,
}

impl MoveSurfaceGrab {
    pub fn new(
        start_data: PointerGrabStartData<CompositorState>,
        window: Window,
        initial_window_location: Point<i32, Logical>,
    ) -> Self {
        Self {
            start_data,
            window,
            initial_window_location,
        }
    }
}

impl PointerGrab<CompositorState> for MoveSurfaceGrab {
    fn motion(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        _focus: Option<(WlSurface, Point<f64, Logical>)>,
        event: &MotionEvent,
    ) {
        handle.motion(data, None, event);

        let delta = event.location - self.start_data.location;
        let new_location = self.initial_window_location.to_f64() + delta;
        data.space
            .map_element(self.window.clone(), new_location.to_i32_round(), true);

        data.notify_geometry_if_changed(&self.window);
    }

    fn relative_motion(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        focus: Option<(WlSurface, Point<f64, Logical>)>,
        event: &RelativeMotionEvent,
    ) {
        handle.relative_motion(data, focus, event);
    }

    fn button(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &ButtonEvent,
    ) {
        handle.button(data, event);

        const BTN_LEFT: u32 = 0x110;

        if !handle.current_pressed().contains(&BTN_LEFT) {
            handle.unset_grab(self, data, event.serial, event.time, true);
            data.notify_geometry_if_changed(&self.window);
        }
    }

    fn axis(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        details: AxisFrame,
    ) {
        handle.axis(data, details)
    }

    fn frame(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
    ) {
        handle.frame(data);
    }

    fn gesture_swipe_begin(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &GestureSwipeBeginEvent,
    ) {
        handle.gesture_swipe_begin(data, event)
    }

    fn gesture_swipe_update(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &GestureSwipeUpdateEvent,
    ) {
        handle.gesture_swipe_update(data, event)
    }

    fn gesture_swipe_end(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &GestureSwipeEndEvent,
    ) {
        handle.gesture_swipe_end(data, event)
    }

    fn gesture_pinch_begin(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &GesturePinchBeginEvent,
    ) {
        handle.gesture_pinch_begin(data, event)
    }

    fn gesture_pinch_update(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &GesturePinchUpdateEvent,
    ) {
        handle.gesture_pinch_update(data, event)
    }

    fn gesture_pinch_end(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &GesturePinchEndEvent,
    ) {
        handle.gesture_pinch_end(data, event)
    }

    fn gesture_hold_begin(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &GestureHoldBeginEvent,
    ) {
        handle.gesture_hold_begin(data, event)
    }

    fn gesture_hold_end(
        &mut self,
        data: &mut CompositorState,
        handle: &mut PointerInnerHandle<'_, CompositorState>,
        event: &GestureHoldEndEvent,
    ) {
        handle.gesture_hold_end(data, event)
    }

    fn start_data(&self) -> &PointerGrabStartData<CompositorState> {
        &self.start_data
    }

    fn unset(&mut self, _data: &mut CompositorState) {}
}
