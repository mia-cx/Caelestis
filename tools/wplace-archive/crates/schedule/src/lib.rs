//! **wpa-schedule** — adaptive per-tile polling cadence.
//!
//! Learns each tile's change rate from its poll outcomes, blends it with an
//! [`ActivityModel`] prior, and hands out the tiles most worth polling now.
//! Implements [`Scheduler`].

use std::collections::HashMap;
use std::time::{Duration, Instant};

use wpa_contracts::{Outcome, Scheduler, TileId};

/// The seam a learned activity model plugs into, as a prior for tiles with little history.
pub trait ActivityModel: Send + Sync {
    /// Expected change events per second for `tile` around `now_unix` (seconds since the epoch).
    fn expected_rate(&self, tile: TileId, now_unix: u64) -> f64;
}

/// Cadence bounds and the explore/exploit split.
#[derive(Clone, Debug)]
pub struct SchedulerConfig {
    /// Hard floor: a tile is never polled faster than this.
    pub min_interval: Duration,
    /// Ceiling: even the coldest tile is polled at least this often.
    pub max_interval: Duration,
    /// Cadence for tiles last seen `Empty` (the 404 frontier probe).
    pub refetch_404: Duration,
    /// Share of each budget, `0..=1`, spent on the least-recently-polled due tiles.
    pub explore_fraction: f64,
    /// Wall-clock seconds at the `Instant` the scheduler was created; localizes `now` for the model.
    pub epoch_unix: u64,
}

/// Smoothing factor for the per-poll change EWMA.
const EWMA_ALPHA: f64 = 0.3;
/// Caps the change probability so the Poisson inversion stays finite.
const MAX_CHANGE_PROBABILITY: f64 = 0.99;
/// How many polls of its own history a tile needs before it outweighs the model.
const MODEL_PRIOR_POLLS: f64 = 2.0;

/// What a tile looked like the last time it answered.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Seen {
    Empty,
    Unchanged,
    Painted,
}

struct TileState {
    /// Last successful observation; `None` until the tile first answers.
    last_polled: Option<Instant>,
    next_due: Instant,
    /// The cadence last set for this tile; errors back off from it.
    interval: Duration,
    /// EWMA of "this poll saw a change", i.e. the per-poll change probability.
    ewma_change: f64,
    /// Changes per second implied by `ewma_change` over the last poll gap.
    own_rate: f64,
    /// Polls that contributed to `ewma_change`.
    samples: u32,
    last_outcome: Option<Seen>,
}

/// Polls each tile about as often as it is expected to change.
///
/// Every tile [`next_due`](Scheduler::next_due) returns is leased: it is not offered again
/// until [`record`](Scheduler::record) reports it (`Outcome::Err` included), or
/// `max_interval` passes without a report.
pub struct AdaptiveScheduler<A: ActivityModel> {
    model: A,
    config: SchedulerConfig,
    created: Instant,
    tiles: HashMap<TileId, TileState>,
}

impl<A: ActivityModel> AdaptiveScheduler<A> {
    /// `tiles` seeds the working set (e.g. the known-active bounding region); every seed is
    /// due immediately. Tiles recorded later join the set.
    pub fn new(model: A, config: SchedulerConfig, tiles: impl IntoIterator<Item = TileId>) -> Self {
        let created = Instant::now();
        let tiles = tiles
            .into_iter()
            .map(|tile| (tile, TileState::seed(created, config.min_interval)))
            .collect();
        Self {
            model,
            config,
            created,
            tiles,
        }
    }

    /// When `tile` is next due, if it is in the working set.
    pub fn due_at(&self, tile: TileId) -> Option<Instant> {
        self.tiles.get(&tile).map(|state| state.next_due)
    }

    fn unix(&self, at: Instant) -> u64 {
        self.config.epoch_unix + at.saturating_duration_since(self.created).as_secs()
    }

    /// Expected changes per second: the model prior, giving way to the tile's own history.
    fn rate(&self, tile: TileId, state: &TileState, now_unix: u64) -> f64 {
        let samples = f64::from(state.samples);
        let own_weight = samples / (samples + MODEL_PRIOR_POLLS);
        own_weight * state.own_rate + (1.0 - own_weight) * self.model.expected_rate(tile, now_unix)
    }

    /// Expected time until the next change, clamped to the cadence bounds.
    fn interval(&self, tile: TileId, state: &TileState, now_unix: u64) -> Duration {
        if state.last_outcome == Some(Seen::Empty) {
            return self.config.refetch_404;
        }
        let rate = self.rate(tile, state, now_unix);
        if rate <= 0.0 || rate.is_nan() {
            return self.config.max_interval;
        }
        let (min, max) = (self.config.min_interval, self.config.max_interval);
        Duration::from_secs_f64((1.0 / rate).clamp(min.as_secs_f64(), max.as_secs_f64()))
    }
}

