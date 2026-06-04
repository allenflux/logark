use sqlx::{mysql::MySqlPoolOptions, MySqlPool};

pub async fn connect(database_url: &str, max_connections: u32) -> anyhow::Result<MySqlPool> {
    let pool = MySqlPoolOptions::new()
        .max_connections(max_connections)
        .connect(database_url)
        .await?;
    Ok(pool)
}

pub async fn migrate(pool: &MySqlPool) -> anyhow::Result<()> {
    let sql = include_str!("../../migrations/001_init.sql");
    sqlx::raw_sql(sql).execute(pool).await?;
    ensure_column(
        pool,
        "api_audit_log",
        "api_key",
        "ALTER TABLE api_audit_log ADD COLUMN api_key VARCHAR(255) NULL AFTER user_agent",
    )
    .await?;
    ensure_index(
        pool,
        "api_audit_log",
        "idx_api_key_request_ts",
        "ALTER TABLE api_audit_log ADD INDEX idx_api_key_request_ts (api_key, request_ts)",
    )
    .await?;
    Ok(())
}

async fn ensure_column(
    pool: &MySqlPool,
    table_name: &str,
    column_name: &str,
    ddl: &str,
) -> anyhow::Result<()> {
    let exists = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = ?
          AND column_name = ?
        "#,
    )
    .bind(table_name)
    .bind(column_name)
    .fetch_one(pool)
    .await?;

    if exists == 0 {
        sqlx::query(ddl).execute(pool).await?;
    }

    Ok(())
}

async fn ensure_index(
    pool: &MySqlPool,
    table_name: &str,
    index_name: &str,
    ddl: &str,
) -> anyhow::Result<()> {
    let exists = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = ?
          AND index_name = ?
        "#,
    )
    .bind(table_name)
    .bind(index_name)
    .fetch_one(pool)
    .await?;

    if exists == 0 {
        sqlx::query(ddl).execute(pool).await?;
    }

    Ok(())
}
