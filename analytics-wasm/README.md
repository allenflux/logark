# Browser report analytics

A dependency-free Rust `no_std` WebAssembly module computes failure impact ranking,
Pareto concentration, and trend summaries. `static/analytics.js` loads it from the
same asset directory and exposes `window.LogArkAnalytics`. The checked-in
`static/analytics.wasm` is included by the existing static asset deployment.

Install the target once with `rustup target add wasm32-unknown-unknown`, then run:

```sh
bash scripts/build-wasm.sh
node scripts/test-analytics.mjs
```

The build is offline and locked. Its target directory is inside this crate.
No network requests or external services are used to process report data.
No performance claim is made: the purpose is to keep report computation in a
small, inspectable Rust module with a portable JavaScript fallback.

## JavaScript API

All computations are synchronous and return fresh objects without changing their
inputs. They work immediately, including before the asynchronous module finishes
loading. `ready` always resolves to a boolean, `engine` reports `wasm` or
`javascript`, and `loadError` exposes load/runtime failure details for diagnostics.
Loading times out after six seconds. Browsers with no WebAssembly, blocked fetches,
invalid modules, and inputs larger than 8192 rows use the JavaScript implementation.
`engine` describes the available engine; an oversized individual call uses JavaScript.

- `rankFailures(groups, totalFailures?)` accepts rows with `count` and
  `status_code`, preserves every original field, and adds `impact_share_pct`,
  `cumulative_share_pct`, and `priority_score`. Ranking is descending count, then
  descending priority score, then original input order. The score is
  `count × 1.5` for HTTP 500–599 and `count × 1` for all other codes. This explicit
  heuristic weights server errors more heavily on a count tie; it is neither a
  failure probability nor a claim about business severity. The caller may choose
  a different display order using the returned metrics.
- `concentration(counts, totalFailures?)` sorts counts descending and returns
  `shares`, `cumulative`, `top_three_share_pct`, `coverage_share_pct`, and
  `pareto_count` (smallest group count covering at least 80% of failures).
  `pareto_count` is `null` when the supplied total cannot be covered to 80% by the
  available groups, and `0` when there are no failures. Shares use
  `max(totalFailures, sum(available counts))`, so a truncated top-groups response
  cannot be mistaken for a report covering all failures.
- `summarizeTrend(points)` accepts chronological rows with `count` and
  `error_count`, returning `total_requests`, `total_failures`, `peak_index`,
  `peak_requests`, `peak_failure_index`, `peak_failures`, and `failure_rate_pct`.
  Failure counts are capped to their request counts. Peak ties choose the first
  occurrence; empty/all-zero series return `-1` for absent peaks.

Counts accept numeric strings and are clamped to `[0, Number.MAX_SAFE_INTEGER]`.
Nonfinite or nonnumeric values become zero. Percentages are always `[0,100]`.
All normalization and ranking rules are the same in both implementations.

## ABI version 1

The module exports linear `memory`, `abi_version()`, `max_rows()`, `input_ptr()`,
`output_ptr()` and the three routines below. Pointers are byte offsets into
separate fixed buffers, each with 32768 `f64` values. The instance processes one
call at a time. Copy the output before the next call. Row capacity is 8192;
oversized calls return `-1` without writing results. Other calls return the row
count, except `summarize_trend`, which returns its output length (7).

| Export | Input layout | Output layout |
| --- | --- | --- |
| `rank_failures(len: u32, total: f64)` | `[count, status]` per row | `[source_index, share_pct, cumulative_pct, score]` per ranked row |
| `concentration(len: u32, total: f64)` | count per row | `[share_pct, cumulative_pct]` per ranked row |
| `summarize_trend(len: u32)` | `[requests, failures]` per row | `[requests, failures, peak_index, peak_requests, peak_failure_index, peak_failures, rate_pct]` |

Input and output data are IEEE-754 doubles in WebAssembly's little-endian linear
memory. The JavaScript adapter normalizes values before writing them; Rust also
checks numeric bounds so direct ABI calls behave consistently.
