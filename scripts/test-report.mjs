// Run with Playwright installed, or PLAYWRIGHT_MODULE=/path/to/playwright-core/package.json.
// Uses a disposable localhost fixture API. It never starts LogArk or reads database settings.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = modulePath
  ? require(modulePath.endsWith("package.json") ? dirname(modulePath) : modulePath)
  : await import("playwright");
const root = new URL("../", import.meta.url);
const start = Date.UTC(2026, 8, 4, 8);
const end = start + 24 * 3_600_000 - 1;
const errorsByHour = [4, 6, 7, 5, 4, 5, 8, 10, 12, 14, 12, 10, 15, 20, 25, 28, 35, 64, 38, 24, 18, 12, 14, 10];
const summaries = [
  { id: 1203, path: "/api/v1/images/generate", status_code: 429, error_code: "RATE_LIMIT", duration_ms: 320 },
  { id: 1202, path: "/api/v1/jobs/dispatch", status_code: 503, error_code: "UPSTREAM_UNAVAILABLE", duration_ms: 1850 },
  { id: 1201, path: "/api/v1/files/prepare", status_code: 408, error_code: "TIMEOUT", duration_ms: 9100 },
].map((item, index) => ({ ...item, request_id: `fixture-request-${item.id}`, request_ts: end - index * 60_000,
  method: "POST", client_ip: "192.0.2.10", api_key: "fixture-api-key-private-12345", task_id: `task-${item.id}`, task_type: "image" }));
const patterns = summaries.map((representative, index) => ({
  method: representative.method, path: representative.path, status_code: representative.status_code,
  error_code: representative.error_code, count: [240, 80, 40][index], error_share: [60, 20, 10][index],
  first_seen_ts: start + index * 60_000, last_seen_ts: representative.request_ts,
  avg_duration_ms: [240, 1420, 4800][index], max_duration_ms: representative.duration_ms, representative,
}));
const dimension = (label, total, errors) => ({ label, total_requests: total, error_requests: errors, error_rate: errors / total * 100 });
const privateKey = "fixture-api-key-private-12345";
const lowVolumeKey = "fixture-low-volume-key-100-percent-012345";
const secondaryKey = "fixture-secondary-api-key-67890";
const route = (path, total, errors, keyErrors) => ({ path, total_requests: total, error_requests: errors,
  error_rate: errors / total * 100, error_share: errors / keyErrors * 100 });
const apiKeyAnalysis = {
  total_keys: 18, failing_keys: 3, returned_keys: 3, total_requests: 4800, error_requests: 400, limit: 20, route_limit: 5,
  keys: [
    { api_key: lowVolumeKey, total_requests: 4, error_requests: 4, error_rate: 100, error_share: 1,
      affected_routes: 1, returned_route_errors: 4, routes: [route("/api/v1/low-volume", 4, 4, 4)] },
    { api_key: privateKey, total_requests: 2000, error_requests: 220, error_rate: 11, error_share: 55,
      affected_routes: 7, returned_route_errors: 198,
      routes: [route("/api/v1/images/generate", 1000, 120, 220), route("/api/v1/jobs/dispatch", 400, 50, 220),
        route("/api/v1/files/prepare", 300, 20, 220), route("/api/v1/uploads", 200, 6, 220), route("/api/v1/webhooks", 50, 2, 220)] },
    { api_key: secondaryKey, total_requests: 2000, error_requests: 176, error_rate: 8.8, error_share: 44,
      affected_routes: 2, returned_route_errors: 176,
      routes: [route("/api/v1/images/generate", 1600, 160, 176), route("/api/v1/jobs/dispatch", 400, 16, 176)] },
  ],
};
const fixture = {
  window: { from_ts: start, to_ts: end, bucket_ms: 3_600_000, hours: 24 },
  summary: { total_requests: 4800, successful_requests: 4400, error_requests: 400,
    error_rate: 400 / 4800 * 100, success_rate: 4400 / 4800 * 100, avg_duration_ms: 180,
    avg_error_duration_ms: 920, max_duration_ms: 9100, p95_duration_ms: 1500,
    unique_api_keys: 18, unique_task_ids: 320, affected_paths: 8 },
  error_timeline: errorsByHour.map((error_count, index) => ({ ts: start + index * 3_600_000,
    count: 200, error_count, error_rate: error_count / 2, avg_duration_ms: 180 })),
  error_status_distribution: [{ label: "429", value: 240 }, { label: "503", value: 80 }, { label: "408", value: 40 }],
  error_method_distribution: [dimension("POST", 4000, 380), dimension("GET", 800, 20)],
  top_error_paths: patterns.map((pattern) => dimension(pattern.path, 800, pattern.count)),
  top_error_api_keys: [dimension("fixture-api-key-private-12345", 2000, 220)],
  top_error_task_types: [dimension("image", 3200, 360)],
  api_key_analysis: apiKeyAnalysis,
  failure_patterns: patterns,
  failure_pattern_coverage: { aggregation_scope: "filtered_window", group_by: ["method", "path", "status_code", "error_code"],
    total_patterns: 18, returned_patterns: 3, returned_error_requests: 360, total_error_requests: 400,
    covered_error_rate: 90, truncated: true, limit: 12, representative_strategy: "highest_id" },
  latest_errors: summaries,
};

