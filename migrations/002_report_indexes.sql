-- Covers report aggregates without rereading the wide request/response rows.
-- The failure index covers the default report; api_key/task_type filters can
-- still require table lookups. Existing selective indexes remain available.
-- Run once on an existing database; this migration is not applied at startup.
ALTER TABLE api_audit_log
    ADD INDEX idx_report_summary (
        request_ts, status_code, duration_ms, path, api_key, task_id, task_type, method
    ),
    ADD INDEX idx_report_failures (
        request_ts, status_code, duration_ms, path, method, error_code
    ),
    ALGORITHM=INPLACE,
    LOCK=NONE;

-- Rollback (only removes these secondary indexes):
-- ALTER TABLE api_audit_log
--     DROP INDEX idx_report_summary,
--     DROP INDEX idx_report_failures,
--     ALGORITHM=INPLACE,
--     LOCK=NONE;
