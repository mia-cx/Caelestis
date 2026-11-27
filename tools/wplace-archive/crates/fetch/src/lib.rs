//! **wpa-fetch** — conditional GET hot path (ETag/304/200/404, keep-alive)
//!
//! Delegate model: opus-5.5
//!
//! The request hot path: conditional GET with per-lane source binding,
//! HTTP/2 keep-alive, timeouts, retry. Implements `wpa_contracts::Fetcher`.
#![allow(async_fn_in_trait)]

// TODO: conditional GET hot path (ETag/304/200/404, keep-alive)
