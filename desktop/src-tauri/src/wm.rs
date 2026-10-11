//! The app's four windows.
//!
//! - `core`: hidden, made at start and kept for the app's life. It runs the
//!   extension's background logic (desktop/src/core): the chat queue, answers
//!   and the cloud copy.
//! - `overlay`: transparent, over the whole display under the pointer, above
//!   everything (full-screen apps included). It draws the bar and the
//!   selection. While a selection is being made it takes every click; while
//!   the bar waits, clicks go through to the app beneath except on the bar
//!   and its tooltips (`passthrough`).
//! - `panel`: the answer panel, a floating card at the top right of the
//!   display the selection was made on, as tall as its chat needs (up to the
//!   screen). Closing it finishes the chat, as ✕ on Chrome's side panel does.
//! - `settings`: the settings page, a card in the middle of the screen.
//!
//! The panel and settings are cards like the bar: no title bar (their top
//! bar drags them), rounded on macOS (Windows 11 rounds them itself), with
//! the system's shadow. Each is made hidden and shows itself once its page
//! has drawn (`window_show`), so it never flashes white or empty.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::geometry::{self, Display, Placement, Rect, Space};

pub const CORE: &str = "core";
pub const OVERLAY: &str = "overlay";
pub const PANEL: &str = "panel";
pub const SETTINGS: &str = "settings";

/// The panel's width, in CSS pixels (Chrome's side panel is 320–ish to 600).
pub const PANEL_WIDTH: f64 = 420.0;
/// The panel's height before its chat has anything in it, and the least it fits to.
pub const PANEL_HEIGHT: f64 = 440.0;
/// Settings, CSS pixels (less on a small screen).
const SETTINGS_SIZE: (f64, f64) = (760.0, 680.0);

/// Where the overlay is and what of it takes clicks.
#[derive(Clone, Debug, Default)]
pub struct OverlayState {
    pub visible: bool,
    /// A selection is armed: the whole overlay takes the pointer.
    pub interactive: bool,
    /// While the bar waits: the parts that take the pointer, in CSS pixels.
    pub regions: Vec<Rect>,
    pub display: Option<Display>,
    /// The main display's scale, which macOS reports the pointer in.
    pub main_scale: f64,
    /// What the overlay was last told: ignore the pointer or not.
    pub ignoring: Option<bool>,
}

pub type SharedOverlay = Arc<Mutex<OverlayState>>;

fn displays(app: &AppHandle) -> Vec<Display> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let (p, s, w) = (m.position(), m.size(), m.work_area());
            Display {
                name: m.name().cloned().unwrap_or_default(),
                frame: Rect::new(p.x as f64, p.y as f64, s.width as f64, s.height as f64),
                work: Rect::new(w.position.x as f64, w.position.y as f64, w.size.width as f64, w.size.height as f64),
                scale: m.scale_factor(),
            }
        })
        .collect()
}

fn main_scale(app: &AppHandle) -> f64 {
    app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0)
}

/// The display the pointer is on now.
pub fn display_under_pointer(app: &AppHandle) -> Option<(Display, f64)> {
    let all = displays(app);
    let scale = main_scale(app);
    let cursor = app.cursor_position().map(|p| (p.x, p.y)).unwrap_or((0.0, 0.0));
    let at = geometry::global_cursor(cursor, Space::native(), scale);
    geometry::display_at(&all, at, Space::native()).map(|i| (all[i].clone(), scale))
}

/// Moves first, then sizes: on Windows a move onto a monitor at another
/// scale rescales the window (WM_DPICHANGED), which would undo a size set
/// before it.
fn place(window: &WebviewWindow, placement: Placement) -> tauri::Result<()> {
    match placement {
        Placement::Logical(r) => {
            window.set_position(LogicalPosition::new(r.x, r.y))?;
            window.set_size(LogicalSize::new(r.width, r.height))?;
        }
        Placement::Physical(r) => {
            window.set_position(PhysicalPosition::new(r.x.round() as i32, r.y.round() as i32))?;
            window.set_size(PhysicalSize::new(r.width.round() as u32, r.height.round() as u32))?;
        }
    }
    Ok(())
}

pub fn make_core(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, CORE, WebviewUrl::App("web/core.html".into()))
        .title("Selection AI (core)")
        .visible(false)
        .skip_taskbar(true)
        .focused(false)
        // macOS suspends a webview that is not in a visible window; this one
        // never is, and answers stream through it.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .build()
}

