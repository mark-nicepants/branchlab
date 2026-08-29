//! Tiny helpers shared across subsystems.

/// Current time in epoch milliseconds.
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// A fresh sortable id (monotonic ULID).
pub fn new_id() -> String {
    ulid::Ulid::generate().to_string()
}

/// Tolerant "JSON somewhere in the reply" parse: first `{` .. last `}`, then
/// serde (models love fences and prose around the object).
pub fn json_blob<T: serde::de::DeserializeOwned>(raw: &str) -> Option<T> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    serde_json::from_str(&raw[start..=end]).ok()
}
