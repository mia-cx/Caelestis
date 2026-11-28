//! Load the tile archive settings from TOML before starting any work.

use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use ipnet::Ipv6Net;
use serde::Deserialize;

/// Settings for the archiver and its optional local mock server.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub source: Source,
    pub runtime: Runtime,
    pub egress: Egress,
    pub politeness: Politeness,
    pub baseline: Baseline,
    pub storage: Storage,
    pub mock: Option<Mock>,
}

/// Tile server URL and the path template for its tile coordinates.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub base_url: String,
    pub path_tmpl: String,
}

/// Worker count and the maximum number of in-flight fetches.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Runtime {
    pub workers: usize,
    pub fetch_concurrency: usize,
}

/// IPv6 address pool and per-lane request limit.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Egress {
    pub prefix: Ipv6Net,
    pub addresses: usize,
    pub spread: Spread,
    pub per_lane_rate: u64,
}

/// How egress addresses are distributed within the configured prefix.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Spread {
    #[serde(rename = "per_64")]
    Per64,
    Flat,
}

/// Limits and HTTP settings shared by all tile requests.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Politeness {
    pub global_max_rate: u64,
    #[serde(with = "humantime_serde")]
    pub min_poll_interval: Duration,
    pub respect_retry_after: bool,
    pub user_agent: String,
}

/// Sweep rate and the interval before revisiting empty tiles.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Baseline {
    pub sweep_rate: u64,
    #[serde(with = "humantime_serde")]
    pub refetch_404_every: Duration,
}

/// Where and how to store archived tiles.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Storage {
    pub path: PathBuf,
    pub encoding: Encoding,
    pub dedup: bool,
}

/// Format for stored tiles.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Encoding {
    Palette,
    Raw,
}

/// Address, tile fixtures, and simulated latency for the local mock.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mock {
    pub listen: String,
    pub snapshot_dir: PathBuf,
    pub sample_dir: PathBuf,
    #[serde(with = "humantime_serde")]
    pub inject_latency: Duration,
}

/// Read a TOML file and reject invalid limits or incomplete tile templates.
pub fn load(path: &Path) -> Result<Config> {
    let contents = fs::read_to_string(path)
        .with_context(|| format!("could not read config {}", path.display()))?;
    let config: Config = toml::from_str(&contents)
        .with_context(|| format!("could not parse config {}", path.display()))?;

    ensure!(config.egress.addresses > 0, "egress.addresses must be > 0");
    ensure!(
        config.egress.per_lane_rate > 0,
        "egress.per_lane_rate must be > 0"
    );
    ensure!(
        config.politeness.global_max_rate > 0,
        "politeness.global_max_rate must be > 0"
    );
    ensure!(config.runtime.workers > 0, "runtime.workers must be > 0");
    ensure!(
        config.runtime.fetch_concurrency > 0,
        "runtime.fetch_concurrency must be > 0"
    );
    ensure!(
        config.source.path_tmpl.contains("{x}") && config.source.path_tmpl.contains("{y}"),
        "source.path_tmpl must contain both {{x}} and {{y}}"
    );

    Ok(config)
}
