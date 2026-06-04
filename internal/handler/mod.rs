use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{Html, IntoResponse},
    Json,
};
use serde_json::json;

use crate::{
    model::{DashboardQuery, HealthResponse, RecordListQuery},
    service::AuditAnalyticsService,
};

#[derive(Clone)]
pub struct AppState {
    pub audit_service: AuditAnalyticsService,
}

pub async fn index() -> Html<&'static str> {
    Html(include_str!("../../static/index.html"))
}

pub async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".into(),
        name: "logark".into(),
        cache_entries: state.audit_service.cache_entry_count().await,
    })
}

pub async fn dashboard(
    State(state): State<AppState>,
    Query(query): Query<DashboardQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let payload = state.audit_service.dashboard(query).await?;
    Ok(Json(json!(payload)))
}

pub async fn list_records(
    State(state): State<AppState>,
    Query(query): Query<RecordListQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let payload = state.audit_service.list_records(query).await?;
    Ok(Json(json!(payload)))
}

pub async fn get_record(
    State(state): State<AppState>,
    Path(id): Path<u64>,
) -> Result<Json<serde_json::Value>, AppError> {
    let Some(record) = state.audit_service.get_record_by_id(id).await? else {
        return Err(AppError::NotFound("record not found".into()));
    };
    Ok(Json(json!(record)))
}

pub async fn get_record_by_request_id(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let Some(record) = state
        .audit_service
        .get_record_by_request_id(&request_id)
        .await?
    else {
        return Err(AppError::NotFound("request id not found".into()));
    };
    Ok(Json(json!(record)))
}

pub async fn get_record_by_uuid(
    State(state): State<AppState>,
    Path(uuid): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let Some(record) = state.audit_service.get_record_by_uuid(&uuid).await? else {
        return Err(AppError::NotFound("uuid not found".into()));
    };
    Ok(Json(json!(record)))
}

pub enum AppError {
    Internal(anyhow::Error),
    NotFound(String),
}

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        Self::Internal(err.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        match self {
            AppError::Internal(err) => {
                tracing::error!(error = ?err, "request failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": err.to_string() })),
                )
                    .into_response()
            }
            AppError::NotFound(message) => {
                (StatusCode::NOT_FOUND, Json(json!({ "error": message }))).into_response()
            }
        }
    }
}
