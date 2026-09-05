#!/usr/bin/env python3
"""Compare report indexes in a disposable local MariaDB container.

Uses only Python's standard library and Docker. No application configuration,
credentials, host database, or production service is accessed. The container
has no published port or persistent volume and is removed on exit.

Example: python3 scripts/benchmark-report-indexes.py --rows 200000 \
    --output /tmp/logark-report-index-benchmark.json

Times describe this synthetic fixture, not expected production speedups.
"""

import argparse
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import time
import uuid


ROOT = Path(__file__).resolve().parents[1]
FROM_TS = 1_710_000_000_000
TO_TS = FROM_TS + 86_400_000
WINDOW = f"request_ts BETWEEN {FROM_TS} AND {TO_TS}"
FILTERED = WINDOW + " AND path LIKE '/v1/%' AND method = 'POST' AND api_key = 'key-1' AND task_type = 'type-1'"


def summary(where):
    return f"""SELECT COUNT(*) AS total_requests,
        SUM(status_code = 200) AS successful_requests,
        SUM(status_code <> 200) AS error_requests,
        AVG(duration_ms) AS avg_duration_ms,
        AVG(CASE WHEN status_code <> 200 THEN duration_ms END) AS avg_error_duration_ms,
        MAX(duration_ms) AS max_duration_ms,
        COUNT(DISTINCT NULLIF(api_key, '')) AS unique_api_keys,
        COUNT(DISTINCT NULLIF(task_id, '')) AS unique_task_ids,
        COUNT(DISTINCT CASE WHEN status_code <> 200 THEN NULLIF(path, '') END) AS affected_paths
        FROM api_audit_log WHERE {where}"""


def failure_patterns(where):
    return f"""SELECT sample.id, sample.request_id, sample.request_ts, sample.duration_ms,
        sample.method, sample.path, sample.status_code, sample.client_ip, sample.api_key,
        sample.task_id, sample.task_type, sample.error_code,
        patterns.normalized_error_code, patterns.count, patterns.first_seen_ts,
        patterns.last_seen_ts, patterns.avg_duration_ms, patterns.max_duration_ms,
        patterns.total_patterns, patterns.total_error_requests
        FROM (SELECT MIN(method) AS method, MIN(path) AS path, status_code,
        MIN(NULLIF(TRIM(error_code), '')) AS normalized_error_code,
        COUNT(*) AS count, MIN(request_ts) AS first_seen_ts, MAX(request_ts) AS last_seen_ts,
        AVG(duration_ms) AS avg_duration_ms, MAX(duration_ms) AS max_duration_ms,
        MAX(id) AS representative_id, COUNT(*) OVER () AS total_patterns,
        SUM(COUNT(*)) OVER () AS total_error_requests
        FROM api_audit_log WHERE {where} AND status_code <> 200
        GROUP BY BINARY method, BINARY path, status_code, BINARY NULLIF(TRIM(error_code), '')
        ORDER BY count DESC, last_seen_ts DESC, BINARY MIN(method), BINARY MIN(path),
        status_code, BINARY MIN(NULLIF(TRIM(error_code), '')) LIMIT 12) AS patterns
        INNER JOIN api_audit_log AS sample ON sample.id = patterns.representative_id
        ORDER BY patterns.count DESC, patterns.last_seen_ts DESC, BINARY patterns.method,
        BINARY patterns.path, patterns.status_code, BINARY patterns.normalized_error_code"""


def queries(rows):
    result = {
        "summary": summary(WINDOW),
        "summary_filtered": summary(FILTERED),
        "timeline": f"""SELECT FLOOR(request_ts / 3600000) * 3600000 AS ts,
            COUNT(*) AS count, AVG(duration_ms) AS avg_duration_ms,
            SUM(status_code <> 200) AS error_count
            FROM api_audit_log WHERE {WINDOW} GROUP BY ts ORDER BY ts""",
        "p95": f"SELECT duration_ms FROM (SELECT duration_ms, SUM(COUNT(*)) OVER (ORDER BY duration_ms DESC) AS cumulative_count, SUM(COUNT(*)) OVER () AS total_count FROM api_audit_log WHERE {WINDOW} GROUP BY duration_ms) AS histogram WHERE cumulative_count > FLOOR(total_count / 20) ORDER BY duration_ms DESC LIMIT 1",
        "failure_patterns": failure_patterns(WINDOW),
        "failure_patterns_filtered": failure_patterns(FILTERED),
    }
    for column, limit in (("path", 10), ("method", 8), ("api_key", 8), ("task_type", 8)):
        result[f"dimension_{column}"] = f"""SELECT {column} AS label,
            COUNT(*) AS total_requests, SUM(status_code <> 200) AS error_requests
            FROM api_audit_log WHERE {WINDOW} AND {column} IS NOT NULL AND {column} <> ''
            GROUP BY {column} HAVING error_requests > 0
            ORDER BY error_requests DESC, total_requests DESC, {column} LIMIT {limit}"""
    return result


