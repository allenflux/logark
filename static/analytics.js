/* Report computations share one explicit ABI with analytics-wasm/src/lib.rs. */
(function (global) {
  "use strict";

  const MAX_COUNT = Number.MAX_SAFE_INTEGER;
  let wasm = null;
  let failure = null;

  function numeric(value) {
    try {
      const number = Number(value);
      return Number.isFinite(number) ? number : 0;
    } catch (_) {
      return 0;
    }
  }

  const count = (value) => Math.min(MAX_COUNT, Math.max(0, numeric(value)));
  const percentage = (value, total) => total > 0 ? Math.min(100, Math.max(0, value / total * 100)) : 0;
  const severity = (status) => status >= 500 && status < 600 ? 1.5 : 1;
  const rows = (value) => Array.isArray(value) ? value : [];

  function run(name, input, length, outputLength, total) {
    if (!wasm || length > wasm.max_rows()) return null;
    try {
      new Float64Array(wasm.memory.buffer, wasm.input_ptr(), input.length).set(input);
      const result = total === undefined ? wasm[name](length) : wasm[name](length, total);
      if (result < 0) throw new Error("Analytics input exceeds ABI capacity");
      return new Float64Array(wasm.memory.buffer, wasm.output_ptr(), outputLength).slice();
    } catch (error) {
      // A blocked, stale, or incompatible module cannot make reports unavailable.
      failure = error;
      wasm = null;
      return null;
    }
  }

  function rankFailures(groups, totalFailures) {
    const source = rows(groups);
    const normalized = source.map((group, index) => ({
      index,
      count: count(group?.count),
      status: numeric(group?.status_code),
    }));
    const input = normalized.flatMap((group) => [group.count, group.status]);
    const result = run("rank_failures", input, source.length, source.length * 4, count(totalFailures));
    if (result) {
      return source.map((_, rank) => ({
        ...source[result[rank * 4]],
        impact_share_pct: result[rank * 4 + 1],
        cumulative_share_pct: result[rank * 4 + 2],
        priority_score: result[rank * 4 + 3],
      }));
    }
    const total = Math.max(count(totalFailures), normalized.reduce((sum, group) => sum + group.count, 0));
    normalized.sort((a, b) => b.count - a.count
      || b.count * severity(b.status) - a.count * severity(a.status)
      || a.index - b.index);
    let cumulative = 0;
    return normalized.map((group) => {
      cumulative += group.count;
      return {
        ...source[group.index],
        impact_share_pct: percentage(group.count, total),
        cumulative_share_pct: percentage(cumulative, total),
        priority_score: group.count * severity(group.status),
      };
    });
  }

  function concentration(values, totalFailures) {
    const counts = (Array.isArray(values) || ArrayBuffer.isView(values) ? Array.from(values) : []).map(count);
    const result = run("concentration", counts, counts.length, counts.length * 2, count(totalFailures));
    const shares = [];
    const cumulative = [];
    if (result) {
      for (let index = 0; index < counts.length; index += 1) {
        shares.push(result[index * 2]);
        cumulative.push(result[index * 2 + 1]);
      }
    } else {
      const total = Math.max(count(totalFailures), counts.reduce((sum, value) => sum + value, 0));
      let running = 0;
      counts.sort((a, b) => b - a).forEach((value) => {
        running += value;
        shares.push(percentage(value, total));
        cumulative.push(percentage(running, total));
      });
    }
    const coverage = cumulative[cumulative.length - 1] || 0;
    const paretoIndex = cumulative.findIndex((value) => value >= 80);
    const hasFailures = count(totalFailures) > 0 || counts.some((value) => value > 0);
    return {
      shares,
      cumulative,
      top_three_share_pct: cumulative[Math.min(2, cumulative.length - 1)] || 0,
      coverage_share_pct: coverage,
      pareto_count: !hasFailures ? 0 : paretoIndex >= 0 ? paretoIndex + 1 : null,
    };
  }

  function summarizeTrend(points) {
    const source = rows(points);
    const input = source.flatMap((point) => [count(point?.count), count(point?.error_count)]);
    const result = run("summarize_trend", input, source.length, 7);
    let totals = result;
    if (!totals) {
      totals = [0, 0, -1, 0, -1, 0, 0];
      source.forEach((_, index) => {
        const requests = input[index * 2];
        const failures = Math.min(requests, input[index * 2 + 1]);
        totals[0] += requests;
        totals[1] += failures;
        if (requests > totals[3]) {
          totals[2] = index;
          totals[3] = requests;
        }
        if (failures > totals[5]) {
          totals[4] = index;
          totals[5] = failures;
        }
      });
      totals[6] = percentage(totals[1], totals[0]);
    }
    return {
      total_requests: totals[0],
      total_failures: totals[1],
      peak_index: totals[2],
      peak_requests: totals[3],
      peak_failure_index: totals[4],
      peak_failures: totals[5],
      failure_rate_pct: totals[6],
    };
  }

  async function initialize() {
    if (typeof WebAssembly === "undefined" || typeof fetch !== "function") return false;
    let timer;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    try {
      const scriptUrl = typeof document === "undefined" ? null : document.currentScript?.src;
      const assetUrl = scriptUrl ? new URL("analytics.wasm", scriptUrl).href : "/assets/analytics.wasm";
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller?.abort();
          reject(new Error("Analytics module loading timed out"));
        }, 6000);
      });
      const loading = (async () => {
        const response = await fetch(assetUrl, controller ? { signal: controller.signal } : {});
        if (!response.ok) throw new Error(`Analytics module HTTP ${response.status}`);
        const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
        const exports = instance.exports;
        const required = ["abi_version", "max_rows", "input_ptr", "output_ptr", "rank_failures", "concentration", "summarize_trend"];
        if (!exports.memory || required.some((name) => typeof exports[name] !== "function")
          || exports.abi_version() !== 1 || exports.max_rows() !== 8192) {
          throw new Error("Unsupported analytics module ABI");
        }
        return exports;
      })();
      wasm = await Promise.race([loading, timeout]);
      return true;
    } catch (error) {
      failure = error;
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  global.LogArkAnalytics = Object.freeze({
    ready: initialize(),
    get engine() { return wasm ? "wasm" : "javascript"; },
    get loadError() { return failure; },
    rankFailures,
    concentration,
    summarizeTrend,
  });
})(window);
