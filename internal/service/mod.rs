use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use anyhow::Context;
use sqlx::{MySql, MySqlPool, QueryBuilder, Row};
use tokio::sync::RwLock;

use crate::{
    config::Config,
    model::{
        AuditRecordDetail, AuditRecordSummary, BidReport, BidReportWindow, BidStatusCodeStat,
        BidWatchItem, DashboardQuery, DashboardResponse, DashboardSummary, DashboardWindow,
        ErrorRateSlice, MetricSlice, RecordListQuery, RecordListResponse, TimelinePoint,
    },
};

#[derive(Clone)]
pub struct AuditAnalyticsService {
    pool: MySqlPool,
    config: Config,
    dashboard_cache: std::sync::Arc<RwLock<HashMap<String, CacheEntry>>>,
}

struct CacheEntry {
    expires_at: Instant,
    payload: DashboardResponse,
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

impl AuditAnalyticsService {
    pub fn new(pool: MySqlPool, config: Config) -> Self {
        Self {
            pool,
            config,
            dashboard_cache: std::sync::Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn dashboard(&self, query: DashboardQuery) -> anyhow::Result<DashboardResponse> {
        let window = self.resolve_window(query.hours);
        let filter = CommonFilter {
            path: normalize_str(query.path),
            method: normalize_str(query.method).map(|v| v.to_uppercase()),
            api_key: normalize_str(query.api_key),
            task_type: normalize_str(query.task_type),
        };
        let cache_key = dashboard_cache_key(&window, &filter, self.config.analytics_cache_ttl_secs);

        if let Some(payload) = self.get_cached_dashboard(&cache_key).await {
            return Ok(payload);
        }

        let (
            summary,
            error_timeline,
            top_error_paths,
            error_status_distribution,
            error_method_distribution,
            top_error_api_keys,
            top_error_task_types,
            latest_errors,
        ) = tokio::try_join!(
            self.fetch_summary(&window, &filter),
            self.fetch_timeline(&window, &filter),
            self.fetch_top_error_paths(&window, &filter),
            self.fetch_error_status_distribution(&window, &filter),
            self.fetch_error_method_distribution(&window, &filter),
            self.fetch_top_error_api_keys(&window, &filter),
            self.fetch_top_error_task_types(&window, &filter),
            self.fetch_latest_errors(&window, &filter),
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
            top_error_task_types,
            latest_errors,
        };

        self.store_cached_dashboard(cache_key, payload.clone())
            .await;
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
        if let Some(api_key) = normalize_str(query.api_key) {
            qb.push(" AND api_key = ").push_bind(api_key);
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
        self.dashboard_cache.read().await.len()
    }

    pub async fn health_snapshot(&self) -> anyhow::Result<(i64, Option<i64>)> {
        let row = sqlx::query(
            r#"
            SELECT
                CAST(COUNT(*) AS SIGNED) AS total_records,
                CAST(MAX(request_ts) AS SIGNED) AS latest_request_ts
            FROM api_audit_log
            "#,
        )
        .fetch_one(&self.pool)
        .await?;

        let total_records = row.try_get::<i64, _>("total_records")?;
        let latest_request_ts = row.try_get::<Option<i64>, _>("latest_request_ts")?;
        Ok((total_records, latest_request_ts))
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

    async fn get_cached_dashboard(&self, key: &str) -> Option<DashboardResponse> {
        let cache = self.dashboard_cache.read().await;
        cache.get(key).and_then(|entry| {
            if entry.expires_at > Instant::now() {
                Some(entry.payload.clone())
            } else {
                None
            }
        })
    }

    async fn store_cached_dashboard(&self, key: String, payload: DashboardResponse) {
        let mut cache = self.dashboard_cache.write().await;
        cache.retain(|_, entry| entry.expires_at > Instant::now());
        cache.insert(
            key,
            CacheEntry {
                expires_at: Instant::now()
                    + Duration::from_secs(self.config.analytics_cache_ttl_secs),
                payload,
            },
        );
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
             CAST(COUNT(DISTINCT NULLIF(api_key, '')) AS SIGNED) AS unique_api_keys, \
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

        let offset = ((total_requests as f64) * 0.95).ceil() as i64 - 1;
        let mut qb: QueryBuilder<MySql> =
            QueryBuilder::new("SELECT duration_ms FROM api_audit_log WHERE request_ts BETWEEN ");
        qb.push_bind(window.from_ts)
            .push(" AND ")
            .push_bind(window.to_ts);
        push_common_filters(&mut qb, filter);
        qb.push(" ORDER BY duration_ms ASC LIMIT 1 OFFSET ")
            .push_bind(offset.max(0));

        let row = qb
            .build()
            .fetch_optional(&self.pool)
            .await?
            .context("p95 row missing")?;
        Ok(row.try_get("duration_ms")?)
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

    async fn fetch_top_error_api_keys(
        &self,
        window: &AnalyticsWindow,
        filter: &CommonFilter,
    ) -> anyhow::Result<Vec<ErrorRateSlice>> {
        self.fetch_top_error_dimension(window, filter, "api_key", 8)
            .await
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
                 FROM api_audit_log WHERE request_ts BETWEEN ",
            )
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
        qb.push(" AND api_key = ").push_bind(api_key);
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

fn percentage(part: i64, total: i64) -> f64 {
    if total <= 0 {
        0.0
    } else {
        (part as f64 / total as f64) * 100.0
    }
}

fn dashboard_cache_key(
    window: &AnalyticsWindow,
    filter: &CommonFilter,
    cache_ttl_secs: u64,
) -> String {
    let cache_bucket_ms = i64::try_from(cache_ttl_secs.max(1))
        .unwrap_or(i64::MAX / 1_000)
        .saturating_mul(1_000);
    format!(
        "{}:{}:{}{}{}{}",
        window.hours,
        window.to_ts / cache_bucket_ms,
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

    #[test]
    fn dashboard_cache_key_is_stable_inside_ttl_bucket() {
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
            from_ts: 2,
            to_ts: 30_999,
            hours: 24,
            bucket_ms: 900_000,
        };

        assert_eq!(
            dashboard_cache_key(&first, &filter, 15),
            dashboard_cache_key(&second, &filter, 15)
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
            dashboard_cache_key(&window, &empty_filter, 15),
            dashboard_cache_key(&window, &literal_filter, 15)
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
}
