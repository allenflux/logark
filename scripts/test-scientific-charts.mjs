import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../static/scientific-charts.js", import.meta.url), "utf8");
const hosts = Object.fromEntries(["endpointScatter", "failurePareto", "methodComposition"].map((id) => [id, { innerHTML: "", clientWidth: 576 }]));
const sandbox = { window: {}, Intl, navigator: { language: "en" }, localStorage: { getItem: () => null, setItem: () => {} },
  document: { getElementById: (id) => hosts[id] } };
vm.runInNewContext(readFileSync(new URL("../static/i18n.js", import.meta.url), "utf8"), sandbox);
vm.runInNewContext(source, sandbox);
const api = sandbox.window.LogArkFigures;
const i18n = sandbox.window.LogArkI18n;
const payload = {
  summary: { total_requests: 1000, error_requests: 100 },
  top_error_paths: [
    { label: "/high-volume", total_requests: 800, error_requests: 20, error_rate: 99 },
    { label: "/high-rate", total_requests: 100, error_requests: 60, error_rate: 1 },
    { label: "/small", total_requests: 40, error_requests: 10, error_rate: 25 },
  ],
  error_method_distribution: [
    { label: "POST", total_requests: 200, error_requests: 80 },
    { label: "GET", total_requests: 800, error_requests: 20 },
  ],
};
const render = (data = payload) => api.render(data, { t: (key, values) => i18n.t(key, values), locale: i18n.locale });
function tags(id, name, marker) {
  return [...hosts[id].innerHTML.matchAll(new RegExp("<" + name + "\\b[^>]*>", "g"))]
    .map((match) => Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map((attribute) => [attribute[1], attribute[2]])))
    .filter((attributes) => marker in attributes);
}
function approximately(actual, expected, message) {
  assert.ok(Math.abs(Number(actual) - expected) < 1e-8, message + ": " + actual + " != " + expected);
}
function finiteGeometry() {
  for (const [id, host] of Object.entries(hosts)) {
    assert.ok(!/NaN|Infinity|undefined/.test(host.innerHTML), id + " contains a nonfinite value");
    for (const attribute of [...host.innerHTML.matchAll(/\s(?:cx|cy|x|y|x1|x2|y1|y2|r|width|height)="([^"]+)"/g)]) {
      assert.ok(Number.isFinite(Number(attribute[1])), id + " has invalid geometry: " + attribute[0]);
    }
  }
}
const before = JSON.stringify(payload);
render();
assert.equal(JSON.stringify(payload), before, "figures must not mutate API data");
for (const [id, host] of Object.entries(hosts)) {
  assert.equal((host.innerHTML.match(/<svg\b/g) || []).length, 1, id + " must contain a chart");
  assert.equal((host.innerHTML.match(/<table\b/g) || []).length, 1, id + " must contain a semantic data table");
  assert.match(host.innerHTML, /<title id=/);
  assert.match(host.innerHTML, /<th scope="col">/);
  assert.doesNotMatch(host.innerHTML, /figures\.[a-zA-Z]+/, id + " has untranslated labels");
}
const points = tags("endpointScatter", "circle", "data-point");
assert.deepEqual(points.map((point) => point["data-x"]), ["100", "800", "40"]);
assert.deepEqual(points.map((point) => point["data-y"]), ["60", "2.5", "25"], "endpoint rates derive from their own counts, not stale rate fields");
assert.deepEqual(points.map((point) => point.r), ["4", "4", "4"], "point sizes must not invent a third metric");
for (const point of points) {
  approximately(point.cx, 64 + Number(point["data-x"]) / 800 * 490, "scatter x is linearly scaled");
  approximately(point.cy, 260 - Number(point["data-y"]) / 100 * 234, "scatter y follows the 0-100 rate scale");
}
assert.match(hosts.endpointScatter.innerHTML, /<th scope="row">1<\/th><td>\/high-rate<\/td>/, "point identifiers resolve to exact paths");
const bars = tags("failurePareto", "rect", "data-bar");
const cumulative = tags("failurePareto", "circle", "data-cumulative");
assert.deepEqual(bars.map((bar) => bar["data-count"]), ["60", "20", "10"]);
assert.deepEqual(cumulative.map((point) => point["data-cumulative"]), ["60", "80", "90"], "Pareto denominator is all 100 failures, not the displayed 90");
for (const point of cumulative) approximately(point.cy, 268 - Number(point["data-cumulative"]) / 100 * 238, "cumulative geometry follows its own axis");
for (const bar of bars) approximately(Number(bar.y) + Number(bar.height), 268, "all bars have the same zero baseline");
assert.match(hosts.failurePareto.innerHTML, /90 \/ 100/);
assert.match(hosts.failurePareto.innerHTML, /data-tick="share" data-value="100"/);
const successes = tags("methodComposition", "rect", "data-success");
const failures = tags("methodComposition", "rect", "data-failures");
assert.deepEqual(successes.map((bar) => bar["data-success"]), ["120", "780"]);
assert.deepEqual(failures.map((bar) => bar["data-failures"]), ["80", "20"]);
for (let index = 0; index < successes.length; index += 1) {
  approximately(Number(successes[index].width) + Number(failures[index].width), 469, "method totals normalize to equal widths");
  approximately(failures[index].x, Number(successes[index].x) + Number(successes[index].width), "stack segments are contiguous");
}
assert.match(hosts.methodComposition.innerHTML, /not the full method population/);
finiteGeometry();

