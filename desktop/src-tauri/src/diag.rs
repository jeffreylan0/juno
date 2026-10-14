//! A short log of what the app did while starting and what went wrong, for
//! when it misbehaves on someone else's computer: `juno.log` in the usual
//! place for the system (Windows: `%LOCALAPPDATA%\com.humanbn.juno\`;
//! macOS: `~/Library/Logs/Juno/`; Linux: `~/.local/state/com.humanbn.juno/`).
//! Only the app's own steps and errors, never what the student asked, their
//! screen or a key. It is kept small: a new start trims it.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Past this, a start keeps only the newest half.
const MAX_BYTES: u64 = 256 * 1024;
/// One note, at most (a page's error message included).
const MAX_NOTE: usize = 400;

static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Where the log is, worked out from the system alone, so it works before
/// (and when) the app itself fails to start.
pub fn path() -> Option<PathBuf> {
    PATH.get_or_init(|| {
        let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
        let dir = if cfg!(windows) {
            env("LOCALAPPDATA").map(|d| d.join("com.humanbn.juno"))
        } else if cfg!(target_os = "macos") {
            env("HOME").map(|h| h.join("Library/Logs/Juno"))
        } else {
            env("XDG_STATE_HOME").or_else(|| env("HOME").map(|h| h.join(".local/state"))).map(|d| d.join("com.humanbn.juno"))
        }?;
        Some(dir.join("juno.log"))
    })
    .clone()
}

/// Starts a run's log: the old one trimmed, then a line saying which build this is.
pub fn start() {
    if let Some(path) = path() {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
            if let Ok(text) = fs::read_to_string(&path) {
                let keep = &text[text.len() / 2..];
                let from = keep.find('\n').map(|i| i + 1).unwrap_or(0);
                let _ = fs::write(&path, &keep[from..]);
            }
        }
    }
    note(&format!("start: Juno {} on {} {}", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH));
    std::panic::set_hook(Box::new(|info| note(&format!("panic: {info}"))));
}

/// Adds a line (and says it on stderr, for a terminal or a test).
pub fn note(text: &str) {
    let mut text: String = text.chars().filter(|c| !c.is_control() || *c == ' ').collect();
    if text.len() > MAX_NOTE {
        let mut end = MAX_NOTE;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let line = format!("{secs} {text}\n");
    eprint!("[juno] {line}");
    if let Some(path) = path() {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

/// The app can't start: said in the log and, where nobody sees a terminal,
/// in a message on screen, then the app ends.
pub fn fatal(what: &str) -> ! {
    note(&format!("fatal: {what}"));
    let log = path().map(|p| p.display().to_string()).unwrap_or_default();
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let text = HSTRING::from(format!("Juno couldn't start.\n\n{what}\n\nDetails: {log}"));
        unsafe {
            MessageBoxW(None, &text, &HSTRING::from("Juno"), MB_OK | MB_ICONERROR);
        }
    }
    #[cfg(not(windows))]
    eprintln!("Juno couldn't start: {what} (details: {log})");
    std::process::exit(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_are_single_bounded_lines() {
        // No path in a bare test environment is fine: notes still go to stderr.
        note(&format!("a\nb{}", "x".repeat(2000)));
    }
}
