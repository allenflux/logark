mod dashboard_cache;
mod key_route;
pub use key_route::KeyRouteError;

use std::time::{Duration, Instant, SystemTime};

use dashboard_cache::DashboardCache;
use sqlx::{MySql, MySqlPool, QueryBuilder, Row};

use crate::{
    config::Config,
    model::{
        ApiKeyAnalysis, ApiKeyFailure, ApiKeyRoute, AuditRecordDetail, AuditRecordSummary,
        BidReport, BidReportWindow, BidStatusCodeStat, BidWatchItem, DashboardQuery,
        DashboardResponse, DashboardSummary, DashboardWindow, ErrorRateSlice, FailurePattern,
        FailurePatternCoverage, KeyRouteErrorsResponse, MetricSlice, RecordListQuery,
        RecordListResponse, TimelinePoint,
    },
    redis_cache::RedisReportCache,
};

#[derive(Clone)]
pub struct AuditAnalyticsService {
    pool: MySqlPool,
    config: Config,
    dashboard_cache: std::sync::Arc<DashboardCache<DashboardResponse>>,
    key_route_cache: std::sync::Arc<DashboardCache<KeyRouteErrorsResponse>>,
    redis_cache: Option<RedisReportCache>,
}

#[derive(Clone)]
struct AnalyticsWindow {
    from_ts: i64,
    to_ts: i64,
    hours: u32,
    bucket_ms: i64,
}

#[derive(Clone)]
struct CommonFilter {
    path: Option<String>,
    method: Option<String>,
    api_key: Option<String>,
    task_type: Option<String>,
}

const FAILURE_PATTERN_LIMIT: usize = 12;
const FAILURE_PATTERN_ERROR_CODE: &str = "NULLIF(TRIM(error_code), '')";
const API_KEY_LIMIT: usize = 20;
const API_KEY_ROUTE_LIMIT: usize = 5;
const LEGACY_API_KEY_LIMIT: usize = 8;

#[derive(sqlx::FromRow)]
struct ApiKeyAnalysisRow {
    api_key: String,
    path: String,
    route_requests: i64,
    route_errors: i64,
    key_requests: i64,
    key_errors: i64,
    affected_routes: i64,
    key_rank: i64,
    failure_count_rank: i64,
    route_rank: i64,
    total_keys: i64,
    failing_keys: i64,
    total_requests: i64,
    error_requests: i64,
}

#[derive(sqlx::FromRow)]
struct FailurePatternRow {
    normalized_error_code: Option<String>,
    count: i64,
    first_seen_ts: i64,
    last_seen_ts: i64,
    avg_duration_ms: f64,
    max_duration_ms: i64,
    total_patterns: i64,
    total_error_requests: i64,
    #[sqlx(flatten)]
    representative: AuditRecordSummary,
}

impl AuditAnalyticsService {
    pub fn new(pool: MySqlPool, config: Config) -> Self {
        // A report already fans out into nine SQL branches. Bound distinct
        // reports as well as coalescing requests for the same filter.
        let concurrent_reports = (config.db_max_connections / 9).clamp(1, 2) as usize;
        let query_timeout = Duration::from_secs(config.analytics_query_timeout_secs);
        let redis_cache = RedisReportCache::from_config(&config);
        tracing::info!(
            redis_enabled = redis_cache.is_some(),
            memory_cache_ttl_secs = config.analytics_cache_ttl_secs,
            redis_cache_ttl_secs = config.redis_cache_ttl_secs,
            "report cache configured"
        );
        Self {
            pool,
            config,
            dashboard_cache: DashboardCache::new(64, concurrent_reports, query_timeout),
            key_route_cache: DashboardCache::new(32, 1, query_timeout.min(Duration::from_secs(30))),
            redis_cache,
        }
    }

    pub async fn dashboard(&self, query: DashboardQuery) -> anyhow::Result<DashboardResponse> {
        let window = self.resolve_window(query.hours);
        let filter = CommonFilter {
            path: normalize_str(query.path),
            method: normalize_str(query.method).map(|v| v.to_uppercase()),
            api_key: normalize_api_key(query.api_key),
            task_type: normalize_str(query.task_type),
        };
        let cache_key = dashboard_cache_key(&window, &filter);
        let ttl = Duration::from_secs(self.config.analytics_cache_ttl_secs);
        let service = self.clone();
        let shared_cache = self.redis_cache.clone();
        let shared_key = cache_key.clone();
        let payload = self
            .dashboard_cache
            .get_or_load_with_cache(
                cache_key.clone(),
                async move {
                    let cached = shared_cache?.get(&shared_key).await?;
                    Some((cached.payload, ttl.min(cached.remaining_ttl)))
                },
                async move {
                    // Resolve time after queueing so a report always describes its
                    // actual computation window, not when a waiting client arrived.
                    let window = service.resolve_window(Some(window.hours));
                    let payload = service.compute_dashboard(&window, &filter).await?;
                    let completed_at = SystemTime::now();
                    let completed_instant = Instant::now();
                    if let Some(redis) = &service.redis_cache {
                        redis.put(&cache_key, &payload, completed_at).await;
                    }
                    Ok((payload, ttl.saturating_sub(completed_instant.elapsed())))
                },
            )
            .await?;
        Ok((*payload).clone())
    }

    async fn compute_dashboard(
        &self,
        window: &AnalyticsWindow,
        filter: &CommonFilter,
    ) -> anyhow::Result<DashboardResponse> {
        let (
            summary,
            error_timeline,
            top_error_paths,
            error_status_distribution,
            error_method_distribution,
            (api_key_analysis, top_error_api_keys),
            top_error_task_types,
            (failure_patterns, failure_pattern_coverage),
            latest_errors,
        ) = tokio::try_join!(
            timed_dashboard_query("summary", self.fetch_summary(window, filter)),
            timed_dashboard_query("timeline", self.fetch_timeline(window, filter)),
            timed_dashboard_query("paths", self.fetch_top_error_paths(window, filter)),
            timed_dashboard_query(
                "statuses",
                self.fetch_error_status_distribution(window, filter)
            ),
            timed_dashboard_query(
                "methods",
                self.fetch_error_method_distribution(window, filter)
            ),
            timed_dashboard_query("api_keys", self.fetch_api_key_analysis(window, filter)),
            timed_dashboard_query(
                "task_types",
                self.fetch_top_error_task_types(window, filter)
            ),
            timed_dashboard_query(
                "failure_patterns",
                self.fetch_failure_patterns(window, filter)
            ),
            timed_dashboard_query("latest_errors", self.fetch_latest_errors(window, filter)),
        )?;

        let payload = DashboardResponse {
            window: DashboardWindow {
                from_ts: window.from_ts,
                to_ts: window.to_ts,
                bucket_ms: window.bucket_ms,
                hours: window.hours,
            },
            summary,
            error_timeline,
            error_status_distribution,
            error_method_distribution,
            top_error_paths,
            top_error_api_keys,
            api_key_analysis,
            top_error_task_types,
            failure_patterns,
            failure_pattern_coverage,
            latest_errors,
        };

        Ok(payload)
    }

    pub async fn list_records(&self, query: RecordListQuery) -> anyhow::Result<RecordListResponse> {
        let window = self.resolve_window(query.hours);
        let limit = query
            .limit
            .unwrap_or(30)
            .clamp(1, self.config.max_list_limit) as usize;

        let mut qb: QueryBuilder<MySql> = QueryBuilder::new(
            "SELECT id, request_id, request_ts, duration_ms, method, path, status_code, client_ip, api_key, task_id, task_type, error_code FROM api_audit_log WHERE request_ts BETWEEN ",
        );
        qb.push_bind(window.from_ts)
            .push(" AND ")
            .push_bind(window.to_ts);

        if let Some(request_id) = normalize_str(query.request_id) {
            qb.push(" AND request_id = ").push_bind(request_id);
        }
        if let Some(task_id) = normalize_str(query.task_id) {
            qb.push(" AND task_id = ").push_bind(task_id);
        }
        if let Some(uuid) = normalize_str(query.uuid) {
            qb.push(" AND uuid = ").push_bind(uuid);
        }
        if let Some(bid) = normalize_str(query.bid) {
            qb.push(" AND bid = ").push_bind(bid);
        }
        if let Some(path) = normalize_str(query.path) {
            qb.push(" AND path LIKE CONCAT(")
                .push_bind(path)
                .push(", '%')");
        }
        if let Some(method) = normalize_str(query.method) {
            qb.push(" AND method = ").push_bind(method.to_uppercase());
        }
        if let Some(api_key) = normalize_api_key(query.api_key) {
            qb.push(" AND api_key = ")
                .push_bind(api_key.clone())
                .push(" AND BINARY api_key = BINARY ")
                .push_bind(api_key);
        }
        push_record_status_filter(&mut qb, query.status_code, query.non_200.unwrap_or(false));
        if let Some(task_type) = normalize_str(query.task_type) {
            qb.push(" AND task_type = ").push_bind(task_type);
        }
        if let Some(error_code) = normalize_str(query.error_code) {
            qb.push(" AND error_code = ").push_bind(error_code);
        }
        if let (Some(cursor_ts), Some(cursor_id)) = (query.cursor_ts, query.cursor_id) {
            qb.push(" AND (request_ts < ")
                .push_bind(cursor_ts)
                .push(" OR (request_ts = ")
                .push_bind(cursor_ts)
                .push(" AND id < ")
                .push_bind(cursor_id)
                .push("))");
        }

        qb.push(" ORDER BY request_ts DESC, id DESC LIMIT ")
            .push_bind((limit + 1) as i64);

        let mut items = qb
            .build_query_as::<AuditRecordSummary>()
            .fetch_all(&self.pool)
            .await?;

        let has_more = items.len() > limit;
        if has_more {
            items.pop();
        }

        let next_cursor_ts = items
            .last()
            .map(|item| item.request_ts)
            .filter(|_| has_more);
        let next_cursor_id = items.last().map(|item| item.id).filter(|_| has_more);

        Ok(RecordListResponse {
            items,
            next_cursor_ts,
            next_cursor_id,
        })
    }

