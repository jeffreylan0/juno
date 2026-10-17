//! Juno for the desktop: the native core.
//!
//! It does only what the system has to: the global shortcut, the menu bar (or
//! tray) icon, the windows, screen capture, and keeping chats, screenshots and
//! keys on disk. Everything else (the bar, the panel, chats, answers,
//! accounts) is web code running in the app's windows (desktop/src). The
//! `core` window owns the chats; the others reach it through events
//! (desktop/src/platform).

mod capture;
mod crop;
mod diag;
mod geometry;
mod store;
#[cfg(feature = "test-hook")]
mod testhook;
mod wm;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

use capture::{Access, CaptureError, Source};
use crop::CropRequest;
use geometry::{Display, Rect, Space};
use store::{Area, Changes, Images, StoredImage, Store};
use wm::{OverlayState, SharedOverlay};

/// What every command can reach.
pub struct Shared {
    store: Store,
    images: Images,
    overlay: SharedOverlay,
    shortcut: Mutex<ShortcutStatus>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutStatus {
    /// As the settings show it: "Alt+Shift+S" ("⌥⇧S" on a Mac).
    shortcut: String,
    /// Why the system refused it (another app holds it), if it did.
    error: Option<String>,
}

type Res<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn area(name: &str) -> Res<Area> {
    Area::parse(name).ok_or_else(|| format!("no storage area {name:?}"))
}

/// Refuses a command from any window but these. Every page can invoke every
/// command, so the ones that matter check who is asking: the overlay, drawn
/// over whatever is on screen, never needs the keys, the capture or the
/// login item.
fn only(window: &WebviewWindow, allowed: &[&str]) -> Res<()> {
    if allowed.contains(&window.label()) {
        Ok(())
    } else {
        Err(format!("not from the {} window", window.label()))
    }
}

/// The API keys and the session: never to or from the overlay.
fn keep_secrets_from(window: &WebviewWindow, keys: impl IntoIterator<Item = impl AsRef<str>>) -> Res<()> {
    if window.label() == wm::OVERLAY && keys.into_iter().any(|k| store::is_secret(k.as_ref())) {
        return Err("the overlay has no access to keys".into());
    }
    Ok(())
}

/// One storage write, at most: a long chat is a few MB.
const MAX_WRITE_BYTES: usize = 32 * 1024 * 1024;
/// One screenshot, as a data URL: crops are at most 1568 px a side.
const MAX_IMAGE_URL_BYTES: usize = 32 * 1024 * 1024;
/// Regions of the overlay that take clicks (the bar, a few tooltips).
const MAX_REGIONS: usize = 64;

/// Every window hears about every change, as `storage.onChanged` does; the
/// overlay without the secrets' values.
fn announce(app: &AppHandle, area: &str, changes: Changes) -> Res<()> {
    if changes.is_empty() {
        return Ok(());
    }
    #[derive(Serialize, Clone)]
    struct Changed<'a> {
        area: &'a str,
        changes: Changes,
    }
    if !changes.keys().any(|k| store::is_secret(k)) {
        return app.emit("storage:changed", Changed { area, changes }).map_err(err);
    }
    let public: Changes = changes.iter().filter(|(k, _)| !store::is_secret(k)).map(|(k, v)| (k.clone(), v.clone())).collect();
    for window in app.webview_windows().into_values() {
        let to = if window.label() == wm::OVERLAY { &public } else { &changes };
        if !to.is_empty() {
            app.emit_to(window.label(), "storage:changed", Changed { area, changes: to.clone() }).map_err(err)?;
        }
    }
    Ok(())
}

// ── Storage (browser.storage) and screenshots (lib/images.ts) ────────────

#[tauri::command(async)]
fn storage_get(window: WebviewWindow, state: State<Shared>, area: String, keys: Option<Vec<String>>) -> Res<Map<String, Value>> {
    let mut found = state.store.get(self::area(&area)?, keys.as_deref()).map_err(err)?;
    if window.label() == wm::OVERLAY {
        found.retain(|k, _| !store::is_secret(k));
    }
    Ok(found)
}

