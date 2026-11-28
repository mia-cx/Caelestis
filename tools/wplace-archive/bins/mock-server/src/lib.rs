//! A local fixture for tile downloads and conditional GETs.

use std::{
    io,
    path::{Path as FsPath, PathBuf},
    time::{Duration, UNIX_EPOCH},
};

use axum::{
    Router,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use rand::seq::IndexedRandom;
use tokio::{fs, io::AsyncReadExt};

#[derive(Clone)]
struct Options {
    root: PathBuf,
    sample_dir: Option<PathBuf>,
    latency: Option<Duration>,
}

/// Build the fixture router. A sample directory enables fallback for missing tiles.
pub fn router(root: PathBuf, sample_dir: Option<PathBuf>, latency: Option<Duration>) -> Router {
    Router::new()
        .route("/files/s0/tiles/{x}/{file}", get(get_tile))
        .with_state(Options {
            root,
            sample_dir,
            latency,
        })
}

async fn get_tile(
    State(options): State<Options>,
    Path((x, file)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Some(latency) = options.latency {
        tokio::time::sleep(latency).await;
    }

    // Coordinates are decimal path components, never filesystem fragments.
    let decimal = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    if !decimal(&x) || !file.strip_suffix(".png").is_some_and(decimal) {
        return not_found();
    }

    match serve_tile(&options, &x, &file, headers.get(header::IF_NONE_MATCH)).await {
        Ok(response) => response,
        Err(error) if error.kind() == io::ErrorKind::NotFound => not_found(),
        Err(error) => {
            eprintln!("wpa-mock: {x}/{file}: {error}");
            (StatusCode::INTERNAL_SERVER_ERROR, "could not read tile").into_response()
        }
    }
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

async fn serve_tile(
    options: &Options,
    x: &str,
    file: &str,
    if_none_match: Option<&HeaderValue>,
) -> io::Result<Response> {
    let tile = read_tile(&options.root.join(x).join(file), if_none_match).await;
    match (tile, &options.sample_dir) {
        (Err(error), Some(dir)) if error.kind() == io::ErrorKind::NotFound => {
            let sample = pick_sample(dir).await?.ok_or(error)?;
            // A random substitute is not the cached representation of this tile.
            read_tile(&sample, None).await
        }
        (result, _) => result,
    }
}

async fn pick_sample(dir: &FsPath) -> io::Result<Option<PathBuf>> {
    let mut entries = fs::read_dir(dir).await?;
    let mut samples = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "png") && entry.file_type().await?.is_file() {
            samples.push(path);
        }
    }
    Ok(samples.choose(&mut rand::rng()).cloned())
}

async fn read_tile(path: &FsPath, if_none_match: Option<&HeaderValue>) -> io::Result<Response> {
    let mut file = fs::File::open(path).await?;
    let metadata = file.metadata().await?;
    if !metadata.is_file() {
        return Err(io::ErrorKind::NotFound.into());
    }

    let modified = metadata.modified()?;
    let seconds = modified
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?;
    let etag = nginx_etag(seconds.as_secs(), metadata.len());
    let last_modified = httpdate::fmt_http_date(modified);
    let validators = [
        (header::ETAG, etag.as_str()),
        (header::LAST_MODIFIED, &last_modified),
    ];
    if if_none_match.is_some_and(|value| value == etag.as_str()) {
        return Ok((StatusCode::NOT_MODIFIED, validators).into_response());
    }

    let mut body = Vec::new();
    file.read_to_end(&mut body).await?;
    Ok((validators, [(header::CONTENT_TYPE, "image/png")], body).into_response())
}

fn nginx_etag(mtime_secs: u64, size: u64) -> String {
    format!("\"{mtime_secs:x}-{size:x}\"")
}
