// Standalone, test-only route fixtures. Never installs or edits real skills.
// Run: node e2e/skills-grouping.mjs (requires the repo's Playwright + Chromium).
import assert from "node:assert/strict";
import { authenticateLocalContext, localBrowserAuth, localServerFetch } from "./local-server-auth.mjs";
import { createJiti } from "jiti";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(root, "test-results/skills-grouping");
mkdirSync(artifacts, { recursive: true });
const agentDir = mkdtempSync(join(tmpdir(), "pi-skills-grouping-"));
const project = join(agentDir, "project");
const localRoot = join(project, ".pi/skills");
const port = Number(process.env.PI_WEB_E2E_PORT || 30141);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "Invalid PI_WEB_E2E_PORT");
const base = `http://127.0.0.1:${port}`;
const sessionId = "e2e-skills-grouping";
const timestamp = "2026-08-23T00:00:00.000Z";
const checks = [], consoleMessages = [], pageErrors = [], requests = [], blockedWrites = [], failedResponses = [];
let server, serverExit, serverLog, browser, context, page, releasePatch;
let reused = false, gets = 0, patchGate = null, failPath = null;
const summary = { status: "running", checks, artifacts, server: null };
const save = (name, data) => writeFileSync(join(artifacts, name), JSON.stringify(data, null, 2) + "\n");
const pass = (name) => { checks.push(name); console.log(`PASS: ${name}`); };
const stop = () => { releasePatch?.(); void browser?.close().catch(() => {}); server?.kill("SIGTERM"); process.exitCode = 1; };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

