//! **wpa-config** — load + validate the TOML config (incl. base_url)
//!
//! Delegate model: gpt-6.1-sol
//!
//! Parses `config.toml` into a typed, validated `Config`. Owns the
//! `[source] base_url` knob that points the fetcher at the mock or prod.
#![allow(async_fn_in_trait)]

// TODO: load + validate the TOML config (incl. base_url)
