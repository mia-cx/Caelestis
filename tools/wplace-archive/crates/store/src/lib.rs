//! **wpa-store** — content-addressed, palette-indexed, keyframe/delta blobs
//!
//! Delegate model: fable-5.1 (format taste)
//!
//! The blob half of the store: dedup'd, palette-indexed tiles with a
//! keyframe+delta layout. Implements `wpa_contracts::TileStore`.
#![allow(async_fn_in_trait)]

// TODO: content-addressed, palette-indexed, keyframe/delta blobs