/// macOS: with nothing of ours left on screen, the app steps back, so the
/// keyboard goes back to the app the student was in.
pub fn yield_focus(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let showing = [OVERLAY, PANEL, SETTINGS]
            .iter()
            .any(|label| app.get_webview_window(label).and_then(|w| w.is_visible().ok()).unwrap_or(false));
        if !showing {
            let _ = app.hide();
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// macOS: a window cannot show while the app is hidden (yield_focus).
fn unhide(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn overlay(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(OVERLAY) {
        return Ok(w);
    }
    let window = WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("web/overlay.html".into()))
        .title("Selection AI")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .accept_first_mouse(true)
        .visible(false)
        .focused(false)
        // Hidden between selections, but it must answer the moment it shows.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        // Windows: out of every capture, ours included (see capture/windows.rs).
        .content_protected(cfg!(windows))
        .build()?;
    #[cfg(target_os = "macos")]
    mac::float_above_everything(&window, true);
    Ok(window)
}

/// Puts the overlay on the display under the pointer and shows it; `focus`
/// also gives it the keyboard (Escape and Enter while selecting).
pub fn show_overlay(app: &AppHandle, state: &SharedOverlay, focus: bool) -> tauri::Result<Option<Display>> {
    let Some((display, scale)) = display_under_pointer(app) else { return Ok(None) };
    unhide(app);
    let window = overlay(app)?;
    let moved = state.lock().unwrap().display.as_ref() != Some(&display);
    if moved || !window.is_visible().unwrap_or(false) {
        place(&window, display.overlay_placement(Space::native()))?;
    }
    {
        let mut s = state.lock().unwrap();
        s.visible = true;
        s.display = Some(display.clone());
        s.main_scale = scale;
    }
    window.show()?;
    if focus {
        window.set_focus()?;
    }
    Ok(Some(display))
}

pub fn hide_overlay(app: &AppHandle, state: &SharedOverlay) -> tauri::Result<()> {
    {
        let mut s = state.lock().unwrap();
        s.visible = false;
        s.interactive = false;
        s.regions.clear();
    }
    if let Some(w) = app.get_webview_window(OVERLAY) {
        w.hide()?;
    }
    yield_focus(app);
    Ok(())
}

pub fn focus_overlay(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(OVERLAY) {
        w.set_focus()?;
    }
    Ok(())
}

/// A card window: no title bar, the system's shadow, transparent on macOS
/// (where the page rounds it), made hidden until its page has drawn.
fn card<'a>(app: &'a AppHandle, label: &'a str, url: &str, title: &str) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .decorations(false)
        .shadow(true)
        .transparent(cfg!(target_os = "macos"))
        .resizable(true)
        .visible(false)
        .focused(false)
        .content_protected(cfg!(windows))
}

/// Shows a card once its page has drawn (window_show), or after a moment whatever happens.
fn show_soon(window: &WebviewWindow) {
    let w = window.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(1500));
        if !w.is_visible().unwrap_or(true) {
            let _ = w.show();
        }
    });
}

/// A card's page has drawn: its window shows, with the keyboard.
pub fn show_window(window: &WebviewWindow) -> tauri::Result<()> {
    unhide(window.app_handle());
    window.show()?;
    window.set_focus()?;
    refresh_shadow_soon(window);
    Ok(())
}

/// macOS works out a see-through window's shadow from what it shows when it
/// appears, which for a card fading in is nothing: once it is in (or has
/// changed size), the shadow is worked out again.
fn refresh_shadow_soon(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let w = window.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(260));
            mac::refresh_shadow(&w);
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// Opens the panel at the top right of the overlay's display (or the
/// pointer's), or brings it forward if it is open. `focus` gives it the
/// keyboard, so the student can type a question straight away.
pub fn open_panel(app: &AppHandle, state: &SharedOverlay, focus: bool) -> tauri::Result<()> {
    let display = state.lock().unwrap().display.clone().or_else(|| display_under_pointer(app).map(|(d, _)| d));
    unhide(app);
    if let Some(window) = app.get_webview_window(PANEL) {
        window.show()?;
        if focus {
            window.set_focus()?;
        }
        return Ok(());
    }
    let window = card(app, PANEL, "web/panel.html", "Selection AI")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .min_inner_size(320.0, 320.0)
        .always_on_top(true)
        .build()?;
    #[cfg(target_os = "macos")]
    mac::float_above_everything(&window, false);
    if let Some(d) = &display {
        place(&window, d.panel_placement(Space::native(), PANEL_WIDTH, PANEL_HEIGHT))?;
    }
    show_soon(&window);
    Ok(())
}

