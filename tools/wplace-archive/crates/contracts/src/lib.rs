//! **wpa-contracts** — the shared seam every other crate codes against.
//!
//! These types and traits are the whole API surface between modules, so each
//! crate can be built and tested in isolation against them.
#![allow(async_fn_in_trait)]

use std::net::IpAddr;
use std::time::Instant;

/// Canvas width/height in tiles: a 2048 x 2048 grid at zoom 11.
pub const CANVAS_TILES: u16 = 2048;

/// A tile on the canvas. `x` and `y` are each in `0..CANVAS_TILES`.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct TileId {
    pub x: u16,
    pub y: u16,
}

impl TileId {
    pub fn new(x: u16, y: u16) -> Self {
        Self { x, y }
    }

    /// Row-major position in `0..CANVAS_TILES * CANVAS_TILES`.
    pub fn index(self) -> u32 {
        u32::from(self.y) * u32::from(CANVAS_TILES) + u32::from(self.x)
    }

    /// The tile at a row-major `index` (wraps past the canvas by construction of the caller).
    pub fn from_index(index: u32) -> Self {
        let n = u32::from(CANVAS_TILES);
        Self {
            x: (index % n) as u16,
            y: (index / n) as u16,
        }
    }

    /// Fill a path template, replacing `{x}` and `{y}` with this tile's coordinates.
    pub fn render_path(self, template: &str) -> String {
        template
            .replace("{x}", &self.x.to_string())
            .replace("{y}", &self.y.to_string())
    }

    /// Every tile on the canvas, row-major.
    pub fn all() -> impl Iterator<Item = TileId> {
        let n = u32::from(CANVAS_TILES);
        (0..n * n).map(TileId::from_index)
    }
}

/// An HTTP entity tag, used as the validator for conditional GETs.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ETag(pub String);

/// What one tile request turned out to be.
#[derive(Clone, Debug)]
pub enum Outcome {
    /// 404 — tile has never been painted (a frontier candidate).
    Empty,
    /// 304 — unchanged since the `ETag` we sent.
    Unchanged,
    /// 200 — new or changed; carries the body and its new `ETag`.
    Painted { bytes: Vec<u8>, etag: ETag },
    /// Transport or HTTP error worth retrying or logging; the string carries context.
    Err(String),
}

/// One egress identity: a bound local source address.
#[derive(Clone, Copy, Debug)]
pub struct Lane {
    pub source: IpAddr,
}

/// Hands out egress lanes, each already paced under its own request budget.
pub trait LanePool: Send + Sync {
    /// Acquire a lane with spare budget, awaiting if every lane is saturated.
    async fn acquire(&self) -> Lane;
}

/// Performs one conditional tile request over a given lane.
pub trait Fetcher: Send + Sync {
    async fn fetch(&self, tile: TileId, known: Option<ETag>, lane: &Lane) -> Outcome;
}

/// Persists tile bytes and remembers the validator last stored for each tile.
pub trait TileStore: Send + Sync {
    /// The validator last stored for `tile`, if any.
    async fn etag_of(&self, tile: TileId) -> anyhow::Result<Option<ETag>>;
    /// Store `bytes` for `tile` under `etag`.
    async fn put(&self, tile: TileId, bytes: &[u8], etag: ETag) -> anyhow::Result<()>;
}

/// Decides which tiles are due and learns from each outcome.
pub trait Scheduler: Send + Sync {
    /// Up to `budget` tiles due at `now`, most valuable first.
    fn next_due(&mut self, now: Instant, budget: usize) -> Vec<TileId>;
    /// Record an outcome so cadence adapts.
    fn record(&mut self, tile: TileId, outcome: &Outcome, at: Instant);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_round_trips() {
        for tile in [
            TileId::new(0, 0),
            TileId::new(1100, 671),
            TileId::new(CANVAS_TILES - 1, CANVAS_TILES - 1),
        ] {
            assert_eq!(TileId::from_index(tile.index()), tile);
        }
    }

    #[test]
    fn renders_path_template() {
        assert_eq!(
            TileId::new(1100, 671).render_path("/files/s0/tiles/{x}/{y}.png"),
            "/files/s0/tiles/1100/671.png"
        );
    }

    #[test]
    fn all_covers_the_canvas_once() {
        let n = u64::from(CANVAS_TILES);
        assert_eq!(TileId::all().count() as u64, n * n);
    }
}
