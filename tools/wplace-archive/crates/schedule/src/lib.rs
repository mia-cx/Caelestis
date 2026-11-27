//! **wpa-schedule** — per-tile change-rate EWMA + cadence tiers
//!
//! Delegate model: opus-5.5
//!
//! Decides when each tile is next due: EWMA change-rate, cadence tiers
//! (active / sparse / 404-frontier), explore-vs-exploit. Implements `Scheduler`.
#![allow(async_fn_in_trait)]

// TODO: per-tile change-rate EWMA + cadence tiers
