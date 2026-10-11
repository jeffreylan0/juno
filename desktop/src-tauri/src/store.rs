//! What the extension keeps in `browser.storage` and IndexedDB, kept by the
//! app instead, in one place every window shares:
//!
//! - `local`: one JSON file per key under `<store>/local/`, read into
//!   memory at start. Except the API keys and the account session (`keys`,
//!   `account`), which go together into one file only this user can read,
//!   `<store>/secrets.json` — the protection the browser gives the
//!   extension's own storage.
//!
//!   Not the system keychain: macOS ties a keychain item to the exact build
//!   that made it, so every new build (and every development build) had to
//!   ask for the keychain password, and once refused, asked again at every
//!   read. Signed with a Developer ID, the app could go back to it.
//! - `session`: memory only, gone when the app quits — temporary chats and
//!   their screenshots never touch the disk, as in the extension.
//! - screenshots of saved chats: files under `<store>/images/<chat id>/`.
//!
//! `<store>` is `store/` in the app's data folder (on Linux WebKitGTK keeps
//! its own files in that folder, a `storage/` among them).
//!
//! Every change is reported (old and new value) so the windows can fire
//! `storage.onChanged`, which is how the panel follows the chat.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use base64::Engine;
use serde::Serialize;
use serde_json::{Map, Value};

/// Local keys that hold secrets and live in the private secrets file, not with the other values.
const SECRET_KEYS: [&str; 2] = ["keys", "account"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Area {
    Local,
    Session,
}

impl Area {
    pub fn parse(name: &str) -> Option<Area> {
        match name {
            "local" => Some(Area::Local),
            "session" => Some(Area::Session),
            _ => None,
        }
    }
}

/// One key's change, shaped like `chrome.storage.StorageChange`.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Change {
    #[serde(rename = "oldValue", skip_serializing_if = "Option::is_none")]
    pub old_value: Option<Value>,
    #[serde(rename = "newValue", skip_serializing_if = "Option::is_none")]
    pub new_value: Option<Value>,
}

pub type Changes = HashMap<String, Change>;

/// Where the secrets are kept (a private file; a stand-in in tests).
pub trait Secrets: Send + Sync {
    fn load(&self) -> io::Result<Map<String, Value>>;
    fn save(&self, secrets: &Map<String, Value>) -> io::Result<()>;
}

pub struct Store {
    dir: PathBuf,
    local: Mutex<Local>,
    session: Mutex<HashMap<String, Value>>,
    secrets: Box<dyn Secrets>,
}

struct Local {
    values: HashMap<String, Value>,
    /// Secrets are read the first time they are needed, not at start.
    secrets_loaded: bool,
}

