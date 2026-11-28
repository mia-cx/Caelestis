use std::{
    fs::{self, FileTimes},
    time::{Duration, UNIX_EPOCH},
};

use axum::Router;
use reqwest::{Client, StatusCode, header};
use tempfile::tempdir;
use tokio::net::TcpListener;

async fn start(router: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    // Each test owns its runtime, which stops the server when the test ends.
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}/files/s0/tiles")
}

#[tokio::test]
async fn serves_tiles_and_honors_the_current_etag() {
    let root = tempdir().unwrap();
    fs::create_dir(root.path().join("12")).unwrap();
    let path = root.path().join("12/34.png");
    fs::write(&path, b"tile bytes").unwrap();
    fs::File::open(&path)
        .unwrap()
        .set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1_700_000_000)))
        .unwrap();
    let base = start(wpa_mock::router(root.path().to_path_buf(), None, None)).await;
    let url = format!("{base}/12/34.png");
    let client = Client::new();

    let response = client.get(&url).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let etag = response.headers()[header::ETAG].clone();
    assert_eq!(etag, "\"6553f100-a\"");
    assert_eq!(
        response.headers()[header::LAST_MODIFIED],
        "Tue, 14 Nov 2023 22:13:20 GMT"
    );
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(response.bytes().await.unwrap(), b"tile bytes".as_slice());

    let response = client
        .get(&url)
        .header(header::IF_NONE_MATCH, etag.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(response.headers()[header::ETAG], etag);
    assert!(response.bytes().await.unwrap().is_empty());

    let response = client
        .get(&url)
        .header(header::IF_NONE_MATCH, "\"stale\"")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.bytes().await.unwrap(), b"tile bytes".as_slice());

    let response = client
        .get(format!("{base}/12/35.png"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(response.text().await.unwrap(), "not found");
}

#[tokio::test]
async fn substitutes_a_sample_for_a_missing_tile() {
    let root = tempdir().unwrap();
    let samples = tempdir().unwrap();
    fs::write(samples.path().join("sample.png"), b"sample bytes").unwrap();
    fs::write(samples.path().join("ignore.txt"), b"not a tile").unwrap();
    fs::create_dir(samples.path().join("ignore.png")).unwrap();
    let base = start(wpa_mock::router(
        root.path().to_path_buf(),
        Some(samples.path().to_path_buf()),
        None,
    ))
    .await;
    let url = format!("{base}/12/34.png");
    let client = Client::new();

    let sample = client.get(&url).send().await.unwrap();
    assert_eq!(sample.status(), StatusCode::OK);
    let etag = sample.headers()[header::ETAG].clone();
    assert_eq!(sample.bytes().await.unwrap(), b"sample bytes".as_slice());

    let response = client
        .get(&url)
        .header(header::IF_NONE_MATCH, etag.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::ETAG], etag);
    assert_eq!(response.bytes().await.unwrap(), b"sample bytes".as_slice());

    let response = client
        .get(format!("{base}/12/35.jpg"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
