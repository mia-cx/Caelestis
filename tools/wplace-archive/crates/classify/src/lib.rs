//! **wpa-classify** — pure (status, headers, body) -> Outcome
//!
//! Delegate model: gpt-6.1-sol
//!
//! Stateless mapping of an HTTP response to a [`wpa_contracts::Outcome`].
//! No I/O, fully unit-testable.
#![allow(async_fn_in_trait)]

// TODO: pure (status, headers, body) -> Outcome