impl Store {
    /// Opens (creating) the store under `dir`, reading every local value.
    pub fn open(dir: &Path, secrets: Box<dyn Secrets>) -> io::Result<Store> {
        let files = dir.join("local");
        fs::create_dir_all(&files)?;
        let mut values = HashMap::new();
        for entry in fs::read_dir(&files)? {
            let path = entry?.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
            let Some(encoded) = name.strip_suffix(".json") else { continue };
            let Some(key) = decode_key(encoded) else { continue };
            // A file half-written by a crash is skipped, not fatal.
            if let Ok(value) = fs::read(&path).map_err(|_| ()).and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|_| ())) {
                values.insert(key, value);
            }
        }
        Ok(Store {
            dir: dir.to_path_buf(),
            local: Mutex::new(Local { values, secrets_loaded: false }),
            session: Mutex::new(HashMap::new()),
            secrets,
        })
    }

    pub fn get(&self, area: Area, keys: Option<&[String]>) -> io::Result<Map<String, Value>> {
        match area {
            Area::Session => {
                let session = self.session.lock().unwrap();
                Ok(pick(&session, keys))
            }
            Area::Local => {
                let mut local = self.local.lock().unwrap();
                let wants_secret = keys.is_none_or(|k| k.iter().any(|k| is_secret(k)));
                // Secrets that cannot be read never stop the rest from being:
                // settings, chats and the panel carry on without the keys.
                if wants_secret {
                    if let Err(e) = self.load_secrets(&mut local) {
                        eprintln!("[selection-ai] could not read the secrets: {e}");
                    }
                }
                Ok(pick(&local.values, keys))
            }
        }
    }

    pub fn set(&self, area: Area, items: Map<String, Value>) -> io::Result<Changes> {
        let mut changes = Changes::new();
        match area {
            Area::Session => {
                let mut session = self.session.lock().unwrap();
                for (key, value) in items {
                    let old = session.insert(key.clone(), value.clone());
                    if old.as_ref() != Some(&value) {
                        changes.insert(key, Change { old_value: old, new_value: Some(value) });
                    }
                }
            }
            Area::Local => {
                let mut local = self.local.lock().unwrap();
                // Secrets first, and only into memory once they are on disk: a
                // failed write must not look saved until a restart.
                if items.keys().any(|k| is_secret(k)) {
                    self.load_secrets(&mut local)?;
                    let mut next = secrets_of(&local.values);
                    next.extend(items.iter().filter(|(k, _)| is_secret(k)).map(|(k, v)| (k.clone(), v.clone())));
                    self.secrets.save(&next)?;
                }
                for (key, value) in items {
                    if !is_secret(&key) {
                        self.write_file(&key, &value)?;
                    }
                    let old = local.values.insert(key.clone(), value.clone());
                    if old.as_ref() != Some(&value) {
                        changes.insert(key, Change { old_value: old, new_value: Some(value) });
                    }
                }
            }
        }
        Ok(changes)
    }

    pub fn remove(&self, area: Area, keys: &[String]) -> io::Result<Changes> {
        let mut changes = Changes::new();
        match area {
            Area::Session => {
                let mut session = self.session.lock().unwrap();
                for key in keys {
                    if let Some(old) = session.remove(key) {
                        changes.insert(key.clone(), Change { old_value: Some(old), new_value: None });
                    }
                }
            }
            Area::Local => {
                let mut local = self.local.lock().unwrap();
                if keys.iter().any(|k| is_secret(k)) {
                    self.load_secrets(&mut local)?;
                    let mut next = secrets_of(&local.values);
                    next.retain(|k, _| !keys.contains(k));
                    self.secrets.save(&next)?;
                }
                for key in keys {
                    if !is_secret(key) {
                        self.remove_file(key)?;
                    }
                    if let Some(old) = local.values.remove(key) {
                        changes.insert(key.clone(), Change { old_value: Some(old), new_value: None });
                    }
                }
            }
        }
        Ok(changes)
    }

    pub fn clear(&self, area: Area) -> io::Result<Changes> {
        let keys: Vec<String> = match area {
            Area::Session => self.session.lock().unwrap().keys().cloned().collect(),
            Area::Local => {
                let mut local = self.local.lock().unwrap();
                self.load_secrets(&mut local)?;
                local.values.keys().cloned().collect()
            }
        };
        self.remove(area, &keys)
    }

    fn load_secrets(&self, local: &mut Local) -> io::Result<()> {
        if local.secrets_loaded {
            return Ok(());
        }
        for (key, value) in self.secrets.load()? {
            if is_secret(&key) {
                local.values.insert(key, value);
            }
        }
        local.secrets_loaded = true;
        Ok(())
    }

    fn file_for(&self, key: &str) -> PathBuf {
        self.dir.join("local").join(format!("{}.json", encode_key(key)))
    }

    fn write_file(&self, key: &str, value: &Value) -> io::Result<()> {
        write_atomic(&self.file_for(key), &serde_json::to_vec(value)?)
    }

    fn remove_file(&self, key: &str) -> io::Result<()> {
        match fs::remove_file(self.file_for(key)) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }
}

fn is_secret(key: &str) -> bool {
    SECRET_KEYS.contains(&key)
}

/// The secrets among the local values, as secrets.json holds them.
fn secrets_of(values: &HashMap<String, Value>) -> Map<String, Value> {
    SECRET_KEYS.iter().filter_map(|k| values.get(*k).map(|v| (k.to_string(), v.clone()))).collect()
}

fn pick(values: &HashMap<String, Value>, keys: Option<&[String]>) -> Map<String, Value> {
    match keys {
        None => values.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Some(keys) => keys.iter().filter_map(|k| values.get(k).map(|v| (k.clone(), v.clone()))).collect(),
    }
}

/// Writes through a temporary file and a rename, so a crash leaves the old value or the new one.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

