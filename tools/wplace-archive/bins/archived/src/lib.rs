//! **wplace-archive** orchestration — wire the crates into a running archiver.
//!
//! The canvas is polled like a variable-framerate video: [`baseline_sweep`] takes the first
//! keyframe of a tile set, then [`run`] loops [`run_tick`], asking the [`Scheduler`] which tiles
//! are due, fetching each over a [`LanePool`] lane, storing changed tiles in a [`TileStore`] and
//! feeding every outcome back to the scheduler and the activity model.
//!
//! The functions are generic over the `wpa-contracts` traits, so the binary runs them against the
//! real HTTP fetcher and IPv6 lanes while tests run them against a local mock over loopback.

use std::net::IpAddr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use futures::stream::{self, StreamExt};
use wpa_contracts::{Fetcher, Lane, LanePool, Outcome, Scheduler, TileId, TileStore};
use wpa_schedule::ActivityModel;
use wpa_temporal::TemporalModel;

/// Adapts a shared [`TemporalModel`] to the scheduler's [`ActivityModel`] seam.
///
/// The model lives behind a shared lock so the orchestrator can keep recording changes into it
/// while the scheduler reads it as a prior.
pub struct TemporalPrior(pub std::sync::Arc<Mutex<TemporalModel>>);

impl ActivityModel for TemporalPrior {
    fn expected_rate(&self, tile: TileId, now_unix: u64) -> f64 {
        self.0.lock().expect("temporal model poisoned").expected_rate(tile, now_unix)
    }
}

/// A fixed set of source addresses handed out round-robin, for a single-network run or loopback
/// tests. Real IPv6 runs use `wpa_lanes::RoundRobinLanePool`, which also paces each address.
pub struct FixedLanePool {
    addresses: Vec<IpAddr>,
    next: AtomicUsize,
}

impl FixedLanePool {
    /// Build a pool over `addresses`; panics if empty.
    pub fn new(addresses: Vec<IpAddr>) -> Self {
        assert!(!addresses.is_empty(), "a lane pool needs at least one address");
        Self { addresses, next: AtomicUsize::new(0) }
    }
}

impl LanePool for FixedLanePool {
    async fn acquire(&self) -> Lane {
        let i = self.next.fetch_add(1, Ordering::Relaxed) % self.addresses.len();
        Lane { source: self.addresses[i] }
    }
}

/// How much work each tick does.
#[derive(Clone, Copy, Debug)]
pub struct Settings {
    /// Tiles pulled from the scheduler per tick.
    pub budget: usize,
    /// Requests allowed in flight at once.
    pub concurrency: usize,
}

/// Tallies of the outcomes seen over a sweep or a tick.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub painted: u64,
    pub unchanged: u64,
    pub empty: u64,
    pub errors: u64,
}

impl Stats {
    fn record(&mut self, outcome: &Outcome) {
        match outcome {
            Outcome::Painted { .. } => self.painted += 1,
            Outcome::Unchanged => self.unchanged += 1,
            Outcome::Empty => self.empty += 1,
            Outcome::Err(_) => self.errors += 1,
        }
    }
}

/// Fetch one tile over a freshly acquired lane, storing it and noting its change when painted.
/// The store's current validator is sent as the conditional-GET `If-None-Match`.
async fn visit<L, F, St>(
    lanes: &L,
    fetcher: &F,
    store: &St,
    temporal: &Mutex<TemporalModel>,
    tile: TileId,
    now_unix: u64,
) -> Outcome
where
    L: LanePool,
    F: Fetcher,
    St: TileStore,
{
    let lane = lanes.acquire().await;
    let known = store.etag_of(tile).await.unwrap_or(None);
    let outcome = fetcher.fetch(tile, known, &lane).await;
    if let Outcome::Painted { bytes, etag } = &outcome {
        if let Err(error) = store.put(tile, bytes, etag.clone()).await {
            return Outcome::Err(format!("store {tile:?}: {error}"));
        }
        temporal.lock().expect("temporal model poisoned").record(tile, now_unix);
    }
    outcome
}

/// Take one keyframe of every tile in `tiles`, bounded to `concurrency` in-flight requests.
/// Used for the initial snapshot; it does not touch the scheduler.
pub async fn baseline_sweep<L, F, St>(
    lanes: &L,
    fetcher: &F,
    store: &St,
    temporal: &Mutex<TemporalModel>,
    tiles: impl IntoIterator<Item = TileId>,
    now_unix: u64,
    concurrency: usize,
) -> Stats
where
    L: LanePool,
    F: Fetcher,
    St: TileStore,
{
    stream::iter(tiles)
        .map(|tile| visit(lanes, fetcher, store, temporal, tile, now_unix))
        .buffer_unordered(concurrency.max(1))
        .fold(Stats::default(), |mut stats, outcome| async move {
            stats.record(&outcome);
            stats
        })
        .await
}

/// Poll the tiles the scheduler says are due, fetch them concurrently, and feed every outcome
/// back to the scheduler so cadence adapts. Returns what the tick saw.
#[allow(clippy::too_many_arguments)]
pub async fn run_tick<L, F, St, C>(
    lanes: &L,
    fetcher: &F,
    store: &St,
    scheduler: &mut C,
    temporal: &Mutex<TemporalModel>,
    now: Instant,
    now_unix: u64,
    settings: Settings,
) -> Stats
where
    L: LanePool,
    F: Fetcher,
    St: TileStore,
    C: Scheduler,
{
    let due = scheduler.next_due(now, settings.budget);
    let outcomes: Vec<(TileId, Outcome)> = stream::iter(due)
        .map(|tile| async move {
            (tile, visit(lanes, fetcher, store, temporal, tile, now_unix).await)
        })
        .buffer_unordered(settings.concurrency.max(1))
        .collect()
        .await;

    let mut stats = Stats::default();
    for (tile, outcome) in &outcomes {
        stats.record(outcome);
        scheduler.record(*tile, outcome, Instant::now());
    }
    stats
}

