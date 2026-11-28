//! In-memory tile metadata with atomic snapshots for resuming an archive run.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result, ensure};
use bincode::Options;
use serde::{Deserialize, Serialize};
use wpa_contracts::{ETag, TileId};

/// The most recent observation for one tile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub etag: Option<ETag>,
    pub size: u64,
    pub status: u16,
    pub seen_unix: u64,
}

// Keep contract types out of the snapshot schema.
#[derive(Serialize, Deserialize)]
struct StoredRecord {
    etag: Option<String>,
    size: u64,
    status: u16,
    seen_unix: u64,
}

type Records = HashMap<(u16, u16), StoredRecord>;

/// A tile index owned by one writer, which can share this handle across threads.
pub struct Index {
    path: PathBuf,
    records: Mutex<Records>,
}

impl Index {
    /// Load the last checkpoint, or start empty if it does not exist.
    /// The parent directory must exist before the first checkpoint.
    pub fn open(path: &Path) -> Result<Self> {
        let path = std::path::absolute(path)?;
        let records = match File::open(&path) {
            Ok(file) => read_snapshot(file)
                .with_context(|| format!("read tile index {}", path.display()))?,
            Err(err) if err.kind() == ErrorKind::NotFound => Records::new(),
            Err(err) => {
                return Err(err).with_context(|| format!("open tile index {}", path.display()));
            }
        };
        Ok(Self {
            path,
            records: Mutex::new(records),
        })
    }

    /// Return a copy of the latest observation for this tile, if known.
    pub fn get(&self, tile: TileId) -> Option<Record> {
        let records = self.records.lock().unwrap();
        let record = records.get(&(tile.x, tile.y))?;
        Some(Record {
            etag: record.etag.clone().map(ETag),
            size: record.size,
            status: record.status,
            seen_unix: record.seen_unix,
        })
    }

    /// Insert or replace a tile's observation in memory.
    pub fn upsert(&self, tile: TileId, rec: Record) {
        self.records.lock().unwrap().insert(
            (tile.x, tile.y),
            StoredRecord {
                etag: rec.etag.map(|tag| tag.0),
                size: rec.size,
                status: rec.status,
                seen_unix: rec.seen_unix,
            },
        );
    }

    /// Atomically replace the on-disk snapshot with the current observations.
    pub fn checkpoint(&self) -> Result<()> {
        // Hold the lock through sync and rename so checkpoints cannot finish out of order.
        let records = self.records.lock().unwrap();
        write_snapshot(&self.path, &records)
            .with_context(|| format!("checkpoint tile index {}", self.path.display()))
    }

    /// Count the distinct tiles with observations in memory.
    pub fn len(&self) -> usize {
        self.records.lock().unwrap().len()
    }

    /// Tell whether the index has any observations in memory.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn read_snapshot(file: File) -> Result<Records> {
    let len = file.metadata()?.len();
    let mut reader = BufReader::new(file);
    let records = bincode::options()
        .with_limit(len)
        .deserialize_from(&mut reader)?;
    ensure!(
        reader.fill_buf()?.is_empty(),
        "trailing bytes in tile index snapshot"
    );
    Ok(records)
}

fn write_snapshot(path: &Path, records: &Records) -> Result<()> {
    #[cfg(unix)]
    let directory = File::open(path.parent().context("snapshot path has no parent")?)?;
    let (temp_path, file) = create_temp(path)?;
    let replace = || -> Result<()> {
        let mut writer = BufWriter::new(file);
        bincode::options().serialize_into(&mut writer, records)?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
        drop(writer);
        fs::rename(&temp_path, path)?;
        Ok(())
    };
    if let Err(err) = replace() {
        // Preserve the original failure if cleanup also fails.
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }
    // The file sync covers the bytes; the directory sync covers the rename.
    #[cfg(unix)]
    directory.sync_all()?;
    Ok(())
}

fn create_temp(path: &Path) -> Result<(PathBuf, File)> {
    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    let name = path.file_name().context("snapshot path has no filename")?;
    loop {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let mut temp_name = name.to_os_string();
        temp_name.push(format!(".{}.{}.tmp", std::process::id(), id));
        let temp_path = path.with_file_name(temp_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => return Ok((temp_path, file)),
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err.into()),
        }
    }
}