/// Storage keys as file names: letters, digits, `-`, `_` and `.` as they are,
/// anything else (the `:` in `chat:<id>`, which Windows forbids) as `%XX`.
pub fn encode_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for b in key.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || (b == b'.' && !out.is_empty()) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn decode_key(name: &str) -> Option<String> {
    let bytes = name.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

// ── Secrets ──────────────────────────────────────────────────────────────

/// A file readable only by this user (0600 on macOS and Linux; on Windows
/// the user's own application data folder already is).
pub struct SecretsFile(pub PathBuf);

impl Secrets for SecretsFile {
    fn load(&self) -> io::Result<Map<String, Value>> {
        match fs::read(&self.0) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Map::new()),
            Err(e) => Err(e),
        }
    }

    fn save(&self, secrets: &Map<String, Value>) -> io::Result<()> {
        // Readable only by this user from the moment it exists, not after.
        let tmp = self.0.with_extension("tmp");
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        std::io::Write::write_all(&mut file, &serde_json::to_vec(secrets)?)?;
        drop(file);
        fs::rename(&tmp, &self.0)
    }
}

/// Where the app keeps its secrets: `secrets.json` in the store, private to this user.
pub fn system_secrets(dir: &Path) -> Box<dyn Secrets> {
    Box::new(SecretsFile(dir.join("secrets.json")))
}

// ── Screenshots ──────────────────────────────────────────────────────────

/// A screenshot as `lib/images.ts` stores it.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredImage {
    pub id: String,
    pub chat_id: String,
    pub data_url: String,
    pub created_at: u64,
}

/// Screenshots of saved chats, as files: `<dir>/<chat id>/<image id>.<ext>`.
pub struct Images {
    dir: PathBuf,
    /// Image id → (chat id, file extension), so a lookup by id needs no scan.
    index: Mutex<HashMap<String, (String, String)>>,
}

impl Images {
    pub fn open(dir: &Path) -> io::Result<Images> {
        fs::create_dir_all(dir)?;
        let mut index = HashMap::new();
        for chat in fs::read_dir(dir)? {
            let chat = chat?;
            if !chat.file_type()?.is_dir() {
                continue;
            }
            let chat_id = chat.file_name().to_string_lossy().to_string();
            for file in fs::read_dir(chat.path())? {
                let path = file?.path();
                let (Some(stem), Some(ext)) = (path.file_stem(), path.extension()) else { continue };
                index.insert(stem.to_string_lossy().to_string(), (chat_id.clone(), ext.to_string_lossy().to_string()));
            }
        }
        Ok(Images { dir: dir.to_path_buf(), index: Mutex::new(index) })
    }

    pub fn put(&self, id: &str, chat_id: &str, data_url: &str) -> io::Result<()> {
        check_id(id)?;
        check_id(chat_id)?;
        let (ext, bytes) = decode_data_url(data_url)?;
        let folder = self.dir.join(chat_id);
        fs::create_dir_all(&folder)?;
        let mut index = self.index.lock().unwrap();
        write_atomic(&folder.join(format!("{id}.{ext}")), &bytes)?;
        index.insert(id.to_string(), (chat_id.to_string(), ext.to_string()));
        Ok(())
    }

    pub fn get(&self, id: &str) -> io::Result<Option<StoredImage>> {
        let Some((chat_id, ext)) = self.index.lock().unwrap().get(id).cloned() else { return Ok(None) };
        let path = self.dir.join(&chat_id).join(format!("{id}.{ext}"));
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let created_at = fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mime = match ext.as_str() {
            "jpg" => "image/jpeg",
            "webp" => "image/webp",
            _ => "image/png",
        };
        Ok(Some(StoredImage {
            id: id.to_string(),
            chat_id,
            data_url: format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)),
            created_at,
        }))
    }

    pub fn delete(&self, ids: &[String]) -> io::Result<()> {
        let mut index = self.index.lock().unwrap();
        for id in ids {
            if let Some((chat_id, ext)) = index.remove(id) {
                match fs::remove_file(self.dir.join(&chat_id).join(format!("{id}.{ext}"))) {
                    Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                    _ => {}
                }
                let _ = fs::remove_dir(self.dir.join(&chat_id)); // only if now empty
            }
        }
        Ok(())
    }

    pub fn delete_for_chat(&self, chat_id: &str) -> io::Result<()> {
        check_id(chat_id)?;
        let mut index = self.index.lock().unwrap();
        index.retain(|_, (c, _)| c != chat_id);
        match fs::remove_dir_all(self.dir.join(chat_id)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    pub fn chat_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.index.lock().unwrap().values().map(|(c, _)| c.clone()).collect();
        ids.sort();
        ids.dedup();
        ids
    }
}