#[tauri::command(async)]
fn storage_set(app: AppHandle, window: WebviewWindow, state: State<Shared>, area: String, items: Map<String, Value>) -> Res<()> {
    keep_secrets_from(&window, items.keys())?;
    if serde_json::to_vec(&items).map_err(err)?.len() > MAX_WRITE_BYTES {
        return Err("too much to store at once".into());
    }
    let changes = state.store.set(self::area(&area)?, items).map_err(err)?;
    announce(&app, &area, changes)
}

#[tauri::command(async)]
fn storage_remove(app: AppHandle, window: WebviewWindow, state: State<Shared>, area: String, keys: Vec<String>) -> Res<()> {
    keep_secrets_from(&window, &keys)?;
    let changes = state.store.remove(self::area(&area)?, &keys).map_err(err)?;
    announce(&app, &area, changes)
}

#[tauri::command(async)]
fn storage_clear(app: AppHandle, window: WebviewWindow, state: State<Shared>, area: String) -> Res<()> {
    only(&window, &[wm::CORE, wm::PANEL, wm::SETTINGS])?;
    let changes = state.store.clear(self::area(&area)?).map_err(err)?;
    announce(&app, &area, changes)
}

#[tauri::command(async)]
fn image_put(state: State<Shared>, id: String, chat_id: String, data_url: String) -> Res<()> {
    if data_url.len() > MAX_IMAGE_URL_BYTES {
        return Err("that screenshot is too large".into());
    }
    state.images.put(&id, &chat_id, &data_url).map_err(err)
}

#[tauri::command(async)]
fn image_get(state: State<Shared>, id: String) -> Res<Option<StoredImage>> {
    state.images.get(&id).map_err(err)
}

#[tauri::command(async)]
fn image_delete(state: State<Shared>, ids: Vec<String>) -> Res<()> {
    state.images.delete(&ids).map_err(err)
}

#[tauri::command(async)]
fn image_delete_for_chat(state: State<Shared>, chat_id: String) -> Res<()> {
    state.images.delete_for_chat(&chat_id).map_err(err)
}

#[tauri::command(async)]
fn image_chat_ids(state: State<Shared>) -> Vec<String> {
    state.images.chat_ids()
}

// ── Windows ──────────────────────────────────────────────────────────────

#[tauri::command(async)]
fn overlay_show(app: AppHandle, state: State<Shared>, focus: bool) -> Res<()> {
    static FIRST: std::sync::Once = std::sync::Once::new();
    FIRST.call_once(|| diag::note("overlay_show: first"));
    wm::show_overlay(&app, &state.overlay, focus).map_err(|e| {
        diag::note(&format!("overlay_show failed: {e}"));
        err(e)
    })
}

#[tauri::command(async)]
fn overlay_hide(app: AppHandle, state: State<Shared>) -> Res<()> {
    wm::hide_overlay(&app, &state.overlay).map_err(err)
}

#[tauri::command(async)]
fn overlay_focus(app: AppHandle) -> Res<()> {
    wm::focus_overlay(&app).map_err(err)
}

/// From the overlay page: whether a selection is armed (it takes every
/// click), and otherwise which parts of it take clicks (the bar, tooltips).
#[tauri::command(async)]
fn overlay_pointer(state: State<Shared>, interactive: bool, mut regions: Vec<Rect>) {
    regions.truncate(MAX_REGIONS);
    let mut s = state.overlay.lock().unwrap();
    s.interactive = interactive;
    s.regions = regions;
    if !interactive {
        s.scroll_anchor = None;
    }
}

/// The student scrolled over an armed selection: the scroll goes to the app
/// beneath (the overlay lets the pointer through) until the pointer moves,
/// when the overlay takes it back to select (wm::start_passthrough).
#[tauri::command(async)]
fn overlay_scroll_through(app: AppHandle, state: State<Shared>) {
    let mut s = state.overlay.lock().unwrap();
    if s.interactive && s.scroll_anchor.is_none() {
        s.scroll_anchor = app.cursor_position().ok().map(|p| (p.x, p.y));
    }
}