let scenario = "report";
const requests = [];
const responseGates = [];
function gateResponse(pathname, match = () => true) {
  let received, release, closed;
  const gate = {
    pathname, match, taken: false,
    received: new Promise((resolve) => { received = resolve; }),
    released: new Promise((resolve) => { release = resolve; }),
    closed: new Promise((resolve) => { closed = resolve; }),
    release: (result) => release(result),
    arrive(url, response) { received(url); response.once("close", closed); },
  };
  responseGates.push(gate);
  return gate;
}
const injection = '/api/' + 'long-path-'.repeat(60) + '<img src=x onerror="window.__reportInjection=true">';
const hostileKey = 'fixture-long-plaintext-key-'.repeat(12) + '\"><img src=x onerror="window.__apiKeyInjection=true">';
const routeDetailRecords = new Map();
function keyRouteErrors(url) {
  const apiKey = url.searchParams.get("api_key");
  const path = url.searchParams.get("path");
  const method = url.searchParams.get("method");
  const taskType = url.searchParams.get("task_type");
  const selected = dashboard(url).api_key_analysis.keys.find((key) => key.api_key === apiKey)?.routes.find((route) => route.path === path);
  const totalErrors = selected?.error_requests ?? 120;
  const counts = [Math.ceil(totalErrors * .6), Math.floor(totalErrors * .2), Math.floor(totalErrors * .1)];
  const routePatterns = ["QUOTA_EXCEEDED", "UPSTREAM_TIMEOUT", "INVALID_PARAMETER"].map((code, index) => {
    const representative = { ...summaries[index], id: 2203 - index, request_id: `scoped-request-${2203 - index}`,
      api_key: apiKey, path, method: method || "POST", task_type: taskType || "image",
      status_code: [429, 504, 400][index], error_code: scenario === "hostile" && index === 0 ? injection : code };
    routeDetailRecords.set(representative.id, representative);
    return { ...patterns[index], path, method: representative.method, status_code: representative.status_code,
      error_code: representative.error_code, count: counts[index], error_share: counts[index] / totalErrors * 100, representative };
  }).filter((pattern) => pattern.count > 0);
  const returnedErrors = counts.reduce((sum, count) => sum + count, 0);
  return { window: { ...fixture.window, from_ts: Number(url.searchParams.get("from_ts")), to_ts: Number(url.searchParams.get("to_ts")) },
    api_key: apiKey, path, method, task_type: taskType, patterns: routePatterns,
    coverage: { ...fixture.failure_pattern_coverage, total_patterns: routePatterns.length + Math.min(2, totalErrors - returnedErrors),
      returned_patterns: routePatterns.length, returned_error_requests: returnedErrors, total_error_requests: totalErrors,
      covered_error_rate: returnedErrors / totalErrors * 100, truncated: returnedErrors < totalErrors } };
}
function dashboard(url) {
  const payload = structuredClone(fixture);
  payload.window.hours = Number(url.searchParams.get("hours") || 24);
  if (scenario === "hostile") {
    payload.failure_patterns[0].path = injection;
    payload.failure_patterns[0].representative.path = injection;
    payload.top_error_paths[0].label = injection;
    payload.api_key_analysis.keys[0].api_key = hostileKey;
    payload.api_key_analysis.keys[0].routes[0].path = injection;
    payload.top_error_api_keys[0].label = hostileKey;
  }
  if (scenario === "missingKeyAnalysis") delete payload.api_key_analysis;
  if (scenario === "shortKey") {
    payload.api_key_analysis.keys[0].api_key = "short123";
    payload.top_error_api_keys[0].label = "short123";
  }
  if (scenario === "removedKey") {
    payload.api_key_analysis.keys = [payload.api_key_analysis.keys[0], payload.api_key_analysis.keys[2]];
    Object.assign(payload.api_key_analysis, { total_keys: 17, failing_keys: 2, returned_keys: 2, total_requests: 2800, error_requests: 180 });
  }
  if (scenario === "manyKeys") {
    const keys = Array.from({ length: 20 }, (_, index) => ({ api_key: `fixture-ranked-api-key-${index + 1}`,
      total_requests: 100, error_requests: 100 - index, error_rate: 100 - index,
      error_share: (100 - index) / 1884 * 100, affected_routes: 1, returned_route_errors: 100 - index,
      routes: [route(`/api/v1/ranked-route-${index + 1}`, 100, 100 - index, 100 - index)] }));
    Object.assign(payload.api_key_analysis, { total_keys: 24, failing_keys: 24, returned_keys: 20,
      total_requests: 2400, error_requests: 1884, keys });
  }
  if (scenario === "empty" || scenario === "success") {
    const total = scenario === "empty" ? 0 : 4800;
    Object.assign(payload.summary, { total_requests: total, successful_requests: total, error_requests: 0,
      error_rate: 0, success_rate: total ? 100 : 0, affected_paths: 0, avg_error_duration_ms: 0 });
    payload.error_timeline = total ? payload.error_timeline.map((point) => ({ ...point, error_count: 0, error_rate: 0 })) : [];
    for (const key of ["error_status_distribution", "error_method_distribution", "top_error_paths", "top_error_api_keys",
      "top_error_task_types", "failure_patterns", "latest_errors"]) payload[key] = [];
    Object.assign(payload.failure_pattern_coverage, { total_patterns: 0, returned_patterns: 0, returned_error_requests: 0,
      total_error_requests: 0, covered_error_rate: 0, truncated: false });
    Object.assign(payload.api_key_analysis, { total_keys: total ? 18 : 0, failing_keys: 0, returned_keys: 0,
      total_requests: total, error_requests: 0, keys: [] });
  }
  return payload;
}

const assetNames = new Set(["index.html", "app.js", "i18n.js", "styles.css", "favicon.svg", "analytics.js", "analytics.wasm", "scientific-charts.js", "clipboard.js"]);
const mime = { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml", wasm: "application/wasm" };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  requests.push(url);
  const json = async (body, status = 200) => {
    const gate = responseGates.find((item) => !item.taken && item.pathname === url.pathname && item.match(url));
    if (gate) {
      gate.taken = true;
      gate.arrive(url, response);
      const override = await Promise.race([gate.released, gate.closed]);
      if (response.destroyed) return;
      if (override) { body = override.body; status = override.status; }
    }
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === "/api/dashboard") {
    if (scenario === "failure") return json({ error: "Fixture report unavailable" }, 503);
    return json(dashboard(url));
  }
  if (url.pathname === "/api/key-route-errors") return json(keyRouteErrors(url));
  if (url.pathname === "/api/records") {
    return json(url.searchParams.has("cursor_ts")
      ? { items: summaries.slice(2), next_cursor_ts: null, next_cursor_id: null }
      : { items: summaries.slice(0, 2), next_cursor_ts: summaries[1].request_ts, next_cursor_id: summaries[1].id });
  }
  if (/^\/api\/records\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split("/").at(-1));
    const record = routeDetailRecords.get(id) || summaries.find((item) => item.id === id);
    if (!record) return json({ error: "Fixture record missing" }, 404);
    return json({ ...record, response_ts: record.request_ts + record.duration_ms, query_string: "fixture=true", uuid: "fixture-uuid",
      request_headers_json: '{"content-type":"application/json"}', response_headers_json: '{"retry-after":"30"}',
      request_body: '{"task":"fixture"}', response_body: JSON.stringify({ error: record.error_code, message: "Representative failure response" }),
      request_body_size: 18, response_body_size: 88, request_body_truncated: false, response_body_truncated: false });
  }
  const name = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/assets\//, "");
  if (!assetNames.has(name)) { response.writeHead(404); response.end(); return; }
  try {
    const body = await readFile(new URL(`static/${name}`, root));
    response.writeHead(200, { "Content-Type": mime[name.split(".").at(-1)], "Cache-Control": "no-store" });
    response.end(body);
  } catch (error) { response.writeHead(500); response.end(error.message); }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const browserErrors = [];
