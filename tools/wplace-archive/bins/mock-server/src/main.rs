use std::{io, net::SocketAddr, path::PathBuf, time::Duration};

use clap::Parser;
use tokio::net::TcpListener;

/// Serve local tile files for archive tests.
#[derive(Parser)]
struct Args {
    /// Address to listen on.
    #[arg(long, default_value = "127.0.0.1:8787")]
    listen: SocketAddr,
    /// Root of the <x>/<y>.png tile tree.
    #[arg(long)]
    root: PathBuf,
    /// Directory of PNGs for sample fallback.
    #[arg(long)]
    sample_dir: Option<PathBuf>,
    /// Serve a random sample when a tile is missing and --sample-dir is set.
    #[arg(long)]
    sample_fallback: bool,
    /// Delay tile responses by this duration (e.g. 15ms).
    #[arg(long, value_parser = humantime::parse_duration)]
    inject_latency: Option<Duration>,
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let args = Args::parse();
    let sample_dir = args.sample_dir.filter(|_| args.sample_fallback);
    let listener = TcpListener::bind(args.listen).await?;
    axum::serve(
        listener,
        wpa_mock::router(args.root, sample_dir, args.inject_latency),
    )
    .await
}
