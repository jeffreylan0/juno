//! A local HTTP hook for the end-to-end tests (desktop/tests/e2e). Built only
//! with `--features test-hook`, never into a release.
//!
//! Listens on 127.0.0.1:$SAI_TEST_PORT (47321 by default), one request per
//! connection:
//!
//! - `POST /summon` — the shortcut, as if pressed
//! - `POST /eval/<window>` — runs the body as JavaScript in that window
//! - `GET /storage/<local|session>` — every stored value
//! - `GET /image/<id>` — a stored screenshot
//! - `GET /windows` — which windows exist, where, and whether they show
//! - `GET /overlay` — what of the overlay takes the pointer
//! - `POST /fixture?x=&y=&w=&h=` — a window with known content to select over
//! - `POST /quit`
//!
//! `SAI_TEST_SCREEN_ACCESS=denied` makes the app behave as macOS does before
//! Screen Recording is allowed.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::store::Area;
use crate::Shared;

pub fn start(app: AppHandle) {
    let port: u16 = std::env::var("SAI_TEST_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(47321);
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("binding the test hook");
    eprintln!("[test-hook] listening on 127.0.0.1:{port}");
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            thread::spawn(move || {
                let _ = serve(&app, stream);
            });
        }
    });
}

fn serve(app: &AppHandle, mut stream: TcpStream) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let mut length = 0usize;
    // A browser always says where a request comes from; the tests never do.
    // So a web page open while a test build runs can't drive it (a no-CORS
    // POST would otherwise reach /eval).
    let mut from_a_page = false;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header)?;
        if header.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
            if name.eq_ignore_ascii_case("origin") || name.eq_ignore_ascii_case("sec-fetch-site") {
                from_a_page = true;
            }
        }
    }
    if from_a_page {
        return write!(stream, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
    let mut body = vec![0; length.min(64 * 1024 * 1024)];
    reader.read_exact(&mut body)?;
    let body = String::from_utf8_lossy(&body).to_string();
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));

    let (status, reply) = match handle(app, &method, path, query, &body) {
        Ok(v) => ("200 OK", v),
        Err(e) => ("400 Bad Request", json!({ "error": e })),
    };
    let text = reply.to_string();
    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len())?;
    stream.flush()
}

/// What a test says the system allows, in place of asking it.
pub fn screen_access() -> Option<crate::capture::Access> {
    match std::env::var("SAI_TEST_SCREEN_ACCESS").ok()?.as_str() {
        "denied" => Some(crate::capture::Access::Denied),
        "granted" => Some(crate::capture::Access::Granted),
        _ => None,
    }
}

fn param(query: &str, name: &str) -> Option<f64> {
    query.split('&').find_map(|kv| kv.strip_prefix(name)?.strip_prefix('=')?.parse().ok())
}

fn handle(app: &AppHandle, method: &str, path: &str, query: &str, body: &str) -> Result<Value, String> {
    // Started before the rest of setup: until it is done, only /windows answers.
    let Some(shared) = app.try_state::<Shared>() else {
        return match (method, path) {
            ("GET", "/windows") => Ok(json!([])),
            _ => Err("the app is still starting".into()),
        };
    };
    match (method, path) {
        ("POST", "/summon") => {
            crate::summon(app);
            Ok(json!("ok"))
        }
        ("POST", p) if p.starts_with("/eval/") => {
            let label = &p["/eval/".len()..];
            let window = app.get_webview_window(label).ok_or(format!("no window {label}"))?;
            window.eval(body).map_err(|e| e.to_string())?;
            Ok(json!("ok"))
        }
        ("GET", p) if p.starts_with("/storage/") => {
            let area = Area::parse(&p["/storage/".len()..]).ok_or("no such area")?;
            Ok(Value::Object(shared.store.get(area, None).map_err(|e| e.to_string())?))
        }
        ("GET", p) if p.starts_with("/image/") => Ok(json!(shared.images.get(&p["/image/".len()..]).map_err(|e| e.to_string())?)),
        ("GET", "/windows") => Ok(Value::Array(
            app.webview_windows()
                .values()
                .map(|w| {
                    let pos = w.outer_position().unwrap_or_default();
                    let size = w.outer_size().unwrap_or_default();
                    json!({
                        "label": w.label(),
                        "visible": w.is_visible().unwrap_or(false),
                        "focused": w.is_focused().unwrap_or(false),
                        "x": pos.x, "y": pos.y, "width": size.width, "height": size.height,
                        "scale": w.scale_factor().unwrap_or(1.0),
                    })
                })
                .collect(),
        )),
        ("GET", "/overlay") => {
            let s = shared.overlay.lock().unwrap().clone();
            Ok(json!({ "visible": s.visible, "interactive": s.interactive, "regions": s.regions, "ignoring": s.ignoring, "display": s.display }))
        }
        ("POST", "/fixture") => {
            let (x, y) = (param(query, "x").unwrap_or(0.0), param(query, "y").unwrap_or(0.0));
            let (w, h) = (param(query, "w").unwrap_or(800.0), param(query, "h").unwrap_or(600.0));
            let window = match app.get_webview_window("fixture") {
                Some(w) => w,
                None => WebviewWindowBuilder::new(app, "fixture", WebviewUrl::App("web/fixture.html".into()))
                    .title("Fixture")
                    .decorations(false)
                    .focused(false)
                    .build()
                    .map_err(|e| e.to_string())?,
            };
            window.set_position(PhysicalPosition::new(x as i32, y as i32)).map_err(|e| e.to_string())?;
            window.set_size(PhysicalSize::new(w as u32, h as u32)).map_err(|e| e.to_string())?;
            Ok(json!("ok"))
        }
        ("POST", "/quit") => {
            let app = app.clone();
            thread::spawn(move || {
                thread::sleep(std::time::Duration::from_millis(50));
                app.exit(0);
            });
            Ok(json!("ok"))
        }
        _ => Err(format!("no route {method} {path}")),
    }
}