function skill(name, scope, sourceKey, kind, segments, dormant, sourceLabel = sourceKey) {
  const rootKey = kind === "local" ? localRoot : join(agentDir, "packages", scope, sourceKey.replace(/[^a-z0-9]/gi, "_"));
  const filePath = join(rootKey, ...segments, name, "SKILL.md");
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `---\nname: ${name}\ndescription: Browser fixture ${name}\ndisable-model-invocation: ${dormant}\n---\n\nFixture instructions for ${name}.\n`);
  return { name, description: `Browser fixture ${name}`, filePath, baseDir: dirname(filePath), disableModelInvocation: dormant,
    sourceInfo: { scope: scope === "global" ? "user" : scope, source: sourceKey, origin: kind === "plugin" ? "package" : "top-level", baseDir: rootKey },
    grouping: { scope, kind, sourceKey, sourceLabel, rootKey, directorySegments: segments } };
}
mkdirSync(project, { recursive: true });
const one = "npm:@fixture/shared", two = "git:https://example.invalid/other/shared";
const alpha = skill("plugin-alpha", "project", one, "plugin", [], false, "Shared plugin");
const beta = skill("plugin-beta", "project", one, "plugin", [], true, "Shared plugin");
const twin = skill("plugin-other-source", "project", two, "plugin", [], true, "Shared plugin");
const globalSkill = skill("global-plugin-with-a-very-long-unbroken-skill-name-for-responsive-layout-checks", "global", one, "plugin", [], true, "Shared plugin");
const cut = skill("cut", "project", "local", "local", ["video", "edit"], false);
const sound = skill("sound", "project", "local", "local", ["video", "edit"], true);
const test = skill("test", "project", "local", "local", ["code"], true);
alpha.install = { package: "fixture/repository@plugin-alpha", scope: "project", source: "fixture/repository", sourceType: "github", versionHash: "aaaaaaaa", canCheckForUpdates: true };
let skills = [alpha, beta, twin, globalSkill, cut, sound, test];
const sessionDir = join(agentDir, "sessions", "e2e");
mkdirSync(sessionDir, { recursive: true });
const sessionPath = join(sessionDir, `2026-08-23T00-00-00-000Z_${sessionId}.jsonl`);
const entry = { type: "message", id: "abc12345", parentId: null, timestamp, message: { role: "user", content: "Skills grouping browser fixture" } };
writeFileSync(sessionPath, [{ type: "session", version: 3, id: sessionId, timestamp, cwd: project }, entry].map(JSON.stringify).join("\n") + "\n");
const info = { id: sessionId, path: sessionPath, cwd: project, name: "Skills grouping fixture", created: timestamp, modified: timestamp, messageCount: 1, firstMessage: entry.message.content };
// Only needed when reusing a server whose PI_CODING_AGENT_DIR cannot be changed.
const fixtureDetail = { sessionId, filePath: sessionPath, info, leafId: entry.id, tree: [{ entry, children: [] }], context: { messages: [entry.message], entryIds: [entry.id], hasMore: false, leafId: entry.id }, totalActiveMs: 0 };
const uiState = { version: 1, revision: 0, pinned: [], archived: [], projectOrder: [], projectNames: {}, readTimes: {} };
function holdNextPatch() {
  assert.equal(patchGate, null);
  patchGate = new Promise((resolve) => { releasePatch = resolve; });
}
async function ready() {
  const response = await localServerFetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!response?.ok) return false;
  const data = await response.json().catch(() => null);
  return Array.isArray(data?.sessions);
}
async function startServer() {
  const probe = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (probe.error || (probe.status !== 0 && probe.status !== 1)) throw new Error(`Cannot inspect port ${port} with lsof; refusing to start another dev process`);
  const pids = [...new Set(probe.stdout.trim().split(/\s+/).filter(Boolean))];
  const locked = existsSync(join(root, ".next/dev/lock"));
  summary.preflight = { listenerPids: pids, devLock: locked };
  if (pids.length) {
    for (const pid of pids) {
      const cwd = spawnSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf8" });
      const path = cwd.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
      assert.ok(path && realpathSync(path) === realpathSync(root), `Port ${port} belongs to another checkout/process; not touching it`);
    }
    assert.ok(await ready(), "Existing repo server is unhealthy; not restarting it");
    reused = true;
    summary.server = "reused repo server (all browser writes mocked; synthetic session bootstrap)";
    return;
  }
  assert.ok(!locked, `A dev lock exists without a ${port} listener; not starting or removing another process's lock`);
  assert.ok(existsSync(join(root, "node_modules/next/dist/bin/next")), "Next dependencies are not ready; no installation attempted");
  serverLog = createWriteStream(join(artifacts, "server.log"));
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root, detached: true,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverExit = once(server, "exit");
  server.stdout.pipe(serverLog, { end: false }); server.stderr.pipe(serverLog, { end: false });
  summary.server = `owned dev process ${server.pid}`;
  const deadline = Date.now() + 120_000;
  while (!(await ready())) {
    assert.equal(server.exitCode, null, "Dev server exited; see server.log");
    assert.ok(Date.now() < deadline, "Dev readiness timed out; see server.log");
    await delay(300);
  }
  const response = await localServerFetch(`${base}/api/sessions/${sessionId}`);
  assert.equal(response.status, 200, "Real SDK session fixture must load on owned server");
  const detail = await response.json();
  assert.deepEqual(detail.context.entryIds, [entry.id]);
  pass("owned server reads the temporary SDK-format session");
}
async function mockApi(route) {
  const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
  const body = request.postData() ? JSON.parse(request.postData()) : null;
  const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
  if (path === "/api/skills" || path.startsWith("/api/skills/")) {
    requests.push({ path, method, body });
    if (path === "/api/skills" && method === "GET") { gets++; return json({ skills, diagnostics: [], projectResourcesLoaded: true }); }
    if (path === "/api/skills/content" && method === "GET") {
      const found = skills.find((s) => s.filePath === url.searchParams.get("filePath"));
      return json({ content: `# ${found?.name}\n\nFixture instructions for ${found?.name}.` });
    }
    if (path === "/api/skills" && method === "PATCH") {
      const gate = patchGate; patchGate = null;
      if (gate) await gate;
      const paths = body.filePaths ?? [body.filePath];
      const results = paths.map((filePath) => ({ filePath, ...(filePath === failPath ? { error: "fixture write refused" } : {}) }));
      const changed = new Set(results.filter((r) => !r.error).map((r) => r.filePath));
      skills = skills.map((s) => changed.has(s.filePath) ? { ...s, disableModelInvocation: body.disableModelInvocation } : s);
      return json(body.filePaths ? { results } : { success: true });
    }
    if (path === "/api/skills/check" && method === "POST") return json({ updates: [{ package: alpha.install.package, scope: "project", state: "update-available", currentVersion: "aaaaaaaa", latestVersion: "bbbbbbbb" }] });
    if (path === "/api/skills/update" && method === "POST") return json({ success: true, skill: { ...alpha, install: { ...alpha.install, versionHash: "bbbbbbbb" } } });
    if (path === "/api/skills/search" && method === "POST") return json({ results: [{ package: "fixture/new@install-fixture", installs: "42", url: "https://example.invalid/fixture" }] });
    if (path === "/api/skills/install" && method === "POST") return json({ success: true });
    throw new Error(`Unhandled skills fixture: ${method} ${path}`);
  }
  // A reused server does not authorize the isolated fixture cwd. Keep the
  // surrounding shell read-only and deterministic rather than issuing real
  // project requests outside the skills panel under test.
  if (path === "/api/worktrees") return json({ projectRoot: project, projectKey: project, isGit: false, isTopLevel: true, currentWorktreePath: project, worktrees: [] });
  if (path.startsWith("/api/files/")) return json({ entries: [], path: project });
  if (path === "/api/git/status") return json({ files: [], isGit: false });
  if (path === "/api/models") return json({ models: [], modelList: [], defaultModel: null });
  if (path === `/api/agent/${sessionId}/events`) return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": fixture idle\n\n" });
  if (path === "/api/sessions/ui-state") return json({ state: uiState });
  if (path === "/api/project-trust") return json({ requiresTrust: false, trusted: true, decision: true, inherited: false, servers: [] });
  if (path === "/api/agent/running") return json({ runningSessionIds: [], awaitingInputSessionIds: [], completionNotificationSuppressedSessionIds: [], serverTime: Date.now() });
  if (reused && path === "/api/sessions") return json({ sessions: [info], runningSessionIds: [], awaitingInputSessionIds: [] });
  if (reused && path === `/api/sessions/${sessionId}`) return json(fixtureDetail);
  if (reused && path === `/api/sessions/${sessionId}/state`) return json({ running: false });
  // A hard safety boundary, including automatic read markers and agent leases.
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    blockedWrites.push({ path, method, body });
    return json({ success: true, running: false, awaitingInput: false, subagentsActive: false });
  }
  return route.continue();
}

