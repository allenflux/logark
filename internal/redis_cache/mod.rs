//! Optional shared cache for completed dashboard reports.
//!
//! Failures are cache misses, and neither credentials nor filter values are
//! included in keys or logs. SQL remains the source of truth.

use std::{
    str::FromStr,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use redis::aio::MultiplexedConnection;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::mysql::MySqlConnectOptions;
use tokio::sync::Mutex;

use crate::{config::Config, model::DashboardResponse};

const SCHEMA_VERSION: u32 = 2;
const MAX_ENVELOPE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone)]
pub struct RedisReportCache {
    client: redis::Client,
    connection: Arc<Mutex<Option<MultiplexedConnection>>>,
    namespace: String,
    ttl: Duration,
    operation_timeout: Duration,
}

/// A hit carries its remaining lifetime, so an L1 cache cannot renew old data.
pub struct CachedReport<T = DashboardResponse> {
    pub payload: T,
    pub completed_at: SystemTime,
    pub remaining_ttl: Duration,
}

#[derive(Serialize, Deserialize)]
struct Envelope<T> {
    schema_version: u32,
    completed_at_ms: u64,
    expires_at_ms: u64,
    payload: T,
}

impl RedisReportCache {
    /// Missing configuration, invalid connection information, or TTL=0 disables
    /// the optional cache without preventing the application from starting.
    pub fn from_config(config: &Config) -> Option<Self> {
        let url = config.redis_url.as_deref()?;
        Self::new(
            url,
            &config.database_url,
            Duration::from_secs(config.redis_cache_ttl_secs),
            Duration::from_millis(config.redis_operation_timeout_ms),
        )
    }

    pub fn new(
        redis_url: &str,
        database_url: &str,
        ttl: Duration,
        operation_timeout: Duration,
    ) -> Option<Self> {
        if ttl.is_zero() || operation_timeout.is_zero() {
            return None;
        }
        let Some(namespace) = database_namespace(database_url) else {
            tracing::warn!("Redis report cache disabled: invalid database configuration");
            return None;
        };
        let Ok(client) = redis::Client::open(redis_url) else {
            tracing::warn!("Redis report cache disabled: invalid Redis configuration");
            return None;
        };
        Some(Self {
            client,
            connection: Arc::new(Mutex::new(None)),
            namespace,
            ttl,
            operation_timeout,
        })
    }

    pub async fn get(&self, report_key: &str) -> Option<CachedReport> {
        self.get_typed(report_key).await
    }

    pub async fn get_typed<T: DeserializeOwned>(
        &self,
        report_key: &str,
    ) -> Option<CachedReport<T>> {
        let started = Instant::now();
        let key = self.key(report_key);
        let operation = async {
            let mut connection = self.connection().await?;
            // MULTI/EXEC binds the payload and its expiry to the same key state;
            // a concurrent writer cannot replace it between GET and PTTL.
            redis::pipe()
                .atomic()
                .cmd("GET")
                .arg(&key)
                .cmd("PTTL")
                .arg(&key)
                .query_async::<(Option<Vec<u8>>, i64)>(&mut connection)
                .await
        };
        let (bytes, pttl) = match tokio::time::timeout(self.operation_timeout, operation).await {
            Ok(Ok(result)) => result,
            _ => {
                self.discard_connection();
                tracing::debug!(operation = "read", "Redis report cache unavailable");
                return None;
            }
        };
        let decode_started = Instant::now();
        let mut report = decode_typed_hit(
            bytes.as_deref()?,
            pttl,
            SystemTime::now(),
            started.elapsed(),
            self.ttl,
        )?;
        report.remaining_ttl = report
            .remaining_ttl
            .saturating_sub(decode_started.elapsed());
        if report.remaining_ttl.is_zero() {
            return None;
        }
        tracing::debug!(hit = true, "Redis report cache read");
        Some(report)
    }

