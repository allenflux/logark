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
function dashboard(url) {
  const payload = structuredClone(fixture);
  payload.window.hours = Number(url.searchParams.get("hours") || 24);
  if (scenario === "hostile") {
    payload.failure_patterns[0].path = injection;
    payload.failure_patterns[0].representative.path = injection;
    payload.top_error_paths[0].label = injection;
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
  await noOverflow(page, "desktop report");
  await page.screenshot({ path: "/tmp/logark-report-desktop.png", fullPage: true });
  await page.screenshot({ path: "/tmp/logark-report-first-screen.png" });
  await page.locator("#statisticalViews").screenshot({ path: "/tmp/logark-report-statistics.png" });
  await page.locator(".report-footer").screenshot({ path: "/tmp/tracenote-footer.png" });

  await page.selectOption("#patternSort", "severity");
  assert.deepEqual(await paths(page), [patterns[1].path, patterns[0].path, patterns[2].path]);
  await page.selectOption("#patternSort", "latency");
  assert.deepEqual(await paths(page), [patterns[2].path, patterns[1].path, patterns[0].path]);
  await page.locator("[data-pattern-detail]").first().click();
  await page.locator("#responseBody").filter({ hasText: "Representative failure response" }).waitFor({ state: "visible" });
  assert.match(await page.locator("#responseBody").textContent(), /TIMEOUT/);
  assert.match(await page.locator("#detailPatternContext").textContent(), /40/);
  assert.ok(!(await page.locator("#detailMeta").textContent()).includes("fixture-api-key-private-12345"), "detail API keys must be masked");
  await page.locator("#detailModal [data-bs-dismiss=modal]").click();
  await page.locator("#detailModal").waitFor({ state: "hidden" });
  assert.equal(recordsRequests().length, 0, "representative detail must not fetch all records");

  await page.selectOption("#localeSelect", "en");
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.equal(await page.locator("#typicalFailuresTitle").textContent(), "Representative failures");
  assert.match(await page.locator("#patternCount").textContent(), /3 \/ 18 patterns/);
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
  assert.ok(!exported.includes("report-filter-secret-12345"), "export masks the applied API key");
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
  assert.ok(!(await page.locator("#reportFreshness").textContent()).includes("report-filter-secret-12345"), "displayed scope masks the API key");
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
  await noOverflow(hostile.page, "long hostile path in mobile report");
  assert.equal(await hostile.page.locator("#failureCoverage [role=meter]").getAttribute("aria-valuenow"), "90");
  await hostile.context.close();

  for (const mode of ["empty", "success", "failure"]) {
    const empty = await openPage({ mode });
    if (mode === "failure") {
      assert.equal(await empty.page.locator("#pageAlert").isVisible(), true);
      assert.match(await empty.page.locator("#pageAlertMessage").textContent(), /Fixture report unavailable/);
      assert.equal(await empty.page.locator("#reportExportButton").isDisabled(), true);
      assert.equal(await empty.page.locator("#metricCards .spinner-border").count(), 0, "an initial failure must not leave a loading spinner running");
      assert.match(await empty.page.locator("#metricCards").textContent(), /读取失败/);
      assert.equal(await empty.page.locator(".report-refresh-status").getAttribute("data-state"), "failed");
    } else {
      assert.equal(await empty.page.locator("#failurePatterns .failure-card").count(), 0);
      assert.match(await empty.page.locator("#failurePatterns").textContent(), /没有非 200/);
      assert.ok(!/NaN|Infinity/.test(await empty.page.locator("main").textContent()));
      if (mode === "empty") assert.match(await empty.page.locator("#reportFindings").textContent(), /没有审计请求/);
    }
    await empty.context.close();
  }
  assert.deepEqual(browserErrors, [], "browser must have no uncaught application errors");
  assert.ok((await stat("/tmp/logark-report-desktop.png")).size > 1000);
  assert.ok((await stat("/tmp/logark-report-mobile.png")).size > 1000);
  console.log("report browser checks passed (WASM/fallback, ranking, coverage, detail, locale, statistical figures and tables, chart keyboard control, applied filters, lazy records, pagination, Markdown export, delayed refresh and preserved scope, request deduplication/cancellation/late-response guard, nonblocking records, desktop/tablet/mobile overflow, hostile paths, empty/success/error states)");
  console.log("Screenshots: /tmp/logark-report-desktop.png and /tmp/logark-report-mobile.png");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
