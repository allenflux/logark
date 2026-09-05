import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const source = readFileSync(new URL("static/analytics.js", root), "utf8");
const bytes = readFileSync(new URL("static/analytics.wasm", root));
assert.equal(WebAssembly.validate(bytes), true, "checked-in artifact must be executable WebAssembly");

function load(overrides = {}) {
  const sandbox = {
    window: {},
    WebAssembly,
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, arrayBuffer: async () => bytes }),
    ...overrides,
  };
  vm.runInNewContext(source, sandbox, { filename: "static/analytics.js" });
  return sandbox.window.LogArkAnalytics;
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const equal = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);
const wasm = load();
const fallback = load({ WebAssembly: undefined });
assert.equal(await wasm.ready, true);
assert.equal(wasm.engine, "wasm");
assert.equal(await fallback.ready, false);
assert.equal(fallback.engine, "javascript");

const groups = [
  { id: "client", count: 10, status_code: 400, representative: { id: 91 } },
  { id: "server", count: 10, status_code: 503, representative: { id: 92 } },
  { id: "largest", count: 40, status_code: 422, representative: { id: 93 } },
];
const original = JSON.stringify(groups);
const ranked = wasm.rankFailures(groups, 100);
equal(ranked.map((row) => row.id), ["largest", "server", "client"], "volume ranking and server-error tie break");
equal(ranked.map((row) => row.priority_score), [40, 15, 10], "documented severity weights");
equal(ranked.map((row) => row.impact_share_pct), [40, 10, 10], "full-report denominator must be retained");
equal(ranked.map((row) => row.cumulative_share_pct), [40, 50, 60]);
assert.equal(ranked[1].representative, groups[1].representative, "original sample data must be retained");
assert.equal(JSON.stringify(groups), original, "ranking must not mutate rows");

equal(wasm.concentration([10, 60, 10, 20]), {
  shares: [60, 20, 10, 10], cumulative: [60, 80, 90, 100],
  top_three_share_pct: 90, coverage_share_pct: 100, pareto_count: 2,
});
equal(wasm.concentration([10, 60], 100), {
  shares: [60, 10], cumulative: [60, 70],
  top_three_share_pct: 70, coverage_share_pct: 70, pareto_count: null,
}, "truncated groups must not claim complete failure coverage");
assert.equal(wasm.concentration([], 0).pareto_count, 0);
assert.equal(wasm.concentration([], 100).pareto_count, null);
assert.equal(wasm.concentration([80, 20], 10).coverage_share_pct, 100, "denominator cannot be below the loaded count sum");
equal(wasm.concentration(new Float64Array([80, 20])), wasm.concentration([80, 20]));

const trend = [{ count: 10, error_count: 2 }, { count: 25, error_count: 0 },
  { count: 25, error_count: 8 }, { count: 1, error_count: 5 }, { count: null, error_count: -2 }];
equal(wasm.summarizeTrend(trend), {
  total_requests: 61, total_failures: 11,
  peak_index: 1, peak_requests: 25, peak_failure_index: 2, peak_failures: 8,
  failure_rate_pct: 11 / 61 * 100,
}, "trends clamp impossible failures and choose the first tied peak");
equal(wasm.summarizeTrend([]), {
  total_requests: 0, total_failures: 0, peak_index: -1, peak_requests: 0,
  peak_failure_index: -1, peak_failures: 0, failure_rate_pct: 0,
});
assert.equal(wasm.summarizeTrend([{ count: 10, error_count: 0 }]).peak_failure_index, -1);

let seed = 0x1a2b3c4d;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
const invalid = [NaN, Infinity, -Infinity, -10, null, undefined, "bad", "32", Number.MAX_VALUE];
let cases = 0;
for (const length of [0, 1, 2, 12, 31, 256, 8192, 8193]) {
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const counts = Array.from({ length }, (_, index) => index % 7 === 0 ? invalid[random() % invalid.length] : random() % 1000);
    const reportGroups = counts.map((value, index) => ({ id: index, count: value, status_code: [400, 429, 500, 503, 599, 600, "502"][random() % 7] }));
    const points = counts.map((value) => ({ count: value, error_count: random() % 800 }));
    const total = iteration % 2 ? counts.length * 1000 : undefined;
    equal(wasm.rankFailures(reportGroups, total), fallback.rankFailures(reportGroups, total), `ranking parity at ${length} rows`);
    equal(wasm.concentration(counts, total), fallback.concentration(counts, total), `concentration parity at ${length} rows`);
    equal(wasm.summarizeTrend(points), fallback.summarizeTrend(points), `trend parity at ${length} rows`);
    cases += 3;
  }
}
assert.equal(wasm.engine, "wasm", "oversized calls must fall back without disabling the available module");

// Check the ABI itself, not only the normalized adapter path.
const { instance } = await WebAssembly.instantiate(bytes, {});
const raw = instance.exports;
assert.equal(raw.abi_version(), 1);
assert.equal(raw.max_rows(), 8192);
assert.equal(raw.input_ptr() % 8, 0);
assert.equal(raw.output_ptr() % 8, 0);
assert.equal(raw.rank_failures(8193, 0), -1);
assert.equal(raw.concentration(0xffffffff, 0), -1);
assert.equal(raw.summarize_trend(8193), -1);
new Float64Array(raw.memory.buffer, raw.input_ptr(), 6).set([NaN, Infinity, 12, 99, -3, 5]);
assert.equal(raw.summarize_trend(3), 7);
equal(Array.from(new Float64Array(raw.memory.buffer, raw.output_ptr(), 7)), [12, 12, 1, 12, 1, 12, 100]);

// Calls remain available during loading, including when a response never arrives.
let resolveFetch;
const loading = load({ fetch: () => new Promise((resolve) => { resolveFetch = resolve; }) });
assert.equal(loading.engine, "javascript");
equal(loading.rankFailures(groups, 100), ranked);
resolveFetch({ ok: true, arrayBuffer: async () => bytes });
assert.equal(await loading.ready, true);
equal(loading.rankFailures(groups, 100), ranked);

for (const fetch of [
  async () => { throw new Error("offline"); },
  async () => ({ ok: false, status: 404 }),
  async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([0, 1, 2, 3]) }),
  async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) }),
]) {
  const blocked = load({ fetch });
  assert.equal(await blocked.ready, false);
  assert.equal(blocked.engine, "javascript");
  assert.ok(blocked.loadError);
  equal(blocked.rankFailures(groups, 100), ranked);
}

const timedOut = load({
  fetch: () => new Promise(() => {}),
  setTimeout: (callback) => setTimeout(callback, 1),
});
assert.equal(await timedOut.ready, false);
assert.match(timedOut.loadError.message, /timed out/);
equal(timedOut.summarizeTrend(trend), fallback.summarizeTrend(trend));

let assetRequest;
const relocated = load({
  document: { currentScript: { src: "https://example.test/nested/analytics.js?v=2" } },
  fetch: async (url) => { assetRequest = url; return { ok: true, arrayBuffer: async () => bytes }; },
});
assert.equal(await relocated.ready, true);
assert.equal(assetRequest, "https://example.test/nested/analytics.wasm");

console.log(`analytics checks passed (${cases} Rust/JavaScript parity cases; ${bytes.length} WASM bytes; ABI, loading, fallback, and coverage checks)`);
