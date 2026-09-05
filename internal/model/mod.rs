use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AuditRecordSummary {
    pub id: u64,
    pub request_id: String,
    pub request_ts: i64,
    pub duration_ms: i32,
    pub method: String,
    pub path: String,
    pub status_code: i16,
    pub client_ip: Option<String>,
    pub api_key: Option<String>,
    pub task_id: Option<String>,
    pub task_type: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AuditRecordDetail {
    pub id: u64,
    pub request_id: String,
    pub request_ts: i64,
    pub response_ts: i64,
    pub duration_ms: i32,
    pub method: String,
    pub path: String,
    pub query_string: Option<String>,
    pub status_code: i16,
    pub client_ip: Option<String>,
    pub user_agent: Option<String>,
    pub api_key: Option<String>,
    pub request_content_type: Option<String>,
    pub response_content_type: Option<String>,
    pub request_headers_json: Option<String>,
    pub response_headers_json: Option<String>,
    pub request_body: Option<String>,
    pub response_body: Option<String>,
    pub request_body_size: i32,
    pub response_body_size: i32,
    pub request_body_truncated: bool,
    pub response_body_truncated: bool,
    pub uuid: Option<String>,
    pub task_id: Option<String>,
    pub task_type: Option<String>,
    pub bid: Option<String>,
    pub error_code: Option<String>,
    pub created_ts: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DashboardQuery {
    pub hours: Option<u32>,
    pub path: Option<String>,
    pub method: Option<String>,
    pub api_key: Option<String>,
    pub task_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RecordListQuery {
    pub hours: Option<u32>,
    pub limit: Option<u32>,
    pub cursor_ts: Option<i64>,
    pub cursor_id: Option<u64>,
    pub request_id: Option<String>,
    pub task_id: Option<String>,
    pub uuid: Option<String>,
    pub bid: Option<String>,
    pub path: Option<String>,
    pub method: Option<String>,
    pub api_key: Option<String>,
    pub status_code: Option<i16>,
    pub non_200: Option<bool>,
    pub task_type: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub name: String,
    pub cache_entries: usize,
    pub total_records: i64,
    pub latest_request_ts: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DashboardResponse {
    pub window: DashboardWindow,
    pub summary: DashboardSummary,
    pub error_timeline: Vec<TimelinePoint>,
    pub error_status_distribution: Vec<MetricSlice>,
    pub error_method_distribution: Vec<ErrorRateSlice>,
    pub top_error_paths: Vec<ErrorRateSlice>,
    pub top_error_api_keys: Vec<ErrorRateSlice>,
    pub top_error_task_types: Vec<ErrorRateSlice>,
    pub failure_patterns: Vec<FailurePattern>,
    pub failure_pattern_coverage: FailurePatternCoverage,
    pub latest_errors: Vec<AuditRecordSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailurePattern {
    pub method: String,
    pub path: String,
    pub status_code: i16,
    /// SQL space trimming normalizes empty/space-only values and NULL to None.
    pub error_code: Option<String>,
    pub count: i64,
    /// Percentage of all non-200 requests in the filtered report window.
    pub error_share: f64,
    pub first_seen_ts: i64,
    pub last_seen_ts: i64,
    pub avg_duration_ms: f64,
    pub max_duration_ms: i32,
    pub representative: AuditRecordSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailurePatternCoverage {
    pub aggregation_scope: String,
    /// String signature components are grouped bytewise, preserving case.
    pub group_by: [String; 4],
    pub total_patterns: i64,
    pub returned_patterns: usize,
    pub returned_error_requests: i64,
    /// Denominator from the same database statement as the returned patterns.
    pub total_error_requests: i64,
    pub covered_error_rate: f64,
    pub truncated: bool,
    pub limit: usize,
    /// Highest ID selects the newest ingested example, which can have an older request timestamp.
    pub representative_strategy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DashboardWindow {
    pub from_ts: i64,
    pub to_ts: i64,
    pub bucket_ms: i64,
    pub hours: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DashboardSummary {
    pub total_requests: i64,
    pub successful_requests: i64,
    pub error_requests: i64,
    pub error_rate: f64,
    pub success_rate: f64,
    pub avg_duration_ms: f64,
    pub avg_error_duration_ms: f64,
    pub max_duration_ms: i32,
    pub p95_duration_ms: i32,
    pub unique_api_keys: i64,
    pub unique_task_ids: i64,
    pub affected_paths: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelinePoint {
    pub ts: i64,
    pub count: i64,
    pub avg_duration_ms: f64,
    pub error_count: i64,
    pub error_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricSlice {
    pub label: String,
    pub value: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorRateSlice {
    pub label: String,
    pub total_requests: i64,
    pub error_requests: i64,
    pub error_rate: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordListResponse {
    pub items: Vec<AuditRecordSummary>,
    pub next_cursor_ts: Option<i64>,
    pub next_cursor_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct BidStatusCodeStat {
    pub bid: String,
    pub total_calls: i64,
    pub status_400_calls: i64,
    pub distinct_task_ids: i64,
    pub distinct_api_keys: i64,
    pub last_request_ts: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BidWatchItem {
    pub bid: String,
    pub note: Option<String>,
    pub created_ts: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BidReportWindow {
    pub from_ts: i64,
    pub to_ts: i64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BidReport {
    pub window: BidReportWindow,
    pub ranking: Vec<BidStatusCodeStat>,
    pub watched: Vec<BidStatusCodeStat>,
}

#[cfg(test)]
mod tests {
    use axum::{extract::Query, http::Uri};

    use super::RecordListQuery;

    #[test]
    fn record_list_query_parses_non_200_and_exact_status_filters() {
        let uri: Uri = "/api/records?non_200=true&status_code=201"
            .parse()
            .expect("valid URI");
        let Query(query) =
            Query::<RecordListQuery>::try_from_uri(&uri).expect("valid record filters");

        assert_eq!(query.non_200, Some(true));
        assert_eq!(query.status_code, Some(201));
    }
}