/// Ids name files and folders, so only uuid-like ids are let through.
fn check_id(id: &str) -> io::Result<()> {
    if !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        Ok(())
    } else {
        Err(io::Error::new(io::ErrorKind::InvalidInput, format!("not an id: {id:?}")))
    }
}

fn decode_data_url(url: &str) -> io::Result<(&'static str, Vec<u8>)> {
    let bad = || io::Error::new(io::ErrorKind::InvalidData, "not a base64 image data URL");
    let rest = url.strip_prefix("data:").ok_or_else(bad)?;
    let (meta, data) = rest.split_once(',').ok_or_else(bad)?;
    let mime = meta.strip_suffix(";base64").ok_or_else(bad)?;
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => return Err(bad()),
    };
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| bad())?;
    Ok((ext, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct MemorySecrets(Mutex<Map<String, Value>>, Mutex<usize>);
    impl Secrets for MemorySecrets {
        fn load(&self) -> io::Result<Map<String, Value>> {
            *self.1.lock().unwrap() += 1;
            Ok(self.0.lock().unwrap().clone())
        }
        fn save(&self, s: &Map<String, Value>) -> io::Result<()> {
            *self.0.lock().unwrap() = s.clone();
            Ok(())
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sai-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn keys(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn keys_survive_as_file_names() {
        for key in ["chat:5b1c-77", "chatIndex", "settings", "current:1", ".hidden", "a/b\\c", "ümlaut"] {
            let name = encode_key(key);
            assert!(name.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.%".contains(&b)), "{name}");
            assert!(!name.starts_with('.'));
            assert_eq!(decode_key(&name).as_deref(), Some(key));
        }
        assert_eq!(encode_key("chat:1"), "chat%3A1");
    }

    #[test]
    fn local_values_persist_and_report_changes() {
        let dir = temp_dir("local");
        let store = Store::open(&dir, Box::new(SecretsFile(dir.join("secrets.json")))).unwrap();
        let mut items = Map::new();
        items.insert("chat:1".into(), json!({ "id": "1", "items": [] }));
        items.insert("chatIndex".into(), json!([]));
        let changes = store.set(Area::Local, items).unwrap();
        assert_eq!(changes.len(), 2);
        assert_eq!(changes["chat:1"].old_value, None);
        // The same value again is no change.
        let mut again = Map::new();
        again.insert("chatIndex".into(), json!([]));
        assert!(store.set(Area::Local, again).unwrap().is_empty());

        let reopened = Store::open(&dir, Box::new(SecretsFile(dir.join("secrets.json")))).unwrap();
        assert_eq!(reopened.get(Area::Local, Some(&keys(&["chat:1"]))).unwrap()["chat:1"], json!({ "id": "1", "items": [] }));
        let removed = reopened.remove(Area::Local, &keys(&["chat:1", "missing"])).unwrap();
        assert_eq!(removed.len(), 1);
        assert!(removed["chat:1"].new_value.is_none());
        assert!(!dir.join("local").join("chat%3A1.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_values_live_in_memory_only() {
        let dir = temp_dir("session");
        let store = Store::open(&dir, Box::new(SecretsFile(dir.join("secrets.json")))).unwrap();
        let mut items = Map::new();
        items.insert("current:1".into(), json!({ "chatId": "a", "temporary": true }));
        store.set(Area::Session, items).unwrap();
        assert_eq!(store.get(Area::Session, None).unwrap().len(), 1);
        assert_eq!(fs::read_dir(dir.join("local")).unwrap().count(), 0);
        let cleared = store.clear(Area::Session).unwrap();
        assert_eq!(cleared.len(), 1);
        assert!(store.get(Area::Session, None).unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn secrets_are_kept_apart_and_read_only_when_wanted() {
        let dir = temp_dir("secrets");
        let secrets = std::sync::Arc::new(MemorySecrets(Mutex::new(Map::new()), Mutex::new(0)));
        struct Shared(std::sync::Arc<MemorySecrets>);
        impl Secrets for Shared {
            fn load(&self) -> io::Result<Map<String, Value>> {
                self.0.load()
            }
            fn save(&self, s: &Map<String, Value>) -> io::Result<()> {
                self.0.save(s)
            }
        }
        let store = Store::open(&dir, Box::new(Shared(secrets.clone()))).unwrap();
        // Reading settings does not read the secrets.
        store.get(Area::Local, Some(&keys(&["settings"]))).unwrap();
        assert_eq!(*secrets.1.lock().unwrap(), 0);

        let mut items = Map::new();
        items.insert("keys".into(), json!({ "anthropic": "sk-ant-x", "openai": "", "session": "" }));
        items.insert("settings".into(), json!({ "provider": "byok" }));
        store.set(Area::Local, items).unwrap();
        assert_eq!(*secrets.1.lock().unwrap(), 1);
        assert_eq!(secrets.0.lock().unwrap()["keys"]["anthropic"], "sk-ant-x");
        // Never written to a file.
        assert!(!dir.join("local").join("keys.json").exists());
        assert!(dir.join("local").join("settings.json").exists());

        store.remove(Area::Local, &keys(&["keys"])).unwrap();
        assert!(secrets.0.lock().unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_secrets_write_changes_nothing() {
        struct Refusing;
        impl Secrets for Refusing {
            fn load(&self) -> io::Result<Map<String, Value>> {
                Ok(Map::new())
            }
            fn save(&self, _: &Map<String, Value>) -> io::Result<()> {
                Err(io::Error::other("TooLong"))
            }
        }
        let dir = temp_dir("refused");
        let store = Store::open(&dir, Box::new(Refusing)).unwrap();
        let mut items = Map::new();
        items.insert("keys".into(), json!({ "anthropic": "sk-ant-x" }));
        assert!(store.set(Area::Local, items).is_err());
        assert!(store.get(Area::Local, Some(&keys(&["keys"]))).unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_secrets_never_stop_the_rest() {
        struct Unreadable;
        impl Secrets for Unreadable {
            fn load(&self) -> io::Result<Map<String, Value>> {
                Err(io::Error::other("refused"))
            }
            fn save(&self, _: &Map<String, Value>) -> io::Result<()> {
                Err(io::Error::other("refused"))
            }
        }
        let dir = temp_dir("unreadable");
        let store = Store::open(&dir, Box::new(Unreadable)).unwrap();
        let mut items = Map::new();
        items.insert("settings".into(), json!({ "provider": "mock" }));
        store.set(Area::Local, items).unwrap();
        // Everything, or the keys themselves: what can be read comes back.
        assert_eq!(store.get(Area::Local, None).unwrap()["settings"]["provider"], "mock");
        assert!(store.get(Area::Local, Some(&keys(&["keys", "settings"]))).unwrap().contains_key("settings"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_secrets_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("private");
        fs::create_dir_all(&dir).unwrap();
        let file = SecretsFile(dir.join("secrets.json"));
        let mut s = Map::new();
        s.insert("keys".into(), json!({ "anthropic": "sk-ant-x" }));
        file.save(&s).unwrap();
        assert_eq!(fs::metadata(dir.join("secrets.json")).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(file.load().unwrap(), s);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn screenshots_are_files_per_chat() {
        let dir = temp_dir("images");
        let images = Images::open(&dir).unwrap();
        let png = crate::crop::png_data_url(&image::RgbImage::from_pixel(2, 2, image::Rgb([9, 9, 9])));
        images.put("img-1", "chat-a", &png).unwrap();
        images.put("img-2", "chat-a", &png).unwrap();
        images.put("img-3", "chat-b", &png).unwrap();
        assert_eq!(images.chat_ids(), vec!["chat-a".to_string(), "chat-b".to_string()]);

        let reopened = Images::open(&dir).unwrap();
        let got = reopened.get("img-1").unwrap().unwrap();
        assert_eq!(got.chat_id, "chat-a");
        assert_eq!(got.data_url, png);
        reopened.delete(&keys(&["img-1"])).unwrap();
        assert!(reopened.get("img-1").unwrap().is_none());
        reopened.delete_for_chat("chat-a").unwrap();
        assert_eq!(reopened.chat_ids(), vec!["chat-b".to_string()]);
        assert!(!dir.join("chat-a").exists());
        assert!(images.put("../escape", "chat-a", &png).is_err());
        assert!(images.put("x", "chat-a", "data:text/html;base64,AAAA").is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
