use axum::{routing::get, Router};
use tower_http::{cors::CorsLayer, services::ServeDir, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use logark::{
    config::Config,
    db,
    handler::{self, AppState},
    service::AuditAnalyticsService,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let cfg = Config::from_env()?;
    let pool = db::connect(&cfg.database_url, cfg.db_max_connections).await?;
    db::migrate(&pool).await?;

    let state = AppState {
        audit_service: AuditAnalyticsService::new(pool, cfg.clone()),
    };

    let app = Router::new()
        .route("/", get(handler::index))
        .route("/health", get(handler::health))
        .route("/api/dashboard", get(handler::dashboard))
        .route("/api/records", get(handler::list_records))
        .route("/api/records/:id", get(handler::get_record))
        .route(
            "/api/records/request/:request_id",
            get(handler::get_record_by_request_id),
        )
        .route("/api/records/uuid/:uuid", get(handler::get_record_by_uuid))
        .nest_service("/assets", ServeDir::new("static"))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&cfg.addr).await?;
    tracing::info!(addr = %cfg.addr, "LogArk server started");
    axum::serve(listener, app).await?;
    Ok(())
}