#[tauri::command(async)]
fn panel_open(app: AppHandle, state: State<Shared>, focus: bool, place: Option<String>, size: Option<PanelSize>) -> Res<()> {
    let at = place.as_deref().and_then(geometry::Place::parse).unwrap_or_default();
    // A size the student gave it, within reason (wm.rs keeps it on screen).
    let size = size.filter(|s| s.width.is_finite() && s.height.is_finite()).map(|s| (s.width.clamp(320.0, 1600.0), s.height.clamp(320.0, 2400.0)));
    wm::open_panel(&app, &state.overlay, focus, at, size).map_err(err)
}

#[derive(serde::Deserialize)]
struct PanelSize {
    width: f64,
    height: f64,
}

/// The panel's page asks for the height its chat needs (CSS pixels).
#[tauri::command(async)]
fn panel_fit(app: AppHandle, state: State<Shared>, height: f64, animate: Option<bool>) -> Res<f64> {
    wm::fit_panel(&app, &state.overlay, height, animate.unwrap_or(true)).map_err(err)
}

/// A card's page (the panel, settings) has drawn: its window shows.
#[tauri::command(async)]
fn window_show(window: WebviewWindow) -> Res<()> {
    wm::show_window(&window).map_err(err)
}

#[tauri::command(async)]
fn panel_close(app: AppHandle) -> Res<()> {
    wm::close_panel(&app).map_err(err)
}

#[tauri::command(async)]
fn settings_open(app: AppHandle, hash: Option<String>) -> Res<()> {
    wm::open_settings(&app, hash.as_deref()).map_err(err)
}

/// `window.close()` from a page: the panel and settings go; the core and the
/// overlay are never closed, only hidden.
#[tauri::command(async)]
fn window_close(app: AppHandle, window: WebviewWindow) -> Res<()> {
    match window.label() {
        wm::CORE => Ok(()),
        wm::OVERLAY => window.hide().map_err(err),
        // Kept for the next selection (wm.rs).
        wm::PANEL => wm::close_panel(&app).map_err(err),
        _ => window.destroy().map_err(err),
    }
}

// ── Capture ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Captured {
    data_url: String,
    width: u32,
    height: u32,
    source: Option<Source>,
}

#[derive(Serialize)]
struct CaptureFailure {
    /// "permission": Screen Recording is off (macOS); "failed": anything else.
    code: &'static str,
    message: String,
}

impl From<CaptureError> for CaptureFailure {
    fn from(e: CaptureError) -> Self {
        let code = if matches!(e, CaptureError::Permission) { "permission" } else { "failed" };
        CaptureFailure { code, message: e.to_string() }
    }
}

/// The display the overlay is on.
fn overlay_display(state: &Shared) -> Result<Display, CaptureFailure> {
    state.overlay.lock().unwrap().display.clone().ok_or_else(|| CaptureFailure { code: "failed", message: "The bar is not on a display".into() })
}

/// A screenshot of `display` without the app's own windows.
fn shoot(app: &AppHandle, display: &Display) -> Result<image::RgbaImage, CaptureError> {
    let frame = display.global_frame(Space::native());
    let take = || capture::capture_display(frame, display.scale);
    // macOS: ScreenCaptureKit leaves the app's windows out by itself.
    #[cfg(target_os = "macos")]
    let shot = {
        let _ = app;
        take()
    };
    // Windows: the app's windows on screen are left out of this one capture
    // only (capture/windows.rs), so recordings and screen sharing still show
    // them. Not the hidden ones (the core): changing a never-shown window's
    // affinity drew it, empty, on screen.
    #[cfg(windows)]
    let shot = {
        let ours: Vec<isize> = app
            .webview_windows()
            .values()
            .filter(|w| w.is_visible().unwrap_or(false))
            .filter_map(|w| w.hwnd().ok())
            .map(|h| h.0 as isize)
            .collect();
        capture::without_windows(&ours, take)
    };
    // X11 cannot leave a window out of a capture: the overlay steps aside for it.
    #[cfg(target_os = "linux")]
    let shot = {
        let overlay = app.get_webview_window(wm::OVERLAY);
        if let Some(w) = &overlay {
            let _ = w.hide();
        }
        std::thread::sleep(std::time::Duration::from_millis(180));
        let shot = take();
        if let Some(w) = &overlay {
            let _ = w.show();
        }
        shot
    };
    shot
}

