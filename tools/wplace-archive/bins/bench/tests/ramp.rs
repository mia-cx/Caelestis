use std::time::Duration;

use axum::{Router, routing::get};
use tokio::net::TcpListener;
use wpa_bench::Benchmark;

#[tokio::test]
async fn reports_completed_tile_gets_for_one_level() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/tiles/0/0.png", get(|| async { "first tile" }))
        .route("/tiles/1/0.png", get(|| async { "second tile" }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let benchmark = Benchmark::new(
        format!("http://{address}").parse().unwrap(),
        "/tiles/{x}/{y}.png".into(),
        2,
        None,
    )
    .unwrap();

    let mut reports = Vec::new();
    let plateau = benchmark
        .run(&[2], Duration::from_millis(150), |level| {
            reports.push(level)
        })
        .await
        .unwrap();
    assert!(!plateau);
    let [report] = reports.as_slice() else {
        panic!("expected one report, got {reports:?}");
    };
    assert_eq!(report.concurrency, 2);
    assert!(report.requests_per_second > 0.0);
    assert_eq!(report.errors, 0);

    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[test]
fn rejects_a_non_loopback_target_without_contacting_it() {
    let benchmark = Benchmark::new(
        "http://192.0.2.1".parse().unwrap(),
        "/tiles/{x}/{y}.png".into(),
        2,
        None,
    );
    assert!(benchmark.is_err());
}