render({ ...payload, summary: { total_requests: 1000, error_requests: 50 } });
assert.equal(tags("failurePareto", "circle", "data-cumulative").length, 0, "inconsistent snapshots must not fabricate valid percentages");
assert.match(hosts.failurePareto.innerHTML, /90.*50.*unavailable/);
assert.equal(tags("failurePareto", "rect", "data-bar").length, 3, "known raw counts remain visible");
render({ ...payload, summary: {} });
assert.equal(tags("failurePareto", "circle", "data-cumulative").length, 0);
assert.match(hosts.failurePareto.innerHTML, /full-window failure total is unavailable/i);
const invalidRows = [
  { label: "/zero-denominator", total_requests: 0, error_requests: 4 },
  { label: "/impossible-count", total_requests: 2, error_requests: 8 },
  { label: "/not-a-number", total_requests: Infinity, error_requests: NaN },
  { label: "/missing", total_requests: null, error_requests: null },
  { label: "/blank", total_requests: "   ", error_requests: "   " },
  { label: "/array", total_requests: [], error_requests: [] },
];
render({ ...payload, top_error_paths: invalidRows, error_method_distribution: invalidRows });
assert.equal(tags("endpointScatter", "circle", "data-point").length, 0);
assert.equal(tags("methodComposition", "rect", "data-success").length, 0);
assert.match(hosts.endpointScatter.innerHTML, /excluded from percentage plots/);
assert.match(hosts.endpointScatter.innerHTML, /\/zero-denominator/);
assert.doesNotMatch(hosts.failurePareto.innerHTML, /full-window failure total is unavailable/i, "missing row counts must not be confused with a missing report total");
assert.match(hosts.failurePareto.innerHTML, /endpoint failure counts are unavailable/);
finiteGeometry();

const hostile = '<img src=x onerror="window.pwned=true">&\'"';
render({ ...payload, top_error_paths: [{ label: hostile, total_requests: 100, error_requests: 20 }],
  error_method_distribution: [{ label: hostile, total_requests: 100, error_requests: 20 }] });
for (const host of Object.values(hosts)) {
  assert.doesNotMatch(host.innerHTML, /<img\b/);
  assert.match(host.innerHTML, /&lt;img/);
}
assert.equal(sandbox.window.pwned, undefined);
finiteGeometry();

const coincident = Array.from({ length: 10 }, (_, index) => ({ label: "/same-" + index, total_requests: 100, error_requests: 10 }));
render({ ...payload, top_error_paths: coincident });
const samePoints = tags("endpointScatter", "circle", "data-point");
assert.equal(samePoints.length, 1, "coincident points share one marker rather than obscuring ten labels");
assert.equal(samePoints[0]["data-point"], "1,2,3,4,5,6,7,8,9,10");
assert.equal(samePoints[0]["data-x"], "100");
assert.equal(samePoints[0]["data-y"], "10");
for (let index = 0; index < 10; index += 1) assert.ok(hosts.endpointScatter.innerHTML.includes("/same-" + index));
assert.equal((hosts.endpointScatter.innerHTML.match(/<th scope="row">/g) || []).length, 10, "every coincident observation stays in the lookup table");

for (const host of Object.values(hosts)) host.clientWidth = 318;
render({ ...payload, top_error_paths: [{ label: "/large", total_requests: 10_000_000, error_requests: 1_000_000 }],
  summary: { total_requests: 10_000_000, error_requests: 1_000_000 } });
for (const host of Object.values(hosts)) assert.match(host.innerHTML, /viewBox="0 0 318 /, "mobile viewBox follows its host");
assert.match(hosts.failurePareto.innerHTML, />1e\+6<\/text>/, "large axis counts use readable scientific notation");
assert.match(hosts.failurePareto.innerHTML, />1,000,000<\/td>/, "tables retain exact full counts");
finiteGeometry();
for (const host of Object.values(hosts)) host.clientWidth = 1200;
render();
for (const host of Object.values(hosts)) assert.match(host.innerHTML, /style="width:600px;max-width:100%;height:auto"/, "wide panels do not stretch typography");

for (const locale of ["en", "zh-CN"]) {
  i18n.setLocale(locale);
  render();
  for (const host of Object.values(hosts)) assert.doesNotMatch(host.innerHTML, /figures\.[a-zA-Z]+/);
  render({ summary: { total_requests: 200, error_requests: 0 } });
  for (const host of Object.values(hosts)) {
    assert.doesNotMatch(host.innerHTML, /<svg\b/);
    assert.ok(host.innerHTML.includes(i18n.t("figures.noFailures")));
  }
  render({});
  for (const host of Object.values(hosts)) assert.ok(host.innerHTML.includes(i18n.t("figures.empty")));
}
api.render(null);
finiteGeometry();
console.log("scientific chart checks passed (coordinate scales, zero baselines, fixed markers, coincident data, denominator consistency, normalized composition, tables, escaping, invalid/empty data, responsive widths, large counts, and both locales)");
