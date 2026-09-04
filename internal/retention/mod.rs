use std::time::Duration;

use anyhow::Context;
use sqlx::MySqlPool;
use tokio::{
    task::JoinHandle,
    time::{interval, MissedTickBehavior},
};

use crate::config::Config;

const MILLIS_PER_DAY: i64 = 86_400_000;
const DEFAULT_RETENTION_DAYS: u32 = 30;
const DEFAULT_INTERVAL_SECS: u64 = 3_600;
const DEFAULT_BATCH_SIZE: u32 = 1_000;
const MAX_BATCHES_PER_RUN: u32 = 100;
const CATCH_UP_PAUSE_SECS: u64 = 30;
const MIN_PLAUSIBLE_MILLIS_TIMESTAMP: i64 = 100_000_000_000;
const DELETE_EXPIRED_BATCH_SQL: &str =
    "DELETE FROM api_audit_log WHERE request_ts >= ? AND request_ts < ? ORDER BY request_ts ASC LIMIT ?";
const REQUEST_TS_INDEX_CHECK_SQL: &str = r#"
    SELECT CAST(COUNT(*) AS SIGNED)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'api_audit_log'
      AND column_name = 'request_ts'
      AND seq_in_index = 1
"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuditRetentionPolicy {
    retention_days: u32,
    interval_secs: u64,
    batch_size: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuditCleanupReport {
    pub deleted_rows: u64,
    pub cutoff_ms: i64,
    pub batch_limit_reached: bool,
}

impl AuditRetentionPolicy {
    pub fn from_config(config: &Config) -> Self {
        Self {
            retention_days: match config.audit_retention_days {
                1..=3_650 => config.audit_retention_days,
                _ => DEFAULT_RETENTION_DAYS,
            },
            interval_secs: match config.audit_cleanup_interval_secs {
                60..=604_800 => config.audit_cleanup_interval_secs,
                _ => DEFAULT_INTERVAL_SECS,
            },
            batch_size: match config.audit_cleanup_batch_size {
                1..=10_000 => config.audit_cleanup_batch_size,
                _ => DEFAULT_BATCH_SIZE,
            },
        }
    }
}

pub fn spawn_audit_retention_task(pool: MySqlPool, policy: AuditRetentionPolicy) -> JoinHandle<()> {
    tokio::spawn(async move {
        tracing::info!(
            retention_days = policy.retention_days,
            interval_secs = policy.interval_secs,
            batch_size = policy.batch_size,
            "api audit retention task started"
        );

        let mut ticker = interval(Duration::from_secs(policy.interval_secs));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;
            loop {
                match cleanup_expired_audit_records(&pool, policy).await {
                    Ok(report) if report.batch_limit_reached => {
                        tracing::warn!(
                            deleted_rows = report.deleted_rows,
                            cutoff_ms = report.cutoff_ms,
                            retention_days = policy.retention_days,
                            pause_secs = CATCH_UP_PAUSE_SECS,
                            "api audit retention cleanup reached its batch limit; catch-up will continue after a pause"
                        );
                        tokio::time::sleep(Duration::from_secs(CATCH_UP_PAUSE_SECS)).await;
                    }
                    Ok(report) if report.deleted_rows == 0 => {
                        tracing::debug!(
                            cutoff_ms = report.cutoff_ms,
                            retention_days = policy.retention_days,
                            "api audit retention cleanup completed with no expired records"
                        );
                        break;
                    }
                    Ok(report) => {
                        tracing::info!(
                            deleted_rows = report.deleted_rows,
                            cutoff_ms = report.cutoff_ms,
                            retention_days = policy.retention_days,
                            "api audit retention cleanup completed"
                        );
                        break;
                    }
                    Err(error) => {
                        tracing::error!(
                            error = ?error,
                            retention_days = policy.retention_days,
                            "api audit retention cleanup failed; it will retry on the next interval"
                        );
                        break;
                    }
                }
            }
        }
    })
}

pub async fn cleanup_expired_audit_records(
    pool: &MySqlPool,
    policy: AuditRetentionPolicy,
) -> anyhow::Result<AuditCleanupReport> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    validate_cleanup_preconditions(pool, now_ms).await?;
    let cutoff_ms = retention_cutoff_ms(now_ms, policy.retention_days);
    tracing::debug!(
        cutoff_ms,
        retention_days = policy.retention_days,
        batch_size = policy.batch_size,
        "api audit retention cleanup started"
    );
    let (deleted_rows, batch_limit_reached) =
        delete_expired_batches(pool, cutoff_ms, policy.batch_size).await?;
    Ok(AuditCleanupReport {
        deleted_rows,
        cutoff_ms,
        batch_limit_reached,
    })
}

