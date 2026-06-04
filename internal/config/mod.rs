use anyhow::Context;
use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub addr: String,
    pub database_url: String,
    pub db_max_connections: u32,
    pub analytics_cache_ttl_secs: u64,
    pub default_window_hours: u32,
    pub max_window_hours: u32,
    pub max_list_limit: u32,
    pub slow_request_ms: i32,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let _ = dotenvy::dotenv();
        Ok(Self {
            addr: env::var("LOGARK_ADDR").unwrap_or_else(|_| "0.0.0.0:7700".to_string()),
            database_url: database_url_from_env()?,
            db_max_connections: env_u32("LOGARK_DB_MAX_CONNECTIONS", 12),
            analytics_cache_ttl_secs: env_u64("LOGARK_ANALYTICS_CACHE_TTL_SECS", 15),
            default_window_hours: env_u32("LOGARK_DEFAULT_WINDOW_HOURS", 24),
            max_window_hours: env_u32("LOGARK_MAX_WINDOW_HOURS", 168),
            max_list_limit: env_u32("LOGARK_MAX_LIST_LIMIT", 100),
            slow_request_ms: env_i32("LOGARK_SLOW_REQUEST_MS", 1000),
        })
    }
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
