use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
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
    pub task_type: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub name: String,
    pub cache_entries: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct DashboardResponse {
    pub window: DashboardWindow,
    pub summary: DashboardSummary,
    pub throughput: Vec<TimelinePoint>,
    pub latency: Vec<TimelinePoint>,
    pub top_paths: Vec<MetricSlice>,
    pub status_distribution: Vec<MetricSlice>,
    pub top_api_keys: Vec<MetricSlice>,
    pub top_task_types: Vec<MetricSlice>,
    pub latest_errors: Vec<AuditRecordSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DashboardWindow {
    pub from_ts: i64,
    pub to_ts: i64,
    pub bucket_ms: i64,
    pub hours: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct DashboardSummary {
    pub total_requests: i64,
    pub error_requests: i64,
    pub success_rate: f64,
    pub avg_duration_ms: f64,
    pub max_duration_ms: i32,
    pub p95_duration_ms: i32,
    pub unique_api_keys: i64,
    pub unique_task_ids: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TimelinePoint {
    pub ts: i64,
    pub count: i64,
    pub avg_duration_ms: f64,
    pub error_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetricSlice {
    pub label: String,
    pub value: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordListResponse {
    pub items: Vec<AuditRecordSummary>,
    pub next_cursor_ts: Option<i64>,
    pub next_cursor_id: Option<u64>,
}
