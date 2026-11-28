use std::{io::Write, path::Path, time::Duration};

use tempfile::NamedTempFile;
use wpa_config::{Config, Encoding, Spread, load};

const TOML: &str = r#"
[source]
base_url = "http://127.0.0.1:8787"
path_tmpl = "/files/s0/tiles/{x}/{y}.png"

[runtime]
workers = 8
fetch_concurrency = 512

[egress]
prefix = "2001:db8::/56"
addresses = 4000
spread = "per_64"
per_lane_rate = 24

[politeness]
global_max_rate = 60000
min_poll_interval = "5s"
respect_retry_after = true
user_agent = "tile-archiver/0.1"

[baseline]
sweep_rate = 40000
refetch_404_every = "6h"

[storage]
path = "/var/lib/tile-archive"
encoding = "palette"
dedup = true

[mock]
listen = "127.0.0.1:8787"
snapshot_dir = ""
sample_dir = "./samples"
inject_latency = "15ms"
"#;

fn load_toml(contents: &str) -> anyhow::Result<Config> {
    let mut file = NamedTempFile::new()?;
    file.write_all(contents.as_bytes())?;
    load(file.path())
}

#[test]
fn loads_all_sections() {
    let config = load_toml(TOML).unwrap();
    assert_eq!(config.source.base_url, "http://127.0.0.1:8787");
    assert_eq!(config.source.path_tmpl, "/files/s0/tiles/{x}/{y}.png");
    assert_eq!(config.runtime.workers, 8);
    assert_eq!(config.runtime.fetch_concurrency, 512);
    assert_eq!(
        config.egress.prefix,
        "2001:db8::/56".parse::<ipnet::Ipv6Net>().unwrap()
    );
    assert_eq!(config.egress.addresses, 4000);
    assert_eq!(config.egress.spread, Spread::Per64);
    assert_eq!(config.egress.per_lane_rate, 24);
    assert_eq!(config.politeness.global_max_rate, 60000);
    assert_eq!(config.politeness.min_poll_interval, Duration::from_secs(5));
    assert!(config.politeness.respect_retry_after);
    assert_eq!(config.politeness.user_agent, "tile-archiver/0.1");
    assert_eq!(config.baseline.sweep_rate, 40000);
    assert_eq!(
        config.baseline.refetch_404_every,
        Duration::from_secs(21600)
    );
    assert_eq!(config.storage.path, Path::new("/var/lib/tile-archive"));
    assert_eq!(config.storage.encoding, Encoding::Palette);
    assert!(config.storage.dedup);

    let mock = config.mock.unwrap();
    assert_eq!(mock.listen, "127.0.0.1:8787");
    assert_eq!(mock.snapshot_dir, Path::new(""));
    assert_eq!(mock.sample_dir, Path::new("./samples"));
    assert_eq!(mock.inject_latency, Duration::from_millis(15));
}

#[test]
fn loads_without_mock_and_accepts_alternate_modes() {
    let (without_mock, _) = TOML.split_once("[mock]").unwrap();
    let config = load_toml(
        &without_mock
            .replace("per_64", "flat")
            .replace("palette", "raw"),
    )
    .unwrap();

    assert!(config.mock.is_none());
    assert_eq!(config.egress.spread, Spread::Flat);
    assert_eq!(config.storage.encoding, Encoding::Raw);
}

#[test]
fn rejects_invalid_settings_with_field_names() {
    for (valid, invalid, expected) in [
        ("addresses = 4000", "addresses = 0", "egress.addresses"),
        (
            "per_lane_rate = 24",
            "per_lane_rate = 0",
            "egress.per_lane_rate",
        ),
        (
            "global_max_rate = 60000",
            "global_max_rate = 0",
            "politeness.global_max_rate",
        ),
        ("workers = 8", "workers = 0", "runtime.workers"),
        (
            "fetch_concurrency = 512",
            "fetch_concurrency = 0",
            "runtime.fetch_concurrency",
        ),
        ("/{x}/{y}.png", "/{x}/0.png", "source.path_tmpl"),
        ("/{x}/{y}.png", "/0/{y}.png", "source.path_tmpl"),
        ("2001:db8::/56", "192.0.2.0/24", "prefix"),
        ("2001:db8::/56", "2001:db8::/129", "prefix"),
        ("15ms", "soon", "inject_latency"),
    ] {
        let error = load_toml(&TOML.replace(valid, invalid)).unwrap_err();
        assert!(
            format!("{error:#}").contains(expected),
            "{invalid}: {error:#}"
        );
    }
}
