//! **wpa-state-index** — persistent TileId -> {etag,size,status,seen}; resume
//!
//! Delegate model: gpt-6.1-sol
//!
//! The index half of the store: what we know about each tile, checkpointed
//! so a run resumes without re-sweeping.
#![allow(async_fn_in_trait)]

// TODO: persistent TileId -> {etag,size,status,seen}; resume
