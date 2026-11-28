use std::fs::{self, File};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use wpa_contracts::{ETag, TileId};
use wpa_state_index::{Index, Record};

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        loop {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("wpa-index-test-{}-{id}", std::process::id()));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(err) => panic!("could not create test directory: {err}"),
            }
        }
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn upsert_replaces_observation_without_growing_index() -> anyhow::Result<()> {
    let dir = TestDir::new();
    let index = Index::open(&dir.0.join("tiles"))?;
    let tile = TileId { x: 12, y: 34 };
    assert_eq!(index.get(tile), None);
    assert!(index.is_empty());

    let first = Record {
        etag: None,
        size: 0,
        status: 404,
        seen_unix: 1,
    };
    index.upsert(tile, first.clone());
    assert_eq!(index.get(tile), Some(first));

    let latest = Record {
        etag: Some(ETag("tile-v1".into())),
        size: 5_831,
        status: 200,
        seen_unix: 2,
    };
    index.upsert(tile, latest.clone());
    assert_eq!(index.get(tile), Some(latest));
    assert_eq!(index.len(), 1);
    Ok(())
}

#[test]
fn reopen_loads_latest_checkpoint() -> anyhow::Result<()> {
    let dir = TestDir::new();
    let path = dir.0.join("tiles");
    let index = Index::open(&path)?;
    let empty_tile = TileId { x: 3, y: 19 };
    let painted_tile = TileId { x: 19, y: 3 };
    let empty = Record {
        etag: None,
        size: 0,
        status: 404,
        seen_unix: 1_700_000_000,
    };
    let painted = Record {
        etag: Some(ETag("tile-v2".into())),
        size: 10_502,
        status: 200,
        seen_unix: 1_700_000_001,
    };
    index.upsert(empty_tile, empty.clone());
    index.checkpoint()?;
    index.upsert(painted_tile, painted.clone());
    index.checkpoint()?;
    drop(index);

    let reopened = Index::open(&path)?;
    assert_eq!(reopened.len(), 2);
    assert_eq!(reopened.get(empty_tile), Some(empty));
    assert_eq!(reopened.get(painted_tile), Some(painted));
    Ok(())
}

#[test]
fn open_rejects_truncated_checkpoint() -> anyhow::Result<()> {
    let dir = TestDir::new();
    let path = dir.0.join("tiles");
    Index::open(&path)?.checkpoint()?;
    File::options().write(true).open(&path)?.set_len(0)?;

    assert!(Index::open(&path).is_err());
    Ok(())
}
