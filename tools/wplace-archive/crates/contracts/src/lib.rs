//! **wpa-contracts** — the shared seam every other crate codes against.
//!
//! Delegate model: opus-5.5 (integration backbone; kept coherent by hand)
//!
//! These types and traits are the whole API surface between modules, so each
//! crate can be built and tested in isolation against them. Still a scaffold:
//! shapes are indicative, not final.
#![allow(async_fn_in_trait)]

use std::net::IpAddr;
use std::time::Instant;

/// A tile on the zoom-11 canvas: 2048 x 2048 tiles.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct TileId {
    pub x: u16,
    pub y: u16,
}

/// Canvas width/height in tiles.
pub const CANVAS_TILES: u16 = 2048;

/// An HTTP entity tag, used for conditional GETs.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ETag(pub String);

/// What one tile request turned out to be.
#[derive(Clone, Debug)]
pub enum Outcome {
    /// 404 — tile has never been painted (frontier candidate).
    Empty,
    /// 304 — unchanged since the `ETag` we sent.
    Unchanged,
    /// 200 — new or changed; carries the body and its new `ETag`.
    Painted { bytes: Vec<u8>, etag: ETag },
    /// Transport/HTTP error worth retrying or logging.
    Err(String),
}

/// One egress identity: a bound IPv6 source address.
#[derive(Clone, Copy, Debug)]
pub struct Lane {
    pub source: IpAddr,
}

/// Hands out egress lanes, each already under its own rate budget.
pub trait LanePool: Send + Sync {
    /// Acquire a lane with spare budget, awaiting if all are saturated.
    async fn acquire(&self) -> Lane;
}

/// Performs one conditional tile request over a given lane.
pub trait Fetcher: Send + Sync {
    async fn fetch(&self, tile: TileId, known: Option<ETag>, lane: &Lane) -> Outcome;
}

/// Persists tiles and remembers what we last saw for each.
pub trait TileStore: Send + Sync {
    async fn etag_of(&self, tile: TileId) -> Option<ETag>;
    async fn put(&self, tile: TileId, bytes: &[u8], etag: ETag);
}

/// Decides which tiles are due and learns from each outcome.
pub trait Scheduler: Send + Sync {
    /// Up to `budget` tiles due at `now`, most valuable first.
    fn next_due(&mut self, now: Instant, budget: usize) -> Vec<TileId>;
    /// Record an outcome so cadence adapts.
    fn record(&mut self, tile: TileId, outcome: &Outcome, at: Instant);
}
