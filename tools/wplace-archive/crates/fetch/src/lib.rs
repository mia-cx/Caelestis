//! **wpa-fetch** — conditional GET hot path (ETag/304/200/404, keep-alive)
//!
//! Delegate model: opus-5.5
//!
//! One conditional GET per call, bound to the lane's source address, mapped to
//! an [`Outcome`] by `wpa_classify`. Pacing and retries are the caller's job.
//! Implements `wpa_contracts::Fetcher`.
#![allow(async_fn_in_trait)]

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;

use anyhow::Context;
use reqwest::header::{ETAG, IF_NONE_MATCH, RETRY_AFTER};
use reqwest::{Client, Url};
use wpa_contracts::{ETag, Fetcher, Lane, Outcome, TileId};

/// Fetches tiles over HTTP, keeping one keep-alive client per source address.
pub struct HttpFetcher {
    base_url: String,
    path_tmpl: String,
    user_agent: String,
    clients: Mutex<HashMap<IpAddr, Client>>,
}

impl HttpFetcher {
    /// `base_url` (e.g. `https://backend.example`) is joined with `path_tmpl`
    /// rendered per tile (e.g. `/files/s0/tiles/{x}/{y}.png`).
    pub fn new(base_url: String, path_tmpl: String, user_agent: String) -> anyhow::Result<Self> {
        Url::parse(&base_url).with_context(|| format!("invalid base url {base_url:?}"))?;
        Ok(Self {
            base_url,
            path_tmpl,
            user_agent,
            clients: Mutex::default(),
        })
    }

    /// The client bound to `source`, built on first use and reused after.
    fn client_for(&self, source: IpAddr) -> reqwest::Result<Client> {
        let mut clients = self.clients.lock().expect("client map poisoned");
        if let Some(client) = clients.get(&source) {
            return Ok(client.clone());
        }
        let client = Client::builder()
            .local_address(source)
            .user_agent(&self.user_agent)
            .build()?;
        clients.insert(source, client.clone());
        Ok(client)
    }
}

impl Fetcher for HttpFetcher {
    async fn fetch(&self, tile: TileId, known: Option<ETag>, lane: &Lane) -> Outcome {
        let url = format!("{}{}", self.base_url, tile.render_path(&self.path_tmpl));
        let client = match self.client_for(lane.source) {
            Ok(client) => client,
            Err(err) => return Outcome::Err(format!("client for {}: {err}", lane.source)),
        };
        let mut request = client.get(&url);
        if let Some(ETag(tag)) = known {
            request = request.header(IF_NONE_MATCH, tag);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(err) => return Outcome::Err(format!("GET {url}: {err}")),
        };

        let status = response.status().as_u16();
        let header = |name| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };
        let etag = header(ETAG);
        let retry_after = header(RETRY_AFTER);
        let body = match response.bytes().await {
            Ok(body) => body.to_vec(),
            Err(err) => return Outcome::Err(format!("GET {url}: reading body: {err}")),
        };

        match (
            wpa_classify::classify(status, etag.as_deref(), body),
            retry_after,
        ) {
            (Outcome::Err(message), Some(wait)) => {
                Outcome::Err(format!("{message} (retry-after {wait})"))
            }
            (outcome, _) => outcome,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::http::{HeaderMap, StatusCode, header};
    use axum::response::IntoResponse;
    use axum::routing::get;

    const TAG: &str = r#""rev-1""#;
    const PNG: &[u8] = b"\x89PNG tile";

    /// Tile 1/2 is painted with `TAG`, tile 9/9 is rate limited, every other tile is empty.
    async fn tile(
        axum::extract::Path((x, y)): axum::extract::Path<(u16, String)>,
        headers: HeaderMap,
    ) -> impl IntoResponse {
        match (x, y.as_str()) {
            (1, "2.png") if headers.get(header::IF_NONE_MATCH).is_some_and(|v| v == TAG) => {
                StatusCode::NOT_MODIFIED.into_response()
            }
            (1, "2.png") => ([(header::ETAG, TAG)], PNG).into_response(),
            (9, "9.png") => {
                (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "7")]).into_response()
            }
            _ => StatusCode::NOT_FOUND.into_response(),
        }
    }

    async fn serve() -> HttpFetcher {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().route("/tiles/{x}/{y}", get(tile));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        HttpFetcher::new(base_url, "/tiles/{x}/{y}.png".into(), "wpa-test".into()).unwrap()
    }

    const LANE: Lane = Lane {
        source: IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
    };

    #[tokio::test]
    async fn conditional_get_maps_responses() {
        let fetcher = serve().await;

        let etag = match fetcher.fetch(TileId::new(1, 2), None, &LANE).await {
            Outcome::Painted { bytes, etag } => {
                assert_eq!(bytes, PNG);
                assert_eq!(etag, ETag(TAG.into()));
                etag
            }
            other => panic!("expected Painted, got {other:?}"),
        };

        let refetch = fetcher.fetch(TileId::new(1, 2), Some(etag), &LANE).await;
        assert!(matches!(refetch, Outcome::Unchanged), "got {refetch:?}");

        let missing = fetcher.fetch(TileId::new(3, 4), None, &LANE).await;
        assert!(matches!(missing, Outcome::Empty), "got {missing:?}");
    }

    #[tokio::test]
    async fn rate_limit_reports_retry_after() {
        let fetcher = serve().await;
        match fetcher.fetch(TileId::new(9, 9), None, &LANE).await {
            Outcome::Err(message) => assert!(message.contains("retry-after 7"), "{message}"),
            other => panic!("expected Err, got {other:?}"),
        }
    }
}
