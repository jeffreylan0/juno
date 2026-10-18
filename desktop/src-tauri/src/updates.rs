//! Updating itself, the way Discord does: a new version is looked for at
//! start and every few hours, downloaded in the background, and installed
//! when the app isn't in use (no bar, panel or settings on screen). The app
//! then restarts into the menu bar, as it is at login: nothing pops up.
//!
//! Settings → Juno → *Update automatically* (on unless turned off) stops
//! the looking; *Check now* looks at once either way. Updates come from the
//! endpoint in tauri.conf.json (`plugins.updater`, a `latest.json` the
//! release workflow publishes), each checked against the public key there.
//! A build without that key has updates off and says so.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::store::Area;
use crate::{diag, wm, Shared};

/// The first look, once the app has settled.
const FIRST_CHECK: Duration = Duration::from_secs(60);
/// Then this often.
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// How often a downloaded update looks for a moment the app isn't in use.
const IDLE_POLL: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    /// This build has no update key: updates aren't set up.
    Off,
    Idle,
    Checking,
    UpToDate,
    Downloading { version: String },
    /// Installs when the app isn't in use.
    Ready { version: String },
    Failed { message: String },
}

pub struct Updates {
    status: Mutex<Status>,
    busy: AtomicBool,
}

/// Left by an update just before the restart: the new copy starts as it does
/// at login, in the menu bar only.
const MARKER: &str = "started-by-update";
static STARTED_BY_UPDATE: AtomicBool = AtomicBool::new(false);

/// Whether this start is the restart after an update (the marker is used up).
pub fn take_marker(dir: &Path) -> bool {
    let started = std::fs::remove_file(dir.join(MARKER)).is_ok();
    STARTED_BY_UPDATE.store(started, Ordering::Relaxed);
    started
}

pub fn started_by_update() -> bool {
    STARTED_BY_UPDATE.load(Ordering::Relaxed)
}

/// Whether the build carries the key updates are checked against.
fn configured(app: &AppHandle) -> bool {
    let plugins = &app.config().plugins.0;
    plugins.get("updater").and_then(|u| u.get("pubkey")).and_then(Value::as_str).is_some_and(|k| !k.trim().is_empty())
}

/// The student's setting, from the stored settings (on unless turned off).
pub fn auto_update_on(stored: &Map<String, Value>) -> bool {
    stored.get("settings").and_then(|s| s.get("autoUpdate")).and_then(Value::as_bool) != Some(false)
}

/// Nothing of the app's is on screen, so a restart interrupts nobody.
fn idle(app: &AppHandle) -> bool {
    [wm::OVERLAY, wm::PANEL, wm::SETTINGS]
        .iter()
        .all(|label| app.get_webview_window(label).is_none_or(|w| !w.is_visible().unwrap_or(false)))
}

impl Updates {
    pub fn new(app: &AppHandle) -> Self {
        Updates { status: Mutex::new(if configured(app) { Status::Idle } else { Status::Off }), busy: AtomicBool::new(false) }
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    fn set(&self, status: Status) {
        *self.status.lock().unwrap() = status;
    }
}

/// Looks now (Settings → Check now), unless a look is already under way.
pub fn check_now(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || tauri::async_runtime::block_on(run_once(&app, true)));
}

/// The background looking, for the app's life, on a thread of its own (it
/// sleeps between looks). Release builds only: a development build is never
/// replaced.
pub fn start(app: AppHandle) {
    if cfg!(debug_assertions) || !configured(&app) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK);
        loop {
            tauri::async_runtime::block_on(run_once(&app, false));
            std::thread::sleep(EVERY);
        }
    });
}

fn setting_on(app: &AppHandle) -> bool {
    let state = app.state::<Shared>();
    state.store.get(Area::Local, Some(&["settings".to_string()])).map(|s| auto_update_on(&s)).unwrap_or(true)
}

/// One look: download what is new, then install it once the app isn't in use.
async fn run_once(app: &AppHandle, asked: bool) {
    let updates = app.state::<Updates>();
    if !configured(app) || (!asked && !setting_on(app)) || updates.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let result = look(app, &updates, asked).await;
    if let Err(message) = result {
        diag::note(&format!("update: {message}"));
        updates.set(Status::Failed { message });
    }
    updates.busy.store(false, Ordering::SeqCst);
}

async fn look(app: &AppHandle, updates: &Updates, asked: bool) -> Result<(), String> {
    updates.set(Status::Checking);
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        updates.set(Status::UpToDate);
        return Ok(());
    };
    let version = update.version.clone();
    diag::note(&format!("update: {version} found"));
    updates.set(Status::Downloading { version: version.clone() });
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    updates.set(Status::Ready { version: version.clone() });
    // Waits for a quiet moment; turning updates off meanwhile keeps it waiting.
    // (This runs on a thread of its own, so it may sleep.)
    while !(idle(app) && (asked || setting_on(app))) {
        std::thread::sleep(IDLE_POLL);
    }
    diag::note(&format!("update: installing {version}"));
    let dir = marker_dir(app)?;
    std::fs::write(dir.join(MARKER), version.as_bytes()).map_err(|e| e.to_string())?;
    // Windows: the installer closes this copy and starts the new one (with
    // the marker); macOS: the new app is in place, and restarts.
    if let Err(e) = update.install(&bytes) {
        let _ = std::fs::remove_file(dir.join(MARKER));
        return Err(e.to_string());
    }
    app.request_restart();
    Ok(())
}

fn marker_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stored(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn updates_are_on_unless_the_student_turned_them_off() {
        assert!(auto_update_on(&stored(json!({}))));
        assert!(auto_update_on(&stored(json!({ "settings": { "theme": "rose" } }))));
        assert!(auto_update_on(&stored(json!({ "settings": { "autoUpdate": true } }))));
        assert!(!auto_update_on(&stored(json!({ "settings": { "autoUpdate": false } }))));
    }

    #[test]
    fn the_restart_after_an_update_starts_hidden_once() {
        let dir = std::env::temp_dir().join(format!("juno-update-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!take_marker(&dir));
        std::fs::write(dir.join(MARKER), "0.2.0").unwrap();
        assert!(take_marker(&dir));
        assert!(started_by_update());
        assert!(!take_marker(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
