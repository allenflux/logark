use super::*;
use crate::model::{KeyRouteErrorsQuery, KeyRouteErrorsResponse};

#[derive(Debug, thiserror::Error)]
pub enum KeyRouteError {
    #[error("{0}")]
    Invalid(&'static str),
    #[error(transparent)]
    Query(#[from] anyhow::Error),
}

struct KeyRouteScope {
    window: AnalyticsWindow,
    filter: CommonFilter,
    api_key: String,
    path: String,
}

impl AuditAnalyticsService {
    pub async fn key_route_errors(
        &self,
        query: KeyRouteErrorsQuery,
    ) -> Result<KeyRouteErrorsResponse, KeyRouteError> {
        // Reject invalid scopes before looking in either cache or acquiring SQL.
        let scope = validate_scope(
            query,
            self.config.max_window_hours,
            chrono::Utc::now().timestamp_millis(),
        )?;
        let cache_key = scope.cache_key();
        let shared_key = cache_key.clone();
        let ttl = Duration::from_secs(self.config.analytics_cache_ttl_secs);
        let shared_cache = self.redis_cache.clone();
        let service = self.clone();
        let operation = self.key_route_cache.get_or_load_with_cache(
            cache_key.clone(),
            async move {
                let cached = shared_cache?.get_typed(&shared_key).await?;
                Some((cached.payload, ttl.min(cached.remaining_ttl)))
            },
            async move {
                let rows = timed_dashboard_query("key_route_errors", async {
                    failure_patterns_query_with_exact_path(
                        &scope.window,
                        &scope.filter,
                        Some(&scope.path),
                    )
                    .build_query_as::<FailurePatternRow>()
                    .fetch_all(&service.pool)
                    .await
                    .map_err(Into::into)
                })
                .await?;
                let (patterns, mut coverage) = failure_patterns_from_rows(rows);
                coverage.aggregation_scope = "exact_key_route_window".into();
                let payload = KeyRouteErrorsResponse {
                    window: DashboardWindow {
                        from_ts: scope.window.from_ts,
                        to_ts: scope.window.to_ts,
                        hours: scope.window.hours,
                        bucket_ms: scope.window.bucket_ms,
                    },
                    api_key: scope.api_key,
                    path: scope.path,
                    method: scope.filter.method,
                    task_type: scope.filter.task_type,
                    patterns,
                    coverage,
                };
                let completed_at = SystemTime::now();
                let completed_instant = Instant::now();
                if let Some(redis) = &service.redis_cache {
                    redis.put(&cache_key, &payload, completed_at).await;
                }
                Ok((payload, ttl.saturating_sub(completed_instant.elapsed())))
            },
        );
        // Bound the HTTP wait too, including time queued behind another scope.
        let result = tokio::time::timeout(Duration::from_secs(35), operation)
            .await
            .map_err(|_| anyhow::anyhow!("Route error analysis timed out; please retry"))??;
        Ok((*result).clone())
    }
}

impl KeyRouteScope {
    fn cache_key(&self) -> String {
        // Length framing avoids delimiter collisions; the shared cache hashes
        // this key. Fixed boundaries must never be replaced by a fresh window.
        format!(
            "key-route-errors:v1:{}:{}:{}{}{}{}",
            self.window.from_ts,
            self.window.to_ts,
            cache_filter_part(Some(&self.api_key)),
            cache_filter_part(Some(&self.path)),
            cache_filter_part(self.filter.method.as_deref()),
            cache_filter_part(self.filter.task_type.as_deref()),
        )
    }
}

fn validate_scope(
    query: KeyRouteErrorsQuery,
    max_window_hours: u32,
    now_ts: i64,
) -> Result<KeyRouteScope, KeyRouteError> {
    use KeyRouteError::Invalid;
    let api_key = query.api_key.ok_or(Invalid("api_key is required"))?;
    if api_key.trim().is_empty() || api_key.len() > 1024 {
        return Err(Invalid("api_key must be nonblank and at most 1024 bytes"));
    }
    // An empty path is a legitimate stored route; absence is different.
    let path = query.path.ok_or(Invalid("path is required"))?;
    if path.len() > 16384 {
        return Err(Invalid("path must be at most 16384 bytes"));
    }
    if query.method.as_ref().is_some_and(|v| v.len() > 64)
        || query.task_type.as_ref().is_some_and(|v| v.len() > 512)
    {
        return Err(Invalid("method or task_type is too long"));
    }
    let from_ts = query.from_ts.ok_or(Invalid("from_ts is required"))?;
    let to_ts = query.to_ts.ok_or(Invalid("to_ts is required"))?;
    if from_ts < 0 || to_ts <= from_ts || to_ts > now_ts.saturating_add(60_000) {
        return Err(Invalid("invalid report time window"));
    }
    let span = to_ts
        .checked_sub(from_ts)
        .ok_or(Invalid("invalid report time window"))?;
    if span > i64::from(max_window_hours) * 3_600_000 {
        return Err(Invalid("report time window exceeds the configured maximum"));
    }
    let hours = ((span + 3_599_999) / 3_600_000) as u32;
    let bucket_ms = if hours <= 6 {
        300_000
    } else if hours <= 24 {
        900_000
    } else {
        3_600_000
    };
    Ok(KeyRouteScope {
        window: AnalyticsWindow {
            from_ts,
            to_ts,
            hours,
            bucket_ms,
        },
        filter: CommonFilter {
            path: None,
            method: normalize_str(query.method).map(|v| v.to_uppercase()),
            api_key: Some(api_key.clone()),
            task_type: normalize_str(query.task_type),
        },
        api_key,
        path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query() -> KeyRouteErrorsQuery {
        KeyRouteErrorsQuery {
            api_key: Some("ExactKey ".into()),
            path: Some("/v1/R_% ".into()),
            from_ts: Some(1_000),
            to_ts: Some(10_000),
            method: Some(" post ".into()),
            task_type: Some(" generation ".into()),
        }
    }

    #[test]
    fn validation_preserves_exact_identities_and_rejects_unbounded_windows() {
        let scope = validate_scope(query(), 168, 20_000).unwrap();
        assert_eq!(scope.api_key, "ExactKey ");
        assert_eq!(scope.path, "/v1/R_% ");
        assert_eq!(scope.filter.method.as_deref(), Some("POST"));
        assert_eq!(scope.filter.task_type.as_deref(), Some("generation"));
        assert!(scope.filter.path.is_none());
        let mut empty_path = query();
        empty_path.path = Some(String::new());
        assert!(validate_scope(empty_path, 168, 20_000).is_ok());
        let invalid = [
            KeyRouteErrorsQuery {
                api_key: None,
                ..query()
            },
            KeyRouteErrorsQuery {
                api_key: Some(" \t\n".into()),
                ..query()
            },
            KeyRouteErrorsQuery {
                api_key: Some("x".repeat(1025)),
                ..query()
            },
            KeyRouteErrorsQuery {
                path: None,
                ..query()
            },
            KeyRouteErrorsQuery {
                path: Some("x".repeat(16385)),
                ..query()
            },
            KeyRouteErrorsQuery {
                from_ts: None,
                ..query()
            },
            KeyRouteErrorsQuery {
                to_ts: None,
                ..query()
            },
            KeyRouteErrorsQuery {
                from_ts: Some(-1),
                ..query()
            },
            KeyRouteErrorsQuery {
                from_ts: Some(10_000),
                ..query()
            },
            KeyRouteErrorsQuery {
                from_ts: Some(10_001),
                ..query()
            },
            KeyRouteErrorsQuery {
                to_ts: Some(i64::MAX),
                ..query()
            },
            KeyRouteErrorsQuery {
                from_ts: Some(0),
                to_ts: Some(168 * 3_600_000 + 1),
                ..query()
            },
            KeyRouteErrorsQuery {
                method: Some("x".repeat(65)),
                ..query()
            },
            KeyRouteErrorsQuery {
                task_type: Some("x".repeat(513)),
                ..query()
            },
        ];
        for query in invalid {
            assert!(matches!(
                validate_scope(query, 168, 1_000_000_000),
                Err(KeyRouteError::Invalid(_))
            ));
        }
        assert!(validate_scope(
            KeyRouteErrorsQuery {
                to_ts: Some(80_001),
                ..query()
            },
            168,
            20_000
        )
        .is_err());
    }

    #[test]
    fn fixed_scope_cache_isolates_time_case_trailing_space_and_optional_filters() {
        let baseline = validate_scope(query(), 168, 20_000).unwrap().cache_key();
        for changed in [
            KeyRouteErrorsQuery {
                api_key: Some("ExactKey".into()),
                ..query()
            },
            KeyRouteErrorsQuery {
                api_key: Some("exactkey ".into()),
                ..query()
            },
            KeyRouteErrorsQuery {
                path: Some("/v1/R_%".into()),
                ..query()
            },
            KeyRouteErrorsQuery {
                path: Some("/v1/r_% ".into()),
                ..query()
            },
            KeyRouteErrorsQuery {
                from_ts: Some(1_001),
                ..query()
            },
            KeyRouteErrorsQuery {
                to_ts: Some(10_001),
                ..query()
            },
            KeyRouteErrorsQuery {
                method: None,
                ..query()
            },
            KeyRouteErrorsQuery {
                task_type: None,
                ..query()
            },
        ] {
            assert_ne!(
                baseline,
                validate_scope(changed, 168, 20_000).unwrap().cache_key()
            );
        }
    }

    #[test]
    fn route_query_is_exact_scoped_and_only_fetches_bounded_sample_summaries() {
        let scope = validate_scope(query(), 168, 20_000).unwrap();
        let query =
            failure_patterns_query_with_exact_path(&scope.window, &scope.filter, Some(&scope.path));
        let sql = query.sql();
        assert!(sql.contains("api_key = ? AND BINARY api_key = BINARY ?"));
        assert!(sql.contains("path = ? AND BINARY path = BINARY ?"));
        assert!(!sql.contains("LIKE"));
        assert!(!sql.contains("request_body"));
        assert!(!sql.contains("response_body"));
        assert!(sql.contains("MAX(id) AS representative_id"));
        assert!(sql.find("SUM(COUNT(*)) OVER ()").unwrap() < sql.find("LIMIT").unwrap());
        assert_eq!(sql.matches("FROM api_audit_log").count(), 1);
    }

    #[tokio::test]
    #[ignore = "requires LOGARK_TEST_DATABASE_URL pointing to a disposable MariaDB instance"]
    async fn key_route_patterns_preserve_scope_full_denominators_and_newest_samples(
    ) -> anyhow::Result<()> {
        use sqlx::{Connection, MySqlConnection};
        let mut connection =
            MySqlConnection::connect(&std::env::var("LOGARK_TEST_DATABASE_URL")?).await?;
        sqlx::query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',ONLY_FULL_GROUP_BY')")
            .execute(&mut connection)
            .await?;
        sqlx::query(
            "CREATE TEMPORARY TABLE api_audit_log (\
             id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT, request_id VARCHAR(64) NOT NULL DEFAULT 'fixture', \
             request_ts BIGINT NOT NULL DEFAULT 2000, duration_ms INT NOT NULL DEFAULT 100, \
             method VARCHAR(16) NOT NULL DEFAULT 'POST', path VARCHAR(255) NOT NULL DEFAULT '/v1/R_% ', \
             status_code SMALLINT NOT NULL DEFAULT 500, client_ip VARCHAR(64) NULL, \
             api_key VARCHAR(255) DEFAULT 'ExactKey ', task_id VARCHAR(64) NULL, \
             task_type VARCHAR(128) DEFAULT 'generation', error_code VARCHAR(128) NULL, \
             INDEX idx_api_key_request_ts (api_key, request_ts)) \
             DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
        ).execute(&mut connection).await?;
        for index in 0..15 {
            for _ in 0..(15 - index) {
                sqlx::query("INSERT INTO api_audit_log (error_code) VALUES (?)")
                    .bind(format!("CODE-{index:02}"))
                    .execute(&mut connection)
                    .await?;
            }
        }
        let newest = sqlx::query("INSERT INTO api_audit_log (request_ts, error_code, request_id) VALUES (1000, ' CODE-00 ', 'newest-ingested')")
            .execute(&mut connection).await?.last_insert_id();
        sqlx::query("INSERT INTO api_audit_log (error_code) VALUES ('code-00')")
            .execute(&mut connection)
            .await?;
        // Every decoy is newer than the representative and would contaminate
        // an imprecise scope or globally-selected representative.
        sqlx::query("INSERT INTO api_audit_log (api_key) VALUES ('ExactKey'), ('exactkey '), ('ExactKey x')")
            .execute(&mut connection).await?;
        sqlx::query("INSERT INTO api_audit_log (path) VALUES ('/v1/R_%'), ('/v1/r_% '), ('/v1/R_% /child'), ('/v1/Rxx '), ('')")
            .execute(&mut connection).await?;
        sqlx::query("INSERT INTO api_audit_log (request_ts) VALUES (999), (10001)")
            .execute(&mut connection)
            .await?;
        sqlx::query("INSERT INTO api_audit_log (method) VALUES ('GET')")
            .execute(&mut connection)
            .await?;
        sqlx::query("INSERT INTO api_audit_log (task_type) VALUES ('other')")
            .execute(&mut connection)
            .await?;
        sqlx::query("INSERT INTO api_audit_log (status_code) VALUES (200)")
            .execute(&mut connection)
            .await?;
        let scope = validate_scope(query(), 168, 20_000).unwrap();
        let rows =
            failure_patterns_query_with_exact_path(&scope.window, &scope.filter, Some(&scope.path))
                .build_query_as::<FailurePatternRow>()
                .fetch_all(&mut connection)
                .await?;
        let (patterns, coverage) = failure_patterns_from_rows(rows);
        assert_eq!(coverage.total_patterns, 16);
        assert_eq!(coverage.total_error_requests, 122);
        assert_eq!(coverage.returned_patterns, 12);
        assert_eq!(coverage.returned_error_requests, 115);
        assert!(coverage.truncated);
        assert_eq!(patterns[0].count, 16);
        assert_eq!(patterns[0].error_code.as_deref(), Some("CODE-00"));
        assert_eq!(patterns[0].representative.id, newest);
        assert_eq!(patterns[0].representative.request_id, "newest-ingested");
        assert_eq!(patterns[0].first_seen_ts, 1000);
        assert_eq!(patterns[0].last_seen_ts, 2000);
        assert!((patterns[0].error_share - 16.0 / 122.0 * 100.0).abs() < 1e-9);
        for item in &patterns {
            assert_eq!(item.path, "/v1/R_% ");
            assert_eq!(item.representative.api_key.as_deref(), Some("ExactKey "));
            assert_eq!(item.method, "POST");
            assert_eq!(item.representative.task_type.as_deref(), Some("generation"));
        }
        // Empty paths can be inspected independently; missing scopes return a
        // real zero result rather than inheriting the previous route's totals.
        for (path, expected) in [("", 1), ("/missing", 0)] {
            let rows =
                failure_patterns_query_with_exact_path(&scope.window, &scope.filter, Some(path))
                    .build_query_as::<FailurePatternRow>()
                    .fetch_all(&mut connection)
                    .await?;
            let (_, coverage) = failure_patterns_from_rows(rows);
            assert_eq!(coverage.total_error_requests, expected);
            assert!(!coverage.truncated);
        }
        let unfiltered = validate_scope(
            KeyRouteErrorsQuery {
                method: None,
                task_type: None,
                ..query()
            },
            168,
            20_000,
        )
        .unwrap();
        let rows = failure_patterns_query_with_exact_path(
            &unfiltered.window,
            &unfiltered.filter,
            Some(&unfiltered.path),
        )
        .build_query_as::<FailurePatternRow>()
        .fetch_all(&mut connection)
        .await?;
        assert_eq!(failure_patterns_from_rows(rows).1.total_error_requests, 124);
        Ok(())
    }
}
