import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("static/index.html", root), "utf8");
const app = readFileSync(new URL("static/app.js", root), "utf8");
const figures = readFileSync(new URL("static/scientific-charts.js", root), "utf8");
const clipboard = readFileSync(new URL("static/clipboard.js", root), "utf8");
const i18nSource = readFileSync(new URL("static/i18n.js", root), "utf8");
const assetSource = readFileSync(new URL("internal/assets/mod.rs", root), "utf8");

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
requireCondition(duplicateIds.length === 0, `duplicate HTML ids: ${duplicateIds.join(", ")}`);

const idSet = new Set(ids);
const referencedIds = [...app.matchAll(/\bel\("([^"]+)"\)/g)].map((match) => match[1]);
const missingIds = [...new Set(referencedIds)].filter((id) => !idSet.has(id));
requireCondition(missingIds.length === 0, `app.js references missing ids: ${missingIds.join(", ")}`);

const sandbox = {
  Intl,
  localStorage: { getItem: () => null, setItem: () => {} },
  navigator: { language: "zh-CN" },
  window: {},
};
vm.runInNewContext(i18nSource, sandbox, { filename: "static/i18n.js" });
const i18n = sandbox.window.LogArkI18n;
requireCondition(i18n, "i18n API was not initialized");

const codeKeys = [...`${app}\n${figures}\n${clipboard}`.matchAll(/\b(?:t|label)\("([^"]+)"/g)].map((match) => match[1]);
const markupKeys = [...html.matchAll(/data-i18n(?:-(?:aria-label|content|placeholder|title))?="([^"]+)"/g)]
  .map((match) => match[1]);
const translationKeys = [...new Set([...codeKeys, ...markupKeys])];
const keyAnalysisKeys = [...new Set([...i18nSource.matchAll(/"(keyAnalysis\.[^"]+)"\s*:/g)]
  .map((match) => match[1]))];
for (const locale of ["zh-CN", "en"]) {
  const missing = [...new Set([...translationKeys, ...keyAnalysisKeys])].filter((key) => !i18n.has(key, locale));
  requireCondition(missing.length === 0, `${locale} is missing translations: ${missing.join(", ")}`);
  i18n.setLocale(locale);
  for (const key of keyAnalysisKeys) {
    const text = i18n.t(key, { shown: 5, total: 20, errors: 12, all: 18, share: "66.7%", rate: "20%", count: 12, seconds: 5, signature: "POST /fixture · HTTP 429 · RATE_LIMIT" });
    requireCondition(text.trim() && text !== key && !/\{[a-zA-Z0-9_]+\}/.test(text), `${locale}: ${key} must resolve all variables`);
    if (locale === "en") requireCondition(!/[\p{Script=Han}]/u.test(text), `${key} is not translated into English`);
  }
}

// A dictionary from an earlier release must never replace readable HTML fallbacks
// with internal translation keys, including metadata and accessibility attributes.
const fallbackNodes = [
  { dataset: { i18n: "fixture.missingTitle" }, textContent: "Readable fallback title" },
  { dataset: { i18n: "keyAnalysis.title" }, textContent: "Existing title" },
];
const attributes = new Map(["aria-label", "content", "placeholder", "title"].map((attribute) =>
  [attribute, new Map([[attribute, `Readable ${attribute}`], [`data-i18n-${attribute}`, `fixture.missing.${attribute}`]])]));
const fakeDocument = {
  documentElement: {}, title: "TraceNote", getElementById: () => null,
  querySelectorAll(selector) {
    if (selector === "[data-i18n]") return fallbackNodes;
    const attribute = selector.match(/^\[data-i18n-(.+)\]$/)?.[1];
    const values = attributes.get(attribute);
    return values ? [{ getAttribute: (name) => values.get(name), setAttribute: (name, value) => values.set(name, value) }] : [];
  },
};
sandbox.document = fakeDocument;
i18n.apply();
requireCondition(fallbackNodes[0].textContent === "Readable fallback title", "missing translation must retain readable HTML text");
requireCondition(fallbackNodes[1].textContent === i18n.t("keyAnalysis.title"), "known translations must still be applied");
for (const [attribute, values] of attributes) {
  requireCondition(values.get(attribute) === `Readable ${attribute}`, `missing translation must retain the existing ${attribute}`);
}

requireCondition(!/[\p{Script=Han}]/u.test(app), "app.js contains untranslated Chinese text");
requireCondition(!/[\p{Script=Han}]/u.test(figures), "scientific-charts.js contains untranslated Chinese text");
requireCondition(html.includes('href="/assets/favicon.svg"'), "favicon link is missing");
requireCondition(html.includes("bootstrap-icons@1.13.1"), "Bootstrap Icons is missing");
const embeddedAssets = new Set([...assetSource.matchAll(/asset!\("([^"]+)"/g)].map((match) => match[1]));
const htmlAssets = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map((match) => match[1]);
requireCondition(
  htmlAssets.every((name) => embeddedAssets.has(name)),
  "HTML references local assets absent from the compiled release",
);
requireCondition(embeddedAssets.has("analytics.wasm"), "compiled release is missing analytics.wasm");
requireCondition(
  html.indexOf('/assets/clipboard.js') < html.indexOf('/assets/app.js'),
  "clipboard.js must load before app.js",
);
requireCondition(
  html.indexOf('/assets/i18n.js') < html.indexOf('/assets/app.js'),
  "i18n.js must load before app.js",
);
requireCondition(
  html.indexOf('/assets/scientific-charts.js') < html.indexOf('/assets/app.js'),
  "scientific-charts.js must load before app.js",
);

console.log(`static checks passed (${ids.length} ids, ${translationKeys.length} translation keys)`);
