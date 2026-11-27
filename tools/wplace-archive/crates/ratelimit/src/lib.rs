//! **wpa-ratelimit** — per-lane token bucket + global ceiling + 429 backoff
//!
//! Delegate model: gpt-6.1-sol (verify vs measured limits)
//!
//! Keeps every lane under the per-address tile limit (~28.5 req/s) and the
//! global politeness ceiling. Honours `Retry-After` on 429.
#![allow(async_fn_in_trait)]

// TODO: per-lane token bucket + global ceiling + 429 backoff
