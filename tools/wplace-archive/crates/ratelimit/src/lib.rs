//! Asynchronous token buckets with per-key backoff and a shared ceiling.

use std::{
    collections::HashMap,
    hash::Hash,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::{Instant, sleep_until};

/// Limits permits per key and across all keys. Clones share buckets and penalties.
#[derive(Clone)]
pub struct RateLimiter<K: Eq + Hash + Clone + Send + 'static> {
    state: Arc<Mutex<State<K>>>,
    per_key_rate: f64,
    global_rate: f64,
    capacity: f64,
}

struct State<K> {
    global: Bucket,
    keys: HashMap<K, Bucket>,
}

// Recheck long waits before they exceed the timer or instant's range.
const MAX_SLEEP: Duration = Duration::from_secs(24 * 60 * 60);

impl<K: Eq + Hash + Clone + Send + 'static> RateLimiter<K> {
    /// `per_key_rate` and `global_rate` are permits per second. Each bucket starts
    /// full and holds up to `burst` permits.
    ///
    /// # Panics
    ///
    /// Panics if either rate is not positive and finite, or if `burst` is zero.
    pub fn new(per_key_rate: f64, global_rate: f64, burst: u32) -> Self {
        assert!(
            per_key_rate.is_finite() && per_key_rate > 0.0,
            "per-key rate must be positive and finite"
        );
        assert!(
            global_rate.is_finite() && global_rate > 0.0,
            "global rate must be positive and finite"
        );
        assert!(burst > 0, "burst must be positive");

        let capacity = f64::from(burst);
        Self {
            state: Arc::new(Mutex::new(State {
                global: Bucket::full(capacity, Instant::now()),
                keys: HashMap::new(),
            })),
            per_key_rate,
            global_rate,
            capacity,
        }
    }

    /// Waits for a permit from both the key's bucket and the global bucket.
    pub async fn acquire(&self, key: K) {
        loop {
            let wake_at = {
                let mut state = self.state.lock().expect("rate limiter state poisoned");
                let now = Instant::now();
                let State { global, keys } = &mut *state;
                let bucket = keys
                    .entry(key.clone())
                    .or_insert_with(|| Bucket::full(self.capacity, now));
                bucket.refill(now, self.per_key_rate, self.capacity);
                global.refill(now, self.global_rate, self.capacity);

                let wait = bucket
                    .wait_for_permit(self.per_key_rate)
                    .max(global.wait_for_permit(self.global_rate));
                // Charge both buckets together. Waiting or cancellation spends neither permit.
                if wait.is_zero() {
                    bucket.permits -= 1.0;
                    global.permits -= 1.0;
                    return;
                }
                now + wait.min(MAX_SLEEP)
            };
            sleep_until(wake_at).await;
        }
    }

    /// Holds acquires for this key for `dur`. Never shortens an existing penalty.
    pub fn penalize(&self, key: K, dur: Duration) {
        let mut state = self.state.lock().expect("rate limiter state poisoned");
        let now = Instant::now();
        let bucket = state
            .keys
            .entry(key)
            .or_insert_with(|| Bucket::full(self.capacity, now));
        bucket.refill(now, self.per_key_rate, self.capacity);
        bucket.backoff = bucket.backoff.max(dur);
    }
}

struct Bucket {
    permits: f64,
    updated_at: Instant,
    backoff: Duration,
}

impl Bucket {
    fn full(capacity: f64, now: Instant) -> Self {
        Self {
            permits: capacity,
            updated_at: now,
            backoff: Duration::ZERO,
        }
    }

    fn refill(&mut self, now: Instant, rate: f64, capacity: f64) {
        let elapsed = now - self.updated_at;
        self.permits = (self.permits + elapsed.as_secs_f64() * rate).min(capacity);
        self.backoff = self.backoff.saturating_sub(elapsed);
        self.updated_at = now;
    }

    fn wait_for_permit(&self, rate: f64) -> Duration {
        if self.permits >= 1.0 {
            return self.backoff;
        }

        let refill =
            Duration::try_from_secs_f64((1.0 - self.permits) / rate).unwrap_or(Duration::MAX);
        // Even a sub-nanosecond deficit requires releasing the lock and waiting.
        refill.max(Duration::from_nanos(1)).max(self.backoff)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        pin::pin,
        task::{Context, Waker},
    };
    use tokio::{
        task::JoinSet,
        time::{advance, pause},
    };

    #[tokio::test]
    async fn one_key_refills_at_its_own_rate_after_the_initial_burst() {
        pause();
        let limiter = RateLimiter::new(4.0, 100.0, 2);
        let start = Instant::now();

        for _ in 0..2 {
            limiter.acquire("key").await;
        }
        assert_eq!(start.elapsed(), Duration::ZERO);

        for _ in 0..8 {
            limiter.acquire("key").await;
        }

        assert!((Duration::from_secs(2)..=Duration::from_millis(2_010)).contains(&start.elapsed()));
    }

    #[tokio::test]
    async fn concurrent_acquires_on_fresh_keys_share_the_global_rate() {
        pause();
        let limiter = RateLimiter::new(100.0, 2.0, 2);
        let start = Instant::now();
        let mut tasks = JoinSet::new();

        for key in 0..8 {
            let limiter = limiter.clone();
            tasks.spawn(async move { limiter.acquire(key).await });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }

        assert!((Duration::from_secs(3)..=Duration::from_millis(3_010)).contains(&start.elapsed()));
    }

    #[tokio::test]
    async fn a_penalty_delays_only_its_key() {
        pause();
        let limiter = RateLimiter::new(10.0, 10.0, 1);
        let start = Instant::now();
        limiter.penalize("held", Duration::from_secs(3));
        let mut acquire = pin!(limiter.acquire("held"));
        let mut cx = Context::from_waker(Waker::noop());

        assert!(acquire.as_mut().poll(&mut cx).is_pending());
        limiter.acquire("free").await;
        assert_eq!(start.elapsed(), Duration::ZERO);

        advance(Duration::from_secs(2)).await;
        assert!(acquire.as_mut().poll(&mut cx).is_pending());
        advance(Duration::from_secs(1)).await;
        acquire.await;

        assert!((Duration::from_secs(3)..=Duration::from_millis(3_001)).contains(&start.elapsed()));
    }
}
