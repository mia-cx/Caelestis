//! **wpa-temporal** — hour/day/week activity model per region (bonus dataset)
//!
//! Delegate model: opus-5.5
//!
//! Learns when each longitude band of the canvas is active, by hour of day, day of week and
//! week of year in that band's local solar time. Feeds `schedule` through
//! [`TemporalModel::expected_rate`] and exports the learned buckets as the
//! "when is a region active" dataset through [`TemporalModel::snapshot`].
//!
//! Rates are smoothed estimates, never zero: a bucket with little data leans on its region's
//! average, and a region with little data leans on [`PRIOR_RATE_PER_TILE`], so a cold tile is
//! still polled eventually.

use chrono::{DateTime, Datelike, Timelike};
use wpa_contracts::{CANVAS_TILES, TileId};

/// Longitude bands the canvas is split into. Each spans 11.25° (45 minutes of solar time).
pub const REGIONS: usize = 32;

/// Expected change events per second for a tile the model knows nothing about: one a week.
pub const PRIOR_RATE_PER_TILE: f64 = 1.0 / WEEK_SECS;

const COLUMNS_PER_REGION: usize = CANVAS_TILES as usize / REGIONS;
const TILES_PER_REGION: f64 = (COLUMNS_PER_REGION * CANVAS_TILES as usize) as f64;

const HOUR_SECS: f64 = 3_600.0;
const DAY_SECS: i64 = 86_400;
const WEEK_SECS: f64 = 7.0 * DAY_SECS as f64;
const DAYS_PER_YEAR: f64 = 365.2425;
const YEAR_SECS: f64 = DAYS_PER_YEAR * DAY_SECS as f64;
const HOURS_PER_WEEK: usize = 24 * 7;
/// Weeks of the year; the last one absorbs the year's trailing one or two days.
const WEEKS_PER_YEAR: usize = 52;

/// Observation time a region average is worth before its own data outweighs the prior.
const REGION_PSEUDO_SECS: f64 = DAY_SECS as f64;
/// Observation time a bucket is worth before its own data outweighs the region average.
const BUCKET_PSEUDO_SECS: f64 = HOUR_SECS;

/// Learned change counts per region, bucketed by local time. See the crate docs.
#[derive(Clone, Debug)]
pub struct TemporalModel {
    regions: [Region; REGIONS],
    /// Earliest and latest recorded change, bounding the time the model has observed.
    observed: Option<(u64, u64)>,
}

/// Change events seen in one region during one local hour of one weekday, summed over all weeks.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct RegionActivity {
    /// Longitude band in `0..REGIONS`, west to east.
    pub region: u16,
    /// Local hour, `0..24`.
    pub hour_of_day: u8,
    /// Local weekday, `0..7` from Monday.
    pub day_of_week: u8,
    pub events: u64,
}

#[derive(Clone, Copy, Debug)]
struct Region {
    /// Indexed by `day_of_week * 24 + hour_of_day`.
    hour_of_week: [u64; HOURS_PER_WEEK],
    week_of_year: [u64; WEEKS_PER_YEAR],
    total: u64,
}

impl Region {
    const EMPTY: Self = Self {
        hour_of_week: [0; HOURS_PER_WEEK],
        week_of_year: [0; WEEKS_PER_YEAR],
        total: 0,
    };
}

/// A region's local wall-clock position.
struct LocalTime {
    hour_of_week: usize,
    week_of_year: usize,
}

impl Default for TemporalModel {
    fn default() -> Self {
        Self::new()
    }
}

impl TemporalModel {
    pub fn new() -> Self {
        Self {
            regions: [Region::EMPTY; REGIONS],
            observed: None,
        }
    }

    /// Note that `tile` changed at `at_unix` (seconds since the epoch).
    pub fn record(&mut self, tile: TileId, at_unix: u64) {
        let region = region_of(tile);
        let local = local_time(region, at_unix);
        let counts = &mut self.regions[region];
        counts.hour_of_week[local.hour_of_week] += 1;
        counts.week_of_year[local.week_of_year] += 1;
        counts.total += 1;
        self.observed = Some(match self.observed {
            Some((first, last)) => (first.min(at_unix), last.max(at_unix)),
            None => (at_unix, at_unix),
        });
    }

    /// Expected change events per second for `tile` around `now_unix`.
    ///
    /// Estimated from the region's count for `now_unix`'s local hour of the week, scaled by its
    /// week of the year once a full year has been observed, and spread evenly over the region's
    /// tiles. Always positive.
    pub fn expected_rate(&self, tile: TileId, now_unix: u64) -> f64 {
        let region = region_of(tile);
        let counts = &self.regions[region];
        let local = local_time(region, now_unix);
        let span = self
            .observed
            .map_or(0.0, |(first, last)| (last - first) as f64);

        let prior = PRIOR_RATE_PER_TILE * TILES_PER_REGION;
        let region_rate =
            (counts.total as f64 + prior * REGION_PSEUDO_SECS) / (span + REGION_PSEUDO_SECS);
        let bucket_exposure = span / HOURS_PER_WEEK as f64;
        let hourly = (counts.hour_of_week[local.hour_of_week] as f64
            + region_rate * BUCKET_PSEUDO_SECS)
            / (bucket_exposure + BUCKET_PSEUDO_SECS);

        // Before a full year, week counts only show which weeks happened to be observed.
        let seasonal = if span >= YEAR_SECS {
            let week = local.week_of_year;
            let expected = counts.total as f64 * days_in_week(week) / DAYS_PER_YEAR;
            (counts.week_of_year[week] as f64 + 1.0) / (expected + 1.0)
        } else {
            1.0
        };

        hourly * seasonal / TILES_PER_REGION
    }