/// Captures the overlay's display and crops it to the selection (CSS pixels
/// in the overlay). Also says which window it was made over. Only for the
/// core, and only while the bar is up: a selection the student is making,
/// never a screenshot taken at some other moment.
#[tauri::command]
async fn capture_selection(app: AppHandle, window: WebviewWindow, state: State<'_, Shared>, request: CropRequest) -> Result<Captured, CaptureFailure> {
    let refused = |message: &str| CaptureFailure { code: "failed", message: message.into() };
    if window.label() != wm::CORE {
        return Err(refused("Only the app's core takes screenshots"));
    }
    if !state.overlay.lock().unwrap().visible {
        return Err(refused("The bar is not up"));
    }
    let display = overlay_display(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let space = Space::native();
        let frame = display.global_frame(space);
        let shot = shoot(&app, &display)?;
        let cropped = crop::crop(&shot, &request).map_err(|e| CaptureError::Failed(e.to_string()))?;
        static FIRST: std::sync::Once = std::sync::Once::new();
        FIRST.call_once(|| diag::note(&format!("capture: first, {}x{} of a {}x{} display", cropped.width(), cropped.height(), shot.width(), shot.height())));
        let r = request.rect;
        let (cx, cy) = (r.x + r.width / 2.0, r.y + r.height / 2.0);
        let at = match space {
            Space::Points => (frame.x + cx, frame.y + cy),
            Space::Physical => (frame.x + cx * display.scale, frame.y + cy * display.scale),
        };
        Ok::<_, CaptureError>(Captured { data_url: crop::png_data_url(&cropped), width: cropped.width(), height: cropped.height(), source: capture::window_at(at) })
    })
    .await
    .map_err(|e| CaptureFailure { code: "failed", message: e.to_string() })?
    .map_err(|e| {
        diag::note(&format!("capture failed: {e}"));
        CaptureFailure::from(e)
    })
}

#[tauri::command(async)]
fn screen_access() -> Access {
    #[cfg(feature = "test-hook")]
    if let Some(access) = testhook::screen_access() {
        return access;
    }
    capture::screen_access()
}

#[tauri::command(async)]
fn screen_access_request() -> Access {
    #[cfg(feature = "test-hook")]
    if let Some(access) = testhook::screen_access() {
        return access;
    }
    capture::request_screen_access()
}

/// System Settings → Privacy & Security → Screen & System Audio Recording.
#[tauri::command(async)]
fn open_privacy_settings(app: AppHandle) -> Res<()> {
    if cfg!(target_os = "macos") {
        app.opener()
            .open_url("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture", None::<&str>)
            .map_err(err)?;
    }
    Ok(())
}

/// macOS applies a new Screen Recording permission only to a fresh process.
#[tauri::command]
fn relaunch(app: AppHandle) {
    app.restart();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    shortcut: ShortcutStatus,
    /// Started with `--hidden` (at login, say): no bar until it is asked for.
    hidden: bool,
}

#[tauri::command(async)]
fn app_info(app: AppHandle, window: WebviewWindow, state: State<Shared>) -> AppInfo {
    diag::note(&format!("{}: app_info", window.label()));
    AppInfo {
        version: app.package_info().version.to_string(),
        shortcut: state.shortcut.lock().unwrap().clone(),
        hidden: std::env::args().any(|a| a == "--hidden"),
    }
}

