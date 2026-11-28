use std::{error::Error, time::Duration};

use clap::Parser;
use reqwest::Url;
use wpa_bench::Benchmark;

#[derive(Parser)]
#[command(about = "Find the throughput plateau of a local HTTP test server")]
struct Args {
    /// Base HTTP(S) URL on localhost or a loopback IP.
    #[arg(long)]
    base_url: Url,
    /// Request path template. Use {x} and {y} for tile coordinates.
    #[arg(long, default_value = "/files/s0/tiles/{x}/{y}.png")]
    path_tmpl: String,
    /// Number of distinct tile coordinates to cycle through.
    #[arg(long, default_value_t = 4096)]
    tiles: usize,
    /// Strictly increasing concurrency levels.
    #[arg(long, value_delimiter = ',', default_value = "16,32,64,128,256,512")]
    levels: Vec<usize>,
    /// Wall time per concurrency level, such as 5s or 250ms.
    #[arg(long, default_value = "5s", value_parser = humantime::parse_duration)]
    per_level: Duration,
    /// User-Agent header to send with requests.
    #[arg(long)]
    user_agent: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    let args = Args::parse();
    let benchmark = Benchmark::new(
        args.base_url,
        args.path_tmpl,
        args.tiles,
        args.user_agent.as_deref(),
    )?;

    println!(
        "{:>11} {:>12} {:>10} {:>10} {:>15}",
        "concurrency", "req/s", "p50 ms", "p99 ms", "non-2xx/errors"
    );
    let plateau = benchmark
        .run(&args.levels, args.per_level, |level| {
            println!(
                "{:>11} {:>12.1} {:>10.2} {:>10.2} {:>15}",
                level.concurrency,
                level.requests_per_second,
                level.p50_ms,
                level.p99_ms,
                level.errors,
            );
        })
        .await?;
    if plateau {
        println!("Plateau: throughput gained less than 5% over the previous level.");
    }
    Ok(())
}