    pub async fn get_record_by_id(&self, id: u64) -> anyhow::Result<Option<AuditRecordDetail>> {
        let record = sqlx::query_as::<_, AuditRecordDetail>(
            r#"
            SELECT
                id, request_id, request_ts, response_ts, duration_ms, method, path, query_string,
                status_code, client_ip, user_agent, api_key, request_content_type,
                response_content_type, request_headers_json, response_headers_json, request_body,
                response_body, request_body_size, response_body_size, request_body_truncated,
                response_body_truncated, uuid, task_id, task_type, bid, error_code, created_ts
            FROM api_audit_log
            WHERE id = ?
            LIMIT 1
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(record)
    }

    pub async fn get_record_by_request_id(
        &self,
        request_id: &str,
    ) -> anyhow::Result<Option<AuditRecordDetail>> {
        let record = sqlx::query_as::<_, AuditRecordDetail>(
            r#"
            SELECT
                id, request_id, request_ts, response_ts, duration_ms, method, path, query_string,
                status_code, client_ip, user_agent, api_key, request_content_type,
                response_content_type, request_headers_json, response_headers_json, request_body,
                response_body, request_body_size, response_body_size, request_body_truncated,
                response_body_truncated, uuid, task_id, task_type, bid, error_code, created_ts
            FROM api_audit_log
            WHERE request_id = ?
            ORDER BY id DESC
            LIMIT 1
            "#,
        )
        .bind(request_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(record)
    }

    pub async fn get_record_by_uuid(
        &self,
        uuid: &str,
    ) -> anyhow::Result<Option<AuditRecordDetail>> {
        let record = sqlx::query_as::<_, AuditRecordDetail>(
            r#"
            SELECT
                id, request_id, request_ts, response_ts, duration_ms, method, path, query_string,
                status_code, client_ip, user_agent, api_key, request_content_type,
                response_content_type, request_headers_json, response_headers_json, request_body,
                response_body, request_body_size, response_body_size, request_body_truncated,
                response_body_truncated, uuid, task_id, task_type, bid, error_code, created_ts
            FROM api_audit_log
            WHERE uuid = ?
            ORDER BY id DESC
            LIMIT 1
            "#,
        )
        .bind(uuid)
        .fetch_optional(&self.pool)
        .await?;
        Ok(record)
    }

    pub async fn cache_entry_count(&self) -> usize {
        self.dashboard_cache.len().await
    }

    pub async fn check_database_ready(&self) -> anyhow::Result<()> {
        // Include waiting for a pooled connection in the deadline. Readiness
        // must not scan audit data or compete with report aggregation.
        tokio::time::timeout(
            Duration::from_secs(2),
            sqlx::query("SELECT 1").execute(&self.pool),
        )
        .await
        .map_err(|_| anyhow::anyhow!("database readiness check timed out"))??;
        Ok(())
    }

    pub async fn report_status_400_bids(
        &self,
        from_ts: i64,
        to_ts: i64,
        limit: u32,
    ) -> anyhow::Result<BidReport> {
        let ranking = self
            .fetch_bid_status_code_stats(from_ts, to_ts, Some(limit), None)
            .await?;
        let watched_bids = self.list_watched_bids().await?;
        let watched = if watched_bids.is_empty() {
            Vec::new()
        } else {
            let bids = watched_bids
                .into_iter()
                .map(|item| item.bid)
                .collect::<Vec<_>>();
            self.fetch_bid_status_code_stats(from_ts, to_ts, None, Some(bids))
                .await?
        };

        Ok(BidReport {
            window: BidReportWindow {
                from_ts,
                to_ts,
                label: format!("{from_ts}-{to_ts}"),
            },
            ranking,
            watched,
        })
    }

    pub async fn get_bid_status_400_stats(
        &self,
        bid: &str,
        from_ts: i64,
        to_ts: i64,
    ) -> anyhow::Result<Option<BidStatusCodeStat>> {
        let bid = bid.trim();
        if bid.is_empty() {
            return Ok(None);
        }

        let mut stats = self
            .fetch_bid_status_code_stats(from_ts, to_ts, Some(1), Some(vec![bid.to_string()]))
            .await?;
        Ok(stats.pop())
    }

    pub async fn add_watched_bid(&self, bid: &str, note: Option<&str>) -> anyhow::Result<()> {
        let bid = bid.trim();
        anyhow::ensure!(!bid.is_empty(), "bid cannot be empty");

        sqlx::query(
            r#"
            INSERT INTO tg_bid_watch (bid, note, created_ts)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE note = VALUES(note)
            "#,
        )
        .bind(bid)
        .bind(note.map(str::trim).filter(|value| !value.is_empty()))
        .bind(chrono::Utc::now().timestamp_millis())
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    pub async fn remove_watched_bid(&self, bid: &str) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM tg_bid_watch WHERE bid = ?")
            .bind(bid.trim())
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn list_watched_bids(&self) -> anyhow::Result<Vec<BidWatchItem>> {
        let rows = sqlx::query(
            r#"
            SELECT bid, note, created_ts
            FROM tg_bid_watch
            ORDER BY created_ts ASC, bid ASC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                Ok(BidWatchItem {
                    bid: row.try_get("bid")?,
                    note: row.try_get("note")?,
                    created_ts: row.try_get("created_ts")?,
                })
            })
            .collect()
    }

    fn resolve_window(&self, hours: Option<u32>) -> AnalyticsWindow {
        let hours = hours
            .unwrap_or(self.config.default_window_hours)
            .clamp(1, self.config.max_window_hours);
        let now_ts = chrono::Utc::now().timestamp_millis();
        let from_ts = now_ts - i64::from(hours) * 3_600_000;
        let bucket_ms = if hours <= 6 {
            300_000
        } else if hours <= 24 {
            900_000
        } else {
            // Keep an exact hourly series even for the seven-day view. The
            // browser merges it only for the compact table; the volume chart
            // still retains one point per hour.
            3_600_000
        };

        AnalyticsWindow {
            from_ts,
            to_ts: now_ts,
            hours,
            bucket_ms,
        }
    }

    async fn fetch_summary(
        &self,
        window: &AnalyticsWindow,
        filter: &CommonFilter,
    ) -> anyhow::Result<DashboardSummary> {
        let mut qb: QueryBuilder<MySql> = QueryBuilder::new(
            "SELECT CAST(COUNT(*) AS SIGNED) AS total_requests, \
             CAST(COALESCE(SUM(CASE WHEN status_code = 200 THEN 1 ELSE 0 END), 0) AS SIGNED) AS successful_requests, \
             CAST(COALESCE(SUM(CASE WHEN status_code <> 200 THEN 1 ELSE 0 END), 0) AS SIGNED) AS error_requests, \
             CAST(COALESCE(AVG(duration_ms), 0) AS DOUBLE) AS avg_duration_ms, \
             CAST(COALESCE(AVG(CASE WHEN status_code <> 200 THEN duration_ms END), 0) AS DOUBLE) AS avg_error_duration_ms, \
             CAST(COALESCE(MAX(duration_ms), 0) AS SIGNED) AS max_duration_ms, \
             CAST(COUNT(DISTINCT CASE WHEN api_key REGEXP '[^[:space:]]' THEN BINARY api_key END) AS SIGNED) AS unique_api_keys, \
             CAST(COUNT(DISTINCT NULLIF(task_id, '')) AS SIGNED) AS unique_task_ids, \
             CAST(COUNT(DISTINCT CASE WHEN status_code <> 200 THEN NULLIF(path, '') END) AS SIGNED) AS affected_paths \
             FROM api_audit_log WHERE request_ts BETWEEN ",
        );
        qb.push_bind(window.from_ts)
            .push(" AND ")
            .push_bind(window.to_ts);
        push_common_filters(&mut qb, filter);

        let row = qb.build().fetch_one(&self.pool).await?;
        let total_requests: i64 = row.try_get("total_requests")?;
        let successful_requests: i64 = row.try_get("successful_requests")?;
        let error_requests: i64 = row.try_get("error_requests")?;
        let avg_duration_ms: f64 = row.try_get("avg_duration_ms")?;
        let avg_error_duration_ms: f64 = row.try_get("avg_error_duration_ms")?;
        let max_duration_ms: i64 = row.try_get("max_duration_ms")?;
        let unique_api_keys: i64 = row.try_get("unique_api_keys")?;
        let unique_task_ids: i64 = row.try_get("unique_task_ids")?;
        let affected_paths: i64 = row.try_get("affected_paths")?;
        let p95_duration_ms = self
            .fetch_p95_duration(window, filter, total_requests)
            .await?;
        let error_rate = percentage(error_requests, total_requests);
        let success_rate = percentage(successful_requests, total_requests);

        Ok(DashboardSummary {
            total_requests,
            successful_requests,
            error_requests,
            error_rate,
            success_rate,
            avg_duration_ms,
            avg_error_duration_ms,
            max_duration_ms: i32::try_from(max_duration_ms).unwrap_or(i32::MAX),
            p95_duration_ms,
            unique_api_keys,
            unique_task_ids,
            affected_paths,
        })
    }

    async fn fetch_p95_duration(
        &self,
        window: &AnalyticsWindow,
        filter: &CommonFilter,
        total_requests: i64,
    ) -> anyhow::Result<i32> {
        if total_requests <= 0 {
            return Ok(0);
        }

        let started_at = Instant::now();
        let result: anyhow::Result<i32> = async {
            Ok(p95_duration_query(window, filter)
                .build_query_scalar::<i32>()
                .fetch_optional(&self.pool)
                .await?
                .unwrap_or(0))
        }
        .await;
        tracing::info!(
            query = "p95_duration",
            elapsed_ms = started_at.elapsed().as_millis() as u64,
            success = result.is_ok(),
            "dashboard query finished"
        );
        result
    }

    async fn fetch_timeline(
        &self,
        window: &AnalyticsWindow,
        filter: &CommonFilter,
    ) -> anyhow::Result<Vec<TimelinePoint>> {
        let bucket_ms = window.bucket_ms;
        let mut qb: QueryBuilder<MySql> = QueryBuilder::new("SELECT CAST(FLOOR(request_ts / ");
        qb.push_bind(bucket_ms)
            .push(") * ")
            .push_bind(bucket_ms)
            .push(" AS SIGNED)")
            .push(
                " AS ts, CAST(COUNT(*) AS SIGNED) AS count, CAST(COALESCE(AVG(duration_ms), 0) AS DOUBLE) AS avg_duration_ms, \
                 CAST(COALESCE(SUM(CASE WHEN status_code <> 200 THEN 1 ELSE 0 END), 0) AS SIGNED) AS error_count \
                 FROM api_audit_log WHERE request_ts BETWEEN ",
            )
            .push_bind(window.from_ts)
            .push(" AND ")
            .push_bind(window.to_ts);
        push_common_filters(&mut qb, filter);
        qb.push(" GROUP BY ts ORDER BY ts ASC");

        let rows = qb.build().fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|row| {
                let count = row.try_get("count")?;
                let error_count = row.try_get("error_count")?;
                Ok(TimelinePoint {
                    ts: row.try_get("ts")?,
                    count,
                    avg_duration_ms: row.try_get("avg_duration_ms")?,
                    error_count,
                    error_rate: percentage(error_count, count),
                })
            })
            .collect()
    }

    async fn fetch_top_error_paths(
        &self,
        window: &AnalyticsWindow,
        filter: &CommonFilter,
    ) -> anyhow::Result<Vec<ErrorRateSlice>> {
        self.fetch_top_error_dimension(window, filter, "path", 10)
            .await
    }

    async fn fetch_top_error_task_types(
        &self,
        window: &AnalyticsWindow,
        filter: &CommonFilter,
    ) -> anyhow::Result<Vec<ErrorRateSlice>> {
        self.fetch_top_error_dimension(window, filter, "task_type", 8)
            .await
    }

    async fn fetch_error_status_distribution(
        &self,
        window: &AnalyticsWindow,
        filter: &CommonFilter,
    ) -> anyhow::Result<Vec<MetricSlice>> {
        let mut qb: QueryBuilder<MySql> = QueryBuilder::new(
            "SELECT CAST(status_code AS CHAR) AS label, CAST(COUNT(*) AS SIGNED) AS value \
             FROM api_audit_log WHERE request_ts BETWEEN ",
        );
        qb.push_bind(window.from_ts)
            .push(" AND ")
            .push_bind(window.to_ts)
            .push(" AND status_code <> 200");
        push_common_filters(&mut qb, filter);
        qb.push(" GROUP BY status_code ORDER BY value DESC, status_code ASC LIMIT 8");

        let rows = qb.build().fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|row| {
                Ok(MetricSlice {
                    label: row.try_get("label")?,
                    value: row.try_get("value")?,
                })
            })
            .collect()
    }

