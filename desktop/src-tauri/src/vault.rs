//! The API keys a student gives the app (Settings → Answers), kept where no
//! page of the app can read them, and sent only to the company each is for.
//!
//! - A key goes in once, from settings (`key_set`), into the private secrets
//!   file (store.rs) under `keys`, which the storage commands never read,
//!   write or announce to any page (lib.rs). Whose key it is comes from the
//!   key itself (each company writes its keys its own way), never from the
//!   page, so it can only ever be kept for, and sent to, that company. Pages
//!   learn only whether there is one, and its last four characters
//!   (`key_status`).
//! - Asking uses it here, not in a page: the core hands over a request
//!   (`vendor_fetch`), and this adds the key and sends it, but only to one of
//!   four endpoints — asking and listing models, at Anthropic and at OpenAI —
//!   over HTTPS, never following a redirect. The answer streams back to the
//!   page; the key never does.
//!
//! So whatever a page might be made to do (a crafted answer, a bad package),
//! the most it can do with a key is ask that company a question.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::async_runtime::JoinHandle;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri_plugin_http::reqwest::{self, header, redirect, Method, Url};

use crate::store::{Area, Store};

/// Where the keys are kept among the local values (in the secrets file).
pub const STORAGE_KEY: &str = "keys";
/// One request's body at most: a question with its screenshot.
const MAX_BODY_BYTES: usize = 40 * 1024 * 1024;
/// What Anthropic's API is asked to speak.
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Lets a question one model's safeguards decline be answered by another, in
/// the same request (`fallbacks`, lib/providers/byok.ts).
const ANTHROPIC_BETA: &str = "server-side-fallback-2026-07-01";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vendor {
    Anthropic,
    OpenAi,
}

impl Vendor {
    pub fn parse(name: &str) -> Option<Vendor> {
        match name {
            "anthropic" => Some(Vendor::Anthropic),
            "openai" => Some(Vendor::OpenAi),
            _ => None,
        }
    }

    /// Whose key this is: Anthropic's start `sk-ant-`, OpenAI's `sk-`. An
    /// admin key manages an organisation and can't answer, so it is refused.
    pub fn of_key(key: &str) -> Result<Vendor, String> {
        let key = key.trim();
        let admin = |company: &str| Err(format!("That's an {company} admin key, which can't answer questions. Make an API key instead."));
        if key.starts_with("sk-ant-admin") {
            admin("Anthropic")
        } else if key.starts_with("sk-ant-") {
            Ok(Vendor::Anthropic)
        } else if key.starts_with("sk-admin-") {
            admin("OpenAI")
        } else if key.starts_with("sk-") {
            Ok(Vendor::OpenAi)
        } else {
            Err("That doesn't look like an Anthropic or OpenAI API key.".into())
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Vendor::Anthropic => "anthropic",
            Vendor::OpenAi => "openai",
        }
    }

    fn host(self) -> &'static str {
        match self {
            Vendor::Anthropic => "api.anthropic.com",
            Vendor::OpenAi => "api.openai.com",
        }
    }

    /// Where it is asked a question.
    fn ask_path(self) -> &'static str {
        match self {
            Vendor::Anthropic => "/v1/messages",
            Vendor::OpenAi => "/v1/responses",
        }
    }
}

/// The one request a page may have a key sent with: a question, or the list
/// of models, at the company's own API. Anything else is refused.
pub fn allowed(vendor: Vendor, method: &str, url: &str) -> Option<(Method, Url)> {
    let url = Url::parse(url).ok()?;
    let plain = url.scheme() == "https"
        && url.host_str() == Some(vendor.host())
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none();
    if !plain {
        return None;
    }
    let method = match (method, url.path()) {
        ("POST", path) if path == vendor.ask_path() && url.query().is_none() => Method::POST,
        // Anthropic pages its list (`?limit=100`).
        ("GET", "/v1/models") if url.query().is_none_or(|q| q.split('&').all(is_limit)) => Method::GET,
        _ => return None,
    };
    Some((method, url))
}

fn is_limit(param: &str) -> bool {
    param.strip_prefix("limit=").is_some_and(|n| (1..=4).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()))
}

/// A key as it may be kept: what the companies issue, printable and without spaces.
fn clean_key(key: &str) -> Result<String, String> {
    let key = key.trim();
    if key.len() > 512 || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("That doesn't look like an API key.".into());
    }
    Ok(key.to_string())
}

