//! **wpa-store** — content-addressed, deduplicating tile blobs.
//!
//! Each distinct tile body is written once to `root/objects/<aa>/<hash>`, where `<hash>`
//! is its blake3 hex digest and `<aa>` that digest's first byte. Tiles with identical
//! bytes, and a tile that returns to an earlier body, share one object.
//!
//! A pointer journal, `root/pointers.jsonl`, maps each tile to its current object and
//! `ETag`. `put` appends one line, so a write costs the same at four million tiles as at
//! one. `open` replays the journal (the last line per tile wins), drops a torn final line
//! left by a crash, and compacts it to one line per tile with a temp file + rename.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use wpa_contracts::{ETag, TileId, TileStore};

const OBJECTS_DIR: &str = "objects";
const JOURNAL_FILE: &str = "pointers.jsonl";
const TEMP_EXTENSION: &str = "tmp";

/// One journal line: `tile` (its row-major index) now holds object `hash` under `etag`.
#[derive(Serialize, Deserialize)]
struct Pointer {
    tile: u32,
    hash: String,
    etag: String,
}

/// A tile's current object and validator.
struct Current {
    hash: blake3::Hash,
    etag: ETag,
}

struct State {
    pointers: HashMap<TileId, Current>,
    journal: tokio::fs::File,
}

/// A deduplicating blob store for tile bytes. Implements [`TileStore`].
///
/// `put`s are serialized behind one lock, so the object write and its journal line land
/// in order and a pointer never names a missing object.
pub struct BlobStore {
    root: PathBuf,
    state: Mutex<State>,
    objects: AtomicUsize,
}

impl BlobStore {
    /// Open the store at `root`, creating it if absent and loading its pointer journal.
    pub fn open(root: &Path) -> anyhow::Result<Self> {
        let objects_dir = root.join(OBJECTS_DIR);
        fs::create_dir_all(&objects_dir)
            .with_context(|| format!("creating {}", objects_dir.display()))?;

        let journal_path = root.join(JOURNAL_FILE);
        let pointers = match fs::read_to_string(&journal_path) {
            Ok(text) => {
                replay(&text).with_context(|| format!("replaying {}", journal_path.display()))?
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(err) => return Err(err).context(format!("reading {}", journal_path.display())),
        };
        compact(&journal_path, &pointers)?;

        let journal = OpenOptions::new()
            .append(true)
            .open(&journal_path)
            .with_context(|| format!("opening {}", journal_path.display()))?;

        Ok(Self {
            root: root.to_owned(),
            state: Mutex::new(State {
                pointers,
                journal: tokio::fs::File::from_std(journal),
            }),
            objects: AtomicUsize::new(count_objects(&objects_dir)?),
        })
    }

    /// The number of distinct blobs on disk.
    pub fn object_count(&self) -> usize {
        self.objects.load(Ordering::Relaxed)
    }

    fn object_path(&self, hash: &blake3::Hash) -> PathBuf {
        let hex = hash.to_hex();
        self.root
            .join(OBJECTS_DIR)
            .join(&hex[..2])
            .join(hex.as_str())
    }
}

impl TileStore for BlobStore {
    async fn etag_of(&self, tile: TileId) -> anyhow::Result<Option<ETag>> {
        let state = self.state.lock().await;
        Ok(state
            .pointers
            .get(&tile)
            .map(|current| current.etag.clone()))
    }

