//! **wpa-mock** (wpa-mock) — local tile server for prototyping (no prod traffic)
//!
//! Delegate model: gpt-6.1-sol
//!
//! Serves tiles from an on-disk snapshot dir or a small sample set, faking
//! ETag / 304 / 200 / 404, injected latency and size distribution, no rate
//! limit. Point `[source] base_url` here so prototyping never hits Wplace.
fn main() {
    println!("wpa-mock: scaffold — not implemented yet");
}
