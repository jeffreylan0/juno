//! A screenshot of one display, without the app's own windows in it, and
//! the window the selection was made over (which names the selection's page).
//!
//! - macOS: ScreenCaptureKit's screenshot API (macOS 14+), filtering out
//!   every window of this app, so the bar never has to step aside. Needs
//!   Screen Recording permission.
//! - Windows: GDI, with the app's windows left out of that one capture by
//!   the system (display affinity, set just for it). No permission.
//! - Linux (a development and test target only): X11. Nothing can be left
//!   out of an X11 capture, so the overlay is hidden for the shot (wm.rs).

use image::RgbaImage;
use serde::Serialize;

use crate::geometry::Rect;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;
#[cfg(windows)]
pub use windows::without_windows;

/// The app (and window title) a selection was made over.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Source {
    pub app: String,
    pub title: String,
}

#[derive(Debug)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // only macOS refuses permission
pub enum CaptureError {
    /// The system did not let us record the screen (macOS Screen Recording).
    Permission,
    Failed(String),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CaptureError::Permission => write!(f, "Screen Recording permission is off"),
            CaptureError::Failed(why) => write!(f, "{why}"),
        }
    }
}

/// Screen Recording permission, where the system has one.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)] // each system uses only some of these
pub enum Access {
    Granted,
    Denied,
    /// Windows and Linux ask for nothing.
    NotNeeded,
}

/// Captures the display whose frame (in the system's global space, see
/// geometry.rs) is `frame`, at its full resolution.
pub fn capture_display(frame: Rect, scale: f64) -> Result<RgbaImage, CaptureError> {
    platform::capture_display(frame, scale)
}

/// The topmost window of another app at `point` (global space), if the system says.
pub fn window_at(point: (f64, f64)) -> Option<Source> {
    platform::window_at(point)
}

pub fn screen_access() -> Access {
    platform::screen_access()
}

/// Asks for Screen Recording permission. The first time, macOS shows its own
/// prompt and lists the app in System Settings; after that it does nothing,
/// and the student has to turn the switch on there (then restart the app).
pub fn request_screen_access() -> Access {
    platform::request_screen_access()
}
