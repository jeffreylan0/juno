//! This computer, as the unlock knows it (lib/account/unlock.ts): a hash of
//! the system's own machine id, salted for Juno, so it names nothing about
//! the computer and matches no other app's id. The unlock is signed for this
//! hash, so it opens the extras on this computer and on no other; a
//! reinstall here keeps the same id.

use std::sync::OnceLock;

use sha2::{Digest, Sha256};

/// The id, worked out once; None if the system won't say (the unlock then isn't offered).
pub fn id() -> Option<&'static str> {
    static ID: OnceLock<Option<String>> = OnceLock::new();
    ID.get_or_init(|| machine().map(|m| hash(&m))).as_deref()
}

fn hash(machine: &str) -> String {
    Sha256::digest(format!("juno-unlock-v1:{}", machine.trim()).as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// The Mac's hardware UUID (IOPlatformUUID).
#[cfg(target_os = "macos")]
fn machine() -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/ioreg").args(["-rd1", "-c", "IOPlatformExpertDevice"]).output().ok()?;
    uuid_in(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(any(target_os = "macos", test))]
fn uuid_in(ioreg: &str) -> Option<String> {
    let line = ioreg.lines().find(|l| l.contains("\"IOPlatformUUID\""))?;
    let uuid = line.rsplit('"').nth(1)?.trim();
    (uuid.len() >= 32).then(|| uuid.to_string())
}

/// Windows' MachineGuid, set when Windows is installed.
#[cfg(windows)]
fn machine() -> Option<String> {
    let key = windows_registry::LOCAL_MACHINE.open(r"SOFTWARE\Microsoft\Cryptography").ok()?;
    key.get_string("MachineGuid").ok().filter(|s| !s.trim().is_empty())
}

#[cfg(target_os = "linux")]
fn machine() -> Option<String> {
    std::fs::read_to_string("/etc/machine-id").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_id_is_a_salted_hash_of_the_machine_id() {
        let h = hash("4C4C4544-0035-5310-8030-B4C04F4A5A31");
        assert_eq!(h.len(), 64);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(h, hash(" 4C4C4544-0035-5310-8030-B4C04F4A5A31\n"));
        assert_ne!(h, hash("4C4C4544-0035-5310-8030-B4C04F4A5A32"));
        // The machine id itself is not in it.
        assert!(!h.contains("4c4c4544"));
    }

    #[test]
    fn the_macs_uuid_is_read_from_ioreg() {
        let out = "+-o J314sAP  <class IOPlatformExpertDevice>\n    {\n      \"IOPlatformSerialNumber\" = \"X\"\n      \"IOPlatformUUID\" = \"564D2F1A-0B3C-4D5E-8F60-718293A4B5C6\"\n    }";
        assert_eq!(uuid_in(out).as_deref(), Some("564D2F1A-0B3C-4D5E-8F60-718293A4B5C6"));
        assert_eq!(uuid_in("nothing here"), None);
    }

    #[test]
    fn this_computer_has_one() {
        assert!(id().is_some());
    }
}