/// What a page may know of the keys: whether each is there, by its last four characters.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct KeyStatus {
    pub anthropic: Option<String>,
    pub openai: Option<String>,
}

fn stored_keys(store: &Store) -> Map<String, Value> {
    store
        .get(Area::Local, Some(&[STORAGE_KEY.to_string()]))
        .ok()
        .and_then(|mut found| found.remove(STORAGE_KEY))
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn key_of(keys: &Map<String, Value>, vendor: Vendor) -> Option<String> {
    keys.get(vendor.name()).and_then(Value::as_str).map(str::trim).filter(|k| !k.is_empty()).map(String::from)
}

pub fn status(store: &Store) -> KeyStatus {
    let keys = stored_keys(store);
    let hint = |vendor| key_of(&keys, vendor).map(|k| format!("…{}", k.chars().skip(k.chars().count().saturating_sub(4)).collect::<String>()));
    KeyStatus { anthropic: hint(Vendor::Anthropic), openai: hint(Vendor::OpenAi) }
}

/// Keeps `key` for the company that issued it; says which, and what is kept now.
pub fn set(store: &Store, key: &str) -> Result<(Vendor, KeyStatus), String> {
    let key = clean_key(key)?;
    let vendor = Vendor::of_key(&key)?;
    Ok((vendor, keep(store, vendor, &key)?))
}

/// Forgets `vendor`'s key.
pub fn remove(store: &Store, vendor: Vendor) -> Result<KeyStatus, String> {
    keep(store, vendor, "")
}

fn keep(store: &Store, vendor: Vendor, key: &str) -> Result<KeyStatus, String> {
    let mut keys = stored_keys(store);
    // Only the two keys; anything else an earlier build kept there goes.
    keys.retain(|k, _| Vendor::parse(k).is_some());
    if key.is_empty() {
        keys.remove(vendor.name());
    } else {
        keys.insert(vendor.name().into(), Value::String(key.to_string()));
    }
    let mut items = Map::new();
    items.insert(STORAGE_KEY.into(), Value::Object(keys));
    store.set(Area::Local, items).map_err(|e| e.to_string())?;
    Ok(status(store))
}

/// What a request's answer starts with, for the page's `Response`.
#[derive(Serialize)]
struct Head {
    status: u16,
    headers: Vec<(String, String)>,
}

/// The headers a page reads from an answer (errors.ts): never all of them.
const PASSED_HEADERS: [&str; 4] = ["content-type", "retry-after", "request-id", "x-request-id"];

pub struct Vault {
    client: reqwest::Client,
    /// Requests under way, by their channel, so a page can stop one.
    running: Mutex<HashMap<u32, JoinHandle<()>>>,
}

impl Vault {
    pub fn new() -> Result<Vault, String> {
        let client = reqwest::Client::builder()
            .https_only(true)
            // A redirect would carry the key wherever it pointed.
            .redirect(redirect::Policy::none())
            .connect_timeout(Duration::from_secs(20))
            // Models think before the first word, at length on a hard question.
            .read_timeout(Duration::from_secs(300))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Vault { client, running: Mutex::new(HashMap::new()) })
    }

    /// Sends a request with `vendor`'s key. The answer comes back over
    /// `channel`: its head (`{status, headers}`), its body in pieces (bytes),
    /// then `{done: true}`, or `{error}` if it failed.
    pub fn fetch(&self, store: &Store, vendor: Vendor, method: &str, url: &str, body: Option<String>, channel: Channel<InvokeResponseBody>) -> Result<(), String> {
        let (method, url) = allowed(vendor, method, url).ok_or_else(|| format!("{} isn't something a key is sent to", url))?;
        let key = key_of(&stored_keys(store), vendor).ok_or("no-key")?;
        if body.as_ref().is_some_and(|b| b.len() > MAX_BODY_BYTES) {
            return Err("That is too large to send.".into());
        }
        let mut request = self.client.request(method.clone(), url);
        for (name, value) in auth_headers(vendor, &key)? {
            request = request.header(name, value);
        }
        if method == Method::POST {
            request = request.header(header::CONTENT_TYPE, "application/json").body(body.unwrap_or_default());
        }
        let id = channel.id();
        let task = tauri::async_runtime::spawn(async move {
            let say = |v: Value| channel.send(InvokeResponseBody::Json(v.to_string()));
            let mut response = match request.send().await {
                Ok(r) => r,
                Err(e) => {
                    let _ = say(json!({ "error": failure(&e) }));
                    return;
                }
            };
            let headers = PASSED_HEADERS
                .iter()
                .filter_map(|n| response.headers().get(*n).and_then(|v| v.to_str().ok()).map(|v| (n.to_string(), v.to_string())))
                .collect();
            if say(json!(Head { status: response.status().as_u16(), headers })).is_err() {
                return;
            }
            loop {
                match response.chunk().await {
                    Ok(Some(piece)) => {
                        if channel.send(InvokeResponseBody::Raw(piece.to_vec())).is_err() {
                            return;
                        }
                    }
                    Ok(None) => {
                        let _ = say(json!({ "done": true }));
                        return;
                    }
                    Err(e) => {
                        let _ = say(json!({ "error": failure(&e) }));
                        return;
                    }
                }
            }
        });
        let mut running = self.running.lock().unwrap();
        running.retain(|_, t| !t.inner().is_finished());
        running.insert(id, task);
        Ok(())
    }

    /// The page stopped waiting (the student pressed Stop).
    pub fn cancel(&self, id: u32) {
        if let Some(task) = self.running.lock().unwrap().remove(&id) {
            task.abort();
        }
    }
}

