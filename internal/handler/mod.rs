use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde_json::json;

use crate::{
    model::{DashboardQuery, HealthResponse, KeyRouteErrorsQuery, RecordListQuery},
    service::{AuditAnalyticsService, KeyRouteError},
};

#[derive(Clone)]
pub struct AppState {
    pub audit_service: AuditAnalyticsService,
}

pub async fn health(State(state): State<AppState>) -> (StatusCode, Json<HealthResponse>) {
    let (http_status, status) = match state.audit_service.check_database_ready().await {
        Ok(()) => (StatusCode::OK, "ok"),
        Err(error) => {
            tracing::warn!(error = %error, "database readiness check failed");
            (StatusCode::SERVICE_UNAVAILABLE, "unavailable")
        }
    };

    (
        http_status,
        Json(HealthResponse {
            status: status.into(),
            name: "logark".into(),
            cache_entries: state.audit_service.cache_entry_count().await,
            total_records: None,
            latest_request_ts: None,
        }),
    )
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

pub async fn key_route_errors(
    State(state): State<AppState>,
    Query(query): Query<KeyRouteErrorsQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let payload =
        state
            .audit_service
            .key_route_errors(query)
            .await
            .map_err(|error| match error {
                KeyRouteError::Invalid(message) => AppError::BadRequest(message.into()),
                KeyRouteError::Query(error) => AppError::Internal(error),
            })?;
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
    BadRequest(String),
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
            AppError::BadRequest(message) => {
                (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
            }
        }
    }
}

#[cfg(test)]
mod health_tests {
    use super::*;
    use crate::config::Config;
    use sqlx::{mysql::MySqlPoolOptions, MySqlPool};
    use std::time::Duration;

    fn state(pool: MySqlPool) -> AppState {
        let config = Config {
            addr: "127.0.0.1:0".into(),
            database_url: String::new(),
            db_max_connections: 1,
            analytics_cache_ttl_secs: 15,
            analytics_query_timeout_secs: 300,
            redis_url: None,
            redis_cache_ttl_secs: 60,
            redis_operation_timeout_ms: 200,
            default_window_hours: 24,
            max_window_hours: 168,
            max_list_limit: 100,
            slow_request_ms: 1000,
            audit_retention_days: 8,
            audit_cleanup_interval_secs: 3600,
            audit_cleanup_batch_size: 1000,
            tg_bot_token: None,
            tg_chat_id: None,
            tg_poll_interval_secs: 10,
            tg_report_hour: 9,
            tg_report_minute: 0,
            tg_timezone_offset_hours: 8,
            tg_default_report_limit: 20,
        };
        AppState {
            audit_service: AuditAnalyticsService::new(pool, config),
        }
    }

    #[tokio::test]
    async fn route_validation_returns_400_before_touching_a_closed_database() -> anyhow::Result<()>
    {
        let pool =
            MySqlPoolOptions::new().connect_lazy("mysql://localhost/route_validation_test")?;
        pool.close().await;
        let app_state = state(pool);
        let valid = KeyRouteErrorsQuery {
            api_key: Some("fixture-key".into()),
            path: Some("/route".into()),
            from_ts: Some(1000),
            to_ts: Some(2000),
            method: None,
            task_type: None,
        };
        for query in [
            KeyRouteErrorsQuery {
                api_key: None,
                ..valid.clone()
            },
            KeyRouteErrorsQuery {
                api_key: Some(" \t".into()),
                ..valid.clone()
            },
            KeyRouteErrorsQuery {
                path: None,
                ..valid.clone()
            },
            KeyRouteErrorsQuery {
                from_ts: None,
                ..valid.clone()
            },
            KeyRouteErrorsQuery {
                from_ts: Some(2001),
                ..valid.clone()
            },
            KeyRouteErrorsQuery {
                to_ts: Some(i64::MAX),
                ..valid.clone()
            },
            KeyRouteErrorsQuery {
                from_ts: Some(0),
                to_ts: Some(169 * 3600000),
                ..valid.clone()
            },
        ] {
            let response = key_route_errors(State(app_state.clone()), Query(query))
                .await
                .into_response();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let body = axum::body::to_bytes(response.into_body(), 4096).await?;
            let value: serde_json::Value = serde_json::from_slice(&body)?;
            assert!(value["error"].is_string());
            assert!(!value["error"].as_str().unwrap().contains("fixture-key"));
        }
        Ok(())
    }

    #[tokio::test]
    async fn health_reports_database_failure_without_fake_record_count() -> anyhow::Result<()> {
        let pool = MySqlPoolOptions::new().connect_lazy("mysql://localhost/health_test")?;
        pool.close().await;
        let response = health(State(state(pool))).await.into_response();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(response.into_body(), 4096).await?;
        let value: serde_json::Value = serde_json::from_slice(&body)?;
        assert_eq!(value["status"], "unavailable");
        assert_eq!(value["name"], "logark");
        assert_eq!(value["cache_entries"], 0);
        assert!(value.get("total_records").unwrap().is_null());
        assert!(value.get("latest_request_ts").unwrap().is_null());
        Ok(())
    }

    #[tokio::test]
    async fn health_deadline_includes_waiting_for_a_database_connection() -> anyhow::Result<()> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("mysql://health_test@{}/health_test", listener.local_addr()?);
        // Accept the TCP connection but never complete the database handshake.
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(10)).await;
            drop(socket);
        });
        let pool = MySqlPoolOptions::new()
            .acquire_timeout(Duration::from_secs(30))
            .connect_lazy(&url)?;
        let response =
            tokio::time::timeout(Duration::from_secs(4), health(State(state(pool)))).await;
        server.abort();
        assert_eq!(response?.0, StatusCode::SERVICE_UNAVAILABLE);
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires LOGARK_TEST_DATABASE_URL pointing to a disposable MariaDB instance"]
    async fn health_ready_does_not_require_audit_data() -> anyhow::Result<()> {
        let pool = MySqlPoolOptions::new()
            .connect(&std::env::var("LOGARK_TEST_DATABASE_URL")?)
            .await?;
        let (status, Json(body)) = health(State(state(pool))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.status, "ok");
        assert_eq!(body.total_records, None);
        assert_eq!(body.latest_request_ts, None);
        Ok(())
    }
}
