//! Selection AI for the desktop: the native core.
//!
//! It does only what the system has to: the global shortcut, the menu bar (or
//! tray) icon, the windows, screen capture, and keeping chats, screenshots and
//! keys on disk and in the keychain. Everything else — the bar, the panel,
//! chats, answers, accounts — is the extension's own web code, running in the
//! app's windows (desktop/src). The `core` window plays the extension's
//! background; the others reach it through events (desktop/src/platform).

mod capture;
mod crop;
mod geometry;
mod store;
#[cfg(feature = "test-hook")]
mod testhook;
mod wm;

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

use capture::{Access, CaptureError, Source};
use crop::CropRequest;
use geometry::{Rect, Space};
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
    /// As the browser extension reports it: "Alt+Shift+S" ("⌥⇧S" on a Mac).
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

/// Every window hears about every change, as `storage.onChanged` does.
fn announce(app: &AppHandle, area: &str, changes: Changes) -> Res<()> {
    if changes.is_empty() {
        return Ok(());
    }
    #[derive(Serialize, Clone)]
    struct Changed<'a> {
        area: &'a str,
        changes: Changes,
    }
    app.emit("storage:changed", Changed { area, changes }).map_err(err)
}

// ── Storage (browser.storage) and screenshots (lib/images.ts) ────────────

#[tauri::command(async)]
fn storage_get(state: State<Shared>, area: String, keys: Option<Vec<String>>) -> Res<Map<String, Value>> {
    state.store.get(self::area(&area)?, keys.as_deref()).map_err(err)
}

#[tauri::command(async)]
fn storage_set(app: AppHandle, state: State<Shared>, area: String, items: Map<String, Value>) -> Res<()> {
    let changes = state.store.set(self::area(&area)?, items).map_err(err)?;
    announce(&app, &area, changes)
}

#[tauri::command(async)]
fn storage_remove(app: AppHandle, state: State<Shared>, area: String, keys: Vec<String>) -> Res<()> {
    let changes = state.store.remove(self::area(&area)?, &keys).map_err(err)?;
    announce(&app, &area, changes)
}

#[tauri::command(async)]
fn storage_clear(app: AppHandle, state: State<Shared>, area: String) -> Res<()> {
    let changes = state.store.clear(self::area(&area)?).map_err(err)?;
    announce(&app, &area, changes)
}

#[tauri::command(async)]
fn image_put(state: State<Shared>, id: String, chat_id: String, data_url: String) -> Res<()> {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayPlace {
    display: String,
    scale: f64,
}

#[tauri::command(async)]
fn overlay_show(app: AppHandle, state: State<Shared>, focus: bool) -> Res<Option<OverlayPlace>> {
    let shown = wm::show_overlay(&app, &state.overlay, focus).map_err(err)?;
    Ok(shown.map(|d| OverlayPlace { display: d.name, scale: d.scale }))
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
fn overlay_pointer(state: State<Shared>, interactive: bool, regions: Vec<Rect>) {
    let mut s = state.overlay.lock().unwrap();
    s.interactive = interactive;
    s.regions = regions;
}

#[tauri::command(async)]
fn panel_open(app: AppHandle, state: State<Shared>, focus: bool) -> Res<()> {
    wm::open_panel(&app, &state.overlay, focus).map_err(err)
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
fn window_close(window: WebviewWindow) -> Res<()> {
    match window.label() {
        wm::CORE => Ok(()),
        wm::OVERLAY => window.hide().map_err(err),
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

/// Captures the overlay's display and crops it to the selection (CSS pixels
/// in the overlay). Also says which window it was made over.
#[tauri::command]
async fn capture_selection(app: AppHandle, state: State<'_, Shared>, request: CropRequest) -> Result<Captured, CaptureFailure> {
    let display = state.overlay.lock().unwrap().display.clone().ok_or_else(|| CaptureFailure { code: "failed", message: "The bar is not on a display".into() })?;
    let hide = !capture::EXCLUDES_OWN_WINDOWS;
    tauri::async_runtime::spawn_blocking(move || {
        let space = Space::native();
        let frame = display.global_frame(space);
        let overlay = app.get_webview_window(wm::OVERLAY);
        if hide {
            // X11 cannot leave a window out of a capture: step aside for it.
            if let Some(w) = &overlay {
                let _ = w.hide();
            }
            thread::sleep(Duration::from_millis(180));
        }
        let shot = capture::capture_display(frame, display.scale);
        if hide {
            if let Some(w) = &overlay {
                let _ = w.show();
            }
        }
        let shot = shot?;
        let cropped = crop::crop(&shot, &request).map_err(|e| CaptureError::Failed(e.to_string()))?;
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
    .map_err(CaptureFailure::from)
}

#[tauri::command(async)]
fn screen_access() -> Access {
    capture::screen_access()
}

#[tauri::command(async)]
fn screen_access_request() -> Access {
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
    os: &'static str,
    version: String,
    shortcut: ShortcutStatus,
}

#[tauri::command(async)]
fn app_info(app: AppHandle, state: State<Shared>) -> AppInfo {
    AppInfo { os: std::env::consts::OS, version: app.package_info().version.to_string(), shortcut: state.shortcut.lock().unwrap().clone() }
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

// ── The shortcut and the menu bar icon ───────────────────────────────────

/// The shortcut (or the menu): the core decides what comes up, as the
/// extension's background does on a toolbar click.
pub(crate) fn summon(app: &AppHandle) {
    let _ = app.emit_to(wm::CORE, "app:summon", ());
}

fn shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyS)
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let label = if cfg!(target_os = "macos") { "Select (⌥⇧S)" } else { "Select (Alt+Shift+S)" };
    let select = MenuItem::with_id(app, "select", label, true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Selection AI", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&select, &settings, &PredefinedMenuItem::separator(app)?, &quit])?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Selection AI")
        .menu(&menu)
        .show_menu_on_left_click(true)
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second copy was started: this one stays, and shows its settings.
            let _ = wm::open_settings(app, None);
        }))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
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
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let dir = app.path().app_data_dir()?.join("store");
            std::fs::create_dir_all(&dir)?;
            let store = Store::open(&dir, store::system_secrets(&dir))?;
            let images = Images::open(&dir.join("images"))?;
            let overlay: SharedOverlay = Arc::new(Mutex::new(OverlayState { main_scale: 1.0, ..Default::default() }));
            let label = if cfg!(target_os = "macos") { "⌥⇧S" } else { "Alt+Shift+S" };
            let error = app.global_shortcut().register(shortcut()).err().map(|e| e.to_string());
            app.manage(Shared { store, images, overlay: overlay.clone(), shortcut: Mutex::new(ShortcutStatus { shortcut: label.into(), error }) });

            let handle = app.handle().clone();
            wm::make_core(&handle)?;
            // Loaded and listening before the shortcut is first pressed.
            wm::overlay(&handle)?;
            tray(&handle)?;
            wm::start_passthrough(handle.clone(), overlay);
            #[cfg(feature = "test-hook")]
            testhook::start(handle);
            Ok(())
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
            panel_open,
            panel_close,
            settings_open,
            window_close,
            capture_selection,
            screen_access,
            screen_access_request,
            open_privacy_settings,
            relaunch,
            app_info,
            quit,
        ])
        .build(tauri::generate_context!())
        .expect("building the app");

    app.run(|_app, event| {
        // Closing the last visible window is not quitting: the app lives in
        // the menu bar. Only Quit (an explicit exit code) ends it.
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}
