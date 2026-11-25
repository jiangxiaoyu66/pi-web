// Reuses the already-running dev server. No model calls or user-data writes.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { createJiti } from "jiti";
import { authenticateLocalContext, localBrowserAuth } from "./local-server-auth.mjs";

const jiti = createJiti(import.meta.url);
const { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH } = await jiti.import("../lib/panel-layout.ts");
const { emptySessionUiState, applySessionUiStateRequest } = await jiti.import("../lib/session-ui-state-shared.ts");

const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30141";
const cwd = process.cwd();
const artifacts = process.env.E2E_ARTIFACTS || "/tmp/pi-web-editor-e2e";
mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.E2E_BROWSER_CHANNEL || "chrome" });
const measurements = [];
async function checkLayout(placement) {
  // No tracing: auth-bearing requests must never be saved in a trace.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...localBrowserAuth(base) });
  await authenticateLocalContext(context, base);
  await context.addInitScript(({ cwd, placement, width }) => {
    localStorage.setItem("pi-locale", "zh-CN");
    localStorage.setItem("pi-web:last-custom-cwd", cwd);
    localStorage.setItem("pi-web:sidebar-tab", "files");
    localStorage.setItem("pi-web:sidebar-files-placement", placement);
    localStorage.setItem("pi-sidebar-width", String(width));
  }, { cwd, placement, width: SIDEBAR_DEFAULT_WIDTH });
  const page = await context.newPage();
  const errors = [];
  const consoleErrors = [];
  const failedResponses = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push({ method: response.request().method(), url: response.url(), status: response.status() });
  });
  // Block every non-fixture write, including implicit sidebar state saves.
  const unexpectedWrites = [];
  let uiState = emptySessionUiState();
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/sessions/ui-state") {
      if (method === "POST") uiState = applySessionUiStateRequest(uiState, route.request().postDataJSON(), Date.now()).state;
      return route.fulfill({ json: { state: uiState } });
    }
    if (path === "/api/cwd/validate") return route.fulfill({ json: { valid: true, path: cwd, projectRoot: cwd, projectKey: cwd } });
    if (path === "/api/agent/running") return route.fulfill({ json: { runningSessionIds: [], awaitingInputSessionIds: [], sessionListVersion: 0, sessionUiStateRevision: uiState.revision, serverNow: Date.now() } });
    if (!["GET", "HEAD"].includes(method)) {
      unexpectedWrites.push(`${method} ${path}`);
      return route.fulfill({ status: 403, json: { error: "Unexpected fixture write" } });
    }
    // Match the other isolated settings suites: the browser's fixture cwd
    // is not a server-authorized file root. Never query its real repository,
    // model settings or trust state (and never grant it access for a test).
    if (path === "/api/git/status") return route.fulfill({ json: { files: [], isGit: false } });
    if (path === "/api/git/diff") return route.fulfill({ json: { supported: false } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], modelList: [], defaultModel: null } });
    if (path === "/api/worktrees") return route.fulfill({ json: { projectRoot: cwd, projectKey: cwd, isGit: false, isTopLevel: true, currentWorktreePath: cwd, worktrees: [] } });
    if (path === "/api/project-trust") return route.fulfill({ json: { requiresTrust: false, trusted: true, decision: true, inherited: false, servers: [] } });
    return route.continue();
  });
  // Keep the UI real but isolate it from the user's catalogue and files.
  await page.route(/\/api\/sessions(?:\?.*)?$/,  (route) => route.fulfill({ json: { sessions: [{ id: "editor-ui-fixture", cwd, projectRoot: cwd, name: "Editor UI fixture", firstMessage: "Editor UI fixture", messageCount: 0, created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z" }], sessionListVersion: 0, runningSessionIds: [], awaitingInputSessionIds: [] } }));
  await page.route("**/api/files/**", async (route) => {
    const url = new URL(route.request().url());
    const type = url.searchParams.get("type");
    if (type === "list") return route.fulfill({ json: { entries: [
      { name: "文 档#?%.txt", isDir: false }, { name: "folder.with.dot", isDir: true },
      ...["png", "wav", "mp4", "pdf", "docx"].map((ext) => ({ name: `preview.${ext}`, isDir: false })),
    ] } });
    if (type === "read") return route.fulfill({ json: { content: "Editor regression fixture\n", language: "text", size: 26, truncated: false, nextOffset: 26 } });
    if (type === "meta") return route.fulfill({ json: { size: 26, mtimeMs: 1 } });
    if (type === "watch") return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
    return route.fulfill({ body: "fixture" });
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const row = page.locator(".editor-file-row").filter({ hasText: "文 档#?%.txt" });
  await row.waitFor({ timeout: 60000 });
  await page.waitForFunction((cwd) => [...document.querySelectorAll(".editor-file-row span[title]")].some((el) => el.title === `${cwd}/文 档#?%.txt`), cwd);
  // Keyboard-focus reveals the otherwise hover-only action.
  const button = row.locator(".editor-open-button");
  await button.focus();
  assert.equal(await button.evaluate((el) => getComputedStyle(el.parentElement).opacity), "1");
  await button.press("Enter");
  const menu = page.getByRole("menu", { name: "在编辑器中打开…" });
  await menu.waitFor();
  await page.getByRole("menuitemradio", { name: "在 Cursor 中打开" }).waitFor();
  assert.match(await menu.innerText(), /同一台电脑/);
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitemradio");
  assert.equal(await page.locator(".file-viewer-actions").count(), 0, "inline activation must not open a preview");
  await page.keyboard.press("Escape");
  await page.waitForFunction((el) => document.activeElement === el, await button.elementHandle());
  await row.focus();
  await row.press("Shift+F10");
  await menu.waitFor();
  await page.keyboard.press("Escape");
  await row.click({ button: "right" });
  await menu.waitFor();
  await page.keyboard.press("Escape");
  await row.hover();
  assert.equal(await row.locator("a[download]").count(), 1, "original download retained");
  await row.click();
  const viewerButton = page.locator(".file-viewer-actions .editor-open-button");
  await viewerButton.waitFor();
  await viewerButton.click();
  await menu.waitFor();
  await page.screenshot({ path: `${artifacts}/${placement}-desktop-menu.png`, animations: "disabled" });
  await page.keyboard.press("Escape");
  // The target is a real absolute cwd, not a display label or the browser host.
  const root = page.locator(".sidebar-files-actions > .editor-open-button, .sidebar-files-keys > .editor-open-button").filter({ visible: true });
  const actions = page.locator(placement === "below" ? ".sidebar-files-keys" : ".sidebar-files-actions");
  const resizer = page.locator('[data-resize-handle="sidebar"]');
  for (const width of [SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH]) {
    if (width === SIDEBAR_MIN_WIDTH) await resizer.press("Home");
    await page.waitForFunction((width) => Number(document.querySelector('[data-resize-handle="sidebar"]')?.getAttribute("aria-valuenow")) === width, width);
    const geometry = await actions.evaluate((el) => {
      const box = (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const sidebar = el.closest(".session-sidebar");
      return {
        sidebar: box(sidebar), group: box(el),
        toggle: sidebar.querySelector(".sidebar-files-section-toggle") ? box(sidebar.querySelector(".sidebar-files-section-toggle")) : null,
        buttons: [...el.querySelectorAll(":scope > button")].map((button) => ({
          ...box(button), name: button.getAttribute("aria-label"),
          sidebarStyle: button.classList.contains("sidebar-tool-button"),
          icon: box(button.querySelector("svg")),
        })),
      };
    });
    measurements.push({ placement, width, ...geometry });
    assert.ok(Math.abs(geometry.sidebar.width - width) <= 1, "actual sidebar width");
    assert.equal(geometry.buttons.length, placement === "below" ? 8 : 7);
    assert.equal(geometry.buttons[2].name, "在编辑器中打开…", "editor follows the file manager");
    const first = geometry.buttons[0];
    for (const [index, button] of geometry.buttons.entries()) {
      assert.equal(button.sidebarStyle, true);
      assert.ok(Math.abs(button.width - first.width) < 1, "equal button widths");
      assert.equal(button.height, first.height);
      assert.equal(button.y, first.y, "no wrapped buttons");
      assert.equal(button.icon.width, placement === "below" ? 13 : 14);
      assert.ok(button.x >= geometry.sidebar.x && button.right <= geometry.sidebar.right, "no clipped button");
      assert.ok(button.icon.x >= button.x && button.icon.right <= button.right, "no clipped icon");
      if (index) assert.ok(button.x >= geometry.buttons[index - 1].right - 0.1, "no overlapping buttons");
    }
    if (geometry.toggle) {
      assert.ok(geometry.toggle.width >= 17, "the fold chevron keeps its minimum");
      assert.ok(geometry.toggle.right <= first.x, "toggle does not overlap keys");
    }
    await root.click();
    await menu.waitFor();
    await page.screenshot({ path: `${artifacts}/${placement}-${width}px-menu.png`, animations: "disabled" });
    await page.keyboard.press("Escape");
    await page.waitForFunction((el) => document.activeElement === el, await root.elementHandle());
  }
  await resizer.press("Enter");
  // Preview payloads are fixtures: this asserts toolbar wiring, not media decoding.
  for (const ext of ["png", "wav", "mp4", "pdf", "docx"]) {
    await page.locator(".editor-file-row").filter({ hasText: `preview.${ext}` }).click();
    const previewButton = page.locator(".editor-open-button:visible").last();
    await previewButton.click();
    await menu.waitFor();
    await page.keyboard.press("Escape");
  }
  await row.click();
  await page.setViewportSize({ width: 375, height: 812 });
  await viewerButton.click();
  await page.getByText("仅适用于浏览器和编辑器位于同一台电脑。", { exact: false }).waitFor();
  await page.screenshot({ path: `${artifacts}/${placement}-mobile-menu.png`, animations: "disabled" });
  writeFileSync(`${artifacts}/${placement}-diagnostics.json`, JSON.stringify({ errors, consoleErrors, failedResponses, unexpectedWrites }, null, 2));
  assert.deepEqual(errors, [], "Unexpected browser pageerror");
  assert.deepEqual(consoleErrors, [], "Unexpected browser console errors");
  assert.deepEqual(failedResponses, [], "Unexpected failed HTTP responses");
  assert.deepEqual(unexpectedWrites, []);
  console.log(`PASS: ${placement}, default/minimum sidebar width, desktop/mobile menus, inline isolation, keyboard/context menus, focus restore, all preview/root entries, preserved download; pageerror, console errors and failed HTTP responses are empty`);
  await context.close();
}
try {
  for (const placement of ["below", "tab"]) await checkLayout(placement);
  writeFileSync(`${artifacts}/measurements.json`, JSON.stringify(measurements, null, 2));
  console.log(`Artifacts: ${artifacts}`);
} finally {
  await browser.close();
}