    async fn fetch_error_method_distribution(
        &self,
        window: &AnalyticsWindow,
        filter: &CommonFilter,
    ) -> anyhow::Result<Vec<ErrorRateSlice>> {
        self.fetch_top_error_dimension(window, filter, "method", 8)
            .await
    }

    async fn fetch_api_key_analysis(
        &self,
        window: &AnalyticsWindow,
        filter: &CommonFilter,
    ) -> anyhow::Result<(ApiKeyAnalysis, Vec<ErrorRateSlice>)> {
        let rows = api_key_analysis_query(window, filter)
            .build_query_as::<ApiKeyAnalysisRow>()
            .fetch_all(&self.pool)
            .await?;
        Ok(api_key_analysis_from_rows(rows))
    }

    async fn fetch_latest_errors(
        &self,
        window: &AnalyticsWindow,
        filter: &CommonFilter,
    ) -> anyhow::Result<Vec<AuditRecordSummary>> {
        let mut qb: QueryBuilder<MySql> = QueryBuilder::new(
            "SELECT id, request_id, request_ts, duration_ms, method, path, status_code, client_ip, api_key, task_id, task_type, error_code \
             FROM api_audit_log WHERE request_ts BETWEEN ",
        );
        qb.push_bind(window.from_ts)
            .push(" AND ")
            .push_bind(window.to_ts)
            .push(" AND status_code <> 200");
        push_common_filters(&mut qb, filter);
        qb.push(" ORDER BY request_ts DESC, id DESC LIMIT 8");

        let rows = qb
            .build_query_as::<AuditRecordSummary>()
            .fetch_all(&self.pool)
            .await?;
        Ok(rows)
    }

    async fn fetch_failure_patterns(
        &self,
        window: &AnalyticsWindow,
        filter: &CommonFilter,
    ) -> anyhow::Result<(Vec<FailurePattern>, FailurePatternCoverage)> {
        let rows = failure_patterns_query(window, filter)
            .build_query_as::<FailurePatternRow>()
            .fetch_all(&self.pool)
            .await?;
        Ok(failure_patterns_from_rows(rows))
    }