    async fn put(&self, tile: TileId, bytes: &[u8], etag: ETag) -> anyhow::Result<()> {
        let hash = blake3::hash(bytes);
        let mut state = self.state.lock().await;

        let object = self.object_path(&hash);
        if !tokio::fs::try_exists(&object).await? {
            let shard = object
                .parent()
                .expect("object paths sit inside a shard directory");
            tokio::fs::create_dir_all(shard).await?;
            let temp = object.with_extension(TEMP_EXTENSION);
            tokio::fs::write(&temp, bytes).await?;
            tokio::fs::rename(&temp, &object).await?;
            self.objects.fetch_add(1, Ordering::Relaxed);
        }

        let mut line = serde_json::to_vec(&Pointer {
            tile: tile.index(),
            hash: hash.to_hex().to_string(),
            etag: etag.0.clone(),
        })?;
        line.push(b'\n');
        state.journal.write_all(&line).await?;
        state.journal.flush().await?;

        state.pointers.insert(tile, Current { hash, etag });
        Ok(())
    }
}

/// Rebuild the pointer map from journal text. A final line without its newline is a
/// write torn by a crash and is dropped; any other unreadable line is an error.
fn replay(text: &str) -> anyhow::Result<HashMap<TileId, Current>> {
    let complete = text.rsplit_once('\n').map_or("", |(lines, _torn)| lines);
    let mut pointers = HashMap::new();
    for (number, line) in complete.lines().enumerate() {
        let pointer: Pointer =
            serde_json::from_str(line).with_context(|| format!("line {}", number + 1))?;
        let hash = blake3::Hash::from_hex(&pointer.hash)
            .with_context(|| format!("line {}", number + 1))?;
        pointers.insert(
            TileId::from_index(pointer.tile),
            Current {
                hash,
                etag: ETag(pointer.etag),
            },
        );
    }
    Ok(pointers)
}

/// Atomically rewrite the journal as one line per tile.
fn compact(journal_path: &Path, pointers: &HashMap<TileId, Current>) -> anyhow::Result<()> {
    let mut text = Vec::new();
    for (tile, current) in pointers {
        serde_json::to_writer(
            &mut text,
            &Pointer {
                tile: tile.index(),
                hash: current.hash.to_hex().to_string(),
                etag: current.etag.0.clone(),
            },
        )?;
        text.push(b'\n');
    }
    let temp = journal_path.with_extension(TEMP_EXTENSION);
    fs::write(&temp, text).with_context(|| format!("writing {}", temp.display()))?;
    fs::rename(&temp, journal_path)
        .with_context(|| format!("replacing {}", journal_path.display()))?;
    Ok(())
}

/// Count finished objects across every shard, skipping temp files a crash left behind.
fn count_objects(objects_dir: &Path) -> anyhow::Result<usize> {
    let mut count = 0;
    for shard in fs::read_dir(objects_dir)? {
        for object in fs::read_dir(shard?.path())? {
            let path = object?.path();
            if path.extension().is_none_or(|ext| ext != TEMP_EXTENSION) {
                count += 1;
            }
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn etag(value: &str) -> ETag {
        ETag(value.to_owned())
    }

    #[tokio::test]
    async fn put_then_etag_of_returns_the_latest_etag() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::open(dir.path()).unwrap();
        let tile = TileId::new(1100, 671);

        assert_eq!(store.etag_of(tile).await.unwrap(), None);
        store.put(tile, b"first", etag("\"a\"")).await.unwrap();
        store.put(tile, b"second", etag("\"b\"")).await.unwrap();

        assert_eq!(store.etag_of(tile).await.unwrap(), Some(etag("\"b\"")));
    }

    #[tokio::test]
    async fn identical_bytes_share_one_object() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::open(dir.path()).unwrap();

        store
            .put(TileId::new(0, 0), b"same", etag("1"))
            .await
            .unwrap();
        store
            .put(TileId::new(5, 9), b"same", etag("2"))
            .await
            .unwrap();
        assert_eq!(store.object_count(), 1);

        store
            .put(TileId::new(0, 0), b"other", etag("3"))
            .await
            .unwrap();
        assert_eq!(store.object_count(), 2);
    }

    #[tokio::test]
    async fn objects_are_written_under_their_sharded_hash() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::open(dir.path()).unwrap();

        store
            .put(TileId::new(3, 4), b"pixels", etag("x"))
            .await
            .unwrap();

        let hex = blake3::hash(b"pixels").to_hex();
        let object = dir
            .path()
            .join("objects")
            .join(&hex[..2])
            .join(hex.as_str());
        assert_eq!(fs::read(object).unwrap(), b"pixels");
    }

    #[tokio::test]
    async fn reopen_keeps_etags_and_objects() {
        let dir = tempfile::tempdir().unwrap();
        let tile = TileId::new(7, 8);
        {
            let store = BlobStore::open(dir.path()).unwrap();
            store.put(tile, b"old", etag("old")).await.unwrap();
            store.put(tile, b"new", etag("new")).await.unwrap();
            store
                .put(TileId::new(9, 9), b"new", etag("twin"))
                .await
                .unwrap();
        }

        let store = BlobStore::open(dir.path()).unwrap();
        assert_eq!(store.etag_of(tile).await.unwrap(), Some(etag("new")));
        assert_eq!(
            store.etag_of(TileId::new(9, 9)).await.unwrap(),
            Some(etag("twin"))
        );
        assert_eq!(store.object_count(), 2);
    }

    #[tokio::test]
    async fn reopen_drops_a_torn_final_journal_line() {
        let dir = tempfile::tempdir().unwrap();
        let tile = TileId::new(1, 2);
        {
            let store = BlobStore::open(dir.path()).unwrap();
            store.put(tile, b"kept", etag("kept")).await.unwrap();
        }
        let journal = dir.path().join(JOURNAL_FILE);
        let mut text = fs::read(&journal).unwrap();
        text.extend_from_slice(br#"{"tile":5,"hash":"ab"#);
        fs::write(&journal, text).unwrap();

        let store = BlobStore::open(dir.path()).unwrap();
        assert_eq!(store.etag_of(tile).await.unwrap(), Some(etag("kept")));
        store.put(tile, b"after", etag("after")).await.unwrap();
        drop(store);

        let store = BlobStore::open(dir.path()).unwrap();
        assert_eq!(store.etag_of(tile).await.unwrap(), Some(etag("after")));
    }
}