/// Loop [`run_tick`] every `tick` until `stop` is set, accumulating stats. Wall-clock time for the
/// activity model advances from `epoch_unix` by the elapsed real time since the loop began.
#[allow(clippy::too_many_arguments)]
pub async fn run<L, F, St, C>(
    lanes: &L,
    fetcher: &F,
    store: &St,
    scheduler: &mut C,
    temporal: &Mutex<TemporalModel>,
    settings: Settings,
    tick: Duration,
    epoch_unix: u64,
    stop: &AtomicBool,
) -> Stats
where
    L: LanePool,
    F: Fetcher,
    St: TileStore,
    C: Scheduler,
{
    let started = Instant::now();
    let mut total = Stats::default();
    while !stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        let now_unix = epoch_unix + now.saturating_duration_since(started).as_secs();
        let stats = run_tick(lanes, fetcher, store, scheduler, temporal, now, now_unix, settings).await;
        total.painted += stats.painted;
        total.unchanged += stats.unchanged;
        total.empty += stats.empty;
        total.errors += stats.errors;
        tokio::time::sleep(tick).await;
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;
    use std::sync::Arc;

    use axum::Router;
    use axum::extract::Path;
    use axum::http::{HeaderMap, StatusCode, header};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use wpa_fetch::HttpFetcher;
    use wpa_schedule::{AdaptiveScheduler, SchedulerConfig};
    use wpa_store::BlobStore;

    const TAG: &str = r#""rev-1""#;
    const PNG: &[u8] = b"\x89PNG painted tile";

    /// Tile 1/1 is painted (and revalidates to 304 with its ETag); every other tile is 404.
    async fn tile(Path((x, y)): Path<(u16, String)>, headers: HeaderMap) -> impl IntoResponse {
        match (x, y.as_str()) {
            (1, "1.png") if headers.get(header::IF_NONE_MATCH).is_some_and(|v| v == TAG) => {
                StatusCode::NOT_MODIFIED.into_response()
            }
            (1, "1.png") => ([(header::ETAG, TAG)], PNG).into_response(),
            _ => StatusCode::NOT_FOUND.into_response(),
        }
    }

    async fn mock() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().route("/files/s0/tiles/{x}/{y}", get(tile));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        base
    }

    fn parts(base: String) -> (FixedLanePool, HttpFetcher, Arc<Mutex<TemporalModel>>) {
        let lanes = FixedLanePool::new(vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]);
        let fetcher =
            HttpFetcher::new(base, "/files/s0/tiles/{x}/{y}.png".into(), "wpa-test".into()).unwrap();
        (lanes, fetcher, Arc::new(Mutex::new(TemporalModel::new())))
    }

    /// Baseline sweep stores only the painted tile with its ETag; a second sweep of it
    /// revalidates to Unchanged because the store replays that ETag as If-None-Match.
    #[tokio::test]
    async fn baseline_sweep_stores_painted_then_revalidates() {
        let (lanes, fetcher, temporal) = parts(mock().await);
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::open(dir.path()).unwrap();
        let tiles = [TileId::new(1, 1), TileId::new(2, 2), TileId::new(3, 3)];

        let first = baseline_sweep(&lanes, &fetcher, &store, &temporal, tiles, 1_700_000_000, 4).await;
        assert_eq!(first, Stats { painted: 1, empty: 2, ..Stats::default() });
        assert_eq!(store.etag_of(TileId::new(1, 1)).await.unwrap(), Some(wpa_contracts::ETag(TAG.into())));
        assert_eq!(store.etag_of(TileId::new(2, 2)).await.unwrap(), None);
        assert_eq!(store.object_count(), 1);

        let again = baseline_sweep(&lanes, &fetcher, &store, &temporal, [TileId::new(1, 1)], 1_700_000_700, 4).await;
        assert_eq!(again, Stats { unchanged: 1, ..Stats::default() }, "stored ETag should revalidate to 304");
        assert_eq!(store.object_count(), 1);
    }

    /// End-to-end scheduler-driven tick: next_due -> lane -> fetch -> classify -> store, and the
    /// outcomes feed back so the tile is no longer immediately due.
    #[tokio::test]
    async fn tick_runs_the_full_slice() {
        let (lanes, fetcher, temporal) = parts(mock().await);
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::open(dir.path()).unwrap();
        let seeds = [TileId::new(1, 1), TileId::new(5, 5)];
        let config = SchedulerConfig {
            min_interval: Duration::from_secs(5),
            max_interval: Duration::from_secs(86_400),
            refetch_404: Duration::from_secs(600),
            explore_fraction: 0.0,
            epoch_unix: 1_700_000_000,
        };
        let mut scheduler = AdaptiveScheduler::new(TemporalPrior(temporal.clone()), config, seeds);
        let settings = Settings { budget: 10, concurrency: 4 };

        let now = Instant::now();
        let first = run_tick(&lanes, &fetcher, &store, &mut scheduler, &temporal, now, 1_700_000_000, settings).await;
        assert_eq!(first, Stats { painted: 1, empty: 1, ..Stats::default() });
        assert_eq!(store.etag_of(TileId::new(1, 1)).await.unwrap(), Some(wpa_contracts::ETag(TAG.into())));
        assert_eq!(store.object_count(), 1);

        // Both tiles were just polled, so the next immediate tick has nothing due.
        let idle = run_tick(&lanes, &fetcher, &store, &mut scheduler, &temporal, now, 1_700_000_000, settings).await;
        assert_eq!(idle, Stats::default(), "leased tiles are not re-offered right away");
    }
}