/// A page's own step or error, for the log (diag.rs): the app's windows say
/// when they are up and what failed, never what the student asked.
#[tauri::command(async)]
fn diag_note(window: WebviewWindow, text: String) {
    diag::note(&format!("{}: {text}", window.label()));
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// Settings → Juno → Open at login: whether the app starts, in the
/// menu bar only (`--hidden`), when the student logs in. Off unless they turn
/// it on. No permission: a launch agent in ~/Library/LaunchAgents on macOS,
/// the user's Run key on Windows, an autostart entry on Linux.
#[tauri::command(async)]
fn login_item(app: AppHandle) -> Res<bool> {
    app.autolaunch().is_enabled().map_err(err)
}

#[tauri::command(async)]
fn login_item_set(app: AppHandle, window: WebviewWindow, on: bool) -> Res<bool> {
    only(&window, &[wm::SETTINGS])?;
    let launcher = app.autolaunch();
    if on { launcher.enable() } else { launcher.disable() }.map_err(err)?;
    #[cfg(windows)]
    if on {
        quote_run_entry(&app)?;
    }
    launcher.is_enabled().map_err(err)
}

/// The plugin writes the Run entry unquoted (`C:\…\Juno\Juno.exe --hidden`):
/// with a space anywhere in the path, Windows would try a shorter program
/// name first (CWE-428). Written again here, quoted, under the same name.
#[cfg(windows)]
fn quote_run_entry(app: &AppHandle) -> Res<()> {
    let exe = std::env::current_exe().map_err(err)?;
    windows_registry::CURRENT_USER
        .create(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run")
        .and_then(|key| key.set_string(&app.package_info().name, format!("\"{}\" --hidden", exe.display())))
        .map_err(err)
}

// ── The shortcut and the menu bar icon ───────────────────────────────────

/// The app's own link, a reverse-DNS scheme (RFC 8252 §7.1): no other app
/// named Juno can claim it by accident.
const LINK_SCHEME: &str = "com.humanbn.juno://";

/// The app's link was opened. Today that is only Google sign-in coming back
/// (`com.humanbn.juno://auth/callback`, platform/browser.ts `identity`): settings,
/// where it started, hear it and come forward.
pub(crate) fn deep_link(app: &AppHandle, url: &str) {
    if !url.starts_with("com.humanbn.juno://auth/") {
        return;
    }
    let _ = app.emit_to(wm::SETTINGS, "app:deep-link", url);
    if let Some(w) = app.get_webview_window(wm::SETTINGS) {
        let _ = wm::show_window(&w);
    }
}

/// The shortcut (or the menu): the core decides what comes up.
pub(crate) fn summon(app: &AppHandle) {
    let _ = app.emit_to(wm::CORE, "app:summon", ());
}

fn shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyS)
}

