//! The app's four windows.
//!
//! - `core`: hidden, made at start and kept for the app's life. It runs the
//!   chats (desktop/src/core): the write queue, answers and the cloud copy.
//! - `overlay`: transparent, over the whole display under the pointer, above
//!   everything (full-screen apps included). It draws the bar and the
//!   selection. While a selection is being made it takes every click; while
//!   the bar waits, clicks go through to the app beneath except on the bar
//!   and its tooltips (`passthrough`).
//! - `panel`: the answer panel, a floating card at the edge of the display
//!   the selection was made on that the student picked (top right unless
//!   they say otherwise), most of the screen tall and growing with its chat,
//!   smoothly; or as big as they last made it. Made hidden at start and kept: a selection only has to
//!   show it, never wait for it to load. Closing it hides it and finishes
//!   the chat.
//! - `settings`: the settings page, a card in the middle of the screen,
//!   floating like the panel and opened above it. Made hidden at start and
//!   kept, so opening it only has to show it; closing it hides it, and so
//!   does summoning the bar (left open behind other apps, it would come
//!   forward with the app). Asked for before its page has drawn, it waits
//!   for that (`window_show`), so it never flashes white or empty. Opening
//!   it takes the bar away.
//!
//! The panel and settings are cards like the bar, with no title bar to see
//! (their top bar drags them): on macOS ordinary windows whose title bar is
//! hidden, so the system rounds them and draws their shadow; on Windows
//! windows without one, which Windows 11 rounds.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::geometry::{self, Display, Place, Placement, Rect, Row, Space};

pub const CORE: &str = "core";
pub const OVERLAY: &str = "overlay";
pub const PANEL: &str = "panel";
pub const SETTINGS: &str = "settings";

/// The panel's width, in CSS pixels.
pub const PANEL_WIDTH: f64 = 420.0;
/// The panel's height before it is placed on a display (it starts at most of the display's: geometry.rs).
pub const PANEL_HEIGHT: f64 = 560.0;
/// Settings, CSS pixels (less on a small screen).
const SETTINGS_SIZE: (f64, f64) = (860.0, 700.0);

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
    /// The pointer when the student scrolled over an armed selection: the
    /// scroll goes to the app beneath until the pointer moves from here.
    pub scroll_anchor: Option<(f64, f64)>,
    /// Where the panel was last opened (the setting), which way it grows.
    pub panel_place: Place,
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

/// Only the app's own pages load in its windows (`tauri://localhost`;
/// `http://tauri.localhost` on Windows; the dev server in development), so
/// a link that got into an answer can't take a window to another site.
pub fn own_page(url: &tauri::Url) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost")) => true,
        ("http", Some("localhost")) => tauri::is_dev(),
        _ => url.as_str() == "about:blank",
    }
}

pub fn make_core(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, CORE, WebviewUrl::App("web/core.html".into()))
        .on_navigation(own_page)
        .title("Juno (core)")
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
        .on_navigation(own_page)
        .title("Juno")
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
        .build()?;
    #[cfg(target_os = "macos")]
    mac::float_above_everything(&window, true);
    Ok(window)
}

/// Puts the overlay on the display under the pointer and shows it; `focus`
/// also gives it the keyboard (Escape and Enter while selecting).
pub fn show_overlay(app: &AppHandle, state: &SharedOverlay, focus: bool) -> tauri::Result<()> {
    let Some((display, scale)) = display_under_pointer(app) else {
        crate::diag::note("overlay: no display to show on");
        return Ok(());
    };
    unhide(app);
    hide_settings(app);
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
    // Where the menu bar, Dock or taskbar are, so the bar stays inside them.
    let _ = app.emit_to(OVERLAY, "overlay:insets", display.insets(Space::native()));
    window.show()?;
    if focus {
        window.set_focus()?;
    }
    Ok(())
}

pub fn hide_overlay(app: &AppHandle, state: &SharedOverlay) -> tauri::Result<()> {
    {
        let mut s = state.lock().unwrap();
        s.visible = false;
        s.interactive = false;
        s.regions.clear();
        s.scroll_anchor = None;
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

/// A card window (see the top of this file), made hidden.
fn card<'a>(app: &'a AppHandle, label: &'a str, url: &str, title: &str) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .on_navigation(own_page)
        .title(title)
        .resizable(true)
        .visible(false)
        .focused(false);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false).shadow(true);
    builder
}

