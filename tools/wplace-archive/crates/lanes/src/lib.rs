//! **wpa-lanes** — derive IPv6 source addresses from a local prefix and hand
//! them out as paced egress lanes.
//!
//! [`AddressPool::derive`] turns a prefix into N distinct addresses, spread
//! across /64s when the prefix allows it. [`RoundRobinLanePool`] cycles through
//! them, pacing each address and the pool as a whole. No proxies.
#![allow(async_fn_in_trait)]

use std::{
    net::{IpAddr, Ipv6Addr},
    sync::atomic::{AtomicUsize, Ordering},
};

use anyhow::ensure;
use ipnet::Ipv6Net;
use wpa_contracts::{Lane, LanePool};
use wpa_ratelimit::RateLimiter;

/// Bits in an IPv6 interface identifier: the low half of the address.
const INTERFACE_ID_BITS: u8 = 64;

/// How [`AddressPool::derive`] places addresses inside a prefix.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Spread {
    /// Round-robin across the prefix's /64 subnets, so addresses land in as
    /// many distinct /64s as possible. Same as `Flat` for a /64 or narrower.
    Per64,
    /// Count up through the low host bits of the prefix's first address.
    Flat,
}

/// A fixed set of distinct IPv6 source addresses inside one prefix.
#[derive(Clone, Debug)]
pub struct AddressPool {
    addresses: Vec<Ipv6Addr>,
}

impl AddressPool {
    /// Derive `count` distinct IPv6 addresses from `prefix`.
    ///
    /// - `Flat`: `network | i` for `i` in `1..=count`, skipping the all-zero
    ///   host (the subnet-router anycast address).
    /// - `Per64`: when the prefix is wider than /64, address `i` (from 0) goes
    ///   to subnet `i % subnet_count` with interface id `i / subnet_count + 1`.
    ///   For a /64 or narrower it behaves like `Flat`.
    ///
    /// Errors when `count` is zero or the prefix has too few addresses.
    pub fn derive(prefix: Ipv6Net, count: usize, spread: Spread) -> anyhow::Result<Self> {
        ensure!(count > 0, "an address pool needs at least one address");
        // The prefix's first address: every host bit zero.
        let network = u128::from(prefix.network());
        let wide = prefix.prefix_len() < INTERFACE_ID_BITS;

        let addresses = match spread {
            Spread::Per64 if wide => per_64(network, prefix.prefix_len(), count),
            Spread::Per64 | Spread::Flat => flat(network, prefix, count)?,
        };
        Ok(Self {
            addresses: addresses.into_iter().map(Ipv6Addr::from).collect(),
        })
    }

    /// The derived addresses, in the order lanes hand them out.
    pub fn addresses(&self) -> &[Ipv6Addr] {
        &self.addresses
    }
}

/// `network | i` for `i` in `1..=count`. Host bits of `network` are zero, so
/// the OR is an exact add as long as `count` fits in the host bits.
fn flat(network: u128, prefix: Ipv6Net, count: usize) -> anyhow::Result<Vec<u128>> {
    let host_bits = 128 - u32::from(prefix.prefix_len());
    // Largest host value that stays inside the prefix: 2^host_bits - 1.
    let max_host = u128::MAX.checked_shr(128 - host_bits).unwrap_or(0);
    ensure!(
        count as u128 <= max_host,
        "{prefix} holds {max_host} usable addresses, {count} requested"
    );
    Ok((1..=count as u128).map(|i| network | i).collect())
}

/// Spread `count` addresses round-robin across the /64s of a prefix wider than
/// /64. Address `i` is `network | subnet << 64 | interface_id` with
/// `subnet = i % subnet_count` and `interface_id = i / subnet_count + 1`.
/// Each `i` maps to a unique (subnet, interface id) pair, so all are distinct.
fn per_64(network: u128, prefix_len: u8, count: usize) -> Vec<u128> {
    // 1..=64 subnet bits, so the count is at least 2 and at most 2^64.
    let subnet_bits = u32::from(INTERFACE_ID_BITS - prefix_len);
    let subnet_count = 1u128 << subnet_bits;
    (0..count as u128)
        .map(|i| {
            let subnet = i % subnet_count;
            // At most usize::MAX / 2 + 1, well inside the 64 interface id bits.
            let interface_id = i / subnet_count + 1;
            network | subnet << INTERFACE_ID_BITS | interface_id
        })
        .collect()
}