/// The menu bar (tray) icon. A click starts a selection at once, as the
/// shortcut does (Claude's icon opens its quick entry the same way); a
/// right-click (or Control-click) opens a small menu, where Quit is.
/// (Linux trays only have the menu.)
fn tray(app: &AppHandle) -> tauri::Result<()> {
    let label = if cfg!(target_os = "macos") { "Select (⌥⇧S)" } else { "Select (Alt+Shift+S)" };
    let select = MenuItem::with_id(app, "select", label, true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Juno", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&select, &settings, &PredefinedMenuItem::separator(app)?, &quit])?;
    // macOS tints a black template icon to suit the menu bar; a Windows
    // taskbar is often dark, where black would vanish, so it gets the app's
    // own (blue) icon.
    let icon = if cfg!(target_os = "macos") { &include_bytes!("../icons/tray.png")[..] } else { &include_bytes!("../icons/32x32.png")[..] };
    TrayIconBuilder::with_id("main")
        .icon(tauri::image::Image::from_bytes(icon)?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip(if cfg!(target_os = "macos") { "Juno: click to select (⌥⇧S)" } else { "Juno: click to select (Alt+Shift+S)" })
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                summon(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "select" => summon(app),
            "settings" => {
                let _ = wm::open_settings(app, None);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    diag::start();
    let builder = tauri::Builder::default();
    // A second copy was started: this one stays, and brings the bar up, as
    // opening the app does; or, on Windows and Linux, the app's link was
    // opened (the system starts a copy with it). Not in test builds, where
    // each test runs its own copy side by side.
    #[cfg(not(feature = "test-hook"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        match args.iter().find(|a| a.starts_with(LINK_SCHEME)) {
            Some(url) => deep_link(app, url),
            None => summon(app),
        }
    }));
    let app = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::Builder::new().args(["--hidden"]).build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, pressed, event| {
                    if pressed == &shortcut() && event.state() == ShortcutState::Pressed {
                        summon(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // First, so a test can see the app even if something below hangs.
            #[cfg(feature = "test-hook")]
            testhook::start(app.handle().clone());
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Local, not roaming, app data: on Windows a roaming profile would
            // copy the keys, chats and screenshots to the domain's server.
            // (The same folder as before on macOS and Linux.)
            let dir = app.path().app_local_data_dir()?.join("store");
            store::adopt_earlier_store(&dir, &[app.path().local_data_dir()?, app.path().data_dir()?]);
            std::fs::create_dir_all(&dir)?;
            let store = Store::open(&dir, store::system_secrets(&dir))?;
            let images = Images::open(&dir.join("images"))?;
            diag::note("setup: storage open");
            let overlay: SharedOverlay = Arc::new(Mutex::new(OverlayState { main_scale: 1.0, ..Default::default() }));
            let label = if cfg!(target_os = "macos") { "⌥⇧S" } else { "Alt+Shift+S" };
            let error = app.global_shortcut().register(shortcut()).err().map(|e| e.to_string());
            diag::note(&format!("setup: shortcut {}", error.as_deref().unwrap_or("registered")));
            app.manage(Shared { store, images, overlay: overlay.clone(), shortcut: Mutex::new(ShortcutStatus { shortcut: label.into(), error }) });

            let handle = app.handle().clone();
            wm::make_core(&handle)?;
            // Loaded and listening before the shortcut is first pressed, and
            // the panel before the first selection, so neither is waited for.
            wm::overlay(&handle)?;
            wm::make_panel(&handle)?;
            diag::note("setup: windows made");
            tray(&handle)?;
            diag::note("setup: tray icon made");
            {
                // macOS hands the link to the running app (its Info.plist names
                // the scheme, from tauri.conf.json); Windows and Linux learn it here.
                use tauri_plugin_deep_link::DeepLinkExt;
                let links = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        deep_link(&links, url.as_str());
                    }
                });
                #[cfg(all(any(windows, target_os = "linux"), not(feature = "test-hook")))]
                if let Err(e) = app.deep_link().register_all() {
                    diag::note(&format!("setup: link not registered: {e}"));
                }
            }
            wm::start_passthrough(handle.clone(), overlay);
            diag::note("setup: done");
            Ok(())
        })
        // Whether each window's page loads at all, for juno.log.
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                diag::note(&format!("{}: page loaded", webview.label()));
            }
        })
        .on_window_event(|window, event| match event {
            // The overlay and the core live as long as the app; the system's
            // close (Alt+F4, ⌘W) only hides them.
            WindowEvent::CloseRequested { api, .. } if matches!(window.label(), wm::CORE | wm::OVERLAY) => {
                api.prevent_close();
                let _ = window.hide();
            }
            // A port to it is gone (the panel closing finishes the chat).
            WindowEvent::Destroyed => {
                let app = window.app_handle();
                let _ = app.emit("rt:gone", window.label());
                wm::yield_focus(app);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            storage_get,
            storage_set,
            storage_remove,
            storage_clear,
            image_put,
            image_get,
            image_delete,
            image_delete_for_chat,
            image_chat_ids,
            overlay_show,
            overlay_hide,
            overlay_focus,
            overlay_pointer,
            overlay_scroll_through,
            panel_open,
            panel_close,
            panel_fit,
            window_show,
            settings_open,
            window_close,
            capture_selection,
            screen_access,
            screen_access_request,
            open_privacy_settings,
            relaunch,
            app_info,
            quit,
            login_item,
            login_item_set,
            diag_note,
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| diag::fatal(&e.to_string()));

    app.run(|_app, event| match event {
        // Closing the last visible window is not quitting: the app lives in
        // the menu bar. Only Quit (an explicit exit code) ends it.
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        // macOS: opening the app again (Finder, Spotlight, Launchpad) while it runs.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => summon(_app),
        _ => {}
    });
}