/// The panel's page asks for the height its chat needs (CSS pixels): it
/// grows, or shrinks, downwards from where its top is, never past the
/// usable area of its display less the margin, nor below where it started.
/// Says the height it got.
pub fn fit_panel(app: &AppHandle, height: f64) -> tauri::Result<f64> {
    let Some(window) = app.get_webview_window(PANEL) else { return Ok(height) };
    let scale = window.scale_factor()?;
    let size = window.inner_size()?.to_logical::<f64>(scale);
    let top = window.outer_position()?.to_logical::<f64>(scale).y;
    let limit = match window.current_monitor()? {
        Some(m) => {
            let (k, work) = (m.scale_factor(), m.work_area());
            (work.position.y as f64 + work.size.height as f64) / k - geometry::CARD_MARGIN - top
        }
        None => height,
    };
    let h = height.min(limit).max(PANEL_HEIGHT.min(limit)).round();
    if (h - size.height).abs() >= 1.0 {
        window.set_size(LogicalSize::new(size.width, h))?;
        refresh_shadow_soon(&window);
    }
    Ok(h)
}

pub fn close_panel(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(PANEL) {
        w.destroy()?;
    }
    Ok(())
}

/// Opens settings (at `#section` if given), or brings them forward.
pub fn open_settings(app: &AppHandle, hash: Option<&str>) -> tauri::Result<()> {
    let hash = hash.map(|h| h.trim_start_matches('#')).filter(|h| h.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    unhide(app);
    if let Some(w) = app.get_webview_window(SETTINGS) {
        if let Some(h) = hash {
            w.eval(format!("location.hash = '#{h}'"))?;
        }
        w.show()?;
        w.unminimize()?;
        w.set_focus()?;
        return Ok(());
    }
    let url = match hash {
        Some(h) => format!("web/settings.html#{h}"),
        None => "web/settings.html".to_string(),
    };
    let window = card(app, SETTINGS, &url, "Selection AI Settings").inner_size(SETTINGS_SIZE.0, SETTINGS_SIZE.1).min_inner_size(520.0, 420.0).build()?;
    if let Some((d, _)) = display_under_pointer(app) {
        place(&window, d.centred_placement(Space::native(), SETTINGS_SIZE.0, SETTINGS_SIZE.1))?;
    }
    show_soon(&window);
    Ok(())
}

/// While the overlay is up, keeps "does it take the pointer here?" in step
/// with the pointer: everywhere while selecting, only over the bar and its
/// tooltips while waiting. A window that ignores the pointer hears nothing of
/// it, so the pointer is polled (cheaply) rather than tracked by the page.
pub fn start_passthrough(app: AppHandle, state: SharedOverlay) {
    thread::Builder::new()
        .name("overlay-passthrough".into())
        .spawn(move || loop {
            let snapshot = state.lock().unwrap().clone();
            if !snapshot.visible {
                thread::sleep(Duration::from_millis(120));
                continue;
            }
            let want_ignore = if snapshot.interactive {
                false
            } else {
                match (&snapshot.display, app.cursor_position()) {
                    (Some(display), Ok(p)) => {
                        let at = geometry::global_cursor((p.x, p.y), Space::native(), snapshot.main_scale);
                        let css = geometry::to_overlay_css(display, at, Space::native());
                        !geometry::over_regions(&snapshot.regions, css, 3.0)
                    }
                    _ => false,
                }
            };
            if snapshot.ignoring != Some(want_ignore) {
                if let Some(w) = app.get_webview_window(OVERLAY) {
                    if w.set_ignore_cursor_events(want_ignore).is_ok() {
                        state.lock().unwrap().ignoring = Some(want_ignore);
                    }
                }
            }
            thread::sleep(Duration::from_millis(16));
        })
        .expect("starting the passthrough thread");
}

#[cfg(target_os = "macos")]
pub mod mac {
    use objc2_app_kit::{NSFloatingWindowLevel, NSPopUpMenuWindowLevel, NSWindow, NSWindowCollectionBehavior};
    use tauri::WebviewWindow;

    /// Above full-screen apps and on every Space. The overlay goes above the
    /// menu bar and the Dock too; the panel floats like a utility window.
    pub fn float_above_everything(window: &WebviewWindow, overlay: bool) {
        let Ok(ptr) = window.ns_window() else { return };
        let ptr = ptr as usize;
        let _ = window.run_on_main_thread(move || {
            // SAFETY: a live NSWindow owned by this window, used on the main thread.
            let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
            let mut behavior = NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary;
            if overlay {
                behavior |= NSWindowCollectionBehavior::Stationary | NSWindowCollectionBehavior::IgnoresCycle;
                ns_window.setLevel(NSPopUpMenuWindowLevel);
            } else {
                ns_window.setLevel(NSFloatingWindowLevel);
            }
            ns_window.setCollectionBehavior(behavior);
            ns_window.setHidesOnDeactivate(false);
        });
    }

    /// Works a see-through window's shadow out again from what it shows now.
    pub fn refresh_shadow(window: &WebviewWindow) {
        let Ok(ptr) = window.ns_window() else { return };
        let ptr = ptr as usize;
        let _ = window.run_on_main_thread(move || {
            // SAFETY: a live NSWindow owned by this window, used on the main thread.
            let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
            ns_window.invalidateShadow();
        });
    }
}