/// Where it failed, never what was sent (reqwest's own message names the URL).
fn failure(e: &reqwest::Error) -> String {
    let what = if e.is_timeout() {
        "timed out"
    } else if e.is_connect() {
        "couldn't connect"
    } else {
        "failed"
    };
    format!("The request {what}.")
}

/// The key, as each company takes it (marked sensitive, so it is never printed), with Anthropic's version and beta.
fn auth_headers(vendor: Vendor, key: &str) -> Result<Vec<(header::HeaderName, header::HeaderValue)>, String> {
    let secret = |v: String| {
        let mut value = header::HeaderValue::from_str(&v).map_err(|_| "That doesn't look like an API key.".to_string())?;
        value.set_sensitive(true);
        Ok::<_, String>(value)
    };
    Ok(match vendor {
        Vendor::Anthropic => vec![
            (header::HeaderName::from_static("x-api-key"), secret(key.to_string())?),
            (header::HeaderName::from_static("anthropic-version"), header::HeaderValue::from_static(ANTHROPIC_VERSION)),
            (header::HeaderName::from_static("anthropic-beta"), header::HeaderValue::from_static(ANTHROPIC_BETA)),
        ],
        Vendor::OpenAi => vec![(header::AUTHORIZATION, secret(format!("Bearer {key}"))?)],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Secrets;
    use std::io;
    use std::sync::Arc;

    #[test]
    fn a_key_goes_only_to_asking_or_listing_models_at_its_own_company() {
        let ok = |v, m, u: &str| allowed(v, m, u).is_some();
        assert!(ok(Vendor::Anthropic, "POST", "https://api.anthropic.com/v1/messages"));
        assert!(ok(Vendor::Anthropic, "GET", "https://api.anthropic.com/v1/models?limit=100"));
        assert!(ok(Vendor::OpenAi, "POST", "https://api.openai.com/v1/responses"));
        assert!(!ok(Vendor::OpenAi, "POST", "https://api.openai.com/v1/chat/completions"));
        assert!(ok(Vendor::OpenAi, "GET", "https://api.openai.com/v1/models"));

        // Another company's address, another host, plain HTTP, another port, a login in the URL.
        assert!(!ok(Vendor::Anthropic, "POST", "https://api.openai.com/v1/responses"));
        assert!(!ok(Vendor::OpenAi, "POST", "https://api.anthropic.com/v1/messages"));
        assert!(!ok(Vendor::Anthropic, "POST", "https://api.anthropic.com.example.com/v1/messages"));
        assert!(!ok(Vendor::Anthropic, "POST", "https://example.com/v1/messages"));
        assert!(!ok(Vendor::Anthropic, "POST", "http://api.anthropic.com/v1/messages"));
        assert!(!ok(Vendor::Anthropic, "POST", "https://api.anthropic.com:8443/v1/messages"));
        assert!(!ok(Vendor::Anthropic, "POST", "https://me@api.anthropic.com/v1/messages"));
        assert!(!ok(Vendor::Anthropic, "POST", "https://api.anthropic.com/v1/messages#x"));
        // Any other endpoint, method or query.
        assert!(!ok(Vendor::Anthropic, "POST", "https://api.anthropic.com/v1/messages/batches"));
        assert!(!ok(Vendor::Anthropic, "POST", "https://api.anthropic.com/v1/files"));
        assert!(!ok(Vendor::Anthropic, "GET", "https://api.anthropic.com/v1/messages"));
        assert!(!ok(Vendor::Anthropic, "POST", "https://api.anthropic.com/v1/models"));
        assert!(!ok(Vendor::Anthropic, "POST", "https://api.anthropic.com/v1/messages?beta=true"));
        assert!(!ok(Vendor::Anthropic, "GET", "https://api.anthropic.com/v1/models?after_id=x"));
        assert!(!ok(Vendor::OpenAi, "GET", "https://api.openai.com/v1/organization/admin_api_keys"));
        assert!(!ok(Vendor::OpenAi, "DELETE", "https://api.openai.com/v1/models"));
        // Paths that only look like an allowed one.
        assert!(!ok(Vendor::Anthropic, "POST", "https://api.anthropic.com/v1/messages/../files"));
        assert!(!ok(Vendor::Anthropic, "POST", "https://api.anthropic.com//v1/messages"));
        assert!(!ok(Vendor::Anthropic, "POST", "not a url"));
    }

    struct Memory(Arc<Mutex<Map<String, Value>>>);
    impl Secrets for Memory {
        fn load(&self) -> io::Result<Map<String, Value>> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn save(&self, s: &Map<String, Value>) -> io::Result<()> {
            *self.0.lock().unwrap() = s.clone();
            Ok(())
        }
    }

    #[test]
    fn keys_are_kept_privately_and_shown_only_by_their_last_four_characters() {
        let dir = std::env::temp_dir().join(format!("juno-vault-test-{}", std::process::id()));
        let secrets = Arc::new(Mutex::new(Map::new()));
        let store = Store::open(&dir, Box::new(Memory(secrets.clone()))).unwrap();
        assert_eq!(status(&store), KeyStatus::default());

        let (vendor, shown) = set(&store, "  sk-ant-api03-abcdWXYZ \n").unwrap();
        assert_eq!(vendor, Vendor::Anthropic);
        assert_eq!(shown, KeyStatus { anthropic: Some("…WXYZ".into()), openai: None });
        assert_eq!(secrets.lock().unwrap()["keys"]["anthropic"], "sk-ant-api03-abcdWXYZ");
        // Not among the ordinary files every value goes to.
        assert!(std::fs::read_dir(dir.join("local")).unwrap().next().is_none());

        assert_eq!(set(&store, "sk-proj-1234").unwrap().0, Vendor::OpenAi);
        assert_eq!(remove(&store, Vendor::Anthropic).unwrap(), KeyStatus { anthropic: None, openai: Some("…1234".into()) });
        assert!(set(&store, "sk with spaces").is_err());
        assert!(set(&store, "sk-é").is_err());
        assert!(set(&store, "").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_key_is_kept_for_the_company_that_issued_it_and_no_other() {
        assert_eq!(Vendor::of_key("sk-ant-api03-x"), Ok(Vendor::Anthropic));
        assert_eq!(Vendor::of_key("sk-proj-x"), Ok(Vendor::OpenAi));
        assert_eq!(Vendor::of_key("sk-svcacct-x"), Ok(Vendor::OpenAi));
        assert_eq!(Vendor::of_key("sk-0123456789abcdef"), Ok(Vendor::OpenAi));
        // Admin keys can't answer; anything else is no one's.
        assert!(Vendor::of_key("sk-ant-admin01-x").unwrap_err().contains("admin key"));
        assert!(Vendor::of_key("sk-admin-x").unwrap_err().contains("admin key"));
        assert!(Vendor::of_key("AIzaSyExample").is_err());
        assert!(Vendor::of_key("ant-sk-x").is_err());
    }

    #[test]
    fn the_key_header_is_never_printed() {
        let headers = auth_headers(Vendor::OpenAi, "sk-secret").unwrap();
        assert!(headers[0].1.is_sensitive());
        assert!(!format!("{:?}", headers[0].1).contains("sk-secret"));
        let headers = auth_headers(Vendor::Anthropic, "sk-ant-secret").unwrap();
        assert!(headers[0].1.is_sensitive());
        let names: Vec<_> = headers.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["x-api-key", "anthropic-version", "anthropic-beta"]);
    }
}