async fn validate_cleanup_preconditions(pool: &MySqlPool, now_ms: i64) -> anyhow::Result<()> {
    let request_ts_indexes: i64 = sqlx::query_scalar(REQUEST_TS_INDEX_CHECK_SQL)
        .fetch_one(pool)
        .await
        .context("failed to verify api_audit_log.request_ts index")?;
    anyhow::ensure!(
        request_ts_indexes > 0,
        "refusing audit cleanup because api_audit_log.request_ts has no leading index"
    );

    let implausibly_small: Option<i64> = sqlx::query_scalar(
        "SELECT request_ts FROM api_audit_log \
         WHERE request_ts < ? ORDER BY request_ts ASC LIMIT 1",
    )
    .bind(MIN_PLAUSIBLE_MILLIS_TIMESTAMP)
    .fetch_optional(pool)
    .await
    .context("failed to check api_audit_log for second-scale request_ts values")?;
    anyhow::ensure!(
        implausibly_small.is_none(),
        "refusing audit cleanup because api_audit_log contains request_ts values below the plausible millisecond range"
    );

    let max_plausible_timestamp = now_ms.saturating_add(365 * MILLIS_PER_DAY);
    let implausibly_large: Option<i64> = sqlx::query_scalar(
        "SELECT request_ts FROM api_audit_log \
         WHERE request_ts > ? ORDER BY request_ts DESC LIMIT 1",
    )
    .bind(max_plausible_timestamp)
    .fetch_optional(pool)
    .await
    .context("failed to check api_audit_log for microsecond-scale request_ts values")?;
    anyhow::ensure!(
        implausibly_large.is_none(),
        "refusing audit cleanup because api_audit_log contains request_ts values above the plausible millisecond range"
    );

    Ok(())
}

async fn delete_expired_batches(
    pool: &MySqlPool,
    cutoff_ms: i64,
    batch_size: u32,
) -> anyhow::Result<(u64, bool)> {
    let batch_size = batch_size.clamp(1, 10_000);
    let mut total_deleted = 0_u64;

    for batch_number in 1..=MAX_BATCHES_PER_RUN {
        let result = sqlx::query(DELETE_EXPIRED_BATCH_SQL)
            .bind(MIN_PLAUSIBLE_MILLIS_TIMESTAMP)
            .bind(cutoff_ms)
            .bind(i64::from(batch_size))
            .execute(pool)
            .await
            .with_context(|| {
                format!("failed to delete api_audit_log records older than cutoff {cutoff_ms}")
            })?;
        let deleted_rows = result.rows_affected();
        total_deleted = total_deleted.saturating_add(deleted_rows);

        if deleted_rows < u64::from(batch_size) {
            return Ok((total_deleted, false));
        }

        if batch_number == MAX_BATCHES_PER_RUN {
            return Ok((total_deleted, true));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    Ok((total_deleted, true))
}

fn retention_cutoff_ms(now_ms: i64, retention_days: u32) -> i64 {
    let retention_ms = i64::from(retention_days)
        .checked_mul(MILLIS_PER_DAY)
        .unwrap_or(i64::MAX);
    now_ms.saturating_sub(retention_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cutoff_keeps_exactly_thirty_days() {
        let now_ms = 40 * MILLIS_PER_DAY;
        assert_eq!(retention_cutoff_ms(now_ms, 30), 10 * MILLIS_PER_DAY);
    }

    #[test]
    fn cutoff_saturates_instead_of_overflowing() {
        assert_eq!(retention_cutoff_ms(i64::MIN + 10, u32::MAX), i64::MIN);
    }

    #[test]
    fn cleanup_query_targets_only_the_audit_table_and_uses_request_time() {
        assert!(DELETE_EXPIRED_BATCH_SQL.starts_with("DELETE FROM api_audit_log "));
        assert!(DELETE_EXPIRED_BATCH_SQL.contains("request_ts >= ?"));
        assert!(DELETE_EXPIRED_BATCH_SQL.contains("request_ts < ?"));
        assert!(DELETE_EXPIRED_BATCH_SQL.contains("LIMIT ?"));
        assert!(!DELETE_EXPIRED_BATCH_SQL.contains("tg_bid_watch"));
        assert!(REQUEST_TS_INDEX_CHECK_SQL.contains("seq_in_index = 1"));
    }
}