impl TileState {
    fn seed(now: Instant, interval: Duration) -> Self {
        Self {
            last_polled: None,
            next_due: now,
            interval,
            ewma_change: 0.0,
            own_rate: 0.0,
            samples: 0,
            last_outcome: None,
        }
    }

    /// Folds one observation into the change estimate. The first observation has no
    /// earlier poll to attribute a change to, so it only sets the baseline.
    fn observe(&mut self, seen: Seen, at: Instant, min_gap: Duration) {
        if let Some(last) = self.last_polled {
            let changed = if seen == Seen::Painted { 1.0 } else { 0.0 };
            self.ewma_change = if self.samples == 0 {
                changed
            } else {
                self.ewma_change + EWMA_ALPHA * (changed - self.ewma_change)
            };
            self.samples = self.samples.saturating_add(1);
            // Invert P(change in gap) = 1 - e^(-rate * gap) for a Poisson change process.
            let gap = at
                .saturating_duration_since(last)
                .max(min_gap)
                .as_secs_f64();
            let probability = self.ewma_change.min(MAX_CHANGE_PROBABILITY);
            self.own_rate = -(1.0 - probability).ln() / gap;
        }
        self.last_polled = Some(at);
        self.last_outcome = Some(seen);
    }
}

/// Moves the `k` smallest items under `cmp` to the front of `items`, sorted.
fn take_smallest<T>(items: &mut [T], k: usize, cmp: impl Fn(&T, &T) -> std::cmp::Ordering) {
    let k = k.min(items.len());
    if k == 0 {
        return;
    }
    if k < items.len() {
        items.select_nth_unstable_by(k - 1, &cmp);
    }
    items[..k].sort_unstable_by(&cmp);
}

struct Candidate {
    tile: TileId,
    rate: f64,
    last_polled: Option<Instant>,
}

impl<A: ActivityModel> Scheduler for AdaptiveScheduler<A> {
    fn next_due(&mut self, now: Instant, budget: usize) -> Vec<TileId> {
        let now_unix = self.unix(now);
        let mut due: Vec<Candidate> = self
            .tiles
            .iter()
            .filter(|(_, state)| state.next_due <= now)
            .map(|(&tile, state)| Candidate {
                tile,
                rate: self.rate(tile, state, now_unix),
                last_polled: state.last_polled,
            })
            .collect();

        let explore = (budget as f64 * self.config.explore_fraction.clamp(0.0, 1.0)).round();
        let exploit = (budget - (explore as usize).min(budget)).min(due.len());

        // Hottest first, then the stalest of the rest; tile index breaks ties deterministically.
        take_smallest(&mut due, exploit, |a, b| {
            b.rate
                .total_cmp(&a.rate)
                .then(a.tile.index().cmp(&b.tile.index()))
        });
        take_smallest(&mut due[exploit..], budget - exploit, |a, b| {
            (a.last_polled, a.tile.index()).cmp(&(b.last_polled, b.tile.index()))
        });
        due.truncate(budget);

        let lease = now + self.config.max_interval;
        due.into_iter()
            .map(|Candidate { tile, .. }| {
                if let Some(state) = self.tiles.get_mut(&tile) {
                    state.next_due = lease;
                }
                tile
            })
            .collect()
    }