    /// Export the learned buckets for inspection (the bonus dataset): every non-empty
    /// (region, weekday, hour), ordered by region, then weekday, then hour.
    pub fn snapshot(&self) -> Vec<RegionActivity> {
        self.regions
            .iter()
            .enumerate()
            .flat_map(|(region, counts)| {
                counts
                    .hour_of_week
                    .iter()
                    .enumerate()
                    .filter(|&(_, &events)| events > 0)
                    .map(move |(slot, &events)| RegionActivity {
                        region: region as u16,
                        hour_of_day: (slot % 24) as u8,
                        day_of_week: (slot / 24) as u8,
                        events,
                    })
            })
            .collect()
    }
}

fn region_of(tile: TileId) -> usize {
    usize::from(tile.x) / COLUMNS_PER_REGION
}

/// Solar UTC offset of a region's central meridian: column 0 is -180°, column 2048 is +180°.
fn utc_offset_secs(region: usize) -> i64 {
    let center = (region * COLUMNS_PER_REGION + COLUMNS_PER_REGION / 2) as i64;
    center * DAY_SECS / i64::from(CANVAS_TILES) - DAY_SECS / 2
}

fn local_time(region: usize, at_unix: u64) -> LocalTime {
    let local_secs =
        i64::try_from(at_unix).expect("unix time fits in i64") + utc_offset_secs(region);
    let clock = DateTime::from_timestamp(local_secs, 0).expect("unix time within chrono's range");
    let day = clock.weekday().num_days_from_monday() as usize;
    LocalTime {
        hour_of_week: day * 24 + clock.hour() as usize,
        week_of_year: (clock.ordinal0() as usize / 7).min(WEEKS_PER_YEAR - 1),
    }
}

fn days_in_week(week: usize) -> f64 {
    if week == WEEKS_PER_YEAR - 1 {
        DAYS_PER_YEAR - 7.0 * (WEEKS_PER_YEAR - 1) as f64
    } else {
        7.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: u64 = 3_600;
    const DAY: u64 = 24 * HOUR;
    const WEEK: u64 = 7 * DAY;
    /// 2024-01-01T00:00:00Z, a Monday.
    const JAN_1_2024: u64 = 1_704_067_200;
    /// 2025-01-01T00:00:00Z.
    const JAN_1_2025: u64 = 1_735_689_600;
    /// Region 16 sits just east of Greenwich, 22.5 minutes ahead of UTC.
    const GREENWICH: TileId = TileId { x: 1024, y: 700 };
    const ANTIMERIDIAN_WEST: TileId = TileId { x: 0, y: 700 };

    #[test]
    fn rate_is_higher_inside_the_active_local_window() {
        let mut model = TemporalModel::new();
        for day in 0..28 {
            for minute in 0..30 {
                model.record(GREENWICH, JAN_1_2024 + day * DAY + 20 * HOUR + minute * 60);
            }
        }

        let evening = JAN_1_2024 + 29 * DAY + 20 * HOUR + 30 * 60;
        let morning = JAN_1_2024 + 29 * DAY + 8 * HOUR;
        assert!(model.expected_rate(GREENWICH, evening) > model.expected_rate(GREENWICH, morning));
    }

    #[test]
    fn same_instant_falls_in_each_longitudes_own_local_hour() {
        let mut model = TemporalModel::new();
        model.record(GREENWICH, 0);
        model.record(ANTIMERIDIAN_WEST, 0);

        // 1970-01-01T00:00Z was a Thursday: ~00:22 there at Greenwich, ~12:22 the previous
        // day at the western antimeridian.
        assert_eq!(
            model.snapshot(),
            [
                RegionActivity {
                    region: 0,
                    hour_of_day: 12,
                    day_of_week: 2,
                    events: 1
                },
                RegionActivity {
                    region: 16,
                    hour_of_day: 0,
                    day_of_week: 3,
                    events: 1
                },
            ]
        );
    }

    #[test]
    fn cold_model_predicts_the_small_positive_prior() {
        let rate = TemporalModel::new().expected_rate(GREENWICH, JAN_1_2024);
        assert!(rate > 0.0);
        assert!((rate - PRIOR_RATE_PER_TILE).abs() < PRIOR_RATE_PER_TILE * 1e-9);
    }

    #[test]
    fn snapshot_sums_tiles_of_one_region_into_one_bucket() {
        let mut model = TemporalModel::new();
        let neighbour = TileId { x: 1030, y: 12 };
        model.record(GREENWICH, JAN_1_2024 + 9 * HOUR);
        model.record(GREENWICH, JAN_1_2024 + WEEK + 9 * HOUR);
        model.record(neighbour, JAN_1_2024 + 9 * HOUR);

        assert_eq!(
            model.snapshot(),
            [RegionActivity {
                region: 16,
                hour_of_day: 9,
                day_of_week: 0,
                events: 3
            }]
        );
    }

    #[test]
    fn active_week_of_year_raises_the_rate_once_a_year_is_observed() {
        let mut model = TemporalModel::new();
        model.record(GREENWICH, JAN_1_2024);
        model.record(GREENWICH, JAN_1_2024 + 2 * 365 * DAY);
        for jan_1 in [JAN_1_2024, JAN_1_2025] {
            for minute in 0..100 {
                model.record(GREENWICH, jan_1 + 70 * DAY + HOUR + minute * 60);
            }
        }

        // Same local hour of the week, in week 10 and week 30.
        let active_week = JAN_1_2025 + 72 * DAY + 12 * HOUR;
        let quiet_week = active_week + 20 * WEEK;
        assert!(
            model.expected_rate(GREENWICH, active_week)
                > model.expected_rate(GREENWICH, quiet_week)
        );
    }
}