    async fn fetch_top_error_dimension(
        &self,
        window: &AnalyticsWindow,
        filter: &CommonFilter,
        column: &str,
        limit: i64,
    ) -> anyhow::Result<Vec<ErrorRateSlice>> {
        let mut qb: QueryBuilder<MySql> = QueryBuilder::new("SELECT ");
        qb.push(column)
            .push(
                " AS label, CAST(COUNT(*) AS SIGNED) AS total_requests, \
                 CAST(COALESCE(SUM(CASE WHEN status_code <> 200 THEN 1 ELSE 0 END), 0) AS SIGNED) AS error_requests \
                 FROM api_audit_log",
            )
            // Without an explicit task-type filter, MariaDB can choose the
            // old non-covering task-type index just for IS NOT NULL, reading
            // the wide audit rows even when a report covering index exists.
            // Keep that selective index available when a task type is chosen.
            .push(if column == "task_type" && filter.task_type.is_none() {
                " IGNORE INDEX (idx_task_type_request_ts)"
            } else {
                ""
            })
            .push(" WHERE request_ts BETWEEN ")
            .push_bind(window.from_ts)
            .push(" AND ")
            .push_bind(window.to_ts)
            .push(" AND ")
            .push(column)
            .push(" IS NOT NULL AND ")
            .push(column)
            .push(" != ''");
        push_common_filters(&mut qb, filter);
        qb.push(" GROUP BY ")
            .push(column)
            .push(
                " HAVING error_requests > 0 \
                 ORDER BY error_requests DESC, total_requests DESC, ",
            )
            .push(column)
            .push(" ASC LIMIT ")
            .push_bind(limit);

        let rows = qb.build().fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|row| {
                let total_requests = row.try_get("total_requests")?;
                let error_requests = row.try_get("error_requests")?;
                Ok(ErrorRateSlice {
                    label: row.try_get("label")?,
                    total_requests,
                    error_requests,
                    error_rate: percentage(error_requests, total_requests),
                })
            })
            .collect()
    }

    async fn fetch_bid_status_code_stats(
        &self,
        from_ts: i64,
        to_ts: i64,
        limit: Option<u32>,
        bids: Option<Vec<String>>,
    ) -> anyhow::Result<Vec<BidStatusCodeStat>> {
        let mut qb: QueryBuilder<MySql> = QueryBuilder::new(
            "SELECT bid, \
             CAST(COUNT(*) AS SIGNED) AS total_calls, \
             CAST(COALESCE(SUM(CASE WHEN status_code = 400 THEN 1 ELSE 0 END), 0) AS SIGNED) AS status_400_calls, \
             CAST(COUNT(DISTINCT NULLIF(task_id, '')) AS SIGNED) AS distinct_task_ids, \
             CAST(COUNT(DISTINCT NULLIF(api_key, '')) AS SIGNED) AS distinct_api_keys, \
             CAST(COALESCE(MAX(request_ts), 0) AS SIGNED) AS last_request_ts \
             FROM api_audit_log WHERE request_ts BETWEEN ",
        );
        qb.push_bind(from_ts)
            .push(" AND ")
            .push_bind(to_ts)
            .push(" AND bid IS NOT NULL AND bid != ''");

        if let Some(bids) = bids.filter(|items| !items.is_empty()) {
            qb.push(" AND bid IN (");
            let mut separated = qb.separated(", ");
            for bid in bids {
                separated.push_bind(bid);
            }
            separated.push_unseparated(")");
        }

        qb.push(" GROUP BY bid HAVING status_400_calls > 0 ORDER BY status_400_calls DESC, total_calls DESC, bid ASC");

        if let Some(limit) = limit {
            qb.push(" LIMIT ").push_bind(i64::from(limit));
        }

        qb.build_query_as::<BidStatusCodeStat>()
            .fetch_all(&self.pool)
            .await
            .map_err(Into::into)
    }
}

fn p95_duration_query<'a>(
    window: &AnalyticsWindow,
    filter: &'a CommonFilter,
) -> QueryBuilder<'a, MySql> {
    // Group equal integer durations before sorting. The descending nearest
    // rank is floor(N / 20) + 1, so choose the first frequency bucket whose
    // cumulative count exceeds floor(N / 20). This remains exact, including
    // ties, and avoids OFFSET retrieving tens of thousands of wide audit rows.
    // Both N and the cumulative counts use this statement's snapshot.
    let mut qb = QueryBuilder::new(
        "SELECT duration_ms FROM (SELECT duration_ms, \
         SUM(COUNT(*)) OVER (ORDER BY duration_ms DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_count, \
         SUM(COUNT(*)) OVER () AS total_count \
         FROM api_audit_log WHERE request_ts BETWEEN ",
    );
    qb.push_bind(window.from_ts)
        .push(" AND ")
        .push_bind(window.to_ts);
    push_common_filters(&mut qb, filter);
    qb.push(
        " GROUP BY duration_ms) AS histogram \
         WHERE cumulative_count > FLOOR(total_count / 20) \
         ORDER BY duration_ms DESC LIMIT 1",
    );
    qb
}

fn api_key_analysis_query<'a>(
    window: &AnalyticsWindow,
    filter: &'a CommonFilter,
) -> QueryBuilder<'a, MySql> {
    // One scan of narrow indexed columns. Subsequent window operations work on
    // key/route groups, and every denominator precedes either ranking limit.
    // Keep original bytes for identity: trimming only decides whether a key is blank.
    let mut qb = QueryBuilder::<MySql>::new(
        "WITH route_counts AS (\
         SELECT BINARY api_key AS api_key, BINARY path AS path, \
         CAST(COUNT(*) AS SIGNED) AS route_requests, \
         CAST(SUM(status_code <> 200) AS SIGNED) AS route_errors \
         FROM api_audit_log",
    );
    if filter.api_key.is_none() {
        // IS NOT NULL alone can otherwise choose a non-covering key index.
        qb.push(" IGNORE INDEX (idx_api_key_request_ts)");
    }
    qb.push(" WHERE request_ts BETWEEN ")
        .push_bind(window.from_ts)
        .push(" AND ")
        .push_bind(window.to_ts)
        .push(" AND api_key IS NOT NULL AND api_key REGEXP '[^[:space:]]'");
    push_common_filters(&mut qb, filter);
    qb.push(
        " GROUP BY BINARY api_key, BINARY path), \
         key_routes AS (SELECT route_counts.*, \
         CAST(SUM(route_requests) OVER (PARTITION BY api_key) AS SIGNED) AS key_requests, \
         CAST(SUM(route_errors) OVER (PARTITION BY api_key) AS SIGNED) AS key_errors, \
         CAST(SUM(route_errors > 0) OVER (PARTITION BY api_key) AS SIGNED) AS affected_routes, \
         CAST(ROW_NUMBER() OVER (PARTITION BY api_key \
           ORDER BY route_errors DESC, route_requests DESC, path ASC) AS SIGNED) AS route_rank \
         FROM route_counts), \
         ranked AS (SELECT key_routes.*, \
         CAST(DENSE_RANK() OVER (ORDER BY \
           CAST(key_errors AS DECIMAL(40,20)) / key_requests DESC, \
           key_errors DESC, key_requests DESC, api_key ASC) AS SIGNED) AS key_rank, \
         CAST(DENSE_RANK() OVER (ORDER BY key_errors DESC, key_requests DESC, api_key ASC) \
           AS SIGNED) AS failure_count_rank, \
         CAST(SUM(route_rank = 1) OVER () AS SIGNED) AS total_keys, \
         CAST(SUM(route_rank = 1 AND key_errors > 0) OVER () AS SIGNED) AS failing_keys, \
         CAST(SUM(CASE WHEN route_rank = 1 THEN key_requests ELSE 0 END) OVER () AS SIGNED) AS total_requests, \
         CAST(SUM(CASE WHEN route_rank = 1 THEN key_errors ELSE 0 END) OVER () AS SIGNED) AS error_requests \
         FROM key_routes) \
         SELECT CONVERT(api_key USING utf8mb4) AS api_key, CONVERT(path USING utf8mb4) AS path, \
         route_requests, route_errors, key_requests, key_errors, affected_routes, \
         key_rank, failure_count_rank, route_rank, total_keys, failing_keys, total_requests, error_requests \
         FROM ranked WHERE (key_rank <= ",
    )
    .push_bind(API_KEY_LIMIT as i64)
    .push(" OR failure_count_rank <= ")
    .push_bind(LEGACY_API_KEY_LIMIT as i64)
    .push(") AND route_rank <= ")
    .push_bind(API_KEY_ROUTE_LIMIT as i64)
    .push(" ORDER BY key_rank ASC, route_rank ASC");
    qb
}

fn api_key_analysis_from_rows(
    rows: Vec<ApiKeyAnalysisRow>,
) -> (ApiKeyAnalysis, Vec<ErrorRateSlice>) {
    let mut analysis = ApiKeyAnalysis {
        total_keys: rows.first().map_or(0, |row| row.total_keys),
        failing_keys: rows.first().map_or(0, |row| row.failing_keys),
        returned_keys: 0,
        total_requests: rows.first().map_or(0, |row| row.total_requests),
        error_requests: rows.first().map_or(0, |row| row.error_requests),
        limit: API_KEY_LIMIT,
        route_limit: API_KEY_ROUTE_LIMIT,
        keys: Vec::new(),
    };
    let mut legacy = Vec::new();
    for row in rows {
        if row.key_errors == 0 {
            continue;
        }
        if row.route_rank == 1 && row.failure_count_rank <= LEGACY_API_KEY_LIMIT as i64 {
            legacy.push((
                row.failure_count_rank,
                ErrorRateSlice {
                    label: row.api_key.clone(),
                    total_requests: row.key_requests,
                    error_requests: row.key_errors,
                    error_rate: percentage(row.key_errors, row.key_requests),
                },
            ));
        }
        if row.key_rank > API_KEY_LIMIT as i64 || row.route_errors == 0 {
            continue;
        }
        if row.route_rank == 1 {
            analysis.keys.push(ApiKeyFailure {
                api_key: row.api_key,
                total_requests: row.key_requests,
                error_requests: row.key_errors,
                error_rate: percentage(row.key_errors, row.key_requests),
                error_share: percentage(row.key_errors, analysis.error_requests),
                affected_routes: row.affected_routes,
                routes: Vec::new(),
                returned_route_errors: 0,
            });
        }
        if let Some(key) = analysis.keys.last_mut() {
            key.returned_route_errors += row.route_errors;
            key.routes.push(ApiKeyRoute {
                path: row.path,
                total_requests: row.route_requests,
                error_requests: row.route_errors,
                error_rate: percentage(row.route_errors, row.route_requests),
                error_share: percentage(row.route_errors, row.key_errors),
            });
        }
    }
    analysis.returned_keys = analysis.keys.len();
    legacy.sort_unstable_by_key(|(rank, _)| *rank);
    (analysis, legacy.into_iter().map(|(_, item)| item).collect())
}

