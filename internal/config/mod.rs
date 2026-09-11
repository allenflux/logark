use anyhow::Context;
use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub addr: String,
    pub database_url: String,
    pub db_max_connections: u32,
    pub analytics_cache_ttl_secs: u64,
    pub analytics_query_timeout_secs: u64,
    pub redis_url: Option<String>,
    pub redis_cache_ttl_secs: u64,
    pub redis_operation_timeout_ms: u64,
    pub default_window_hours: u32,
    pub max_window_hours: u32,
    pub max_list_limit: u32,
    pub slow_request_ms: i32,
    pub audit_retention_days: u32,
    pub audit_cleanup_interval_secs: u64,
    pub audit_cleanup_batch_size: u32,
    pub tg_bot_token: Option<String>,
    pub tg_chat_id: Option<String>,
    pub tg_poll_interval_secs: u64,
    pub tg_report_hour: u32,
    pub tg_report_minute: u32,
    pub tg_timezone_offset_hours: i32,
    pub tg_default_report_limit: u32,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        // Optional local Redis credentials stay separate from tracked examples.
        // dotenvy never overwrites values explicitly supplied by the process.
        let _ = dotenvy::from_filename(".env.redis");
        let _ = dotenvy::dotenv();
        Ok(Self {
            addr: env::var("LOGARK_ADDR").unwrap_or_else(|_| "0.0.0.0:7700".to_string()),
            database_url: database_url_from_env()?,
            db_max_connections: env_u32("LOGARK_DB_MAX_CONNECTIONS", 12),
            analytics_cache_ttl_secs: env_u64("LOGARK_ANALYTICS_CACHE_TTL_SECS", 15),
            analytics_query_timeout_secs: env_u64_in_range(
                "LOGARK_ANALYTICS_QUERY_TIMEOUT_SECS",
                300,
                1,
                3_600,
            )?,
            redis_url: env_opt("LOGARK_REDIS_URL").or_else(|| env_opt("REDIS_URL")),
            redis_cache_ttl_secs: env_u64_in_range("LOGARK_REDIS_CACHE_TTL_SECS", 60, 0, 3_600)?,
            redis_operation_timeout_ms: env_u64_in_range(
                "LOGARK_REDIS_OPERATION_TIMEOUT_MS",
                200,
                10,
                5_000,
            )?,
            default_window_hours: env_u32("LOGARK_DEFAULT_WINDOW_HOURS", 24),
            max_window_hours: env_u32("LOGARK_MAX_WINDOW_HOURS", 168),
            max_list_limit: env_u32("LOGARK_MAX_LIST_LIMIT", 100),
            slow_request_ms: env_i32("LOGARK_SLOW_REQUEST_MS", 1000),
            audit_retention_days: env_u32_in_range("LOGARK_AUDIT_RETENTION_DAYS", 8, 1, 3_650)?,
            audit_cleanup_interval_secs: env_u64_in_range(
                "LOGARK_AUDIT_CLEANUP_INTERVAL_SECS",
                3_600,
                60,
                604_800,
            )?,
            audit_cleanup_batch_size: env_u32_in_range(
                "LOGARK_AUDIT_CLEANUP_BATCH_SIZE",
                1_000,
                1,
                10_000,
            )?,
            tg_bot_token: env_opt("TG_BOT_TOKEN"),
            tg_chat_id: env_opt("TG_CHAT_ID"),
            tg_poll_interval_secs: env_u64("TG_POLL_INTERVAL_SECS", 10),
            tg_report_hour: env_u32("TG_REPORT_HOUR", 9),
            tg_report_minute: env_u32("TG_REPORT_MINUTE", 0),
            tg_timezone_offset_hours: env_i32("TG_TIMEZONE_OFFSET_HOURS", 8),
            tg_default_report_limit: env_u32("TG_DEFAULT_REPORT_LIMIT", 20),
        })
    }
}

fn env_opt(key: &str) -> Option<String> {
    env::var(key).ok().and_then(|v| {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn env_u32(key: &str, default: u32) -> u32 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_u64(key: &str, default: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_u32_in_range(key: &str, default: u32, min: u32, max: u32) -> anyhow::Result<u32> {
    let value = match env::var(key) {
        Ok(value) => value,
        Err(env::VarError::NotPresent) => return Ok(default),
        Err(error) => return Err(error).with_context(|| format!("failed to read {key}")),
    };
    let parsed = value
        .parse::<u32>()
        .with_context(|| format!("{key} must be an integer between {min} and {max}"))?;
    anyhow::ensure!(
        (min..=max).contains(&parsed),
        "{key} must be between {min} and {max}"
    );
    Ok(parsed)
}

fn env_u64_in_range(key: &str, default: u64, min: u64, max: u64) -> anyhow::Result<u64> {
    let value = match env::var(key) {
        Ok(value) => value,
        Err(env::VarError::NotPresent) => return Ok(default),
        Err(error) => return Err(error).with_context(|| format!("failed to read {key}")),
    };
    let parsed = value
        .parse::<u64>()
        .with_context(|| format!("{key} must be an integer between {min} and {max}"))?;
    anyhow::ensure!(
        (min..=max).contains(&parsed),
        "{key} must be between {min} and {max}"
    );
    Ok(parsed)
}

fn env_i32(key: &str, default: i32) -> i32 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn database_url_from_env() -> anyhow::Result<String> {
    if let Ok(url) = env::var("DATABASE_URL") {
        if !url.trim().is_empty() {
            return Ok(url);
        }
    }

    let host = env::var("MYSQL_HOST").context("missing DATABASE_URL or MYSQL_HOST")?;
    let port = env::var("MYSQL_PORT").unwrap_or_else(|_| "3306".to_string());
    let database = env::var("MYSQL_DATABASE").context("missing MYSQL_DATABASE")?;
    let user = env::var("MYSQL_USER").context("missing MYSQL_USER")?;
    let password = env::var("MYSQL_PASSWORD").context("missing MYSQL_PASSWORD")?;

    Ok(format!(
        "mysql://{user}:{password}@{host}:{port}/{database}",
        user = user,
        password = password,
        host = host,
        port = port,
        database = database,
    ))
}
