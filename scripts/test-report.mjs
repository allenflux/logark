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

const assetNames = new Set(["index.html", "app.js", "i18n.js", "styles.css", "favicon.svg", "analytics.js", "analytics.wasm", "scientific-charts.js"]);
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
  if (url.pathname === "/api/records") {
    return json(url.searchParams.has("cursor_ts")
      ? { items: summaries.slice(2), next_cursor_ts: null, next_cursor_id: null }
      : { items: summaries.slice(0, 2), next_cursor_ts: summaries[1].request_ts, next_cursor_id: summaries[1].id });
  }
  if (/^\/api\/records\/\d+$/.test(url.pathname)) {
    const record = summaries.find((item) => item.id === Number(url.pathname.split("/").at(-1)));
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
async function ready(page) {
  try {
    await page.waitForFunction(() => document.querySelector("#refreshButton")?.getAttribute("aria-busy") === "false");
  } catch (error) {
    error.message += `\nScenario: ${scenario}; browser errors: ${JSON.stringify(browserErrors)}; page: ${await page.locator("#pageAlertMessage").textContent()}`;
    throw error;
  }
  await page.evaluate(() => window.LogArkAnalytics.ready);
}
async function openPage({ mode = "report", mobile = false, blockWasm = false, waitForReport = true } = {}) {
  scenario = mode;
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 },
    locale: "zh-CN", reducedMotion: "reduce", acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (error) => browserErrors.push(error.message));
  if (blockWasm) await page.route("**/assets/analytics.wasm", (route) => route.abort());
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

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE
    || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined) });
  const { page, context } = await openPage();
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
  assert.ok(!(await page.locator("#apiKeyAnalysis").textContent()).includes("apiKeys."), "API key translations should resolve after locale changes");
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
  const delayed = gateResponse("/api/dashboard", (url) => url.searchParams.get("path") === "/api/v1/new-scope");
  await page.fill("#path", "/api/v1/new-scope");
  await page.click("#refreshButton");
  await delayed.received;
  const pendingRequestCount = dashboardRequests().length;
  assert.equal(await page.locator("#reportExportButton").isDisabled(), false, "the last complete report stays exportable while updating");
  assert.equal(await page.locator("#metricCards").textContent(), previousMetrics, "refreshing must retain readable report metrics");
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

  const initialReport = gateResponse("/api/dashboard");
  const firstLoad = await openPage({ waitForReport: false });
  await initialReport.received;
  assert.match(await firstLoad.page.locator("#metricCards").textContent(), /正在读取汇总统计/);
  assert.ok(!(await firstLoad.page.locator("#metricCards").textContent()).includes("计算错误率"));
  assert.equal(await firstLoad.page.locator("#reportExportButton").isDisabled(), true);
  initialReport.release();
  await ready(firstLoad.page);
  await firstLoad.context.close();

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
  console.log("report browser checks passed (WASM/fallback, ranking, coverage, detail, locale, statistical figures and tables, API key rate ranking/small samples/routes/plaintext page and copy/masked export/selection persistence, chart keyboard control, applied filters, lazy records, pagination, Markdown export, delayed refresh and preserved scope, request deduplication/cancellation/late-response guard, nonblocking records, desktop/tablet/mobile overflow, hostile paths and keys, empty/success/error/missing-field states)");
  console.log("Screenshots: /tmp/logark-report-desktop.png and /tmp/logark-report-mobile.png");
  console.log("API key screenshots: /tmp/logark-api-key-desktop.png and /tmp/logark-api-key-mobile.png");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