fn failure_patterns_from_rows(
    rows: Vec<FailurePatternRow>,
) -> (Vec<FailurePattern>, FailurePatternCoverage) {
    // The scalar totals share the statement snapshot with the selected
    // groups and examples. No returned groups means an empty error window.
    let (total_patterns, total_error_requests) = rows
        .first()
        .map(|row| (row.total_patterns, row.total_error_requests))
        .unwrap_or((0, 0));
    let patterns: Vec<_> = rows
        .into_iter()
        .map(|row| FailurePattern {
            method: row.representative.method.clone(),
            path: row.representative.path.clone(),
            status_code: row.representative.status_code,
            error_code: row.normalized_error_code,
            count: row.count,
            error_share: percentage(row.count, total_error_requests),
            first_seen_ts: row.first_seen_ts,
            last_seen_ts: row.last_seen_ts,
            avg_duration_ms: row.avg_duration_ms,
            max_duration_ms: i32::try_from(row.max_duration_ms).unwrap_or(i32::MAX),
            representative: row.representative,
        })
        .collect();
    let coverage = failure_pattern_coverage(&patterns, total_patterns, total_error_requests);
    (patterns, coverage)
}

fn failure_patterns_query<'a>(
    window: &AnalyticsWindow,
    filter: &'a CommonFilter,
) -> QueryBuilder<'a, MySql> {
    failure_patterns_query_with_exact_path(window, filter, None)
}

fn failure_patterns_query_with_exact_path<'a>(
    window: &AnalyticsWindow,
    filter: &'a CommonFilter,
    exact_path: Option<&'a str>,
) -> QueryBuilder<'a, MySql> {
    // Aggregate the entire filtered window before applying the display limit.
    // Window totals operate on those groups before LIMIT, avoiding a second
    // scan/group of the audit table while preserving one statement snapshot.
    // Joining MAX(id) retrieves one newest-ingested example per pattern without
    // fetching request/response bodies, relying on GROUP_CONCAT, or using N+1 queries.
    let mut qb = QueryBuilder::new(
        "SELECT sample.id, sample.request_id, sample.request_ts, sample.duration_ms, \
         sample.method, sample.path, sample.status_code, sample.client_ip, sample.api_key, \
         sample.task_id, sample.task_type, sample.error_code, \
         patterns.normalized_error_code, patterns.count, patterns.first_seen_ts, \
         patterns.last_seen_ts, patterns.avg_duration_ms, patterns.max_duration_ms, \
         patterns.total_patterns, patterns.total_error_requests \
         FROM (SELECT MIN(method) AS method, MIN(path) AS path, status_code, MIN(",
    );
    qb.push(FAILURE_PATTERN_ERROR_CODE).push(
        ") AS normalized_error_code, CAST(COUNT(*) AS SIGNED) AS count, \
         CAST(MIN(request_ts) AS SIGNED) AS first_seen_ts, \
         CAST(MAX(request_ts) AS SIGNED) AS last_seen_ts, \
         CAST(AVG(duration_ms) AS DOUBLE) AS avg_duration_ms, \
         CAST(MAX(duration_ms) AS SIGNED) AS max_duration_ms, \
         MAX(id) AS representative_id, \
         CAST(COUNT(*) OVER () AS SIGNED) AS total_patterns, \
         CAST(SUM(COUNT(*)) OVER () AS SIGNED) AS total_error_requests",
    );
    push_failure_pattern_grouping(&mut qb, window, filter, exact_path);
    qb.push(
        " ORDER BY count DESC, last_seen_ts DESC, BINARY MIN(method) ASC, BINARY MIN(path) ASC, \
         status_code ASC, BINARY MIN(NULLIF(TRIM(error_code), '')) ASC LIMIT ",
    )
    .push_bind(FAILURE_PATTERN_LIMIT as i64)
    .push(
        ") AS patterns INNER JOIN api_audit_log AS sample ON sample.id = patterns.representative_id \
         ORDER BY patterns.count DESC, patterns.last_seen_ts DESC, BINARY patterns.method ASC, \
         BINARY patterns.path ASC, patterns.status_code ASC, BINARY patterns.normalized_error_code ASC",
    );
    qb
}

fn push_failure_pattern_grouping<'a>(
    qb: &mut QueryBuilder<'a, MySql>,
    window: &AnalyticsWindow,
    filter: &'a CommonFilter,
    exact_path: Option<&'a str>,
) {
    qb.push(" FROM api_audit_log WHERE request_ts BETWEEN ")
        .push_bind(window.from_ts)
        .push(" AND ")
        .push_bind(window.to_ts)
        .push(" AND status_code <> 200");
    push_common_filters(qb, filter);
    if let Some(path) = exact_path {
        // Keep the indexable comparison and then require the exact byte value,
        // including case, trailing spaces, and literal wildcard characters.
        qb.push(" AND path = ")
            .push_bind(path)
            .push(" AND BINARY path = BINARY ")
            .push_bind(path);
    }
    // HTTP paths and application error codes are case-sensitive signatures even
    // when the source table uses the default case-insensitive MySQL collation.
    qb.push(" GROUP BY BINARY method, BINARY path, status_code, BINARY ")
        .push(FAILURE_PATTERN_ERROR_CODE);
}

fn failure_pattern_coverage(
    patterns: &[FailurePattern],
    total_patterns: i64,
    total_error_requests: i64,
) -> FailurePatternCoverage {
    let returned_error_requests = patterns.iter().map(|pattern| pattern.count).sum();
    FailurePatternCoverage {
        aggregation_scope: "full_filtered_window".into(),
        group_by: ["method", "path", "status_code", "error_code"].map(str::to_owned),
        total_patterns,
        returned_patterns: patterns.len(),
        returned_error_requests,
        total_error_requests,
        covered_error_rate: percentage(returned_error_requests, total_error_requests),
        truncated: total_patterns > patterns.len() as i64,
        limit: FAILURE_PATTERN_LIMIT,
        representative_strategy: "highest_id_per_pattern".into(),
    }
}

fn push_common_filters<'a>(qb: &mut QueryBuilder<'a, MySql>, filter: &'a CommonFilter) {
    if let Some(path) = &filter.path {
        qb.push(" AND path LIKE CONCAT(")
            .push_bind(path)
            .push(", '%')");
    }
    if let Some(method) = &filter.method {
        qb.push(" AND method = ").push_bind(method);
    }
    if let Some(api_key) = &filter.api_key {
        qb.push(" AND api_key = ")
            .push_bind(api_key)
            .push(" AND BINARY api_key = BINARY ")
            .push_bind(api_key);
    }
    if let Some(task_type) = &filter.task_type {
        qb.push(" AND task_type = ").push_bind(task_type);
    }
}

fn push_record_status_filter(
    qb: &mut QueryBuilder<'_, MySql>,
    status_code: Option<i16>,
    non_200: bool,
) {
    if let Some(status_code) = status_code {
        qb.push(" AND status_code = ").push_bind(status_code);
    } else if non_200 {
        qb.push(" AND status_code <> 200");
    }
}

