import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("static/index.html", root), "utf8");
const app = readFileSync(new URL("static/app.js", root), "utf8");
const figures = readFileSync(new URL("static/scientific-charts.js", root), "utf8");
const i18nSource = readFileSync(new URL("static/i18n.js", root), "utf8");

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

const codeKeys = [...`${app}\n${figures}`.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]);
const markupKeys = [...html.matchAll(/data-i18n(?:-(?:aria-label|content|placeholder|title))?="([^"]+)"/g)]
  .map((match) => match[1]);
const translationKeys = [...new Set([...codeKeys, ...markupKeys])];
for (const locale of ["zh-CN", "en"]) {
  const missing = translationKeys.filter((key) => !i18n.has(key, locale));
  requireCondition(missing.length === 0, `${locale} is missing translations: ${missing.join(", ")}`);
}

requireCondition(!/[\p{Script=Han}]/u.test(app), "app.js contains untranslated Chinese text");
requireCondition(!/[\p{Script=Han}]/u.test(figures), "scientific-charts.js contains untranslated Chinese text");
requireCondition(html.includes('href="/assets/favicon.svg"'), "favicon link is missing");
requireCondition(html.includes("bootstrap-icons@1.13.1"), "Bootstrap Icons is missing");
requireCondition(
  html.indexOf('/assets/i18n.js') < html.indexOf('/assets/app.js'),
  "i18n.js must load before app.js",
);
requireCondition(
  html.indexOf('/assets/scientific-charts.js') < html.indexOf('/assets/app.js'),
  "scientific-charts.js must load before app.js",
);

console.log(`static checks passed (${ids.length} ids, ${translationKeys.length} translation keys)`);