    /// Cache a successful report. The caller supplies the computation completion
    /// time; serialization, connection setup, and writes do not extend its TTL.
    pub async fn put<T: Serialize>(
        &self,
        report_key: &str,
        payload: &T,
        completed_at: SystemTime,
    ) -> bool {
        let Some(completed_at_ms) = unix_millis(completed_at) else {
            return false;
        };
        let Some(ttl_ms) = duration_millis(self.ttl) else {
            return false;
        };
        let Some(expires_at_ms) = completed_at_ms.checked_add(ttl_ms) else {
            return false;
        };
        let envelope = Envelope {
            schema_version: SCHEMA_VERSION,
            completed_at_ms,
            expires_at_ms,
            payload,
        };
        let Ok(bytes) = serde_json::to_vec(&envelope) else {
            return false;
        };
        if bytes.len() > MAX_ENVELOPE_BYTES {
            return false;
        }
        let key = self.key(report_key);
        let operation = async {
            let mut connection = self.connection().await?;
            let now_ms = unix_millis(SystemTime::now()).unwrap_or(u64::MAX);
            let Some(remaining_ms) = expires_at_ms.checked_sub(now_ms).filter(|ttl| *ttl > 0)
            else {
                return Ok(false);
            };
            if completed_at_ms > now_ms {
                return Ok(false);
            }
            redis::cmd("SET")
                .arg(&key)
                .arg(&bytes)
                .arg("PX")
                .arg(remaining_ms)
                .query_async::<()>(&mut connection)
                .await?;
            Ok::<_, redis::RedisError>(true)
        };
        match tokio::time::timeout(self.operation_timeout, operation).await {
            Ok(Ok(written)) => written,
            _ => {
                self.discard_connection();
                tracing::debug!(operation = "write", "Redis report cache unavailable");
                false
            }
        }
    }

    async fn connection(&self) -> redis::RedisResult<MultiplexedConnection> {
        let mut existing = self.connection.lock().await;
        if let Some(connection) = existing.as_ref() {
            return Ok(connection.clone());
        }
        let config = redis::AsyncConnectionConfig::new()
            .set_connection_timeout(Some(self.operation_timeout))
            .set_response_timeout(Some(self.operation_timeout));
        let connection = self
            .client
            .get_multiplexed_async_connection_with_config(&config)
            .await?;
        *existing = Some(connection.clone());
        Ok(connection)
    }

    fn discard_connection(&self) {
        // Error handling must not wait behind another connection attempt.
        if let Ok(mut connection) = self.connection.try_lock() {
            *connection = None;
        }
    }

    fn key(&self, report_key: &str) -> String {
        format!(
            "{}:{:x}",
            self.namespace,
            Sha256::digest(report_key.as_bytes())
        )
    }
}

fn database_namespace(database_url: &str) -> Option<String> {
    let options = MySqlConnectOptions::from_str(database_url).ok()?;
    // Password/TLS changes do not change the underlying data identity. Socket
    // paths are included so separate local servers cannot share report entries.
    let identity = serde_json::to_vec(&(
        options.get_host(),
        options.get_port(),
        options.get_database(),
        options.get_username(),
        options.get_socket(),
    ))
    .ok()?;
    Some(format!(
        "tracenote:dashboard:v{SCHEMA_VERSION}:{:x}",
        Sha256::digest(identity)
    ))
}

#[cfg(test)]
fn decode_hit(
    bytes: &[u8],
    redis_ttl_ms: i64,
    now: SystemTime,
    elapsed: Duration,
    configured_ttl: Duration,
) -> Option<CachedReport> {
    decode_typed_hit(bytes, redis_ttl_ms, now, elapsed, configured_ttl)
}

fn decode_typed_hit<T: DeserializeOwned>(
    bytes: &[u8],
    redis_ttl_ms: i64,
    now: SystemTime,
    elapsed: Duration,
    configured_ttl: Duration,
) -> Option<CachedReport<T>> {
    if bytes.len() > MAX_ENVELOPE_BYTES || redis_ttl_ms <= 0 {
        return None;
    }
    let envelope: Envelope<T> = serde_json::from_slice(bytes).ok()?;
    let now_ms = unix_millis(now)?;
    if envelope.schema_version != SCHEMA_VERSION || envelope.completed_at_ms > now_ms {
        return None;
    }
    let configured_expiry = envelope
        .completed_at_ms
        .checked_add(duration_millis(configured_ttl)?)?;
    let expires_at_ms = envelope.expires_at_ms.min(configured_expiry);
    let remaining_ms = expires_at_ms.checked_sub(now_ms)?;
    // Also honor Redis eviction/expiry and conservatively subtract the entire
    // round trip. Repeated reads never renew either deadline.
    let remaining_ttl = Duration::from_millis(remaining_ms)
        .min(Duration::from_millis(redis_ttl_ms as u64).saturating_sub(elapsed));
    if remaining_ttl.is_zero() || expires_at_ms <= envelope.completed_at_ms {
        return None;
    }
    Some(CachedReport {
        payload: envelope.payload,
        completed_at: UNIX_EPOCH.checked_add(Duration::from_millis(envelope.completed_at_ms))?,
        remaining_ttl,
    })
}

fn unix_millis(time: SystemTime) -> Option<u64> {
    duration_millis(time.duration_since(UNIX_EPOCH).ok()?)
}

