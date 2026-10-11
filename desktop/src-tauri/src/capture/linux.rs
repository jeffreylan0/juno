//! X11 capture for development and the end-to-end tests (Xvfb). Linux is not
//! a shipping target for version 1.

use image::RgbaImage;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt, ImageFormat};

use super::{Access, CaptureError, Source};
use crate::geometry::Rect;

pub fn capture_display(frame: Rect, _scale: f64) -> Result<RgbaImage, CaptureError> {
    let fail = |e: &dyn std::fmt::Display| CaptureError::Failed(format!("X11 capture failed: {e}"));
    let (conn, screen) = x11rb::connect(None).map_err(|e| fail(&e))?;
    let root = conn.setup().roots[screen].root;
    let (w, h) = (frame.width.round() as u16, frame.height.round() as u16);
    let reply = conn
        .get_image(ImageFormat::Z_PIXMAP, root, frame.x.round() as i16, frame.y.round() as i16, w, h, !0)
        .map_err(|e| fail(&e))?
        .reply()
        .map_err(|e| fail(&e))?;
    if reply.depth < 24 || reply.data.len() < w as usize * h as usize * 4 {
        return Err(CaptureError::Failed(format!("unexpected X11 image: depth {} with {} bytes", reply.depth, reply.data.len())));
    }
    // 32 bits per pixel, least significant byte first: B, G, R, unused.
    let mut rgba = Vec::with_capacity(w as usize * h as usize * 4);
    for px in reply.data.chunks_exact(4).take(w as usize * h as usize) {
        rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
    }
    RgbaImage::from_raw(w as u32, h as u32, rgba).ok_or_else(|| CaptureError::Failed("X11 image has the wrong size".into()))
}

pub fn window_at(_point: (f64, f64)) -> Option<Source> {
    None
}

pub fn window_list() -> Vec<(Source, Rect)> {
    Vec::new()
}

pub fn screen_access() -> Access {
    Access::NotNeeded
}

pub fn request_screen_access() -> Access {
    Access::NotNeeded
}