    fn record(&mut self, tile: TileId, outcome: &Outcome, at: Instant) {
        let config = &self.config;
        let mut state = self
            .tiles
            .remove(&tile)
            .unwrap_or_else(|| TileState::seed(at, config.min_interval));

        let seen = match outcome {
            Outcome::Empty => Seen::Empty,
            Outcome::Unchanged => Seen::Unchanged,
            Outcome::Painted { .. } => Seen::Painted,
            Outcome::Err(_) => {
                // Learn nothing; back off so a failing tile is not hammered.
                state.interval =
                    (state.interval * 2).clamp(config.min_interval, config.max_interval);
                state.next_due = at + state.interval;
                self.tiles.insert(tile, state);
                return;
            }
        };
        state.observe(seen, at, config.min_interval);
        state.interval = self.interval(tile, &state, self.unix(at));
        state.next_due = at + state.interval;
        self.tiles.insert(tile, state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wpa_contracts::ETag;

    struct Constant(f64);

    impl ActivityModel for Constant {
        fn expected_rate(&self, _: TileId, _: u64) -> f64 {
            self.0
        }
    }

    const MIN: Duration = Duration::from_secs(5);
    const MAX: Duration = Duration::from_secs(24 * 60 * 60);
    const REFETCH_404: Duration = Duration::from_secs(10 * 60);
    /// One change an hour.
    const HOURLY: f64 = 1.0 / 3600.0;

    fn config(explore_fraction: f64) -> SchedulerConfig {
        SchedulerConfig {
            min_interval: MIN,
            max_interval: MAX,
            refetch_404: REFETCH_404,
            explore_fraction,
            epoch_unix: 1_700_000_000,
        }
    }

    fn painted() -> Outcome {
        Outcome::Painted {
            bytes: vec![1],
            etag: ETag("v".into()),
        }
    }

    fn tiles(n: u16) -> Vec<TileId> {
        (0..n).map(|x| TileId::new(x, 0)).collect()
    }

    /// Polls `tile` exactly when due, `polls` times, returning the final interval.
    fn poll_when_due(
        scheduler: &mut AdaptiveScheduler<Constant>,
        tile: TileId,
        outcome: &Outcome,
        polls: usize,
    ) -> Duration {
        let mut at = Instant::now();
        let mut interval = Duration::ZERO;
        for _ in 0..polls {
            scheduler.record(tile, outcome, at);
            let due = scheduler.due_at(tile).unwrap();
            interval = due - at;
            at = due;
        }
        interval
    }

    #[test]
    fn constantly_painted_tile_converges_to_min_interval() {
        let tile = TileId::new(1, 1);
        let mut scheduler = AdaptiveScheduler::new(Constant(HOURLY), config(0.0), [tile]);
        assert_eq!(poll_when_due(&mut scheduler, tile, &painted(), 20), MIN);
    }

    #[test]
    fn unchanged_tile_lengthens_to_max_interval() {
        let tile = TileId::new(1, 1);
        let mut scheduler = AdaptiveScheduler::new(Constant(HOURLY), config(0.0), [tile]);
        let early = poll_when_due(&mut scheduler, tile, &Outcome::Unchanged, 3);
        assert!(
            early > Duration::from_secs(3600) && early < MAX,
            "{early:?}"
        );
        assert_eq!(
            poll_when_due(&mut scheduler, tile, &Outcome::Unchanged, 100),
            MAX
        );
    }

    #[test]
    fn empty_tile_waits_exactly_refetch_404() {
        let tile = TileId::new(1, 1);
        let mut scheduler = AdaptiveScheduler::new(Constant(1.0), config(0.0), [tile]);
        let at = Instant::now();
        scheduler.record(tile, &Outcome::Empty, at);

        let just_before = at + REFETCH_404 - Duration::from_millis(1);
        assert!(scheduler.next_due(just_before, 10).is_empty());
        assert_eq!(scheduler.next_due(at + REFETCH_404, 10), [tile]);
    }

    #[test]
    fn next_due_respects_budget_and_never_repeats_an_unrecorded_tile() {
        let seeds = tiles(10);
        let mut scheduler = AdaptiveScheduler::new(Constant(HOURLY), config(0.2), seeds.clone());
        let now = Instant::now();

        let first = scheduler.next_due(now, 3);
        let rest = scheduler.next_due(now, 100);
        assert_eq!(first.len(), 3);
        assert_eq!(rest.len(), 7);
        assert!(rest.iter().all(|tile| !first.contains(tile)));
        assert!(scheduler.next_due(now + MIN, 100).is_empty());
    }

    /// Three due tiles: `hot` (changes every poll), `warm` (recently polled, hotter than
    /// the prior), and `cold` (never polled). Budget is two.
    fn explore_scenario(explore_fraction: f64) -> Vec<TileId> {
        let [hot, warm, cold] = [TileId::new(0, 0), TileId::new(1, 0), TileId::new(2, 0)];
        let mut scheduler = AdaptiveScheduler::new(
            Constant(1.0 / 600.0),
            config(explore_fraction),
            [hot, warm, cold],
        );
        let t0 = Instant::now();
        scheduler.record(hot, &painted(), t0);
        scheduler.record(hot, &painted(), t0 + MIN);
        scheduler.record(warm, &Outcome::Unchanged, t0);
        scheduler.record(warm, &painted(), t0 + Duration::from_secs(60));

        let now = t0 + Duration::from_secs(200);
        scheduler.next_due(now, 2)
    }

    #[test]
    fn explore_reserve_surfaces_a_stale_cold_tile() {
        let [hot, warm, cold] = [TileId::new(0, 0), TileId::new(1, 0), TileId::new(2, 0)];
        assert_eq!(explore_scenario(0.0), [hot, warm]);
        assert_eq!(explore_scenario(0.5), [hot, cold]);
    }

    #[test]
    fn errors_back_off_from_the_current_cadence() {
        let tile = TileId::new(1, 1);
        let mut scheduler = AdaptiveScheduler::new(Constant(HOURLY), config(0.0), [tile]);
        let at = Instant::now();
        scheduler.record(tile, &Outcome::Err("timeout".into()), at);
        assert_eq!(scheduler.due_at(tile), Some(at + MIN * 2));

        scheduler.record(tile, &Outcome::Empty, at);
        scheduler.record(tile, &Outcome::Err("timeout".into()), at);
        assert_eq!(scheduler.due_at(tile), Some(at + REFETCH_404 * 2));
    }
}