fn duration_millis(duration: Duration) -> Option<u64> {
    u64::try_from(duration.as_millis()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload() -> DashboardResponse {
        serde_json::from_value(json!({
            "window": {"from_ts": 1000, "to_ts": 2000, "hours": 24, "bucket_ms": 3600000},
            "summary": {"total_requests": 0, "successful_requests": 0, "error_requests": 0,
                "error_rate": 0.0, "success_rate": 0.0, "avg_duration_ms": 0.0,
                "avg_error_duration_ms": 0.0, "max_duration_ms": 0, "p95_duration_ms": 0,
                "unique_api_keys": 0, "unique_task_ids": 0, "affected_paths": 0},
            "error_timeline": [], "error_status_distribution": [], "error_method_distribution": [],
            "top_error_paths": [], "top_error_api_keys": [], "top_error_task_types": [],
            "api_key_analysis": {"total_keys": 0, "failing_keys": 0, "returned_keys": 0,
                "total_requests": 0, "error_requests": 0, "limit": 20, "route_limit": 5, "keys": []},
            "failure_patterns": [], "latest_errors": [],
            "failure_pattern_coverage": {"aggregation_scope": "full_filtered_window",
                "group_by": ["method", "path", "status_code", "error_code"],
                "total_patterns": 0, "returned_patterns": 0, "returned_error_requests": 0,
                "total_error_requests": 0, "covered_error_rate": 0.0, "truncated": false,
                "limit": 12, "representative_strategy": "highest_id_per_pattern"}
        }))
        .unwrap()
    }

    fn envelope() -> Vec<u8> {
        serde_json::to_vec(&Envelope {
            schema_version: SCHEMA_VERSION,
            completed_at_ms: 10_000,
            expires_at_ms: 70_000,
            payload: payload(),
        })
        .unwrap()
    }

    fn at(ms: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(ms)
    }

    #[test]
    fn typed_route_cache_round_trip_does_not_alias_dashboard_payloads() {
        let payload = crate::model::KeyRouteErrorsResponse {
            window: crate::model::DashboardWindow {
                from_ts: 1000,
                to_ts: 2000,
                hours: 1,
                bucket_ms: 300000,
            },
            api_key: "Synthetic-key ".into(),
            path: "/Route_% ".into(),
            method: Some("POST".into()),
            task_type: None,
            patterns: vec![],
            coverage: crate::model::FailurePatternCoverage {
                aggregation_scope: "exact_key_route_window".into(),
                group_by: ["method", "path", "status_code", "error_code"].map(str::to_owned),
                total_patterns: 0,
                returned_patterns: 0,
                returned_error_requests: 0,
                total_error_requests: 0,
                covered_error_rate: 0.0,
                truncated: false,
                limit: 12,
                representative_strategy: "highest_id_per_pattern".into(),
            },
        };
        let bytes = serde_json::to_vec(&Envelope {
            schema_version: SCHEMA_VERSION,
            completed_at_ms: 10000,
            expires_at_ms: 70000,
            payload: &payload,
        })
        .unwrap();
        let hit = decode_typed_hit::<crate::model::KeyRouteErrorsResponse>(
            &bytes,
            60000,
            at(20000),
            Duration::ZERO,
            Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(hit.payload).unwrap(),
            serde_json::to_value(payload).unwrap()
        );
        assert_eq!(hit.remaining_ttl, Duration::from_secs(50));
        assert!(decode_hit(
            &bytes,
            60000,
            at(20000),
            Duration::ZERO,
            Duration::from_secs(60)
        )
        .is_none());
    }

    #[test]
    fn keys_isolate_databases_and_filters_but_not_password_rotation() {
        let make = |database_url: &str| {
            RedisReportCache::new(
                "redis://127.0.0.1/",
                database_url,
                Duration::from_secs(60),
                Duration::from_millis(200),
            )
            .unwrap()
        };
        let cache = make("mysql://reader:first-password@db:3306/audit");
        let rotated = make("mysql://reader:second-password@db:3306/audit");
        let key = cache.key("24h:sensitive-api-key");
        assert_eq!(key, rotated.key("24h:sensitive-api-key"));
        assert!(!key.contains("sensitive-api-key"));
        assert!(!key.contains("first-password"));
        for database in [
            "mysql://reader@other:3306/audit",
            "mysql://reader@db:3307/audit",
            "mysql://reader@db:3306/other",
            "mysql://other@db:3306/audit",
        ] {
            assert_ne!(key, make(database).key("24h:sensitive-api-key"));
        }
        assert_ne!(key, cache.key("48h:sensitive-api-key"));
    }

    #[test]
    fn report_json_round_trip_preserves_api_shape() {
        let original = serde_json::to_value(payload()).unwrap();
        let hit = decode_hit(
            &envelope(),
            60_000,
            at(10_000),
            Duration::ZERO,
            Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(serde_json::to_value(hit.payload).unwrap(), original);
        assert_eq!(hit.completed_at, at(10_000));
    }

    #[test]
    fn repeated_reads_and_new_ttl_do_not_renew_completion_deadline() {
        let first = decode_hit(
            &envelope(),
            60_000,
            at(20_000),
            Duration::ZERO,
            Duration::from_secs(60),
        )
        .unwrap();
        let later = decode_hit(
            &envelope(),
            60_000,
            at(69_000),
            Duration::ZERO,
            Duration::from_secs(120),
        )
        .unwrap();
        assert_eq!(first.remaining_ttl, Duration::from_secs(50));
        assert_eq!(later.remaining_ttl, Duration::from_secs(1));
        let shorter = decode_hit(
            &envelope(),
            60_000,
            at(20_000),
            Duration::ZERO,
            Duration::from_secs(15),
        )
        .unwrap();
        assert_eq!(shorter.remaining_ttl, Duration::from_secs(5));
        let redis_limit = decode_hit(
            &envelope(),
            500,
            at(20_000),
            Duration::from_millis(50),
            Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(redis_limit.remaining_ttl, Duration::from_millis(450));
    }

    #[test]
    fn malformed_expired_missing_expiry_and_future_entries_are_misses() {
        let read = |bytes: &[u8], pttl, time| {
            decode_hit(
                bytes,
                pttl,
                at(time),
                Duration::ZERO,
                Duration::from_secs(60),
            )
        };
        assert!(read(b"not json", 1000, 20_000).is_none());
        assert!(read(&envelope(), -1, 20_000).is_none());
        assert!(read(&envelope(), -2, 20_000).is_none());
        assert!(read(&envelope(), 1000, 70_000).is_none());
        assert!(read(&envelope(), 1000, 9_999).is_none());
        let mut wrong_version: serde_json::Value = serde_json::from_slice(&envelope()).unwrap();
        wrong_version["schema_version"] = json!(SCHEMA_VERSION + 1);
        assert!(read(&serde_json::to_vec(&wrong_version).unwrap(), 1000, 20_000).is_none());
        assert!(read(&vec![b' '; MAX_ENVELOPE_BYTES + 1], 1000, 20_000).is_none());
    }

    #[tokio::test]
    async fn unreachable_redis_is_a_bounded_miss_and_failed_write() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let cache = RedisReportCache::new(
            &format!("redis://{address}/"),
            "mysql://reader@fixture/audit",
            Duration::from_secs(60),
            Duration::from_millis(50),
        )
        .unwrap();
        let started = Instant::now();
        assert!(cache.get("24h").await.is_none());
        assert!(!cache.put("24h", &payload(), SystemTime::now()).await);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn stalled_redis_connection_cannot_block_the_report() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });
        let cache = RedisReportCache::new(
            &format!("redis://{address}/"),
            "mysql://reader@fixture/audit",
            Duration::from_secs(60),
            Duration::from_millis(40),
        )
        .unwrap();
        let started = Instant::now();
        assert!(cache.get("24h").await.is_none());
        assert!(started.elapsed() < Duration::from_millis(500));
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    #[ignore = "requires LOGARK_TEST_REDIS_URL pointing to a disposable Redis instance"]
    async fn disposable_redis_round_trip_expiry_and_corruption() -> anyhow::Result<()> {
        let url = std::env::var("LOGARK_TEST_REDIS_URL")?;
        let cache = RedisReportCache::new(
            &url,
            "mysql://fixture@localhost/isolated_report_test",
            Duration::from_millis(500),
            Duration::from_secs(2),
        )
        .unwrap();
        let report_key = format!("test-{}", unix_millis(SystemTime::now()).unwrap());
        let completed_at = SystemTime::now() - Duration::from_millis(100);
        assert!(cache.put(&report_key, &payload(), completed_at).await);
        let first = cache.get(&report_key).await.unwrap();
        assert!(first.remaining_ttl <= Duration::from_millis(400));
        assert_eq!(
            serde_json::to_value(first.payload)?,
            serde_json::to_value(payload())?
        );
        tokio::time::sleep(Duration::from_millis(80)).await;
        let second = cache.get(&report_key).await.unwrap();
        assert!(second.remaining_ttl < first.remaining_ttl);
        tokio::time::sleep(Duration::from_millis(430)).await;
        assert!(cache.get(&report_key).await.is_none());
        assert!(!cache.put(&report_key, &payload(), completed_at).await);
        let mut connection = cache.connection().await?;
        redis::cmd("SET")
            .arg(cache.key(&report_key))
            .arg("invalid report")
            .arg("PX")
            .arg(1000)
            .query_async::<()>(&mut connection)
            .await?;
        assert!(cache.get(&report_key).await.is_none());
        redis::cmd("DEL")
            .arg(cache.key(&report_key))
            .query_async::<i64>(&mut connection)
            .await?;
        Ok(())
    }
}
