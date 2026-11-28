//! In-process metrics for the archive worker.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_secs(10);
const LATENCY_CAPACITY: usize = 4096;

/// A metrics handle. Clones report to the same counters and samples.
#[derive(Clone, Default)]
pub struct Metrics {
    inner: Arc<Mutex<State>>,
}

/// Lifetime counters and measurements from the trailing 10 seconds.
#[derive(Debug)]
pub struct Snapshot {
    /// Named counters since the handle was created.
    pub counters: BTreeMap<String, u64>,
    /// Latency observations per second, averaged over the full window.
    pub rps: f64,
    /// Bytes per second, averaged over the full window.
    pub bytes_per_s: f64,
    /// Nearest-rank median in milliseconds, or zero with no samples.
    pub p50_ms: f64,
    /// Nearest-rank 99th percentile in milliseconds, or zero with no samples.
    pub p99_ms: f64,
}

#[derive(Default)]
struct State {
    counters: BTreeMap<String, u64>,
    requests: VecDeque<Instant>,
    latencies: VecDeque<Duration>,
    byte_events: VecDeque<(Instant, u64)>,
    bytes_in_window: u128,
}

impl State {
    fn expire(&mut self, now: Instant) {
        while self.requests.front().is_some_and(|&at| now - at >= WINDOW) {
            self.requests.pop_front();
        }
        while let Some(&(at, bytes)) = self.byte_events.front() {
            if now - at < WINDOW {
                break;
            }
            self.byte_events.pop_front();
            self.bytes_in_window -= u128::from(bytes);
        }
    }
}

enum Observation {
    Bytes(u64),
    Latency(Duration),
}

impl Metrics {
    /// Start a new, independent set of metrics.
    pub fn new() -> Self {
        Self::default()
    }

    /// Increment a named lifetime counter, saturating at `u64::MAX`.
    pub fn incr(&self, name: &str) {
        let mut state = self.inner.lock().unwrap();
        if let Some(count) = state.counters.get_mut(name) {
            *count = count.saturating_add(1);
        } else {
            state.counters.insert(name.to_owned(), 1);
        }
    }

    /// Record bytes for the throughput rate.
    pub fn add_bytes(&self, n: u64) {
        self.record(Observation::Bytes(n), Instant::now);
    }

    /// Record a request and its latency.
    pub fn observe_latency(&self, d: Duration) {
        self.record(Observation::Latency(d), Instant::now);
    }

    /// Read all metrics together. Percentiles use up to 4096 recent requests.
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot_with_clock(Instant::now)
    }

    fn record(&self, observation: Observation, now: impl FnOnce() -> Instant) {
        let mut state = self.inner.lock().unwrap();
        // Take timestamps under the lock so each queue remains in time order.
        let now = now();
        state.expire(now);
        match observation {
            Observation::Bytes(bytes) => {
                state.byte_events.push_back((now, bytes));
                state.bytes_in_window += u128::from(bytes);
            }
            Observation::Latency(latency) => {
                state.requests.push_back(now);
                if state.latencies.len() == LATENCY_CAPACITY {
                    state.latencies.pop_front();
                }
                state.latencies.push_back(latency);
            }
        }
    }

    fn snapshot_with_clock(&self, now: impl FnOnce() -> Instant) -> Snapshot {
        let (counters, requests, bytes, mut latencies) = {
            let mut state = self.inner.lock().unwrap();
            state.expire(now());
            let requests = state.requests.len();
            // The newest samples correspond to the newest request timestamps.
            let latencies: Vec<_> = state
                .latencies
                .iter()
                .rev()
                .take(requests)
                .copied()
                .collect();
            (
                state.counters.clone(),
                requests,
                state.bytes_in_window,
                latencies,
            )
        };
        latencies.sort_unstable();
        Snapshot {
            counters,
            rps: requests as f64 / WINDOW.as_secs_f64(),
            bytes_per_s: bytes as f64 / WINDOW.as_secs_f64(),
            p50_ms: percentile_ms(&latencies, 50),
            p99_ms: percentile_ms(&latencies, 99),
        }
    }
}

fn percentile_ms(sorted: &[Duration], percent: usize) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = (sorted.len() * percent).div_ceil(100);
    sorted[rank - 1].as_secs_f64() * 1_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clones_sum_concurrent_updates() {
        let metrics = Metrics::new();
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let metrics = metrics.clone();
                scope.spawn(move || {
                    for _ in 0..250 {
                        metrics.incr("hits");
                    }
                    metrics.incr("workers");
                });
            }
        });
        assert_eq!(
            metrics.snapshot().counters,
            BTreeMap::from([("hits".to_owned(), 1000), ("workers".to_owned(), 4)])
        );
    }

    #[test]
    fn percentiles_use_the_newest_samples_without_capping_the_request_rate() {
        let metrics = Metrics::new();
        let now = Instant::now();
        for _ in 0..100 {
            metrics.record(Observation::Latency(Duration::from_secs(1)), || now);
        }
        for micros in (1..=4096).rev() {
            metrics.record(Observation::Latency(Duration::from_micros(micros)), || now);
        }
        let snapshot = metrics.snapshot_with_clock(|| now);
        assert!((snapshot.p50_ms - 2.048).abs() < 0.0001);
        assert!((snapshot.p99_ms - 4.056).abs() < 0.0001);
        assert!((snapshot.rps - 419.6).abs() < 0.001);
    }

    #[test]
    fn rates_and_percentiles_expire_at_the_window_boundary() {
        let metrics = Metrics::new();
        let start = Instant::now();
        let later = start + Duration::from_secs(1);
        metrics.record(Observation::Bytes(200), || start);
        metrics.record(Observation::Latency(Duration::from_millis(50)), || start);
        metrics.record(Observation::Bytes(300), || later);
        metrics.record(Observation::Latency(Duration::from_millis(10)), || later);
        metrics.incr("hits");

        let full = metrics.snapshot_with_clock(|| start + Duration::from_millis(9999));
        assert_eq!((full.rps, full.bytes_per_s, full.p99_ms), (0.2, 50.0, 50.0));

        let partial = metrics.snapshot_with_clock(|| start + Duration::from_secs(10));
        assert_eq!(
            (partial.rps, partial.bytes_per_s, partial.p99_ms),
            (0.1, 30.0, 10.0)
        );

        let empty = metrics.snapshot_with_clock(|| start + Duration::from_secs(11));
        assert_eq!(
            (empty.rps, empty.bytes_per_s, empty.p50_ms, empty.p99_ms),
            (0.0, 0.0, 0.0, 0.0)
        );
        assert_eq!(empty.counters["hits"], 1);
    }
}
