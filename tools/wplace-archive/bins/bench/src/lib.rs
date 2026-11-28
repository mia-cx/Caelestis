//! Run a concurrency ramp against a local HTTP test server.

use std::{
    error::Error,
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use reqwest::{Client, Url, redirect::Policy};
use tokio::{
    task::JoinSet,
    time::{Instant, sleep_until},
};
use wpa_metrics::Metrics;

const TILE_SIDE: usize = 2048;
const MINIMUM_RATE_GAIN: f64 = 0.05;
type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

/// A load generator that shares one HTTP connection pool across levels.
#[derive(Clone)]
pub struct Benchmark {
    client: Client,
    target: Arc<TileTarget>,
}

struct TileTarget {
    base: String,
    path_template: String,
    tiles: usize,
}

/// Results from requests completed within one level's measurement window.
#[derive(Debug)]
pub struct LevelReport {
    /// Number of concurrent workers.
    pub concurrency: usize,
    /// Completed requests per second, including failures.
    pub requests_per_second: f64,
    /// Median latency in milliseconds over the most recent samples.
    pub p50_ms: f64,
    /// 99th-percentile latency in milliseconds over the most recent samples.
    pub p99_ms: f64,
    /// Requests with a non-2xx response or a transport/body error.
    pub errors: u64,
}

impl Benchmark {
    /// Create a benchmark for a loopback URL with a slash-prefixed path template.
    pub fn new(
        base_url: Url,
        path_template: String,
        tiles: usize,
        user_agent: Option<&str>,
    ) -> Result<Self> {
        let loopback = base_url.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if !loopback || !matches!(base_url.scheme(), "http" | "https") {
            return Err(invalid_input(
                "base URL must use HTTP(S) on localhost or a loopback IP",
            ));
        }
        if !base_url.username().is_empty()
            || base_url.password().is_some()
            || base_url.query().is_some()
            || base_url.fragment().is_some()
        {
            return Err(invalid_input(
                "base URL cannot contain credentials, a query, or a fragment",
            ));
        }
        if !path_template.starts_with('/') {
            return Err(invalid_input("path template must start with /"));
        }
        if !(1..=TILE_SIDE * TILE_SIDE).contains(&tiles) {
            return Err(invalid_input(
                "tile count must be positive and fit the 2048 by 2048 grid",
            ));
        }

        // Keep loopback traffic local even with a hosts override, proxy, or redirect.
        let localhost = [
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            SocketAddr::from((Ipv6Addr::LOCALHOST, 0)),
        ];
        let mut client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .resolve_to_addrs("localhost", &localhost);
        if let Some(user_agent) = user_agent {
            client = client.user_agent(user_agent);
        }
        Ok(Self {
            client: client.build()?,
            target: Arc::new(TileTarget {
                base: base_url.as_str().trim_end_matches('/').to_owned(),
                path_template,
                tiles,
            }),
        })
    }

    /// Report each completed level. Return true if throughput reaches a plateau.
    pub async fn run(
        &self,
        levels: &[usize],
        per_level: Duration,
        mut report: impl FnMut(LevelReport),
    ) -> Result<bool> {
        if levels.first().is_none_or(|&n| n == 0)
            || levels.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err(invalid_input(
                "levels must be positive and strictly increasing",
            ));
        }
        if per_level.is_zero() {
            return Err(invalid_input("time per level must be positive"));
        }

        let mut previous = None;
        for &concurrency in levels {
            let level = self.run_level(concurrency, per_level).await?;
            let rate = level.requests_per_second;
            report(level);
            if previous.is_some_and(|last| rate < last * (1.0 + MINIMUM_RATE_GAIN) || rate == 0.0) {
                return Ok(true);
            }
            previous = Some(rate);
        }
        Ok(false)
    }

    async fn run_level(&self, concurrency: usize, per_level: Duration) -> Result<LevelReport> {
        let mut workers = JoinSet::new();
        let next_tile = Arc::new(AtomicUsize::new(0));
        let metrics = Metrics::new();
        let deadline = Instant::now()
            .checked_add(per_level)
            .ok_or_else(|| invalid_input("time per level is too large"))?;

        for _ in 0..concurrency {
            workers.spawn(
                self.clone()
                    .worker(deadline, next_tile.clone(), metrics.clone()),
            );
        }

        let mut completed = 0;
        let mut errors = 0;
        while let Some(result) = workers.join_next().await {
            let (worker_completed, worker_errors) = result?;
            completed += worker_completed;
            errors += worker_errors;
        }
        let snapshot = metrics.snapshot();
        Ok(LevelReport {
            concurrency,
            requests_per_second: completed as f64 / per_level.as_secs_f64(),
            p50_ms: snapshot.p50_ms,
            p99_ms: snapshot.p99_ms,
            errors,
        })
    }

    async fn worker(
        self,
        deadline: Instant,
        next_tile: Arc<AtomicUsize>,
        metrics: Metrics,
    ) -> (u64, u64) {
        let until_deadline = sleep_until(deadline);
        tokio::pin!(until_deadline);
        let mut completed = 0;
        let mut errors = 0;
        loop {
            let start = Instant::now();
            if start >= deadline {
                break;
            }
            let tile = next_tile.fetch_add(1, Ordering::Relaxed) % self.target.tiles;
            let ok = tokio::select! {
                biased;
                _ = &mut until_deadline => break,
                result = self.get_tile(tile) => matches!(result, Ok(true)),
            };
            let end = Instant::now();
            // A request cut short at the deadline has no complete latency sample.
            if end >= deadline {
                break;
            }
            metrics.observe_latency(end - start);
            completed += 1;
            errors += u64::from(!ok);
        }
        (completed, errors)
    }

    async fn get_tile(&self, tile: usize) -> reqwest::Result<bool> {
        let x = tile % TILE_SIDE;
        let y = (tile / TILE_SIDE) % TILE_SIDE;
        let path = self
            .target
            .path_template
            .replace("{x}", &x.to_string())
            .replace("{y}", &y.to_string());
        let mut response = self
            .client
            .get(format!("{}{path}", self.target.base))
            .send()
            .await?;
        let success = response.status().is_success();
        while response.chunk().await?.is_some() {}
        Ok(success)
    }
}

fn invalid_input(message: &'static str) -> Box<dyn Error + Send + Sync> {
    io::Error::new(io::ErrorKind::InvalidInput, message).into()
}
