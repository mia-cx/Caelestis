//! **wpa-lanes** — derive + bind IPv6 source addresses (local prefixes)
//!
//! Delegate model: opus-5.5 (subtle networking)
//!
//! Derives N source addresses from the local IPv6 prefix(es), spread across
//! /64s, and binds each outbound socket to one. No proxies.
#![allow(async_fn_in_trait)]

// TODO: derive + bind IPv6 source addresses (local prefixes)
