//! Read-only report timing probe: no migration, retention, or bot is started.
//! Connects using the same environment as the service, and writes only optional
//! report-cache entries when Redis is configured. Never prints audit samples.
use std::time::Instant;

use logark::{config::Config, db, model::DashboardQuery, service::AuditAnalyticsService};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info,sqlx::query=error,logark::redis_cache=debug")
        .with_ansi(false)
        .init();
    let config = Config::from_env()?;
    let pool = db::connect(&config.database_url, config.db_max_connections).await?;
    let hours = std::env::args()
        .nth(1)
        .map(|v| v.parse())
        .transpose()?
        .unwrap_or(24);
    let mut first_window = None;
    // Separate service instances deliberately bypass L1 on the second read,
    // verifying shared Redis reuse as it would work after an application restart.
    for run in 1..=2 {
        let service = AuditAnalyticsService::new(pool.clone(), config.clone());
        let started = Instant::now();
        let result = service
            .dashboard(DashboardQuery {
                hours: Some(hours),
                path: None,
                method: None,
                api_key: None,
                task_type: None,
            })
            .await?;
        println!(
            "{}",
            serde_json::json!({
                "run": run,
                "elapsed_ms": started.elapsed().as_millis(),
                "hours": result.window.hours,
                "window_to_ts": result.window.to_ts,
                "same_completed_report": first_window.map(|ts| ts == result.window.to_ts),
                "total_requests": result.summary.total_requests,
                "error_requests": result.summary.error_requests,
                "failure_patterns": result.failure_patterns.len(),
            })
        );
        first_window = Some(result.window.to_ts);
    }
    pool.close().await;
    Ok(())
}
