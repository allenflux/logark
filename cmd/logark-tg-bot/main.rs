use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use logark::{bot::TelegramBot, config::Config, db, service::AuditAnalyticsService};

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

    let service = AuditAnalyticsService::new(pool, cfg.clone());
    let bot = TelegramBot::new(service, cfg)?;
    bot.run().await
}