try {
  // Dynamic import keeps a useful summary even while another agent restores dependencies.
  const { chromium } = await import("playwright");
  await startServer();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  context = await browser.newContext({ ...localBrowserAuth(base), viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce", serviceWorkers: "block" });
  await authenticateLocalContext(context, base);
  await context.addInitScript(() => localStorage.setItem("pi-locale", "en"));
  await context.route("**/api/**", mockApi);
  if (!process.env.PI_WEB_PASSWORD) await context.tracing.start({ screenshots: true, snapshots: true });
  page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("response", (response) => { if (response.status() >= 400) failedResponses.push({ url: response.url(), status: response.status() }); });
  await page.goto(`${base}/?session=${sessionId}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByRole("button", { name: "Skills", exact: true }).first().click({ timeout: 60_000 });
  const dialog = page.getByRole("dialog");
  const tree = dialog.locator(".skill-group-tree");
  await tree.waitFor({ timeout: 60_000 });
  // Stable node IDs encode the full source identity, not the ambiguous display name.
  const { buildSkillTree } = await createJiti(import.meta.url).import("../lib/skill-tree.ts");
  const flatten = (nodes) => nodes.flatMap((item) => [item, ...flatten(item.children)]);
  const fixtureNodes = flatten(buildSkillTree(skills));
  const title = (scope, type = "scope", record = null, segments = []) => {
    const matches = fixtureNodes.filter((item) => item.scope === scope && item.type === type && (!record || item.skills.some((s) => s.filePath === record.filePath)));
    const found = type === "directory" ? matches.find((item) => item.label === segments.at(-1)) : matches[0];
    assert.ok(found, `Missing fixture group ${scope}/${type}/${segments.join("/")}`);
    return tree.locator(`button.skill-group-tree-title[aria-controls$='${encodeURIComponent(found.id)}-children']`);
  };
  const node = (button) => button.locator("..").locator("..");
  const groupSwitch = (button) => button.locator("..").getByRole("switch");
  const opened = async (button, value) => { if ((await button.getAttribute("aria-expanded")) !== String(value)) await button.click(); };
  const row = (name) => tree.locator(".config-sidebar-item").filter({ hasText: name });
  const detail = dialog.locator(".config-detail");
  const patches = () => requests.filter((r) => r.method === "PATCH");
  const waitFor = async (fn, message) => { const end = Date.now() + 12_000; while (!(await fn())) { assert.ok(Date.now() < end, message); await delay(40); } };
  const pScope = title("project"), gScope = title("global");
  const plugin = title("project", "source", alpha), other = title("project", "source", twin);
  const local = title("project", "source", cut), video = title("project", "directory", cut, ["video"]), edit = title("project", "directory", cut, ["video", "edit"]);
  assert.equal(await tree.locator(":scope > .skill-group-tree-node").count(), 2);
  assert.equal(await pScope.getAttribute("aria-expanded"), "true");
  assert.equal(await gScope.getAttribute("aria-expanded"), "true");
  assert.equal(await plugin.count(), 1); assert.equal(await other.count(), 1);
  assert.equal(await node(plugin).locator(".config-sidebar-item").count(), 2);
  assert.equal(await other.getAttribute("aria-expanded"), "false");
  await opened(other, true);
  assert.equal(await node(other).locator(".config-sidebar-item").count(), 1);
  await opened(other, false);
  pass("scope layers and same-label plugins keep distinct full-source groups");

  await opened(local, true); await opened(video, true); await opened(edit, true);
  await row("cut").click();
  await detail.getByText("Fixture instructions for cut.", { exact: true }).waitFor();
  await opened(video, false);
  assert.equal(await row("cut").count(), 0);
  assert.ok(await detail.getByText("Fixture instructions for cut.", { exact: true }).isVisible());
  // Native buttons must toggle by both keyboard activation keys.
  await video.focus(); await page.keyboard.press("Enter");
  assert.equal(await video.getAttribute("aria-expanded"), "true");
  await page.keyboard.press("Space");
  assert.equal(await video.getAttribute("aria-expanded"), "false");
  assert.equal(await node(video).locator("[hidden] button, [hidden] a, [hidden] input").count(), 0);
  pass("nested folders collapse without losing selected detail; Enter/Space and hidden descendants");

  await row("plugin-alpha").click();
  await detail.getByText("Fixture instructions for plugin-alpha.", { exact: true }).waitFor();
  await detail.getByRole("button", { name: "Check", exact: true }).click();
  const update = detail.getByRole("button", { name: "Update", exact: true });
  await update.waitFor();
  await opened(plugin, false);
  holdNextPatch();
  const patchBefore = patches().length;
  await groupSwitch(plugin).click();
  await waitFor(() => patches().length === patchBefore + 1, "bulk PATCH did not arrive");
  assert.deepEqual(patches().at(-1).body, { filePaths: [beta.filePath], disableModelInvocation: false });
  assert.ok(await detail.getByRole("switch").isDisabled());
  assert.ok(await groupSwitch(gScope).isDisabled());
  assert.ok(await update.isDisabled());
  // Try the disabled controls too: no extra request may reach the mock.
  await detail.getByRole("switch").dispatchEvent("click");
  await groupSwitch(gScope).dispatchEvent("click");
  await update.dispatchEvent("click");
  await dialog.getByRole("button", { name: "Add skill", exact: true }).click();
  await detail.locator("input").fill("install-fixture");
  await detail.getByRole("button", { name: "Search", exact: true }).click();
  const install = detail.getByRole("button", { name: "Install", exact: true });
  await install.waitFor(); assert.ok(await install.isDisabled());
  await install.dispatchEvent("click");
  assert.equal(patches().length, patchBefore + 1);
  assert.equal(requests.filter((r) => ["/api/skills/install", "/api/skills/update"].includes(r.path)).length, 0);
  releasePatch();
  await waitFor(async () => !(await groupSwitch(plugin).isDisabled()), "bulk PATCH never released");
  assert.equal(await groupSwitch(plugin).getAttribute("aria-checked"), "true");
  pass("collapsed descendants bulk PATCH only changed files; single/group/update/install writes interlocked");

  await opened(plugin, true); await row("plugin-alpha").click();
  await opened(plugin, false);
  const getsBefore = gets;
  await detail.getByRole("button", { name: "Update", exact: true }).click();
  await waitFor(() => gets > getsBefore, "update did not reload GET /api/skills");
  await waitFor(async () => !(await groupSwitch(plugin).isDisabled()), "update never finished");
  assert.equal(await plugin.getAttribute("aria-expanded"), "false");
  assert.ok(await detail.getByText("Fixture instructions for plugin-alpha.", { exact: true }).isVisible());
  pass("update uses mocked POST plus GET reload and preserves user collapse");

  // Local parent includes its collapsed video/edit and code descendants.
  await opened(local, false);
  failPath = sound.filePath;
  holdNextPatch();
  const failBefore = patches().length;
  await groupSwitch(local).click();
  await waitFor(() => patches().length === failBefore + 1, "local bulk PATCH missing");
  assert.deepEqual([...patches().at(-1).body.filePaths].sort(), [sound.filePath, test.filePath].sort());
  assert.equal(patches().at(-1).body.disableModelInvocation, false);
  await opened(pScope, false); releasePatch();
  const alert = tree.getByRole("alert");
  await alert.getByText(/fixture write refused/).waitFor();
  assert.ok(await alert.isVisible());
  await page.screenshot({ path: join(artifacts, "desktop-partial-failure.png") });
  await alert.getByRole("button").click();
  assert.equal(await pScope.getAttribute("aria-expanded"), "true");
  assert.equal(await local.getAttribute("aria-expanded"), "true");
  assert.equal(await node(local).locator(":scope > .skill-group-tree-heading .config-sidebar-group-count").innerText(), "2/3");
  assert.equal(skills.find((s) => s.filePath === sound.filePath).disableModelInvocation, true);
  assert.equal(skills.find((s) => s.filePath === test.filePath).disableModelInvocation, false);
  assert.equal(skills.find((s) => s.filePath === twin.filePath).disableModelInvocation, true);
  assert.equal(skills.find((s) => s.filePath === globalSkill.filePath).disableModelInvocation, true);
  pass("parent batch covers folded descendants, preserves successes and exposes failure outside collapsed scope");

  await page.setViewportSize({ width: 320, height: 740 });
  await opened(video, true); await opened(edit, true); await row("cut").click();
  // The mobile list is hidden while detail is open. Fold its ancestor to
  // reproduce the selected row unmount without changing navigation state.
  await video.dispatchEvent("click");
  const mobileTitle = dialog.locator(".settings-dialog-title");
  await waitFor(async () => (await mobileTitle.innerText()) === "cut", "mobile detail title lost when selected ancestor collapsed");
  assert.ok(await detail.getByText("Fixture instructions for cut.", { exact: true }).isVisible());
  const noOverflow = async () => assert.ok(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && [...el.querySelectorAll('.config-detail, .settings-dialog-main')].filter((x) => x.getClientRects().length).every((x) => x.scrollWidth <= x.clientWidth + 1)), "320px settings/detail overflow");
  await noOverflow();
  await page.screenshot({ path: join(artifacts, "mobile-detail-320.png") });
  await dialog.locator(".settings-phone-back").click();
  await waitFor(async () => (await mobileTitle.innerText()) === "Skills", "phone Back did not restore skills list");
  assert.equal(await video.getAttribute("aria-expanded"), "false");
  // Walk real tab order; folded descendants must never receive focus.
  await video.focus();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest("[hidden]"))), false);
  }
  await noOverflow();
  await page.screenshot({ path: join(artifacts, "mobile-list-320.png") });
  pass("320px detail title survives folded ancestor, Back restores list, no overflow or hidden tab stops");

  // Geometry assertions catch invalid CSS indentation that snapshots cannot:
  // leaves must sit deeper than their owning group at every supported width.
  await opened(pScope, true); await opened(local, true);
  await opened(video, true); await opened(edit, true);
  const globalSource = title("global", "source", globalSkill);
  await opened(title("global"), true); await opened(globalSource, true);
  const geometry = [];
  for (const width of [1440, 1024, 768, 640, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await waitFor(async () => tree.isVisible(), "responsive skills list hidden");
    const metrics = await tree.evaluate((el) => {
      const visible = (node) => node.getClientRects().length > 0;
      const leaves = [...el.querySelectorAll('.skill-group-tree-leaves > .config-sidebar-item')].filter(visible);
      const groups = [...el.querySelectorAll('.skill-group-tree-heading')].filter(visible);
      const badIndent = leaves.filter((row) => {
        const group = row.closest('.skill-group-tree-node').querySelector(':scope > .skill-group-tree-heading');
        const headingInset = parseFloat(getComputedStyle(group).paddingInlineStart);
        const rowInset = parseFloat(getComputedStyle(row).paddingInlineStart);
        return rowInset < headingInset + 9;
      }).map((row) => row.textContent);
      const overflowing = [...groups, ...leaves, el].filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.className);
      const controls = groups.map((group) => {
        const title = group.querySelector('.skill-group-tree-title').getBoundingClientRect();
        const control = group.querySelector('.config-sidebar-group-switch').getBoundingClientRect();
        return title.right <= control.left + 1;
      });
      return { badIndent, overflowing, controls };
    });
    assert.deepEqual(metrics.badIndent, [], `${width}px: leaves lost hierarchy indentation`);
    assert.deepEqual(metrics.overflowing, [], `${width}px: tree rows overflow`);
    assert.ok(metrics.controls.every(Boolean), `${width}px: group titles overlap switches`);
    geometry.push({ width, ...metrics });
    if ([1440, 320].includes(width)) await page.screenshot({ path: join(artifacts, `responsive-tree-${width}.png`) });
  }
  save("responsive-geometry.json", geometry);
  pass("1440/1024/768/640/390/320px: leaf indentation, long names, no row overflow or switch overlap");
  assert.deepEqual(pageErrors, [], "Unexpected browser pageerror; see pageerror.json");
  assert.deepEqual(consoleMessages.filter((m) => m.type === "error"), [], "Unexpected browser console errors; see console.json");
  pass("browser pageerror and console errors are empty");
  summary.status = "passed";
} catch (error) {
  summary.status = checks.length ? "failed" : "blocked";
  summary.error = error.stack ?? String(error);
  process.exitCode = 1;
  console.error(summary.error);
  if (page) {
    await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
    writeFileSync(join(artifacts, "failure.html"), await page.content().catch(() => ""));
  }
} finally {
  releasePatch?.();
  await context?.tracing.stop({ path: join(artifacts, "trace.zip") }).catch(() => {});
  await browser?.close().catch(() => {});
  // Only signal the process group created here, never a reused dev server.
  if (server && server.exitCode === null && server.signalCode === null) {
    const signal = (name) => { try { process.kill(-server.pid, name); } catch { /* already exited */ } };
    signal("SIGTERM");
    const force = setTimeout(() => signal("SIGKILL"), 10_000);
    await serverExit.catch(() => {}); clearTimeout(force);
  }
  serverLog?.end();
  rmSync(agentDir, { recursive: true, force: true });
  save("console.json", consoleMessages); save("pageerror.json", pageErrors);
  save("requests.json", requests); save("blocked-writes.json", blockedWrites); save("failed-responses.json", failedResponses);
  summary.skillsGetCount = gets;
  save("summary.json", summary);
  console.log(`${summary.status.toUpperCase()}: ${checks.length} checks; ${artifacts}`);
  process.off("SIGINT", stop); process.off("SIGTERM", stop);
}