def tables_in(plan):
    tables = []
    if isinstance(plan, dict):
        table = plan.get("table")
        if isinstance(table, dict):
            tables.append({key: table[key] for key in (
                "table_name", "access_type", "key", "using_index", "rows", "r_rows", "r_loops", "r_engine_stats"
            ) if key in table})
        for value in plan.values():
            tables.extend(tables_in(value))
    elif isinstance(plan, list):
        for value in plan:
            tables.extend(tables_in(value))
    return tables


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=200_000)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--image", default="mariadb:11.4")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 100 <= args.rows <= 1_000_000 or not 1 <= args.repeats <= 10:
        parser.error("rows must be 100..1000000; repeats must be 1..10")

    container = "logark-report-index-bench-" + uuid.uuid4().hex[:10]

    def docker(*command, sql=None, timeout=600):
        return subprocess.run(["docker", *command], input=sql, text=True,
                              capture_output=True, check=True, timeout=timeout).stdout

    def query(sql):
        return docker("exec", "-i", container, "mariadb", "--user=root",
                      "--default-character-set=utf8mb4", "--batch", "--raw",
                      "--skip-column-names", "logark_benchmark", sql=sql)

    def storage():
        sql = """SELECT index_name, stat_value * @@innodb_page_size
            FROM mysql.innodb_index_stats WHERE database_name = DATABASE()
            AND table_name = 'api_audit_log' AND stat_name = 'size' ORDER BY index_name"""
        return {name: int(size) for name, size in (line.split("\t") for line in query(sql).splitlines())}

    all_queries = queries(args.rows)

    def measure():
        readings = {}
        for name, sql in all_queries.items():
            result = query(sql)
            timings = []
            plan = None
            for _ in range(args.repeats):
                plan = json.loads(query("ANALYZE FORMAT=JSON " + sql))
                timings.append(plan["query_block"]["r_total_time_ms"])
            readings[name] = {
                "result_sha256": hashlib.sha256(result.encode()).hexdigest(),
                "median_server_ms": statistics.median(timings),
                "server_ms": timings,
                "tables": tables_in(plan),
            }
            print(f"  {name}: {readings[name]['median_server_ms']:.1f} ms", flush=True)
        return readings

    started = False
    try:
        docker("run", "-d", "--rm", "--pull=never", "--name", container,
               "--memory=1g", "--network=none",
               "-e", "MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1",
               "-e", "MARIADB_DATABASE=logark_benchmark", args.image,
               "--innodb-buffer-pool-size=268435456", "--innodb-stats-persistent-sample-pages=128")
        started = True
        for _ in range(60):
            try:
                query("SELECT 1")
                break
            except subprocess.CalledProcessError:
                time.sleep(0.5)
        else:
            raise RuntimeError("disposable MariaDB did not become ready")
        version = query("SELECT VERSION()").strip()
        query((ROOT / "migrations/001_init.sql").read_text())
        # Fresh-install schemas may already include these indexes. Remove them
        # only inside this disposable fixture so the baseline remains comparable.
        existing = query("""SELECT DISTINCT index_name FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'api_audit_log'
            AND index_name IN ('idx_report_summary', 'idx_report_failures')""").splitlines()
        if existing:
            query("ALTER TABLE api_audit_log " + ", ".join("DROP INDEX " + name for name in existing)
                  + ", ALGORITHM=INPLACE, LOCK=NONE")
        print(f"Creating {args.rows:,} synthetic rows with 2 KB of body data each ({version})...", flush=True)
        query(f"""INSERT INTO api_audit_log
            (request_id, request_ts, response_ts, duration_ms, method, path, status_code,
             api_key, task_id, task_type, error_code, created_ts, request_body, response_body)
            SELECT CONCAT('fixture-', seq), {FROM_TS} + FLOOR((seq - 1) * 86400000 / {args.rows}),
             {FROM_TS} + FLOOR((seq - 1) * 86400000 / {args.rows}) + MOD(seq * 37, 10000),
             MOD(seq * 37, 10000), ELT(1 + MOD(seq, 3), 'GET', 'POST', 'PATCH'),
             CONCAT('/v1/route-', MOD(seq, 128)),
             CASE MOD(seq, 20) WHEN 0 THEN 500 WHEN 1 THEN 400 WHEN 2 THEN 201 ELSE 200 END,
             CONCAT('key-', MOD(seq, 1024)), CONCAT('task-', FLOOR(seq / 4)),
             CONCAT('type-', MOD(seq, 8)), IF(MOD(seq, 2), 'UPSTREAM', NULL), {FROM_TS},
             REPEAT('x', 1024), REPEAT('y', 1024) FROM seq_1_to_{args.rows}""")
        query("ANALYZE TABLE api_audit_log")
        before_storage = storage()
        print("Before indexes (sequential repeated queries):", flush=True)
        before = measure()
        ddl_started = time.monotonic()
        query((ROOT / "migrations/002_report_indexes.sql").read_text())
        ddl_seconds = time.monotonic() - ddl_started
        # Exercise the maximum declared utf8mb4 lengths, not only ASCII fixtures.
        query(f"""INSERT INTO api_audit_log
            (request_id, request_ts, response_ts, duration_ms, method, path, status_code,
             api_key, task_id, task_type, error_code, created_ts)
            VALUES ('max-utf8mb4-key', {FROM_TS - 1}, {FROM_TS - 1}, 1,
             REPEAT('🧪',16), REPEAT('🧪',255), 500, REPEAT('🧪',255), REPEAT('🧪',64),
             REPEAT('🧪',128), REPEAT('🧪',128), {FROM_TS - 1})""")
        query("ANALYZE TABLE api_audit_log")
        after_storage = storage()
        print("After indexes (sequential repeated queries):", flush=True)
        after = measure()
        for name in all_queries:
            if before[name]["result_sha256"] != after[name]["result_sha256"]:
                raise AssertionError(f"query output changed after indexing: {name}")
        # Full row lookups for the <=12 samples are expected. The grouped audit
        # table should now be covered for the default report.
        must_cover = ("summary", "timeline", "p95", "failure_patterns",
                      "dimension_path", "dimension_method", "dimension_api_key", "dimension_task_type")
        for name in must_cover:
            audit_tables = [table for table in after[name]["tables"] if table["table_name"] == "api_audit_log"]
            if not audit_tables or not all(table.get("using_index") for table in audit_tables):
                raise AssertionError(f"default aggregate is not covered: {name}: {audit_tables}")
        query("""ALTER TABLE api_audit_log DROP INDEX idx_report_summary,
            DROP INDEX idx_report_failures, ALGORITHM=INPLACE, LOCK=NONE""")
        remaining = query("""SELECT COUNT(*) FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'api_audit_log'
            AND index_name IN ('idx_report_summary', 'idx_report_failures')""").strip()
        if remaining != "0":
            raise AssertionError("rollback left report indexes behind")
        report = {
            "database_version": version,
            "rows": args.rows,
            "body_bytes_per_row": 2048,
            "buffer_pool_bytes": 268_435_456,
            "note": "Synthetic local fixture; repeated queries, not a production or guaranteed cold-cache speedup.",
            "ddl_seconds": ddl_seconds,
            "maximum_utf8mb4_lengths_accepted": True,
            "query_outputs_identical": True,
            "online_index_rollback_verified": True,
            "index_bytes_before": before_storage,
            "index_bytes_after": after_storage,
            "added_index_bytes": sum(after_storage.get(name, 0) for name in ("idx_report_summary", "idx_report_failures")),
            "before": before,
            "after": after,
        }
        output = json.dumps(report, indent=2)
        if args.output:
            args.output.write_text(output + "\n")
            print(f"Saved measurements: {args.output}", flush=True)
        else:
            print(output)
        print("All outputs match; default report aggregates use covering indexes.", flush=True)
    finally:
        if started:
            subprocess.run(["docker", "stop", "--time", "10", container],
                           check=False, capture_output=True, text=True)


if __name__ == "__main__":
    main()