/// A card just made: on macOS its title bar's buttons go too (the page has its own ✕).
fn finish_card(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    mac::hide_window_buttons(window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// Settings' page has drawn, and they were asked for before it had.
static SETTINGS_PAGE: Mutex<(bool, bool)> = Mutex::new((false, false));

/// Settings' page has drawn (`window_show`): they show if they were asked for meanwhile.
pub fn settings_drawn(window: &WebviewWindow) -> tauri::Result<()> {
    let wanted = {
        let mut page = SETTINGS_PAGE.lock().unwrap();
        page.0 = true;
        std::mem::take(&mut page.1)
    };
    if wanted {
        show_window(window)?;
    }
    Ok(())
}

/// Asked for before their page had drawn: they show once it has, or after a moment whatever happens.
fn show_settings_soon(window: &WebviewWindow) -> tauri::Result<()> {
    {
        let mut page = SETTINGS_PAGE.lock().unwrap();
        if !page.0 {
            page.1 = true;
            let w = window.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(1500));
                if std::mem::take(&mut SETTINGS_PAGE.lock().unwrap().1) {
                    let _ = show_window(&w);
                }
            });
            return Ok(());
        }
    }
    show_window(window)
}

/// A card's page has drawn: its window shows, with the keyboard. Settings
/// on screen take the bar (and the dim) away, and only once they are on
/// screen: with nothing of ours showing, macOS would hide the whole app
/// (yield_focus), settings included.
pub fn show_window(window: &WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle();
    unhide(app);
    window.show()?;
    window.set_focus()?;
    if window.label() == SETTINGS {
        let _ = app.emit_to(CORE, "app:settings", ());
    }
    Ok(())
}

/// The panel, made hidden at start and kept (see the top of this file).
pub fn make_panel(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(PANEL) {
        return Ok(w);
    }
    let window = card(app, PANEL, "web/panel.html", "Juno")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .min_inner_size(320.0, 320.0)
        .always_on_top(true)
        // Hidden most of the time, yet it must be ready the moment it shows.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .build()?;
    finish_card(&window);
    #[cfg(target_os = "macos")]
    mac::float_above_everything(&window, false);
    Ok(window)
}

/// Shows the panel, or brings it forward. Coming back from hidden, it goes
/// to `at` (the setting) on the display the selection is on (the overlay's,
/// or the pointer's): `size` if the student gave it one, else most of that
/// display tall. `focus` gives it the keyboard, so the student can type a
/// question straight away.
pub fn open_panel(app: &AppHandle, state: &SharedOverlay, focus: bool, at: Place, size: Option<(f64, f64)>) -> tauri::Result<()> {
    let display = {
        let mut s = state.lock().unwrap();
        s.panel_place = at;
        s.display.clone()
    }
    .or_else(|| display_under_pointer(app).map(|(d, _)| d));
    unhide(app);
    let window = make_panel(app)?;
    if !window.is_visible().unwrap_or(false) {
        if let Some(d) = &display {
            let (w, h) = size.unwrap_or((PANEL_WIDTH, d.panel_height()));
            place(&window, d.panel_placement(Space::native(), w, h, at))?;
        }
    }
    window.show()?;
    if focus {
        window.set_focus()?;
    }
    Ok(())
}

/// Bumped by every panel resize, so an animation a newer one replaced stops.
static PANEL_TURN: AtomicU64 = AtomicU64::new(0);
/// How long the panel takes to grow or shrink to a new height.
const PANEL_ANIMATION: Duration = Duration::from_millis(180);
const PANEL_STEPS: u32 = 12;

/// The panel's page asks for the height its chat needs (CSS pixels): it
/// grows, or shrinks, away from the edge it was placed at (down from the
/// top, up from the bottom, both ways from the middle), never past the
/// usable area of its display less the margin, nor below its starting
/// height. Smoothly unless `animate` is off (reduced motion). Says the
/// height it will have.
pub fn fit_panel(app: &AppHandle, state: &SharedOverlay, height: f64, animate: bool) -> tauri::Result<f64> {
    let Some(window) = app.get_webview_window(PANEL) else { return Ok(height) };
    let Some(monitor) = window.current_monitor()? else { return Ok(height) };
    let scale = window.scale_factor()?;
    let size = window.inner_size()?.to_logical::<f64>(scale);
    let pos = window.outer_position()?.to_logical::<f64>(scale);
    let (k, area) = (monitor.scale_factor(), monitor.work_area());
    let work = Rect::new(area.position.x as f64 / k, area.position.y as f64 / k, area.size.width as f64 / k, area.size.height as f64 / k);
    let m = geometry::CARD_MARGIN;
    let (lo, hi) = (work.y + m, work.y + work.height - m);
    let row = state.lock().unwrap().panel_place.row;
    // How far it may reach, keeping the edge it hangs from where it is.
    let limit = match row {
        Row::Top => hi - pos.y,
        Row::Bottom => pos.y + size.height - lo,
        Row::Middle => hi - lo,
    };
    let h = height.max(work.height * geometry::PANEL_SHARE).min(limit).max(1.0).round();
    if (h - size.height).abs() < 1.0 {
        return Ok(h);
    }
    let y = match row {
        Row::Top => pos.y,
        Row::Bottom => pos.y + size.height - h,
        Row::Middle => (pos.y + size.height / 2.0 - h / 2.0).clamp(lo, (hi - h).max(lo)),
    };
    let turn = PANEL_TURN.fetch_add(1, Ordering::SeqCst) + 1;
    let (x, width, from) = (pos.x, size.width, (pos.y, size.height));
    let step = move |t: f64| {
        // Ease out: quick to start, settling gently.
        let e = 1.0 - (1.0 - t).powi(3);
        let (sy, sh) = (from.0 + (y - from.0) * e, from.1 + (h - from.1) * e);
        if (y - from.0).abs() >= 1.0 {
            let _ = window.set_position(LogicalPosition::new(x, sy));
        }
        let _ = window.set_size(LogicalSize::new(width, sh));
    };
    if !animate {
        step(1.0);
        return Ok(h);
    }
    thread::spawn(move || {
        for i in 1..=PANEL_STEPS {
            if PANEL_TURN.load(Ordering::SeqCst) != turn {
                return;
            }
            step(f64::from(i) / f64::from(PANEL_STEPS));
            thread::sleep(PANEL_ANIMATION / PANEL_STEPS);
        }
    });
    Ok(h)
}

