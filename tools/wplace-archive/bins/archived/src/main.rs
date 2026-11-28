//! **wplace-archive** — activity-aware incremental archiver.
//!
//! Loads a TOML config, builds the IPv6 lane pool, HTTP fetcher, blob store and adaptive
//! scheduler, then runs the archive loop until Ctrl-C.
//!
//!   wplace-archive [config.toml]   (defaults to ./config.toml)

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use wpa_archive::{Settings, TemporalPrior, run};
use wpa_config::{Config, Spread};
use wpa_contracts::{LanePool, TileId};
use wpa_fetch::HttpFetcher;
use wpa_lanes::{AddressPool, RoundRobinLanePool};
use wpa_schedule::{AdaptiveScheduler, SchedulerConfig};
use wpa_store::BlobStore;
use wpa_temporal::TemporalModel;

/// Cadence ceiling for a tile that never seems to change: poll it at least daily.
const MAX_POLL_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// Share of each budget spent sampling the least-recently-polled tiles.
const EXPLORE_FRACTION: f64 = 0.2;
/// Token-bucket burst per lane.
const LANE_BURST: u32 = 1;
/// Gap between ticks of the incremental loop.
const TICK: Duration = Duration::from_millis(200);

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).expect("clock before 1970").as_secs()
}

fn lane_spread(spread: Spread) -> wpa_lanes::Spread {
    match spread {
        Spread::Per64 => wpa_lanes::Spread::Per64,
        Spread::Flat => wpa_lanes::Spread::Flat,
    }
}

/// Build the IPv6 lane pool from the egress config; its lanes pace themselves per address.
fn build_lanes(config: &Config) -> anyhow::Result<RoundRobinLanePool> {
    let pool = AddressPool::derive(
        config.egress.prefix,
        config.egress.addresses,
        lane_spread(config.egress.spread),
    )?;
    Ok(RoundRobinLanePool::new(
        pool,
        config.egress.per_lane_rate as f64,
        config.politeness.global_max_rate as f64,
        LANE_BURST,
    ))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).unwrap_or_else(|| "config.toml".to_owned());
    let config = wpa_config::load(path.as_ref()).with_context(|| format!("loading {path}"))?;

    let fetcher = HttpFetcher::new(
        config.source.base_url.clone(),
        config.source.path_tmpl.clone(),
        config.politeness.user_agent.clone(),
    )?;
    let store = BlobStore::open(&config.storage.path)
        .with_context(|| format!("opening store at {}", config.storage.path.display()))?;
    let lanes = build_lanes(&config)?;
    let temporal = Arc::new(Mutex::new(TemporalModel::new()));

    let scheduler_config = SchedulerConfig {
        min_interval: config.politeness.min_poll_interval,
        max_interval: MAX_POLL_INTERVAL,
        refetch_404: config.baseline.refetch_404_every,
        explore_fraction: EXPLORE_FRACTION,
        epoch_unix: now_unix(),
    };
    // Seed the whole canvas; the scheduler's 404 frontier cadence keeps empty ocean cheap.
    let mut scheduler =
        AdaptiveScheduler::new(TemporalPrior(temporal.clone()), scheduler_config, TileId::all());

    let settings =
        Settings { budget: config.runtime.fetch_concurrency, concurrency: config.runtime.fetch_concurrency };

    let stop = Arc::new(AtomicBool::new(false));
    let signal_stop = stop.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal_stop.store(true, Ordering::Relaxed);
        }
    });

    let sample = lanes.acquire().await;
    println!(
        "wplace-archive: {} lanes, polling {} from {} — Ctrl-C to stop",
        config.egress.addresses, config.source.base_url, sample.source,
    );
    let stats = run(&lanes, &fetcher, &store, &mut scheduler, &temporal, settings, TICK, now_unix(), &stop).await;
    println!(
        "stopped. painted {}, unchanged {}, empty {}, errors {}",
        stats.painted, stats.unchanged, stats.empty, stats.errors,
    );
    Ok(())
}
