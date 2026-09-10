//! HTML and its local dependencies are always served from the same executable.

use std::sync::OnceLock;

use axum::{
    extract::Path,
    http::{header, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use sha2::{Digest, Sha256};

const HTML: &str = include_str!("../../static/index.html");
const NO_CACHE: &str = "no-cache";
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

struct Asset {
    name: &'static str,
    content_type: &'static str,
    bytes: &'static [u8],
}

macro_rules! asset {
    ($name:literal, $content_type:literal) => {
        Asset {
            name: $name,
            content_type: $content_type,
            bytes: include_bytes!(concat!("../../static/", $name)),
        }
    };
}

const ASSETS: &[Asset] = &[
    asset!("styles.css", "text/css; charset=utf-8"),
    asset!("i18n.js", "text/javascript; charset=utf-8"),
    asset!("analytics.js", "text/javascript; charset=utf-8"),
    asset!("scientific-charts.js", "text/javascript; charset=utf-8"),
    asset!("app.js", "text/javascript; charset=utf-8"),
    asset!("analytics.wasm", "application/wasm"),
    asset!("favicon.svg", "image/svg+xml"),
];

struct Release {
    version: String,
    html: String,
}

fn release() -> &'static Release {
    static RELEASE: OnceLock<Release> = OnceLock::new();
    RELEASE.get_or_init(|| {
        let mut hash = Sha256::new();
        hash.update(HTML.as_bytes());
        for asset in ASSETS {
            hash.update(asset.name.as_bytes());
            hash.update((asset.bytes.len() as u64).to_be_bytes());
            hash.update(asset.bytes);
        }
        let version = format!("{:x}", hash.finalize());
        let html = HTML.replace("/assets/", &format!("/assets/{version}/"));
        Release { version, html }
    })
}

pub fn routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/", get(index))
        .route("/assets/*path", get(get_asset))
}

async fn index() -> Response {
    (
        [(header::CACHE_CONTROL, NO_CACHE)],
        Html(release().html.as_str()),
    )
        .into_response()
}

async fn get_asset(Path(path): Path<String>) -> Response {
    // Existing bookmarks and previously loaded pages can still request fixed URLs.
    if path == "index.html" {
        return index().await;
    }
    let (name, cache_control) = match path.split_once('/') {
        Some((version, name)) if version == release().version => (name, IMMUTABLE),
        Some(_) => return missing(),
        None => (path.as_str(), NO_CACHE),
    };
    let Some(asset) = ASSETS.iter().find(|asset| asset.name == name) else {
        return missing();
    };
    (
        [
            (header::CONTENT_TYPE, asset.content_type),
            (header::CACHE_CONTROL, cache_control),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        asset.bytes,
    )
        .into_response()
}

fn missing() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CACHE_CONTROL, "no-store")],
        "Asset not found",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Exercise the actual HTTP routes without database configuration or static/ on disk.
    #[tokio::test]
    async fn http_release_keeps_html_scripts_styles_and_wasm_together() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, routes()).await.unwrap();
        });
        let client = reqwest::Client::new();

        let response = client.get(&base).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], NO_CACHE);
        assert!(response.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/html"));
        let html = response.text().await.unwrap();
        let version = &release().version;
        assert_eq!(version.len(), 64);
        assert!(version.bytes().all(|byte| byte.is_ascii_hexdigit()));

        for asset in ASSETS {
            let path = format!("/assets/{version}/{}", asset.name);
            if asset.name != "analytics.wasm" {
                assert!(
                    html.contains(&path),
                    "HTML does not reference {}",
                    asset.name
                );
            }
            let response = client.get(format!("{base}{path}")).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], IMMUTABLE);
            assert_eq!(response.headers()[header::CONTENT_TYPE], asset.content_type);
            assert_eq!(response.bytes().await.unwrap().as_ref(), asset.bytes);

            let response = client
                .get(format!("{base}/assets/{}", asset.name))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], NO_CACHE);
            assert_eq!(response.bytes().await.unwrap().as_ref(), asset.bytes);
        }

        // analytics.js resolves its WASM relative to its own versioned URL.
        let script_url =
            reqwest::Url::parse(&format!("{base}/assets/{version}/analytics.js")).unwrap();
        let wasm_url = script_url.join("analytics.wasm").unwrap();
        let wasm = client.get(wasm_url).send().await.unwrap();
        assert_eq!(wasm.headers()[header::CONTENT_TYPE], "application/wasm");
        assert!(wasm.bytes().await.unwrap().starts_with(b"\0asm"));

        for path in [
            format!("/assets/previous-release/app.js"),
            format!("/assets/{version}/missing.js"),
            format!("/assets/{version}/nested/app.js"),
            "/assets/missing.js".to_owned(),
        ] {
            let response = client.get(format!("{base}{path}")).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        }
        server.abort();
    }
}
