//! Google sign-in comes back here, to a port on this computer's own address
//! (127.0.0.1, RFC 8252 §7.3), rather than to Supabase's: Google's page then
//! names the app, not a supabase.co address. Settings asks for a listener
//! (`auth_listen`), opens Google's page with it as the place to come back to,
//! and hears what came back (`auth:returned`, with the port, so an older
//! sign-in's listener is told apart): the code, which only the settings
//! page's own PKCE verifier can use (lib/account/session.ts).
//!
//! The listener takes one sign-in, for ten minutes at most, and answers the
//! browser with a fixed page; it is reachable from this computer only.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::wm;

/// How long a sign-in is waited for.
const WAIT: Duration = Duration::from_secs(600);

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>Juno</title>\
<body style=\"font:16px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:grid;place-items:center;height:90vh;margin:0\">\
<p>Signed in. You can close this tab and go back to Juno.</p>";

#[derive(Clone, Serialize)]
struct Returned {
    port: u16,
    query: String,
}

/// Starts a listener; says its port.
pub fn listen(app: AppHandle) -> io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    listener.set_nonblocking(true)?;
    thread::spawn(move || {
        let until = Instant::now() + WAIT;
        while Instant::now() < until {
            match listener.accept() {
                Ok((stream, _)) => {
                    if let Some(query) = answer(stream) {
                        let _ = app.emit_to(wm::SETTINGS, "auth:returned", Returned { port, query });
                        return;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(100)),
                Err(_) => return,
            }
        }
    });
    Ok(port)
}

/// Reads one request: Google's return (`GET /?code=…` or `/?error=…`) gets
/// the page and its query; anything else (a favicon) gets nothing.
fn answer(mut stream: TcpStream) -> Option<String> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut line = String::new();
    BufReader::new((&stream).take(8192)).read_line(&mut line).ok()?;
    let query = returned(&line);
    let reply = match query {
        Some(_) => format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{PAGE}",
            PAGE.len()
        ),
        None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
    };
    let _ = stream.write_all(reply.as_bytes());
    query
}

/// The query of Google's return, from the request's first line.
fn returned(request_line: &str) -> Option<String> {
    let mut parts = request_line.split_whitespace();
    if parts.next() != Some("GET") {
        return None;
    }
    let query = parts.next()?.strip_prefix("/?")?;
    let named = |name: &str| query.split('&').any(|p| p.starts_with(&format!("{name}=")));
    (named("code") || named("error")).then(|| query.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_googles_return_is_taken() {
        assert_eq!(returned("GET /?state=s&code=4%2F0A HTTP/1.1\r\n").as_deref(), Some("state=s&code=4%2F0A"));
        assert_eq!(returned("GET /?error=access_denied&state=s HTTP/1.1").as_deref(), Some("error=access_denied&state=s"));
        assert_eq!(returned("GET /favicon.ico HTTP/1.1"), None);
        assert_eq!(returned("POST /?code=x HTTP/1.1"), None);
        assert_eq!(returned("GET /?nothing=here HTTP/1.1"), None);
        assert_eq!(returned(""), None);
    }

    #[test]
    fn a_return_gets_the_page_and_its_query() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let browser = thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.write_all(b"GET /?code=abc&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
            let mut page = String::new();
            s.read_to_string(&mut page).unwrap();
            page
        });
        let (stream, _) = listener.accept().unwrap();
        assert_eq!(answer(stream).as_deref(), Some("code=abc&state=xyz"));
        let page = browser.join().unwrap();
        assert!(page.starts_with("HTTP/1.1 200 OK"));
        assert!(page.contains("You can close this tab"));
    }
}