/// Hands out an [`AddressPool`]'s addresses round-robin, each acquire waiting
/// for both that address's budget and the pool-wide budget.
pub struct RoundRobinLanePool {
    pool: AddressPool,
    next: AtomicUsize,
    limiter: RateLimiter<Ipv6Addr>,
}

impl RoundRobinLanePool {
    /// `per_lane_rate` and `global_rate` are permits/second; every bucket
    /// starts full and holds up to `burst` permits.
    ///
    /// # Panics
    ///
    /// Panics if either rate is not positive and finite, or if `burst` is zero.
    pub fn new(pool: AddressPool, per_lane_rate: f64, global_rate: f64, burst: u32) -> Self {
        Self {
            pool,
            next: AtomicUsize::new(0),
            limiter: RateLimiter::new(per_lane_rate, global_rate, burst),
        }
    }
}

impl LanePool for RoundRobinLanePool {
    async fn acquire(&self) -> Lane {
        let addresses = self.pool.addresses();
        let source = addresses[self.next.fetch_add(1, Ordering::Relaxed) % addresses.len()];
        self.limiter.acquire(source).await;
        Lane {
            source: IpAddr::V6(source),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashSet, time::Duration};
    use tokio::time::{Instant, pause};

    fn net(s: &str) -> Ipv6Net {
        s.parse().unwrap()
    }

    /// The /64 that holds `addr`.
    fn slash_64(addr: Ipv6Addr) -> Ipv6Net {
        Ipv6Net::new(addr, 64).unwrap().trunc()
    }

    #[test]
    fn derives_exactly_count_distinct_addresses_inside_the_prefix() {
        for prefix in [
            "2001:db8::/48",
            "2001:db8:0:100::/56",
            "2001:db8::/64",
            "2001:db8::/120",
        ] {
            let prefix = net(prefix);
            for spread in [Spread::Per64, Spread::Flat] {
                let pool = AddressPool::derive(prefix, 200, spread).unwrap();
                let addresses = pool.addresses();
                assert_eq!(addresses.len(), 200, "{prefix} {spread:?}");
                assert_eq!(addresses.iter().collect::<HashSet<_>>().len(), 200);
                assert!(
                    addresses.iter().all(|a| prefix.contains(a)),
                    "{prefix} {spread:?}"
                );
            }
        }
    }

    #[test]
    fn per_64_over_a_56_fills_every_64_before_reusing_one() {
        let pool = AddressPool::derive(net("2001:db8:0:100::/56"), 300, Spread::Per64).unwrap();
        let first_256: HashSet<_> = pool.addresses()[..256]
            .iter()
            .copied()
            .map(slash_64)
            .collect();
        assert_eq!(first_256.len(), 256);
    }

    #[test]
    fn flat_stays_within_one_64() {
        let pool = AddressPool::derive(net("2001:db8::/64"), 300, Spread::Flat).unwrap();
        let subnets: HashSet<_> = pool.addresses().iter().copied().map(slash_64).collect();
        assert_eq!(subnets.len(), 1);
    }

    #[test]
    fn refuses_more_addresses_than_the_prefix_holds() {
        // A /120 has 255 non-zero host values.
        assert!(AddressPool::derive(net("2001:db8::/120"), 255, Spread::Flat).is_ok());
        assert!(AddressPool::derive(net("2001:db8::/120"), 256, Spread::Flat).is_err());
        assert!(AddressPool::derive(net("2001:db8::1/128"), 1, Spread::Per64).is_err());
        assert!(AddressPool::derive(net("2001:db8::/64"), 0, Spread::Flat).is_err());
    }

    #[tokio::test]
    async fn acquire_cycles_through_addresses_at_the_per_lane_rate() {
        pause();
        let pool = AddressPool::derive(net("2001:db8::/56"), 3, Spread::Per64).unwrap();
        let expected: Vec<IpAddr> = pool.addresses().iter().map(|&a| IpAddr::V6(a)).collect();
        // The global bucket shares the burst of 1, so each acquire after the first
        // waits 1 ms for it; that adds at most a few ms over the per-lane pacing.
        let lanes = RoundRobinLanePool::new(pool, 1.0, 1_000.0, 1);
        let start = Instant::now();

        let mut sources = Vec::new();
        for _ in 0..9 {
            sources.push(lanes.acquire().await.source);
        }

        assert_eq!(sources, expected.repeat(3));
        // One burst permit per lane, then one per lane per second: two refill rounds.
        assert!((Duration::from_secs(2)..=Duration::from_millis(2_010)).contains(&start.elapsed()));
    }
}