/// Hides the panel; it is kept for the next selection.
pub fn close_panel(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(PANEL) {
        w.hide()?;
    }
    yield_focus(app);
    Ok(())
}

/// Settings, made hidden at start and kept (see the top of this file).
pub fn make_settings(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(SETTINGS) {
        return Ok(w);
    }
    let window = card(app, SETTINGS, "web/settings.html", "Juno Settings")
        .inner_size(SETTINGS_SIZE.0, SETTINGS_SIZE.1)
        .min_inner_size(520.0, 420.0)
        // At the panel's level: opened after it, so above it.
        .always_on_top(true)
        .build()?;
    finish_card(&window);
    #[cfg(target_os = "macos")]
    mac::float_above_everything(&window, false);
    Ok(window)
}

/// Opens settings (at `#section` if given), or brings them forward.
pub fn open_settings(app: &AppHandle, hash: Option<&str>) -> tauri::Result<()> {
    let hash = hash.map(|h| h.trim_start_matches('#')).filter(|h| h.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    unhide(app);
    let window = make_settings(app)?;
    if !window.is_visible().unwrap_or(false) {
        if let Some((d, _)) = display_under_pointer(app) {
            place(&window, d.centred_placement(Space::native(), SETTINGS_SIZE.0, SETTINGS_SIZE.1))?;
        }
    }
    // The page goes to that section (or the top).
    let _ = app.emit_to(SETTINGS, "settings:open", hash.unwrap_or(""));
    window.unminimize()?;
    show_settings_soon(&window)
}

/// Hides settings if they are open; they are kept, and their page starts afresh for next time.
fn hide_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(SETTINGS).filter(|w| w.is_visible().unwrap_or(false)) {
        let _ = w.hide();
        let _ = app.emit_to(SETTINGS, "settings:closed", ());
    }
}

/// Settings' ✕ (or the system's close).
pub fn close_settings(app: &AppHandle) -> tauri::Result<()> {
    hide_settings(app);
    yield_focus(app);
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
                // Scrolling over an armed selection goes to the app beneath
                // (overlay_scroll_through), until the pointer moves to select.
                match (snapshot.scroll_anchor, app.cursor_position()) {
                    (Some(a), Ok(p)) if (p.x - a.0).hypot(p.y - a.1) <= 4.0 => true,
                    (Some(_), _) => {
                        state.lock().unwrap().scroll_anchor = None;
                        false
                    }
                    _ => false,
                }
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
    use objc2_app_kit::{NSFloatingWindowLevel, NSPopUpMenuWindowLevel, NSWindow, NSWindowButton, NSWindowCollectionBehavior};
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

    /// A card's title bar is hidden, its traffic lights too: the page has its own ✕.
    pub fn hide_window_buttons(window: &WebviewWindow) {
        let Ok(ptr) = window.ns_window() else { return };
        let ptr = ptr as usize;
        let _ = window.run_on_main_thread(move || {
            // SAFETY: a live NSWindow owned by this window, used on the main thread.
            let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
            for b in [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton] {
                if let Some(button) = ns_window.standardWindowButton(b) {
                    button.setHidden(true);
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::own_page;

    #[test]
    fn only_the_apps_own_pages_load_in_its_windows() {
        let ok = |u: &str| own_page(&tauri::Url::parse(u).unwrap());
        assert!(ok("tauri://localhost/web/panel.html"));
        assert!(ok("http://tauri.localhost/web/panel.html"));
        assert!(ok("https://tauri.localhost/web/settings.html#answers"));
        assert!(!ok("https://evil.example/"));
        assert!(!ok("https://tauri.localhost.evil.example/"));
        assert!(!ok("http://127.0.0.1:8080/"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("data:text/html,hi"));
        assert!(!ok("javascript:alert(1)"));
        // The dev server, in development builds only.
        assert_eq!(ok("http://localhost:5180/web/panel.html"), tauri::is_dev());
    }
}
