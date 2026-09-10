use axum::{routing::get, Router};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use logark::{
    assets,
    config::Config,
    db,
    handler::{self, AppState},
    retention::{spawn_audit_retention_task, AuditRetentionPolicy},
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
    let retention_policy = AuditRetentionPolicy::from_config(&cfg);

    let state = AppState {
        audit_service: AuditAnalyticsService::new(pool.clone(), cfg.clone()),
    };

    let app = Router::new()
        .merge(assets::routes())
        .route("/health", get(handler::health))
        .route("/api/dashboard", get(handler::dashboard))
        .route("/api/records", get(handler::list_records))
        .route("/api/records/:id", get(handler::get_record))
        .route(
            "/api/records/request/:request_id",
            get(handler::get_record_by_request_id),
        )
        .route("/api/records/uuid/:uuid", get(handler::get_record_by_uuid))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&cfg.addr).await?;
    let _audit_retention_task = spawn_audit_retention_task(pool, retention_policy);
    tracing::info!(addr = %cfg.addr, "LogArk server started");
    axum::serve(listener, app).await?;
    Ok(())
}