const recordsRequests = () => requests.filter((url) => url.pathname === "/api/records");
const dashboardRequests = () => requests.filter((url) => url.pathname === "/api/dashboard");
const keyRouteRequests = () => requests.filter((url) => url.pathname === "/api/key-route-errors");
async function ready(page) {
  try {
    await page.waitForFunction(() => document.querySelector("#refreshButton")?.getAttribute("aria-busy") === "false");
  } catch (error) {
    error.message += `\nScenario: ${scenario}; browser errors: ${JSON.stringify(browserErrors)}; page: ${await page.locator("#pageAlertMessage").textContent()}`;
    throw error;
  }
  await page.evaluate(() => window.LogArkAnalytics.ready);
}
async function openPage({ mode = "report", mobile = false, blockWasm = false, waitForReport = true, missingKeyTranslations = false } = {}) {
  scenario = mode;
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 },
    locale: "zh-CN", reducedMotion: "reduce", acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (error) => browserErrors.push(error.message));
  if (blockWasm) await page.route("**/assets/analytics.wasm", (route) => route.abort());
  if (missingKeyTranslations) {
    const source = await readFile(new URL("static/i18n.js", root), "utf8");
    const olderDictionary = source.replace(/^\s*"keyAnalysis\.[^"]+":.*\n/gm, "");
    assert.ok(!olderDictionary.includes('"keyAnalysis.title":'), "the fixture must actually remove the new translation entries");
    await page.route("**/assets/i18n.js", (route) => route.fulfill({ contentType: "text/javascript", body: olderDictionary }));
  }
  await page.goto(origin, { waitUntil: waitForReport ? "networkidle" : "domcontentloaded" });
  if (waitForReport) await ready(page);
  return { page, context };
}
async function paths(page) { return page.locator("#failurePatterns .failure-path").allTextContents(); }
async function noOverflow(page, label) {
  const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(widths.document <= widths.viewport + 1 && widths.body <= widths.viewport + 1, `${label}: ${JSON.stringify(widths)}`);
}
async function exportedReport(page) {
  const pending = page.waitForEvent("download");
  await page.click("#reportExportButton");
  const download = await pending;
  return readFile(await download.path(), "utf8");
}
async function finishPaint(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function keyAnalysisTranslations(page, locale) {
  const actual = await page.evaluate(() => [...document.querySelectorAll('[data-i18n^="keyAnalysis."]')]
    .map((node) => ({ key: node.dataset.i18n, actual: node.textContent, expected: window.LogArkI18n.t(node.dataset.i18n) })));
  assert.ok(actual.length >= 8, "the key-analysis navigation, headings and methodology must all be checked");
  for (const { key, actual: text, expected } of actual) {
    assert.notEqual(expected, key, `${locale}: ${key} is missing its translation`);
    assert.equal(text, expected, `${locale}: ${key} must be rendered in the selected language`);
  }
  const section = await page.locator("#apiKeyAnalysis").textContent();
  assert.ok(!/\bkeyAnalysis\.[a-zA-Z]+/.test(section), `${locale}: no internal translation keys may appear in the API key section`);
  if (locale === "en") assert.ok(!/[\p{Script=Han}]/u.test(section), "English key analysis must include translated dynamic labels and route coverage");
}

async function keyRouteDrilldownChecks() {
  const beforeInitialLoad = keyRouteRequests().length;
  const { page, context } = await openPage();
  const toggle = (index) => page.locator(`[data-key-route-index="${index}"]`);
  const panel = (index) => page.locator(`#keyRouteErrors-${index}`);
  const samples = (index) => panel(index).locator("[data-key-route-sample]");
  const complete = async (index) => samples(index).first().waitFor({ state: "visible" });
  assert.equal(keyRouteRequests().length, beforeInitialLoad, "initial reporting must not eagerly calculate per-route error details");
  await page.locator('#apiKeyRanking [data-key-index="1"]').click();
  const reportsBeforeExpansion = dashboardRequests().length;
  await toggle(0).focus();
  await toggle(0).press("Enter");
  await complete(0);
  assert.equal(await toggle(0).getAttribute("aria-expanded"), "true", "route drilldown is keyboard accessible");
  assert.equal(await samples(0).count(), 3, "all returned ranked error types expose a representative request");
  assert.deepEqual(Object.fromEntries(keyRouteRequests().at(-1).searchParams), {
    api_key: privateKey, path: apiKeyAnalysis.keys[1].routes[0].path, from_ts: String(start), to_ts: String(end),
  }, "the route query must use the selected plaintext key, exact route, and the completed report's absolute time window");
  const firstPanelText = await panel(0).textContent();
  for (const value of ["QUOTA_EXCEEDED", "UPSTREAM_TIMEOUT", "INVALID_PARAMETER", "72", "24", "12"]) {
    assert.ok(firstPanelText.includes(value), `ranked route errors must show ${value}`);
  }
  assert.match(firstPanelText, /108\s*\/\s*120/, "route error coverage must use all failures for this key and route");
  assert.ok(firstPanelText.indexOf("QUOTA_EXCEEDED") < firstPanelText.indexOf("UPSTREAM_TIMEOUT")
    && firstPanelText.indexOf("UPSTREAM_TIMEOUT") < firstPanelText.indexOf("INVALID_PARAMETER"), "error ranking preserves descending occurrence counts");
  await samples(0).first().click();
  await page.locator("#responseBody").filter({ hasText: "QUOTA_EXCEEDED" }).waitFor({ state: "visible" });
  assert.ok((await page.locator("#detailMeta").textContent()).includes(privateKey));
  assert.ok((await page.locator("#detailMeta").textContent()).includes("scoped-request-2203"),
    "representative details must load the scoped route record, not a global failure sample");
  assert.match(await page.locator("#detailPatternContext").textContent(), /72/);
  await page.locator("#detailModal [data-bs-dismiss=modal]").click();
  await page.locator("#detailModal").waitFor({ state: "hidden" });

  const completedRequestCount = keyRouteRequests().length;
  await toggle(0).click();
  assert.equal(await toggle(0).getAttribute("aria-expanded"), "false");
  await toggle(0).click();
  await complete(0);
  assert.equal(keyRouteRequests().length, completedRequestCount, "reopening a completed route reuses its current-report cache");
  await page.selectOption("#localeSelect", "en");
  assert.equal(await toggle(0).getAttribute("aria-expanded"), "true", "language changes preserve the expanded route");
  await complete(0);
  assert.equal(keyRouteRequests().length, completedRequestCount, "language changes must not calculate the same route again");
  await keyAnalysisTranslations(page, "en");
  await noOverflow(page, "desktop route error ranking");
  await page.locator("#apiKeyRoutes").screenshot({ path: "/tmp/tracenote-route-errors-desktop.png" });
  assert.equal(dashboardRequests().length, reportsBeforeExpansion, "route drilldown does not refresh the report");

  await page.locator("#advancedFilters > summary").click();
  await page.fill("#path", "/api/v1");
  await page.fill("#method", "post");
  await page.fill("#taskType", "image");
  await page.click("#refreshButton");
  await ready(page);
  assert.equal(await page.locator('[data-key-route-index][aria-expanded="true"]').count(), 0,
    "a new completed report closes route detail from the previous report");
  assert.equal(keyRouteRequests().length, completedRequestCount, "refresh must keep route-detail calculation lazy");
  await page.fill("#path", "/unapplied-route-filter");
  await page.fill("#method", "get");
  await page.fill("#taskType", "video");
  await page.fill("#apiKey", "unapplied-key-filter");
  await toggle(0).click();
  await complete(0);
  assert.equal(keyRouteRequests().length, completedRequestCount + 1, "new reports invalidate previously completed route results");
  assert.deepEqual(Object.fromEntries(keyRouteRequests().at(-1).searchParams), {
    api_key: privateKey, path: apiKeyAnalysis.keys[1].routes[0].path, from_ts: String(start), to_ts: String(end),
    method: "POST", task_type: "image",
  }, "route detail preserves applied method/task type and replaces broad path/key filters with the selected exact values; drafts are ignored");

  const previousMetrics = await page.locator("#metricCards").textContent();
  const reportsBeforeFailure = dashboardRequests().length;
  const failedRoute = gateResponse("/api/key-route-errors", (url) => url.searchParams.get("path") === apiKeyAnalysis.keys[1].routes[1].path);
  await toggle(1).click();
  await failedRoute.received;
  failedRoute.release({ status: 503, body: { error: "Fixture route unavailable" } });
  await panel(1).locator("[data-key-route-retry]").waitFor({ state: "visible" });
  assert.equal(await page.locator("#pageAlert").isVisible(), false, "route errors must stay local to the expanded route");
  assert.equal(await page.locator("#metricCards").textContent(), previousMetrics, "a failed route detail must preserve the dashboard");
  assert.equal(await panel(1).locator(".spinner-border").count(), 0, "failed route queries must stop loading");
  await panel(1).locator("[data-key-route-retry]").click();
  await complete(1);
  assert.equal(dashboardRequests().length, reportsBeforeFailure, "retry is limited to route details");

  // Disable transport cancellation here to independently test stale-result guards for route, key and report changes.
  await page.evaluate(() => {
    window.__routeFixtureFetch = window.fetch;
    window.fetch = (url, options) => window.__routeFixtureFetch(url,
      String(url).startsWith("/api/key-route-errors?") ? { ...options, signal: undefined } : options);
  });
  const lateRoute = gateResponse("/api/key-route-errors", (url) => url.searchParams.get("path") === apiKeyAnalysis.keys[1].routes[2].path);
  await toggle(2).click();
  await lateRoute.received;
  assert.equal(await toggle(2).getAttribute("aria-expanded"), "true");
  assert.equal(await samples(2).count(), 0, "a pending route must not display patterns from another route");
  await page.selectOption("#localeSelect", "zh-CN");
  assert.match(await panel(2).textContent(), /加载|读取|查询|统计/);
  await page.selectOption("#localeSelect", "en");
  assert.ok(!/[\p{Script=Han}]/u.test(await panel(2).textContent()), "in-flight route loading also follows the chosen language");
  await panel(2).filter({ hasText: "Still calculating" }).waitFor({ timeout: 8000 });
  const requestsDuringLoading = keyRouteRequests().length;
  await toggle(3).click();
  await complete(3);
  assert.equal(await page.locator('[data-key-route-index][aria-expanded="true"]').count(), 1);
  assert.equal(await toggle(2).getAttribute("aria-expanded"), "false");
  assert.equal(keyRouteRequests().length, requestsDuringLoading + 1, "a locale change must not duplicate the pending route query");
  const obsoleteRoute = keyRouteErrors(await lateRoute.received);
  obsoleteRoute.patterns[0].error_code = "OBSOLETE_ROUTE_RESPONSE";
  const lateRouteResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/key-route-errors"
    && new URL(response.url()).searchParams.get("path") === apiKeyAnalysis.keys[1].routes[2].path);
  lateRoute.release({ status: 200, body: obsoleteRoute });
  await (await lateRouteResponse).finished();
  await finishPaint(page);
  assert.ok(!(await page.locator("#apiKeyRoutes").textContent()).includes("OBSOLETE_ROUTE_RESPONSE"));
  assert.equal(await toggle(3).getAttribute("aria-expanded"), "true", "a late route response cannot change the active route");

  const lateKey = gateResponse("/api/key-route-errors", (url) => url.searchParams.get("path") === apiKeyAnalysis.keys[1].routes[4].path);
  await toggle(4).click();
  await lateKey.received;
  await page.locator('#apiKeyRanking [data-key-index="2"]').click();
  assert.equal(await page.locator('[data-key-route-index][aria-expanded="true"]').count(), 0, "key changes close the previous key's route detail");
  await toggle(0).click();
  await complete(0);
  assert.equal(keyRouteRequests().at(-1).searchParams.get("api_key"), secondaryKey);
  const obsoleteKey = keyRouteErrors(await lateKey.received);
  obsoleteKey.patterns[0].error_code = "OBSOLETE_KEY_RESPONSE";
  const lateKeyResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/key-route-errors"
    && new URL(response.url()).searchParams.get("path") === apiKeyAnalysis.keys[1].routes[4].path);
  lateKey.release({ status: 200, body: obsoleteKey });
  await (await lateKeyResponse).finished();
  await finishPaint(page);
  assert.ok(!(await page.locator("#apiKeyRoutes").textContent()).includes("OBSOLETE_KEY_RESPONSE"));
  assert.equal(await page.locator("#selectedApiKey").textContent(), secondaryKey);

  const lateWindow = gateResponse("/api/key-route-errors", (url) => url.searchParams.get("path") === apiKeyAnalysis.keys[2].routes[1].path);
  await toggle(1).click();
  await lateWindow.received;
  await page.click("#refreshButton");
  await ready(page);
  assert.equal(await page.locator('[data-key-route-index][aria-expanded="true"]').count(), 0);
  const obsoleteWindow = keyRouteErrors(await lateWindow.received);
  obsoleteWindow.patterns[0].error_code = "OBSOLETE_WINDOW_RESPONSE";
  const lateWindowResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/key-route-errors"
    && new URL(response.url()).searchParams.get("path") === apiKeyAnalysis.keys[2].routes[1].path);
  lateWindow.release({ status: 200, body: obsoleteWindow });
  await (await lateWindowResponse).finished();
  await finishPaint(page);
  assert.ok(!(await page.locator("#apiKeyRoutes").textContent()).includes("OBSOLETE_WINDOW_RESPONSE"));
  assert.equal(await page.locator('[data-key-route-index][aria-expanded="true"]').count(), 0,
    "old route responses cannot reopen details after a new report has completed");
  const emptyRoute = gateResponse("/api/key-route-errors");
  await toggle(0).click();
  const emptyPayload = keyRouteErrors(await emptyRoute.received);
  emptyPayload.patterns = [];
  Object.assign(emptyPayload.coverage, { total_patterns: 0, returned_patterns: 0, returned_error_requests: 0,
    total_error_requests: 0, covered_error_rate: 0, truncated: false });
  emptyRoute.release({ status: 200, body: emptyPayload });
  await panel(0).filter({ hasText: "No non-200 requests" }).waitFor({ state: "visible" });
  assert.equal(await samples(0).count(), 0, "an empty scoped result has an explicit empty state and no stale sample buttons");
  assert.equal(await panel(0).getAttribute("aria-busy"), "false");
  await context.close();
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE
    || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined) });
  const { page, context } = await openPage();
  await keyAnalysisTranslations(page, "zh-CN");
  assert.equal(await page.locator("#apiKeyAnalysis").getAttribute("aria-busy"), "false");
  assert.equal(await page.evaluate(() => window.LogArkAnalytics.engine), "wasm", "real WebAssembly should load in the browser");
  assert.equal(recordsRequests().length, 0, "initial report must not fetch the records list");
  assert.equal(await page.locator("#failurePatterns .failure-card").count(), 3);
  assert.equal(await page.locator("#patternCount").textContent(), "3 / 18 类");
  assert.equal(await page.locator("#failureCoverage [role=meter]").getAttribute("aria-valuenow"), "90");
  assert.match(await page.locator("#failureCoverage").textContent(), /360 \/ 400/);
  assert.deepEqual(await paths(page), patterns.map((pattern) => pattern.path));
  for (const host of ["endpointScatter", "failurePareto", "methodComposition"]) {
    assert.equal(await page.locator(`#${host} svg`).count(), 1, `${host} should render a statistical figure`);
    assert.ok(await page.locator(`#${host} table`).count() > 0, `${host} should include its source observations`);
  }
  assert.equal(await page.locator("#exportPreviewRange").textContent(), "最近 24 小时");
  assert.match(await page.locator("#exportPreviewStats").textContent(), /4,800/);
  const keyButtons = page.locator("#apiKeyRanking button[data-key-index]");
  assert.equal(await keyButtons.count(), 3);
  assert.deepEqual(await keyButtons.locator(".key-value").allTextContents(), [lowVolumeKey, privateKey, secondaryKey],
    "API keys remain readable in the server's error-rate order, including the small sample with 100% errors");
  assert.match(await keyButtons.first().locator(".key-rate").textContent(), /100(?:\.0+)?%/);
  assert.match(await keyButtons.nth(1).locator(".key-rate").textContent(), /11(?:\.0+)?%/);
  assert.equal(await keyButtons.first().locator(".key-sample-note").count(), 1, "a key with only four requests needs a low-sample note");
  assert.equal(await keyButtons.nth(1).locator(".key-sample-note").count(), 0, "large samples must not be labeled small");
  const keySummary = await page.locator("#apiKeySummary").textContent();
  for (const value of ["18", "3", "400"]) assert.ok(keySummary.includes(value), `API key summary should include ${value}`);
  assert.equal(await page.locator("#selectedApiKey").textContent(), lowVolumeKey);
  const requestsBeforeKeySelection = dashboardRequests().length;
  const scopeBeforeKeySelection = await page.locator("#reportFreshness").textContent();
  await keyButtons.nth(1).click();
  assert.equal(await page.locator("#selectedApiKey").textContent(), privateKey);
  assert.equal(await page.locator("#apiKeyRoutes .key-route-row").count(), 5);
  assert.deepEqual(await page.locator("#apiKeyRoutes .route-path").allTextContents(), apiKeyAnalysis.keys[1].routes.map((item) => item.path));
  assert.match(await page.locator("#apiKeyRoutes .route-share").first().textContent(), /54\.5\d*%/,
    "each route share uses all 220 errors for the selected key, not just the 198 returned route errors");
  assert.match(await page.locator("#apiKeyRouteCoverage").textContent(), /198\s*\/\s*220/);
  assert.match(await page.locator("#apiKeyRouteCoverage").textContent(), /90(?:\.0+)?%/);
  assert.equal(dashboardRequests().length, requestsBeforeKeySelection, "selecting an API key is local and must not recompute the dashboard");
  assert.equal(await page.locator("#reportFreshness").textContent(), scopeBeforeKeySelection, "selecting an API key must not change the report scope");
  assert.equal(await page.locator("#apiKey").inputValue(), "", "selection must not apply a hidden global key filter");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.locator("#apiKeyRoutes button[data-copy-api-key]").click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), privateKey, "copy returns the complete selected API key");
  await page.evaluate(() => {
    window.__clipboardFixtureDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    window.__clipboardFixtureExecCommand = document.execCommand;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    document.execCommand = () => false;
  });
  await page.locator('[data-pattern-copy="0"]').click();
  const manualCopy = page.locator(".clipboard-dialog__text");
  await manualCopy.waitFor({ state: "visible" });
  const copyPattern = patterns[0];
  const expectedSampleCopy = `${copyPattern.method} ${copyPattern.path} · HTTP ${copyPattern.status_code} · ${copyPattern.error_code}\nrequest_id: ${copyPattern.representative.request_id}`;
  assert.equal(await manualCopy.inputValue(), expectedSampleCopy, "the real sample-copy action supplies its exact signature and request ID to manual fallback");
  assert.deepEqual(await manualCopy.evaluate((field) => [field.selectionStart, field.selectionEnd]), [0, expectedSampleCopy.length],
    "manual fallback selects the complete sample text for copying");
  assert.equal(await page.locator("#pageAlert").isVisible(), false, "unavailable clipboard APIs must not create a page error");
  await page.locator(".clipboard-dialog button").click();
  await page.locator("#apiKeyRoutes button[data-copy-api-key]").click();
  await manualCopy.waitFor({ state: "visible" });
  assert.equal(await manualCopy.inputValue(), privateKey, "selected API keys also remain complete in manual-copy fallback");
  await page.locator(".clipboard-dialog button").click();
  await page.evaluate(() => {
    if (window.__clipboardFixtureDescriptor) Object.defineProperty(navigator, "clipboard", window.__clipboardFixtureDescriptor);
    else delete navigator.clipboard;
    document.execCommand = window.__clipboardFixtureExecCommand;
    delete window.__clipboardFixtureDescriptor;
    delete window.__clipboardFixtureExecCommand;
  });
  assert.ok((await page.locator("#topErrorKeys").textContent()).includes(privateKey), "the existing API key ranking also uses plaintext keys");
  await noOverflow(page, "desktop report");
  await page.screenshot({ path: "/tmp/logark-report-desktop.png", fullPage: true });
  await page.screenshot({ path: "/tmp/logark-report-first-screen.png" });
  await page.locator("#statisticalViews").screenshot({ path: "/tmp/logark-report-statistics.png" });
  await page.locator(".report-footer").screenshot({ path: "/tmp/tracenote-footer.png" });
  await page.locator("#apiKeyAnalysis").screenshot({ path: "/tmp/logark-api-key-desktop.png" });

  await page.selectOption("#patternSort", "severity");
  assert.deepEqual(await paths(page), [patterns[1].path, patterns[0].path, patterns[2].path]);
  await page.selectOption("#patternSort", "latency");
  assert.deepEqual(await paths(page), [patterns[2].path, patterns[1].path, patterns[0].path]);
  await page.locator("[data-pattern-detail]").first().click();
  await page.locator("#responseBody").filter({ hasText: "Representative failure response" }).waitFor({ state: "visible" });
  assert.match(await page.locator("#responseBody").textContent(), /TIMEOUT/);
  assert.match(await page.locator("#detailPatternContext").textContent(), /40/);
  assert.ok((await page.locator("#detailMeta").textContent()).includes(privateKey), "detail API keys must be plaintext as requested");
  await page.locator("#detailModal [data-bs-dismiss=modal]").click();
  await page.locator("#detailModal").waitFor({ state: "hidden" });
  assert.equal(recordsRequests().length, 0, "representative detail must not fetch all records");

  await page.selectOption("#localeSelect", "en");
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.equal(await page.locator("#typicalFailuresTitle").textContent(), "Representative failures");
  assert.match(await page.locator("#patternCount").textContent(), /3 \/ 18 patterns/);
  assert.equal(await page.locator("#selectedApiKey").textContent(), privateKey, "locale changes preserve the selected key");
  await keyAnalysisTranslations(page, "en");
  assert.equal(dashboardRequests().length, requestsBeforeKeySelection, "locale changes must not request another report");
  assert.ok(!(await page.locator("#statisticalViews").textContent()).includes("figures."), "figure translations should resolve after locale changes");
  for (const width of [768, 1024]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.waitForTimeout(300);
    await noOverflow(page, `English report at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('[data-chart-mode="rate"]').click();
  assert.equal(await page.locator('[data-chart-mode="rate"]').getAttribute("aria-pressed"), "true");
  const scrubber = page.locator(".chart-scrubber");
  const previousTooltip = await scrubber.getAttribute("aria-valuetext");
  await scrubber.focus();
  await scrubber.press("Home");
  assert.notEqual(await scrubber.getAttribute("aria-valuetext"), previousTooltip, "keyboard chart navigation updates the selected hour");

  await page.locator("#advancedFilters > summary").click();
  await noOverflow(page, "desktop advanced filters");
  await page.fill("#path", "/api/v1/scoped");
  await page.fill("#method", "post");
  await page.fill("#taskType", "image");
  await page.fill("#apiKey", "report-filter-secret-12345");
  await page.click("#refreshButton");
  await ready(page);
  const applied = dashboardRequests().at(-1).searchParams;
  assert.equal(applied.get("path"), "/api/v1/scoped");
  assert.equal(applied.get("method"), "POST");
  assert.equal(applied.get("task_type"), "image");
  assert.equal(applied.get("api_key"), "report-filter-secret-12345");
  assert.equal(await page.locator("#selectedApiKey").textContent(), privateKey, "refresh preserves the selected key if it still exists");
  assert.equal(recordsRequests().length, 0, "refreshing a collapsed records list must remain lazy");
  await page.fill("#path", "/unapplied-draft");
  await page.locator("#recordsDisclosure > summary").click();
  await page.locator("#recordsTable [data-record-id]").first().waitFor();
  assert.equal(recordsRequests().at(-1).searchParams.get("path"), "/api/v1/scoped", "records use the applied report scope, not an unsaved field edit");
  assert.equal(recordsRequests().at(-1).searchParams.get("non_200"), "true");
  await page.click("#loadMoreButton");
  await page.waitForFunction(() => document.querySelectorAll("#recordsTable [data-record-id]").length === 3);
  assert.equal(recordsRequests().at(-1).searchParams.get("cursor_id"), "1202");
  assert.equal(recordsRequests().at(-1).searchParams.get("path"), "/api/v1/scoped");

  const downloadPromise = page.waitForEvent("download");
  await page.click("#reportExportButton");
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^tracenote-report-.*\.md$/);
  const exported = await readFile(await download.path(), "utf8");
  assert.match(exported, /fixture-request-1201/);
  assert.match(exported, /360 \/ 400/);
  assert.match(exported, /\/api\/v1\/scoped/);
  for (const key of ["report-filter-secret-12345", privateKey, lowVolumeKey, secondaryKey]) {
    assert.ok(!exported.includes(key), "downloaded reports must not include complete API keys");
  }
  assert.ok(exported.includes("api\\_key: repo••••2345"), "export masks the applied API key while retaining its first and last four characters");
  assert.equal(exported.split("### fixt••••2345").length - 1, 2,
    "export masks both returned keys with matching prefixes and suffixes without dropping either key's analysis");
  assert.ok(exported.includes("### fixt••••7890"), "export includes the masked heading of every returned API key");
  assert.match(exported, /198\s*\/\s*220/, "export includes the selected key's full route-error denominator");
  assert.ok(exported.includes("/api/v1/webhooks"), "export includes per-key route details");
  assert.ok(!exported.includes("unapplied-draft"), "export uses the applied report scope");

  const previousMetrics = await page.locator("#metricCards").textContent();
  const previousKeyRanking = await page.locator("#apiKeyRanking").textContent();
  const previousKeyRoutes = await page.locator("#apiKeyRoutes").textContent();
  const delayed = gateResponse("/api/dashboard", (url) => url.searchParams.get("path") === "/api/v1/new-scope");
  await page.fill("#path", "/api/v1/new-scope");
  await page.click("#refreshButton");
  await delayed.received;
  const pendingRequestCount = dashboardRequests().length;
  assert.equal(await page.locator("#reportExportButton").isDisabled(), false, "the last complete report stays exportable while updating");
  assert.equal(await page.locator("#metricCards").textContent(), previousMetrics, "refreshing must retain readable report metrics");
  assert.equal(await page.locator("#apiKeyAnalysis").getAttribute("aria-busy"), "true", "key analysis signals that a refresh is pending");
  assert.equal(await page.locator("#apiKeyRanking").textContent(), previousKeyRanking, "pending refresh keeps the previous key ranking readable");
  assert.equal(await page.locator("#apiKeyRoutes").textContent(), previousKeyRoutes, "pending refresh keeps the selected key's route evidence readable");
  assert.match(await page.locator("#reportFreshness").textContent(), /\/api\/v1\/scoped/);
  assert.ok((await page.locator("#reportFreshness").textContent()).includes("report-filter-secret-12345"), "displayed scope includes the complete API key");
  await page.fill("#path", "/draft-during-request");
  assert.equal(await page.locator("#refreshButton").isDisabled(), false, "editing filters can supersede an in-flight request");
  await page.fill("#path", "/api/v1/new-scope");
  assert.equal(await page.locator("#refreshButton").isDisabled(), true, "unchanged in-flight filters remain deduplicated");
  await page.evaluate(() => {
    document.getElementById("dashboardFilter").requestSubmit();
    document.getElementById("dashboardFilter").requestSubmit();
  });
  await page.locator(".report-refresh-status").filter({ hasText: "server has not returned" }).waitFor({ timeout: 8000 });
  assert.equal(await page.locator("#apiKeyRanking").textContent(), previousKeyRanking, "the slow-request notice must not clear existing keys");
  assert.equal(await page.locator("#apiKeyRoutes").textContent(), previousKeyRoutes, "the slow-request notice must not clear existing route evidence");
  assert.equal(dashboardRequests().length, pendingRequestCount, "duplicate form submissions share one in-flight dashboard request");
  await page.click("#searchButton");
  await page.waitForFunction(() => document.getElementById("searchButton").getAttribute("aria-busy") === "false");
  assert.equal(recordsRequests().at(-1).searchParams.get("path"), "/api/v1/scoped", "records retain the completed scope while a new report is pending");
  const pendingExport = await exportedReport(page);
  assert.match(pendingExport, /\/api\/v1\/scoped/);
  assert.ok(!pendingExport.includes("report-filter-secret-12345") && pendingExport.includes("repo••••2345"),
    "exports of the previous report remain masked while a refresh is pending");
  assert.ok(!pendingExport.includes("/api/v1/new-scope"), "pending filters must not leak into the old report export");
  await page.locator("#reportOverview").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/tracenote-report-updating.png" });
  delayed.release({ status: 503, body: { error: "Fixture delayed report unavailable" } });
  await ready(page);
  assert.equal(await page.locator(".report-refresh-status").getAttribute("data-state"), "failed");
  assert.match(await page.locator(".report-refresh-status").textContent(), /previous report is still available/);
  assert.equal(await page.locator("#refreshSpinner").isVisible(), false, "failed refresh stops its spinner");
  assert.equal(await page.locator("#reportExportButton").isDisabled(), false, "failure keeps the previous report export enabled");
  assert.equal(await page.locator("#metricCards").textContent(), previousMetrics);
  assert.equal(await page.locator("#apiKeyAnalysis").getAttribute("aria-busy"), "false", "a failed refresh ends the key-analysis loading state");
  assert.equal(await page.locator("#apiKeyRanking").textContent(), previousKeyRanking);
  assert.equal(await page.locator("#apiKeyRoutes").textContent(), previousKeyRoutes);
  assert.match(await page.locator("#reportFreshness").textContent(), /\/api\/v1\/scoped/);
  assert.match(await exportedReport(page), /\/api\/v1\/scoped/);

  const retry = gateResponse("/api/dashboard");
  const delayedRecords = gateResponse("/api/records", (url) => url.searchParams.get("path") === "/api/v1/new-scope");
  await page.click("#refreshButton");
  await retry.received;
  retry.release();
  await delayedRecords.received;
  await ready(page);
  assert.equal(await page.locator("#pageAlert").isVisible(), false);
  assert.match(await page.locator("#reportFreshness").textContent(), /\/api\/v1\/new-scope/);
  assert.equal(await page.locator("#searchButton").getAttribute("aria-busy"), "true", "records remain pending after the report finishes");
  assert.equal(await page.locator("#recordsTable [data-record-id]").count(), 0, "a new report must not display records from the previous scope");
  assert.match(await exportedReport(page), /\/api\/v1\/new-scope/);
  delayedRecords.release();
  await page.locator("#recordsTable [data-record-id]").first().waitFor();
  await page.locator("#recordsDisclosure > summary").click();

  const superseded = gateResponse("/api/dashboard", (url) => url.searchParams.get("hours") === "6");
  await page.selectOption("#hours", "6");
  await superseded.received;
  assert.equal(await page.locator("#windowBadge").textContent(), "Last 24 hours");
  const abortObserved = Promise.race([
    superseded.closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  await page.selectOption("#hours", "1");
  await ready(page);
  assert.equal(await abortObserved, true, "a changed reporting period cancels the previous HTTP request");
  superseded.release();
  assert.equal(await page.locator("#windowBadge").textContent(), "Last 1 hour");

  // Make cancellation ineffective for one transport race so the late-response guard is exercised independently.
  await page.evaluate(() => {
    window.__fixtureFetch = window.fetch;
    window.fetch = (url, options) => window.__fixtureFetch(url,
      String(url).startsWith("/api/dashboard?") ? { ...options, signal: undefined } : options);
  });
  const lateReport = gateResponse("/api/dashboard", (url) => url.searchParams.get("hours") === "72");
  await page.selectOption("#hours", "72");
  await lateReport.received;
  await page.selectOption("#hours", "168");
  await ready(page);
  const lateResponse = page.waitForResponse((response) => new URL(response.url()).searchParams.get("hours") === "72");
  lateReport.release();
  await (await lateResponse).finished();
  await finishPaint(page);
  assert.equal(await page.locator("#windowBadge").textContent(), "Last 7 days", "late superseded results cannot overwrite the most recent report");
  assert.match(await exportedReport(page), /hours: 168/);
  await page.evaluate(() => { window.fetch = window.__fixtureFetch; delete window.__fixtureFetch; });
  scenario = "removedKey";
  await page.click("#refreshButton");
  await ready(page);
  assert.equal(await page.locator("#selectedApiKey").textContent(), lowVolumeKey, "when a selected key disappears, select the first current result");
  await context.close();

  await keyRouteDrilldownChecks();

  const initialReport = gateResponse("/api/dashboard");
  const firstLoad = await openPage({ waitForReport: false });
  await initialReport.received;
  assert.match(await firstLoad.page.locator("#metricCards").textContent(), /正在读取汇总统计/);
  assert.ok(!(await firstLoad.page.locator("#metricCards").textContent()).includes("计算错误率"));
  assert.equal(await firstLoad.page.locator("#reportExportButton").isDisabled(), true);
  assert.equal(await firstLoad.page.locator("#apiKeyAnalysis").getAttribute("aria-busy"), "true");
  for (const id of ["apiKeyRanking", "apiKeyRoutes"]) {
    assert.match(await firstLoad.page.locator(`#${id}`).textContent(), /正在读取汇总统计/);
  }
  await firstLoad.page.locator("#apiKeyRanking").filter({ hasText: "服务端尚未返回" }).waitFor({ timeout: 8000 });
  for (const id of ["apiKeyRanking", "apiKeyRoutes"]) {
    assert.match(await firstLoad.page.locator(`#${id}`).textContent(), /服务端尚未返回/,
      "each empty key-analysis panel must explain the server delay after four seconds");
  }
  await firstLoad.page.selectOption("#localeSelect", "en");
  await keyAnalysisTranslations(firstLoad.page, "en");
  for (const id of ["apiKeyRanking", "apiKeyRoutes"]) {
    assert.match(await firstLoad.page.locator(`#${id}`).textContent(), /server has not returned/,
      "switching language during a slow first load updates each panel");
  }
  await firstLoad.page.locator("#apiKeyAnalysis").screenshot({ path: "/tmp/tracenote-api-key-loading-en.png" });
  initialReport.release({ status: 503, body: { error: "Fixture initial report unavailable" } });
  await ready(firstLoad.page);
  assert.equal(await firstLoad.page.locator("#apiKeyAnalysis").getAttribute("aria-busy"), "false");
  for (const id of ["apiKeyRanking", "apiKeyRoutes"]) {
    assert.match(await firstLoad.page.locator(`#${id}`).textContent(), /could not be loaded.*Refresh to retry/,
      "an initial error must replace the waiting message with a retry instruction");
    assert.equal(await firstLoad.page.locator(`#${id} .spinner-border`).count(), 0);
  }
  assert.equal(await firstLoad.page.locator("#refreshButton").isDisabled(), false, "users can retry a failed initial request");
  await firstLoad.page.click("#refreshButton");
  await ready(firstLoad.page);
  assert.equal(await firstLoad.page.locator("#apiKeyRanking button[data-key-index]").count(), 3, "retry recovers the full key analysis");
  assert.equal(await firstLoad.page.locator("#apiKeyAnalysis").getAttribute("aria-busy"), "false");
  await firstLoad.context.close();

  const missingTranslationRequest = gateResponse("/api/dashboard");
  const missingTranslations = await openPage({ waitForReport: false, missingKeyTranslations: true });
  await missingTranslationRequest.received;
  for (const locale of ["zh-CN", "en"]) {
    await missingTranslations.page.selectOption("#localeSelect", locale);
    assert.equal(await missingTranslations.page.locator("#apiKeyAnalysisTitle").textContent(), "API Key 错误率与路由分布",
      "missing dictionary entries preserve the readable HTML fallback");
    assert.ok(!/\bkeyAnalysis\.[a-zA-Z]+/.test(await missingTranslations.page.locator("#apiKeyAnalysis").textContent()),
      "an older dictionary must not reproduce the raw-key headings in the reported screenshot");
  }
  await missingTranslations.page.locator("#apiKeyAnalysis").screenshot({ path: "/tmp/tracenote-api-key-missing-translations.png" });
  await missingTranslations.context.close();
  missingTranslationRequest.release();

  const mobile = await openPage({ mobile: true });
  await noOverflow(mobile.page, "mobile report");
  const svgBox = await mobile.page.locator(".hourly-chart").boundingBox();
  const chartBox = await mobile.page.locator(".hourly-chart-scroll").boundingBox();
  assert.ok(svgBox.width <= chartBox.width + 1, "mobile SVG must fit its parent without horizontal cropping");
  assert.ok(svgBox.x >= chartBox.x - 1 && svgBox.x + svgBox.width <= chartBox.x + chartBox.width + 1,
    "the full mobile plot, including its peak, must remain visible");
  for (const host of ["endpointScatter", "failurePareto", "methodComposition"]) {
    const plot = await mobile.page.locator(`#${host} svg`).boundingBox();
    const container = await mobile.page.locator(`#${host}`).boundingBox();
    assert.ok(plot.width <= container.width + 1, `${host} should fit the mobile figure width`);
  }
  await mobile.page.screenshot({ path: "/tmp/logark-report-mobile.png", fullPage: true });
  await mobile.page.screenshot({ path: "/tmp/logark-report-mobile-first-screen.png" });
  await mobile.page.locator("#statisticalViews").screenshot({ path: "/tmp/logark-report-mobile-statistics.png" });
  await mobile.page.locator("#apiKeyRanking button[data-key-index]").nth(1).click();
  assert.equal(await mobile.page.locator("#selectedApiKey").textContent(), privateKey);
  await noOverflow(mobile.page, "mobile API key route analysis");
  await mobile.page.locator("#apiKeyAnalysis").screenshot({ path: "/tmp/logark-api-key-mobile.png" });
  await mobile.page.locator('[data-key-route-index="0"]').click();
  await mobile.page.locator('#keyRouteErrors-0 [data-key-route-sample]').first().waitFor({ state: "visible" });
  await noOverflow(mobile.page, "mobile route error detail");
  await mobile.page.locator("#apiKeyRoutes").screenshot({ path: "/tmp/tracenote-route-errors-mobile.png" });
  await mobile.page.locator("#advancedFilters > summary").click();
  await noOverflow(mobile.page, "mobile advanced filters");
  const filterBox = await mobile.page.locator(".advanced-filter-content").boundingBox();
  const controlsBox = await mobile.page.locator(".report-controls").boundingBox();
  assert.ok(filterBox.width >= controlsBox.width - 2, "expanded mobile filters should use the full controls width");
  await mobile.page.screenshot({ path: "/tmp/logark-report-mobile-filters.png", fullPage: true });
  await mobile.page.locator("#advancedFilters > summary").click();
  await mobile.page.locator('.report-nav a[href="#requestDetails"]').click();
  await mobile.page.locator("#recordsTable [data-record-id]").first().waitFor();
  assert.equal(await mobile.page.locator("#recordsDisclosure").getAttribute("open"), "", "details navigation unfolds the lazy request list");
  await noOverflow(mobile.page, "mobile expanded records");
  await mobile.context.close();

  const hostile = await openPage({ mode: "hostile", mobile: true, blockWasm: true });
  assert.equal(await hostile.page.evaluate(() => window.LogArkAnalytics.engine), "javascript");
  assert.equal((await paths(hostile.page))[0], injection, "untrusted path must render as literal text");
  assert.equal(await hostile.page.locator("#failurePatterns img").count(), 0);
  assert.equal(await hostile.page.evaluate(() => window.__reportInjection), undefined);
  assert.equal(await hostile.page.locator("#apiKeyRanking .key-value").first().textContent(), hostileKey,
    "long untrusted API keys render in full as literal text");
  assert.equal(await hostile.page.locator("#selectedApiKey").textContent(), hostileKey);
  assert.equal(await hostile.page.locator("#apiKeyRoutes .route-path").first().textContent(), injection);
  assert.equal(await hostile.page.locator("#apiKeyAnalysis img").count(), 0);
  assert.equal(await hostile.page.evaluate(() => window.__apiKeyInjection), undefined);
  await hostile.page.locator('[data-key-route-index="0"]').click();
  await hostile.page.locator('#keyRouteErrors-0 [data-key-route-sample]').first().waitFor({ state: "visible" });
  assert.equal(keyRouteRequests().at(-1).searchParams.get("api_key"), hostileKey, "hostile keys are encoded as one exact URL parameter");
  assert.equal(keyRouteRequests().at(-1).searchParams.get("path"), injection, "hostile paths are encoded as one exact URL parameter");
  assert.ok((await hostile.page.locator("#keyRouteErrors-0").textContent()).includes(injection), "untrusted business error codes remain literal text");
  assert.equal(await hostile.page.locator("#apiKeyAnalysis img").count(), 0, "route error labels must never become executable markup");
  assert.equal(await hostile.page.evaluate(() => window.__reportInjection), undefined);
  await noOverflow(hostile.page, "hostile route error code on mobile");
  await hostile.page.locator("#apiKeyRoutes").screenshot({ path: "/tmp/tracenote-route-errors-hostile-mobile.png" });
  const hostileExport = await exportedReport(hostile.page);
  assert.ok(!hostileExport.includes("fixture-long-plaintext-key-"), "export masks a long untrusted API key before Markdown escaping");
  await noOverflow(hostile.page, "long hostile path in mobile report");
  for (const selector of ["#apiKeyRanking .key-value", "#selectedApiKey", "#apiKeyRoutes .route-path"]) {
    const size = await hostile.page.locator(selector).first().evaluate((node) => ({ visible: node.clientWidth, content: node.scrollWidth }));
    assert.ok(size.content <= size.visible + 1, `${selector} should wrap long plaintext values rather than clip them`);
  }
  assert.equal(await hostile.page.locator("#failureCoverage [role=meter]").getAttribute("aria-valuenow"), "90");
  await hostile.context.close();

  const manyKeys = await openPage({ mode: "manyKeys" });
  const fullRanking = manyKeys.page.locator("#apiKeyRanking button[data-key-index]");
  assert.equal(await fullRanking.count(), 20, "the complete server-provided top 20 should remain accessible");
  assert.match(await manyKeys.page.locator("#apiKeySummary").textContent(), /24/,
    "top-20 rendering must preserve full-window key counts");
  await fullRanking.last().click();
  assert.equal(await manyKeys.page.locator("#selectedApiKey").textContent(), "fixture-ranked-api-key-20");
  assert.match(await manyKeys.page.locator("#apiKeyRoutes .route-path").textContent(), /ranked-route-20/);
  const manyKeysExport = await exportedReport(manyKeys.page);
  assert.ok(manyKeysExport.includes("### fixt••••y-20"), "export includes the masked last key in the top 20");
  assert.ok(!manyKeysExport.includes("fixture-ranked-api-key-"), "none of the top-20 keys should be exported in plaintext");
  await noOverflow(manyKeys.page, "top-20 key ranking");
  await manyKeys.context.close();

  const shortKeyReport = await openPage({ mode: "shortKey" });
  assert.equal(await shortKeyReport.page.locator("#selectedApiKey").textContent(), "short123", "short keys stay readable on the page");
  await shortKeyReport.page.locator("#advancedFilters > summary").click();
  await shortKeyReport.page.fill("#apiKey", "abc");
  await shortKeyReport.page.click("#refreshButton");
  await ready(shortKeyReport.page);
  const shortKeyExport = await exportedReport(shortKeyReport.page);
  assert.ok(shortKeyExport.includes("### ••••••••"), "keys of eight characters are fully masked in exported analysis headings");
  assert.ok(shortKeyExport.includes("api\\_key: ••••••••"), "short API key filters are fully masked in exports");
  assert.ok(!shortKeyExport.includes("short123") && !shortKeyExport.includes("api\\_key: abc"), "exports reveal no part of a short key");
  assert.equal(await shortKeyReport.page.locator("#selectedApiKey").textContent(), "short123", "exporting does not mask the live page");
  await shortKeyReport.context.close();

  for (const mode of ["empty", "success", "failure", "missingKeyAnalysis"]) {
    const empty = await openPage({ mode });
    if (mode === "failure") {
      assert.equal(await empty.page.locator("#pageAlert").isVisible(), true);
      assert.match(await empty.page.locator("#pageAlertMessage").textContent(), /Fixture report unavailable/);
      assert.equal(await empty.page.locator("#reportExportButton").isDisabled(), true);
      assert.equal(await empty.page.locator("#metricCards .spinner-border").count(), 0, "an initial failure must not leave a loading spinner running");
      assert.match(await empty.page.locator("#metricCards").textContent(), /读取失败/);
      assert.equal(await empty.page.locator(".report-refresh-status").getAttribute("data-state"), "failed");
    } else if (mode === "missingKeyAnalysis") {
      assert.equal(await empty.page.locator("#apiKeyRanking button[data-key-index]").count(), 0);
      const missingText = await empty.page.locator("#apiKeyAnalysis").textContent();
      assert.match(missingText, /未提供|不支持|尚未|不可用|升级/,
        "an old API without key analysis should show an explicit unavailable state");
      assert.ok(!/0\s*%/.test(missingText), "missing key analytics must not pretend to be a measured zero error rate");
      assert.equal(await empty.page.locator("#failurePatterns .failure-card").count(), 3, "a missing optional field must not break existing report sections");
    } else {
      assert.equal(await empty.page.locator("#failurePatterns .failure-card").count(), 0);
      assert.match(await empty.page.locator("#failurePatterns").textContent(), /没有非 200/);
      assert.ok(!/NaN|Infinity/.test(await empty.page.locator("main").textContent()));
      assert.equal(await empty.page.locator("#apiKeyRanking button[data-key-index]").count(), 0);
      assert.equal(await empty.page.locator("#apiKeyRoutes .key-route-row").count(), 0);
      if (mode === "success") {
        assert.match(await empty.page.locator("#apiKeyAnalysis").textContent(), /请求均返回 200/);
        assert.match(await empty.page.locator("#apiKeySummary").textContent(), /18/,
          "a successful window still reports the observed API key count");
      }
      if (mode === "empty") assert.match(await empty.page.locator("#reportFindings").textContent(), /没有审计请求/);
    }
    await empty.context.close();
  }
  assert.deepEqual(browserErrors, [], "browser must have no uncaught application errors");
  assert.ok((await stat("/tmp/logark-report-desktop.png")).size > 1000);
  assert.ok((await stat("/tmp/logark-report-mobile.png")).size > 1000);
  assert.ok((await stat("/tmp/logark-api-key-desktop.png")).size > 1000);
  assert.ok((await stat("/tmp/logark-api-key-mobile.png")).size > 1000);
  console.log("report browser checks passed (WASM/fallback, ranking, coverage, detail, complete API key zh/en translations and missing-dictionary HTML fallbacks, statistical figures and tables, API key rate ranking/small samples/routes/plaintext page and copy/masked export/selection persistence, lazy exact-scope route error ranking/representative requests/cache/locale/local retry/key-route-report race guards, chart keyboard control, applied filters, lazy records, pagination, Markdown export, slow initial loading/localized status/retry/aria-busy, delayed refresh and preserved scope, request deduplication/cancellation/late-response guard, nonblocking records, desktop/tablet/mobile overflow, hostile paths/keys/error codes, empty/success/error/missing-field states)");
  console.log("Screenshots: /tmp/logark-report-desktop.png and /tmp/logark-report-mobile.png");
  console.log("API key screenshots: /tmp/logark-api-key-desktop.png and /tmp/logark-api-key-mobile.png");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