fn normalize_str(value: Option<String>) -> Option<String> {
    value.and_then(|v| {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_api_key(value: Option<String>) -> Option<String> {
    value.filter(|key| !key.trim().is_empty())
}

fn percentage(part: i64, total: i64) -> f64 {
    if total <= 0 {
        0.0
    } else {
        (part as f64 / total as f64) * 100.0
    }
}

async fn timed_dashboard_query<T>(
    query: &'static str,
    operation: impl std::future::Future<Output = anyhow::Result<T>>,
) -> anyhow::Result<T> {
    let started_at = Instant::now();
    let result = operation.await;
    tracing::info!(
        query,
        elapsed_ms = started_at.elapsed().as_millis() as u64,
        success = result.is_ok(),
        "dashboard query completed"
    );
    result
}

fn dashboard_cache_key(window: &AnalyticsWindow, filter: &CommonFilter) -> String {
    // Cache expiry determines freshness. A wall-clock bucket makes a slow
    // calculation obsolete before its completed result can even be reused.
    format!(
        "{}:{}{}{}{}",
        window.hours,
        cache_filter_part(filter.path.as_deref()),
        cache_filter_part(filter.method.as_deref()),
        cache_filter_part(filter.api_key.as_deref()),
        cache_filter_part(filter.task_type.as_deref()),
    )
}

fn cache_filter_part(value: Option<&str>) -> String {
    match value {
        Some(value) => format!("s{}:{};", value.len(), value),
        None => "n;".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentage_uses_zero_for_an_empty_window() {
        assert_eq!(percentage(0, 0), 0.0);
    }

    #[test]
    fn percentage_reports_non_200_share() {
        assert!((percentage(3, 8) - 37.5).abs() < f64::EPSILON);
        assert!((percentage(8, 8) - 100.0).abs() < f64::EPSILON);
    }

    #[tokio::test]
    #[ignore = "requires LOGARK_TEST_DATABASE_URL pointing to a disposable MariaDB instance"]
    async fn p95_histogram_matches_exact_rank_for_empty_tied_and_boundary_samples(
    ) -> anyhow::Result<()> {
        use sqlx::{Connection, MySqlConnection};
        let url = std::env::var("LOGARK_TEST_DATABASE_URL")?;
        let mut connection = MySqlConnection::connect(&url).await?;
        sqlx::query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',ONLY_FULL_GROUP_BY')")
            .execute(&mut connection)
            .await?;
        sqlx::query(
            "CREATE TEMPORARY TABLE api_audit_log (
            request_ts BIGINT NOT NULL DEFAULT 1000, duration_ms INT NOT NULL,
            path VARCHAR(255) DEFAULT '/v1/generate', method VARCHAR(16) DEFAULT 'POST',
            api_key VARCHAR(255) DEFAULT 'test-key', task_type VARCHAR(128) DEFAULT 'generation'
        )",
        )
        .execute(&mut connection)
        .await?;
        let mut cases: Vec<Vec<i32>> = [0usize, 1, 2, 19, 20, 21, 39, 40, 41, 99, 100, 101, 1001]
            .into_iter()
            .map(|size| (0..size).map(|i| ((i * 37 + 11) % 127) as i32).collect())
            .collect();
        cases.push(vec![42; 100]);
        cases.push(vec![i32::MIN, 0, 0, i32::MAX]);
        for mut values in cases {
            sqlx::query("DELETE FROM api_audit_log")
                .execute(&mut connection)
                .await?;
            if !values.is_empty() {
                let mut insert =
                    QueryBuilder::<MySql>::new("INSERT INTO api_audit_log (duration_ms) ");
                insert.push_values(&values, |mut row, value| {
                    row.push_bind(*value);
                });
                insert.build().execute(&mut connection).await?;
            }
            values.sort_unstable();
            let expected = if values.is_empty() {
                None
            } else {
                Some(values[(19 * values.len()).div_ceil(20) - 1])
            };
            let actual = p95_duration_query(&test_window(), &test_filter())
                .build_query_scalar::<i32>()
                .fetch_optional(&mut connection)
                .await?;
            assert_eq!(actual, expected, "sample size {}", values.len());
            let missing = CommonFilter {
                api_key: Some("absent-key".into()),
                ..test_filter()
            };
            assert_eq!(
                p95_duration_query(&test_window(), &missing)
                    .build_query_scalar::<i32>()
                    .fetch_optional(&mut connection)
                    .await?,
                None
            );
        }
        Ok(())
    }

    #[test]
    fn dashboard_cache_key_is_stable_across_slow_queries_and_clock_buckets() {
        let filter = CommonFilter {
            path: None,
            method: None,
            api_key: None,
            task_type: None,
        };
        let first = AnalyticsWindow {
            from_ts: 1,
            to_ts: 30_001,
            hours: 24,
            bucket_ms: 900_000,
        };
        let second = AnalyticsWindow {
            from_ts: 36_002,
            to_ts: 66_002,
            hours: 24,
            bucket_ms: 900_000,
        };

        assert_eq!(
            dashboard_cache_key(&first, &filter),
            dashboard_cache_key(&second, &filter)
        );
    }

    #[test]
    fn dashboard_cache_key_distinguishes_empty_and_literal_placeholder_filters() {
        let window = AnalyticsWindow {
            from_ts: 1,
            to_ts: 30_001,
            hours: 24,
            bucket_ms: 900_000,
        };
        let empty_filter = CommonFilter {
            path: None,
            method: None,
            api_key: None,
            task_type: None,
        };
        let literal_filter = CommonFilter {
            path: Some("-".to_string()),
            method: None,
            api_key: None,
            task_type: None,
        };

        assert_ne!(
            dashboard_cache_key(&window, &empty_filter),
            dashboard_cache_key(&window, &literal_filter)
        );
    }

    #[test]
    fn record_status_filter_selects_non_200_only_when_no_exact_code_is_given() {
        let mut only_errors = QueryBuilder::<MySql>::new("SELECT 1 WHERE 1 = 1");
        push_record_status_filter(&mut only_errors, None, true);
        assert!(only_errors.sql().contains("status_code <> 200"));

        let mut exact_code = QueryBuilder::<MySql>::new("SELECT 1 WHERE 1 = 1");
        push_record_status_filter(&mut exact_code, Some(201), true);
        assert!(exact_code.sql().contains("status_code = ?"));
        assert!(!exact_code.sql().contains("status_code <> 200"));

        let mut all_statuses = QueryBuilder::<MySql>::new("SELECT 1 WHERE 1 = 1");
        push_record_status_filter(&mut all_statuses, None, false);
        assert!(!all_statuses.sql().contains("status_code"));
    }

    #[test]
    fn failure_patterns_aggregate_before_limiting_and_only_fetch_summary_columns() {
        let window = test_window();
        let filter = test_filter();
        let query = failure_patterns_query(&window, &filter);
        let sql = query.sql();
        let group_at = sql.find(" GROUP BY ").expect("groups the whole window");
        let limit_at = sql.find(" LIMIT ").expect("bounds returned groups");

        assert!(group_at < limit_at);
        assert_eq!(sql.matches(" LIMIT ").count(), 1);
        assert_eq!(sql.matches(" GROUP BY ").count(), 1);
        assert_eq!(sql.matches(" FROM api_audit_log ").count(), 1);
        assert!(sql.contains("CAST(COUNT(*) OVER () AS SIGNED) AS total_patterns"));
        assert!(sql.contains("CAST(SUM(COUNT(*)) OVER () AS SIGNED) AS total_error_requests"));
        assert!(sql.contains("MAX(id) AS representative_id"));
        assert!(sql.contains("sample.id = patterns.representative_id"));
        assert!(!sql.contains("request_body"));
        assert!(!sql.contains("response_body"));
        assert!(!sql.contains("SELECT *"));
    }

    #[test]
    fn failure_pattern_counts_and_examples_use_identical_filters_and_blank_error_groups() {
        let window = test_window();
        let filter = test_filter();
        let patterns = failure_patterns_query(&window, &filter);
        let expected_grouping = " FROM api_audit_log WHERE request_ts BETWEEN ? AND ? \
            AND status_code <> 200 AND path LIKE CONCAT(?, '%') AND method = ? \
            AND api_key = ? AND BINARY api_key = BINARY ? AND task_type = ? GROUP BY BINARY method, BINARY path, status_code, \
            BINARY NULLIF(TRIM(error_code), '')";

        assert!(patterns.sql().contains(expected_grouping));
        assert_eq!(patterns.sql().matches(expected_grouping).count(), 1);
        assert!(!patterns.sql().contains("status_code >= 400"));
        assert!(patterns
            .sql()
            .contains("MIN(NULLIF(TRIM(error_code), '')) AS normalized_error_code"));
    }

    #[test]
    fn failure_pattern_coverage_reports_full_counts_separately_from_bounded_examples() {
        let patterns = vec![test_pattern(160), test_pattern(40)];
        let coverage = failure_pattern_coverage(&patterns, 15, 250);

        assert_eq!(coverage.total_patterns, 15);
        assert_eq!(coverage.returned_patterns, 2);
        assert_eq!(coverage.returned_error_requests, 200);
        assert_eq!(coverage.total_error_requests, 250);
        assert_eq!(coverage.covered_error_rate, 80.0);
        assert!(coverage.truncated);
        assert_eq!(coverage.aggregation_scope, "full_filtered_window");
        assert_eq!(coverage.representative_strategy, "highest_id_per_pattern");
    }

    #[test]
    fn empty_failure_pattern_coverage_is_zero_and_not_truncated() {
        let coverage = failure_pattern_coverage(&[], 0, 0);

        assert_eq!(coverage.returned_patterns, 0);
        assert_eq!(coverage.returned_error_requests, 0);
        assert_eq!(coverage.covered_error_rate, 0.0);
        assert!(!coverage.truncated);
    }

    #[tokio::test]
    #[ignore = "requires LOGARK_TEST_DATABASE_URL pointing to a disposable MariaDB instance"]
    async fn api_key_analysis_preserves_full_denominators_and_exact_identities(
    ) -> anyhow::Result<()> {
        use sqlx::{Connection, MySqlConnection};

        let mut connection =
            MySqlConnection::connect(&std::env::var("LOGARK_TEST_DATABASE_URL")?).await?;
        sqlx::query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',ONLY_FULL_GROUP_BY')")
            .execute(&mut connection)
            .await?;
        // Session-local fixture: no persistent application table is modified.
        sqlx::query(
            "CREATE TEMPORARY TABLE api_audit_log (\
             request_ts BIGINT NOT NULL DEFAULT 2000, api_key VARCHAR(255), \
             path VARCHAR(255) NOT NULL DEFAULT '/v1/A', method VARCHAR(16) DEFAULT 'POST', \
             status_code SMALLINT NOT NULL DEFAULT 500, task_type VARCHAR(128) DEFAULT 'generation', \
             INDEX idx_api_key_request_ts (api_key, request_ts)) \
             DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        )
        .execute(&mut connection)
        .await?;
        let window = test_window();
        let unfiltered = CommonFilter {
            path: None,
            method: None,
            api_key: None,
            task_type: None,
        };
        let load = |rows| api_key_analysis_from_rows(rows);
        let empty = load(
            api_key_analysis_query(&window, &unfiltered)
                .build_query_as::<ApiKeyAnalysisRow>()
                .fetch_all(&mut connection)
                .await?,
        );
        assert_eq!(empty.0.total_keys, 0);
        assert_eq!(empty.0.error_requests, 0);
        assert!(empty.0.keys.is_empty());
        assert!(empty.1.is_empty());

        for (route, errors) in [
            ("A", 7),
            ("a", 6),
            ("r2", 5),
            ("r3", 4),
            ("r4", 3),
            ("r5", 2),
            ("r6", 1),
        ] {
            for index in 0..errors * 2 {
                sqlx::query(
                    "INSERT INTO api_audit_log (api_key, path, status_code) VALUES ('focus', ?, ?)",
                )
                .bind(format!("/v1/{route}"))
                .bind(if index < errors { 500_i16 } else { 200_i16 })
                .execute(&mut connection)
                .await?;
            }
        }
        for _ in 0..10 {
            sqlx::query("INSERT INTO api_audit_log (api_key, path, status_code) VALUES ('focus', '/v1/success', 200)")
                .execute(&mut connection)
                .await?;
        }
        sqlx::query(
            "INSERT INTO api_audit_log (api_key, method, status_code) VALUES \
             ('focus', 'GET', 201), ('focus', 'GET', 302), \
             ('Focus', 'POST', 500), ('focus ', 'POST', 500), ('focus ', 'POST', 500), \
             ('focus ', 'POST', 500), ('<img src=x onerror=alert(1)>', 'POST', 500), \
             ('success', 'POST', 200), ('success', 'POST', 200), ('success', 'POST', 200), ('success', 'POST', 200), \
             (NULL, 'POST', 500), ('', 'POST', 500), ('   ', 'POST', 500)",
        )
        .execute(&mut connection)
        .await?;
        sqlx::query("INSERT INTO api_audit_log (api_key) VALUES (?)")
            .bind("\t\n")
            .execute(&mut connection)
            .await?;
        let (analysis, legacy) = load(
            api_key_analysis_query(&window, &unfiltered)
                .build_query_as::<ApiKeyAnalysisRow>()
                .fetch_all(&mut connection)
                .await?,
        );
        assert_eq!(
            (
                analysis.total_keys,
                analysis.failing_keys,
                analysis.returned_keys
            ),
            (5, 4, 4)
        );
        assert_eq!((analysis.total_requests, analysis.error_requests), (77, 35));
        assert_eq!(
            analysis
                .keys
                .iter()
                .map(|key| key.api_key.as_str())
                .collect::<Vec<_>>(),
            ["focus ", "<img src=x onerror=alert(1)>", "Focus", "focus"]
        );
        let focus = &analysis.keys[3];
        assert_eq!(
            (
                focus.total_requests,
                focus.error_requests,
                focus.affected_routes
            ),
            (68, 30, 7)
        );
        assert_eq!(focus.routes.len(), 5);
        assert_eq!(focus.returned_route_errors, 27);
        assert!((focus.error_rate - 30.0 / 68.0 * 100.0).abs() < 1e-9);
        assert!((focus.error_share - 30.0 / 35.0 * 100.0).abs() < 1e-9);
        assert_eq!(
            (
                focus.routes[0].path.as_str(),
                focus.routes[0].total_requests,
                focus.routes[0].error_requests
            ),
            ("/v1/A", 16, 9)
        );
        assert_eq!(focus.routes[0].error_rate, 56.25);
        assert_eq!(focus.routes[0].error_share, 30.0);
        assert_eq!(focus.routes[1].path, "/v1/a");
        assert_eq!(legacy[0].label, "focus");
        assert_eq!(legacy[0].error_requests, 30);

        // Every existing filter is applied before grouping. Exact byte comparison
        // excludes both differently cased and trailing-space keys.
        sqlx::query(
            "INSERT INTO api_audit_log (api_key, path, task_type, request_ts) VALUES \
             ('focus', '/v2/outside', 'generation', 2000), \
             ('focus', '/v1/A', 'other-task', 2000), \
             ('focus', '/v1/A', 'generation', 999), \
             ('focus', '/v1/A', 'generation', 10001)",
        )
        .execute(&mut connection)
        .await?;
        let focused_filter = CommonFilter {
            api_key: Some("focus".into()),
            ..test_filter()
        };
        let (focused, _) = load(
            api_key_analysis_query(&window, &focused_filter)
                .build_query_as::<ApiKeyAnalysisRow>()
                .fetch_all(&mut connection)
                .await?,
        );
        assert_eq!(
            (
                focused.total_keys,
                focused.failing_keys,
                focused.returned_keys
            ),
            (1, 1, 1)
        );
        assert_eq!((focused.total_requests, focused.error_requests), (66, 28));
        assert_eq!(focused.keys[0].returned_route_errors, 25);
        assert_eq!(focused.keys[0].routes[0].error_rate, 50.0);
        assert_eq!(focused.keys[0].routes[0].error_share, 25.0);

        let success_filter = CommonFilter {
            api_key: Some("success".into()),
            ..unfiltered.clone()
        };
        let (success, old_success) = load(
            api_key_analysis_query(&window, &success_filter)
                .build_query_as::<ApiKeyAnalysisRow>()
                .fetch_all(&mut connection)
                .await?,
        );
        assert_eq!(
            (
                success.total_keys,
                success.total_requests,
                success.failing_keys
            ),
            (1, 4, 0)
        );
        assert_eq!(success.error_requests, 0);
        assert!(success.keys.is_empty());
        assert!(old_success.is_empty());

        for index in 0..24 {
            sqlx::query("INSERT INTO api_audit_log (api_key) VALUES (?)")
                .bind(format!("key-{index:02}"))
                .execute(&mut connection)
                .await?;
        }
        let (limited, count_ranked) = load(
            api_key_analysis_query(&window, &unfiltered)
                .build_query_as::<ApiKeyAnalysisRow>()
                .fetch_all(&mut connection)
                .await?,
        );
        assert_eq!(
            (
                limited.total_keys,
                limited.failing_keys,
                limited.returned_keys
            ),
            (29, 28, 20)
        );
        assert_eq!((limited.total_requests, limited.error_requests), (103, 61));
        assert!(limited.keys.iter().all(|key| key.error_rate == 100.0));
        assert_eq!(limited.keys.last().unwrap().api_key, "key-16");
        assert_eq!(limited.keys[0].error_share, 3.0 / 61.0 * 100.0);
        assert_eq!(count_ranked.len(), 8);
        assert_eq!(count_ranked[0].label, "focus");
        assert_eq!(count_ranked[0].error_requests, 32);
        Ok(())
    }

    #[test]
    fn api_key_analysis_uses_one_scan_and_limits_only_after_full_window_totals() {
        let window = test_window();
        let filter = test_filter();
        let qb = api_key_analysis_query(&window, &filter);
        let sql = qb.sql();
        assert_eq!(sql.matches("FROM api_audit_log").count(), 1);
        assert_eq!(sql.matches("GROUP BY").count(), 1);
        assert!(sql.contains("GROUP BY BINARY api_key, BINARY path"));
        assert!(sql.contains("SUM(route_rank = 1) OVER ()"));
        assert!(sql.find("AS total_requests").unwrap() < sql.find("WHERE (key_rank").unwrap());
        assert!(sql.contains("AND BINARY api_key = BINARY ?"));
        assert!(!sql.contains("status_code >= 400"));
        assert!(!sql.contains("request_body"));
        assert!(!sql.contains("response_body"));
        assert_eq!(
            normalize_api_key(Some(" Key ".into())),
            Some(" Key ".into())
        );
        assert_eq!(normalize_api_key(Some("\t \n".into())), None);
    }

    #[tokio::test]
    #[ignore = "requires LOGARK_TEST_DATABASE_URL pointing to a disposable MariaDB instance"]
    async fn failure_patterns_execute_against_full_window_fixture() -> anyhow::Result<()> {
        use sqlx::{Connection, MySqlConnection};

        let url = std::env::var("LOGARK_TEST_DATABASE_URL")?;
        let mut connection = MySqlConnection::connect(&url).await?;
        sqlx::query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',ONLY_FULL_GROUP_BY')")
            .execute(&mut connection)
            .await?;
        // A session-scoped temporary table prevents this fixture from modifying
        // persistent audit data even if the supplied test database has that table.
        sqlx::query(
            "CREATE TEMPORARY TABLE api_audit_log (\
             id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT, request_id VARCHAR(64) NOT NULL DEFAULT 'fixture', \
             request_ts BIGINT NOT NULL, duration_ms INT NOT NULL, method VARCHAR(16) NOT NULL DEFAULT 'POST', \
             path VARCHAR(255) NOT NULL DEFAULT '/v1/generate', status_code SMALLINT NOT NULL DEFAULT 500, \
             client_ip VARCHAR(64) NULL, api_key VARCHAR(255) DEFAULT 'test-key', task_id VARCHAR(64) NULL, \
             task_type VARCHAR(128) DEFAULT 'generation', error_code VARCHAR(128) NULL\
             ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        )
        .execute(&mut connection)
        .await?;
        for index in 0..18_i32 {
            sqlx::query(
                "INSERT INTO api_audit_log (request_ts, duration_ms, error_code) VALUES (?, ?, ?)",
            )
            .bind(if index == 17 {
                1_001_i64
            } else {
                1_000 + i64::from(index) * 10
            })
            .bind(100 + index * 10)
            .bind([None, Some(""), Some("   ")][index as usize % 3])
            .execute(&mut connection)
            .await?;
        }
        sqlx::query(
            "INSERT INTO api_audit_log (request_ts, duration_ms, path, status_code, error_code) VALUES \
             (2000, 500, '/v1/Generate', 500, NULL), \
             (2001, 500, '/v1/generate', 500, 'TIMEOUT'), \
             (2002, 500, '/v1/generate', 500, ' TIMEOUT '), \
             (2003, 500, '/v1/generate', 500, 'timeout'), \
             (2004, 500, '/v1/generate', 201, NULL), \
             (2005, 500, '/v1/generate', 302, NULL), \
             (2006, 500, '/v1/generate', 200, NULL), \
             (2006, 100, '/v1/success', 200, NULL), \
             (999, 500, '/v1/generate', 500, NULL), \
             (10001, 500, '/v1/generate', 500, NULL), \
             (2007, 500, '/v2/generate', 500, NULL)",
        )
        .execute(&mut connection)
        .await?;
        for index in 0..13 {
            sqlx::query(
                "INSERT INTO api_audit_log (request_ts, duration_ms, path) VALUES (?, 100, ?)",
            )
            .bind(7_000 + index)
            .bind(format!("/v1/rare-{index}"))
            .execute(&mut connection)
            .await?;
        }
        sqlx::query(
            "INSERT INTO api_audit_log (request_ts, duration_ms, method, api_key, task_type) VALUES \
             (2008, 100, 'GET', 'test-key', 'generation'), \
             (2009, 100, 'POST', 'other-key', 'generation'), \
             (2010, 100, 'POST', 'test-key', 'other-task')",
        )
        .execute(&mut connection)
        .await?;

        let window = test_window();
        let filter = test_filter();
        let rows = failure_patterns_query(&window, &filter)
            .build_query_as::<FailurePatternRow>()
            .fetch_all(&mut connection)
            .await?;
        assert_eq!(rows.len(), FAILURE_PATTERN_LIMIT);
        assert_eq!(rows[0].total_patterns, 19);
        assert_eq!(rows[0].total_error_requests, 37);
        assert!(rows
            .iter()
            .all(|row| row.total_patterns == 19 && row.total_error_requests == 37));
        assert_eq!(rows[0].count, 18);
        assert_eq!(rows[0].normalized_error_code, None);
        assert_eq!(rows[0].first_seen_ts, 1_000);
        assert_eq!(rows[0].last_seen_ts, 1_160);
        assert_eq!(rows[0].avg_duration_ms, 185.0);
        assert_eq!(rows[0].max_duration_ms, 270);
        assert_eq!(rows[0].representative.id, 18);
        assert_eq!(rows[0].representative.request_ts, 1_001);
        assert_eq!(rows[1].normalized_error_code.as_deref(), Some("TIMEOUT"));
        assert_eq!(rows[1].count, 2);
        assert_eq!(rows.iter().map(|row| row.count).sum::<i64>(), 30);

        let earlier_window = AnalyticsWindow {
            to_ts: 3_000,
            ..window.clone()
        };
        let earlier = failure_patterns_query(&earlier_window, &filter)
            .build_query_as::<FailurePatternRow>()
            .fetch_all(&mut connection)
            .await?;
        assert_eq!(earlier.len(), 6);
        assert!(earlier
            .iter()
            .all(|row| row.total_patterns == 6 && row.total_error_requests == 24));
        assert!(earlier
            .iter()
            .any(|row| row.representative.path == "/v1/Generate"));
        assert!(earlier
            .iter()
            .any(|row| row.normalized_error_code.as_deref() == Some("timeout")));
        assert!(earlier
            .iter()
            .any(|row| row.representative.status_code == 201));
        assert!(earlier
            .iter()
            .any(|row| row.representative.status_code == 302));

        // Removing filters must change the complete-window totals, while the
        // same signature still combines records from different keys/task types.
        let unfiltered = CommonFilter {
            path: None,
            method: None,
            api_key: None,
            task_type: None,
        };
        let all = failure_patterns_query(&window, &unfiltered)
            .build_query_as::<FailurePatternRow>()
            .fetch_all(&mut connection)
            .await?;
        assert_eq!(all.len(), FAILURE_PATTERN_LIMIT);
        assert!(all
            .iter()
            .all(|row| row.total_patterns == 21 && row.total_error_requests == 41));
        assert_eq!(all[0].count, 20);
        assert_eq!(
            all[0].representative.task_type.as_deref(),
            Some("other-task")
        );

        let single_window = AnalyticsWindow {
            from_ts: 2_003,
            to_ts: 2_003,
            ..window.clone()
        };
        let single = failure_patterns_query(&single_window, &filter)
            .build_query_as::<FailurePatternRow>()
            .fetch_all(&mut connection)
            .await?;
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].total_patterns, 1);
        assert_eq!(single[0].total_error_requests, 1);
        assert_eq!(single[0].normalized_error_code.as_deref(), Some("timeout"));

        let empty_filter = CommonFilter {
            path: Some("/v1/success".into()),
            ..filter
        };
        let empty = failure_patterns_query(&window, &empty_filter)
            .build_query_as::<FailurePatternRow>()
            .fetch_all(&mut connection)
            .await?;
        assert!(empty.is_empty());
        Ok(())
    }

    fn test_window() -> AnalyticsWindow {
        AnalyticsWindow {
            from_ts: 1_000,
            to_ts: 10_000,
            hours: 1,
            bucket_ms: 300_000,
        }
    }

    fn test_filter() -> CommonFilter {
        CommonFilter {
            path: Some("/v1/".into()),
            method: Some("POST".into()),
            api_key: Some("test-key".into()),
            task_type: Some("generation".into()),
        }
    }

    fn test_pattern(count: i64) -> FailurePattern {
        FailurePattern {
            method: "POST".into(),
            path: "/v1/generate".into(),
            status_code: 500,
            error_code: None,
            count,
            error_share: 0.0,
            first_seen_ts: 1_000,
            last_seen_ts: 2_000,
            avg_duration_ms: 100.0,
            max_duration_ms: 200,
            representative: AuditRecordSummary {
                id: 42,
                request_id: "sample-request".into(),
                request_ts: 1_500,
                duration_ms: 80,
                method: "POST".into(),
                path: "/v1/generate".into(),
                status_code: 500,
                client_ip: None,
                api_key: None,
                task_id: None,
                task_type: None,
                error_code: None,
            },
        }
    }
}
