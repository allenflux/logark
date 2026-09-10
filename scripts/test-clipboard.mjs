// Uses an intercepted HTTP page and synthetic text, without API or database access.
// PLAYWRIGHT_MODULE and CHROME_EXECUTABLE work as in test-report.mjs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = modulePath
  ? require(modulePath.endsWith("package.json") ? dirname(modulePath) : modulePath)
  : await import("playwright");
const source = await readFile(new URL("../static/clipboard.js", import.meta.url), "utf8");
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE
  || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined) });
const signature = 'POST /api/test?x=<img src=x onerror="window.injected=true">\nHTTP 429 / RATE_LIMIT\nrequest_id: fixture-123\nAPI Key: fixture-plain-key';
const translations = { "clipboard.title": "Copy manually", "clipboard.help": "Select and copy this text.",
  "clipboard.close": "Close", "clipboard.label": "Text to copy" };

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://clipboard-fixture.test/", (route) => route.fulfill({ contentType: "text/html", body:
    '<!doctype html><html lang="en"><body><button id="copy">Copy</button><input id="other" value="abcdef"></body></html>' }));
  await page.goto("http://clipboard-fixture.test/");
  await page.addScriptTag({ content: source });
  assert.equal(await page.evaluate(() => window.isSecureContext), false, "fixture must exercise HTTP");
  await page.evaluate(({ signature, translations }) => {
    window.copyText = signature;
    window.translations = translations;
    window.originalExecCommand = document.execCommand.bind(document);
    window.calls = [];
    document.querySelector("#copy").onclick = async () => {
      window.copyResult = null;
      window.copyResult = await window.LogArkClipboard.copy(window.copyText, { t: (key) => window.translations[key] || key });
    };
  }, { signature, translations });

  // Real browser fallback on HTTP: modern clipboard is unavailable, but the user
  // click still permits execCommand. Capture what the selected field contained.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    document.execCommand = (command) => {
      const field = document.activeElement;
      window.calls.push({ command, text: field.value.slice(field.selectionStart, field.selectionEnd) });
      return window.originalExecCommand(command);
    };
  });
  await page.click("#copy");
  await page.waitForFunction(() => window.copyResult !== null);
  assert.equal(await page.evaluate(() => window.copyResult), true, "HTTP user click must use real legacy copy");
  assert.deepEqual(await page.evaluate(() => window.calls), [{ command: "copy", text: signature }]);
  assert.equal(await page.locator("dialog").count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.id), "copy");
  assert.equal(await page.locator("textarea").count(), 0, "temporary copy field must be removed");

  // Modern success avoids the fallback and preserves the exact payload.
  await page.evaluate(() => {
    window.calls = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true,
      value: { writeText: async (text) => window.calls.push({ modern: text }) } });
    document.execCommand = () => { throw new Error("legacy must not run after modern success"); };
  });
  await page.click("#copy");
  await page.waitForFunction(() => window.copyResult !== null);
  assert.equal(await page.evaluate(() => window.copyResult), true);
  assert.deepEqual(await page.evaluate(() => window.calls), [{ modern: signature }]);

  // Clipboard permission rejection falls back successfully without a page error.
  await page.evaluate(() => {
    window.calls = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true,
      value: { writeText: async () => { throw new DOMException("Denied", "NotAllowedError"); } } });
    document.execCommand = (command) => { window.calls.push(command); return true; };
  });
  await page.click("#copy");
  await page.waitForFunction(() => window.copyResult !== null);
  assert.equal(await page.evaluate(() => window.copyResult), true);
  assert.deepEqual(await page.evaluate(() => window.calls), ["copy"]);
  assert.equal(await page.locator("dialog").count(), 0);

  // Preserve an existing text input selection when using the temporary field.
  assert.deepEqual(await page.evaluate(async () => {
    const input = document.querySelector("#other");
    input.focus();
    input.setSelectionRange(1, 4, "backward");
    const result = await window.LogArkClipboard.copy("selection fixture");
    return { result, id: document.activeElement.id, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
  }), { result: true, id: "other", start: 1, end: 4, direction: "backward" });

  // If both automatic APIs refuse, show a selected, read-only manual copy field.
  await page.evaluate(() => { document.execCommand = () => false; });
  await page.click("#copy");
  await page.waitForFunction(() => window.copyResult !== null);
  assert.equal(await page.evaluate(() => window.copyResult), false, "manual display must not claim copy success");
  const dialog = page.getByRole("dialog", { name: "Copy manually" });
  await dialog.waitFor({ state: "visible" });
  assert.equal(await dialog.getByRole("textbox", { name: "Text to copy" }).inputValue(), signature);
  assert.equal(await dialog.locator("textarea").getAttribute("readonly"), "");
  assert.equal(await page.evaluate(() => window.injected), undefined, "copy payload must be text, never HTML");
  assert.deepEqual(await dialog.locator("textarea").evaluate((field) =>
    ({ focused: document.activeElement === field, start: field.selectionStart, end: field.selectionEnd })),
  { focused: true, start: 0, end: signature.length });
  await page.keyboard.press("Tab");
  assert.equal(await dialog.getByRole("button", { name: "Close" }).evaluate((button) => document.activeElement === button), true);
  await page.keyboard.press("Shift+Tab");
  assert.equal(await dialog.locator("textarea").evaluate((field) => document.activeElement === field), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("dialog").count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.id), "copy", "Escape restores trigger focus");

  // Synchronous execCommand exceptions also lead to a manual dialog, and closing
  // via a button has the same focus behavior as Escape.
  await page.evaluate(() => { document.execCommand = () => { throw new Error("copy disabled"); }; });
  await page.click("#copy");
  await page.waitForFunction(() => window.copyResult !== null);
  assert.equal(await page.evaluate(() => window.copyResult), false);
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), "copy");

  // Mount inside an existing Bootstrap modal so its focus trap accepts both the
  // temporary legacy field and the manual dialog.
  await page.evaluate(() => {
    const modal = document.createElement("div");
    modal.className = "modal show";
    document.body.append(modal);
    modal.append(document.querySelector("#copy"));
    document.addEventListener("focusin", (event) => {
      if (!modal.contains(event.target)) document.querySelector("#copy").focus();
    });
  });
  await page.click("#copy");
  await page.waitForFunction(() => window.copyResult !== null);
  assert.equal(await page.locator(".modal.show dialog").count(), 1);
  assert.equal(await page.getByRole("dialog").locator("textarea").evaluate((field) => document.activeElement === field), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement.id), "copy");
  assert.deepEqual(errors, [], "clipboard fallback must not raise unhandled page errors");
  console.log("clipboard browser checks passed (HTTP copy, modern success/denial, manual copy, selection, focus, modal)");
} finally {
  await browser.close();
}
