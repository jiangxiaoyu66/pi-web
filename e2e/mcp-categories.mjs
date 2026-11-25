// Standalone browser fixtures: no MCP process or configuration writes; isolated local login only.
// PLAYWRIGHT_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node e2e/mcp-categories.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { authenticateLocalContext, localBrowserAuth, localServerFetch } from './local-server-auth.mjs';
const jiti = createJiti(import.meta.url);
const { EMPTY_MCP_CATEGORIES, parseMcpCategoriesRequest, updateMcpCategories, hasMcpCategoryData } = await jiti.import('../lib/mcp-categories.ts');
let categoryState = { exists: false, preferences: EMPTY_MCP_CATEGORIES };

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(root, 'test-results/mcp-categories');
mkdirSync(artifacts, { recursive: true });
const port = Number(process.env.PI_WEB_E2E_PORT || 30141);
assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535, 'PI_WEB_E2E_PORT must be a TCP port');
const base = `http://127.0.0.1:${port}`;
const cwd = '/tmp/pi-mcp-categories-fixture'; // Synthetic: never created or sent to the real API.
const sessionId = 'e2e-mcp-categories';
const timestamp = '2026-08-23T00:00:00.000Z';
const checks = [], requests = [], unexpectedWrites = [], consoleMessages = [], pageErrors = [];
const summary = { status: 'running', checks, artifacts, server: `existing ${port} only` };
const save = (name, value) => writeFileSync(join(artifacts, name), JSON.stringify(value, null, 2) + '\n');
const pass = name => { checks.push(name); console.log(`PASS: ${name}`); };
let browser, context, page, mcpGets = 0;
const globalFile = { scope: 'global', path: '/fixture/agent/mcp.json', exists: true, problems: [] };
const projectFile = { scope: 'project', path: `${cwd}/.pi/mcp.json`, exists: true, problems: [] };
function server(name, scope = 'global') {
  return { name, scope, sourcePath: scope === 'global' ? globalFile.path : projectFile.path,
    configKey: `${scope}-${name}`, enabled: true, validated: true, envNames: [], headerNames: [],
    usesOAuth: false, commandFields: [], variableReferences: [], masked: false,
    transport: 'http', exposure: 'codemode', url: `https://${scope}.example.invalid/${name}` };
}
const shared = server('shared'), projectShared = server('shared', 'project');
const longName = 'fixture-server-with-a-very-long-unbroken-name-for-responsive-controls';
let servers = [shared, server(longName), projectShared];
const overview = () => ({ mcp: { available: true },
  codemode: { sandbox: { state: 'available' }, builtinDisabled: false, preference: 'automatic' },
  files: [globalFile, projectFile], servers,
  project: { cwd, trust: { requiresTrust: true, trusted: true, decision: true, decisionPath: cwd, inherited: false } } });
const entry = { type: 'message', id: 'abc12345', parentId: null, timestamp,
  message: { role: 'user', content: 'MCP category browser fixture' } };
const info = { id: sessionId, path: `/fixture/${sessionId}.jsonl`, cwd, name: 'MCP category fixture',
  created: timestamp, modified: timestamp, messageCount: 1, firstMessage: entry.message.content };
const uiState = { version: 1, revision: 0, pinned: [], archived: [], projectOrder: [], projectNames: {}, readTimes: {} };

async function mockApi(route) {
  const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
  const body = request.postData();
  requests.push({ path, method, body });
  const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  // Shared server fixture, not browser storage. No category request reaches the real agent directory.
  if (path === '/api/mcp/categories') {
    if (method === 'GET') return json(categoryState);
    if (method !== 'POST') throw new Error(`Unexpected categories method ${method}`);
    const request = parseMcpCategoriesRequest(JSON.parse(body));
    assert.ok(request, 'category POST uses the validated incremental/conditional-import contract');
    if ('action' in request) {
      const imported = !categoryState.exists && hasMcpCategoryData(request.preferences);
      if (imported) categoryState = { exists: true, preferences: request.preferences };
      return json({ ...categoryState, imported });
    }
    categoryState = { exists: true, preferences: updateMcpCategories(categoryState.preferences, request.operation) };
    return json(categoryState);
  }
  // Check writes FIRST. Even automatic writes must not leak through to the live server.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    if (path === '/api/sessions/ui-state' && method === 'POST' && ['read', 'add-projects'].includes(JSON.parse(body || '{}').action)) return json({ state: uiState });
    if (path === `/api/agent/${sessionId}/lease` && method === 'POST') return json({ running: false, awaitingInput: false, subagentsActive: false });
    unexpectedWrites.push({ path, method, body });
    return json({ error: 'Unexpected write blocked by MCP category E2E fixture' }, 409);
  }
  if (path === '/api/mcp') { mcpGets++; return json(overview()); }
  if (path === '/api/skills') return json({ skills: [], diagnostics: [], projectResourcesLoaded: true });
  // Includes OAuth GET endpoints, which can have side effects. Never pass through.
  if (path.startsWith('/api/mcp/') || /^\/api\/auth\/(login|logout)\//.test(path)) {
    unexpectedWrites.push({ path, method, body });
    return json({ error: 'MCP connection/auth request forbidden in category test' }, 409);
  }
  if (path === '/api/sessions') return json({ sessions: [info], runningSessionIds: [], awaitingInputSessionIds: [] });
  if (path === `/api/sessions/${sessionId}`) return json({ sessionId, filePath: info.path, info, leafId: entry.id,
    tree: [{ entry, children: [] }], context: { messages: [entry.message], entryIds: [entry.id], hasMore: false, leafId: entry.id }, totalActiveMs: 0 });
  if (path === `/api/sessions/${sessionId}/state`) return json({ running: false });
  if (path === '/api/sessions/ui-state') return json({ state: uiState });
  if (path === '/api/agent/running') return json({ runningSessionIds: [], awaitingInputSessionIds: [], completionNotificationSuppressedSessionIds: [], serverTime: Date.now() });
  if (path === `/api/agent/${sessionId}/events`) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture idle\n\n' });
  if (path === '/api/project-trust') return json({ requiresTrust: false, trusted: true, decision: true, inherited: false, servers: [] });
  if (path === '/api/worktrees') return json({ projectRoot: cwd, projectKey: cwd, isGit: false, isTopLevel: true, currentWorktreePath: cwd, worktrees: [] });
  if (path.startsWith('/api/files/')) return json({ entries: [], path: cwd });
  if (path === '/api/git/status') return json({ files: [], isGit: false });
  if (path === '/api/models') return json({ models: [], modelList: [], defaultModel: null });
  // Unrelated read-only shell requests may use their normal route, but never MCP/auth.
  return route.continue();
}

try {
  const probe = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  assert.equal(probe.status, 0, `${port} has no listener; this script never starts or restarts a server`);
  const pids = [...new Set(probe.stdout.trim().split(/\s+/).filter(Boolean))];
  for (const pid of pids) {
    const result = spawnSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    const escaped = result.stdout.split('\n').find(line => line.startsWith('n'))?.slice(1);
    // lsof escapes non-ASCII path bytes on macOS even with -Fn.
    const directory = escaped?.includes('\\x')
      ? Buffer.from(escaped.replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('utf8') : escaped;
    assert.ok(directory && realpathSync(directory) === realpathSync(root), `${port} belongs to another checkout`);
  }
  const health = await localServerFetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(10_000) });
  assert.ok(health.ok && Array.isArray((await health.json()).sessions), 'Existing server is unhealthy; not restarting');
  summary.listenerPids = pids;
  const { chromium, expect } = await import('playwright/test');
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  context = await browser.newContext({ ...localBrowserAuth(base), viewport: { width: 1440, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await authenticateLocalContext(context, base);
  await context.addInitScript(() => localStorage.setItem('pi-locale', 'en'));
  await context.route('**/api/**', mockApi);
  if (!process.env.PI_WEB_PASSWORD) await context.tracing.start({ screenshots: true, snapshots: true });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('console', message => consoleMessages.push({ type: message.type(), text: message.text() }));
  await page.goto(`${base}/?session=${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.getByRole('button', { name: 'Skills', exact: true }).first().click({ timeout: 30_000 });
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.waitFor({ timeout: 30_000 });
  await settings.getByRole('button', { name: 'MCP', exact: true }).click();
  await expect(settings.locator('.config-sidebar-item').filter({ hasText: 'shared' })).toHaveCount(2);
  // One bounded readiness check. Do not repeatedly reload/poll a component being written elsewhere.
  if (!(await settings.locator('.mcp-category-list').count())) {
    summary.status = 'blocked';
    throw new Error('Component not ready: MCP overview rendered, but .mcp-category-list is absent. No component polling/reload attempted.');
  }
  const list = scope => settings.locator('.mcp-category-list').filter({ has: page.getByRole('button', { name: `New category in ${scope}`, exact: true }) });
  const global = list('global'), project = list('project');
  await expect(global).toHaveCount(1); await expect(project).toHaveCount(1);
  const category = (scopeList, name) => scopeList.locator('.mcp-category-section').filter({ has: page.locator('button.mcp-category-title').filter({ hasText: name }) });
  const member = (scopeList, name) => scopeList.locator('.mcp-category-server').filter({ has: page.getByRole('button', { name: `Move ${name} to category`, exact: true }) });
  const menuItem = name => page.getByRole('menuitem', { name, exact: true }).or(page.getByRole('menuitemradio', { name, exact: true }));
  const create = async (scope, name) => {
    await page.getByRole('button', { name: `New category in ${scope}`, exact: true }).click();
    await page.getByRole('textbox', { name: 'Category name', exact: true }).fill(name);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
  };
  await create('global', 'Research');
  await expect(category(global, 'Research')).toBeVisible();
  await member(global, 'shared').getByRole('button', { name: 'Move shared to category', exact: true }).click();
  await menuItem('Research').click();
  const groupId = await category(global, 'Research').getAttribute('data-category-id');
  assert.ok(groupId);
  await expect(category(global, 'Research').locator('.mcp-category-server')).toHaveCount(1);
  await expect(project.locator('.mcp-category-section[data-category-id=""]').locator('.mcp-category-server')).toHaveCount(1);
  pass('create global category and move shared; same-name project server remains uncategorized');

  await global.getByRole('button', { name: 'Category actions: Research', exact: true }).click();
  await menuItem('Rename').click();
  await page.getByRole('textbox', { name: 'Category name', exact: true }).fill('Renamed research');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const renamed = category(global, 'Renamed research');
  assert.equal(await renamed.getAttribute('data-category-id'), groupId);
  await expect(renamed.locator('.mcp-category-server')).toHaveCount(1);
  await member(global, 'shared').locator('.config-sidebar-item').click();
  await expect(settings.locator('.config-detail-title')).toHaveText('shared');
  const title = renamed.locator('button.mcp-category-title');
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  await title.focus(); await page.keyboard.press('Enter');
  await expect(title).toHaveAttribute('aria-expanded', 'false');
  await expect(renamed.locator('.mcp-category-members')).toHaveAttribute('hidden', '');
  await expect(renamed.locator('.mcp-category-server')).toHaveCount(1);
  await expect(settings.locator('.config-detail-title')).toHaveText('shared');
  await page.keyboard.press('Space');
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  pass('rename retains assignment; keyboard collapse preserves hidden DOM and selected server detail');

  assert.equal(categoryState.preferences.buckets[JSON.stringify(['global'])].assignments.shared, groupId);
  await title.click();
  await expect(title).toHaveAttribute('aria-expanded', 'false');
  await page.reload({ waitUntil: 'domcontentloaded' });
  // Settings open-state is not part of the category contract.
  if (!(await settings.isVisible())) {
    await page.getByRole('button', { name: 'Skills', exact: true }).first().click();
    await settings.waitFor();
    await settings.getByRole('button', { name: 'MCP', exact: true }).click();
  }
  await expect(category(global, 'Renamed research').locator('.mcp-category-server')).toHaveCount(1);
  await expect(category(global, 'Renamed research').locator('.mcp-category-title')).toHaveAttribute('aria-expanded', 'false');
  await category(global, 'Renamed research').locator('.mcp-category-title').click();
  pass('server categories, membership and folds persist through reload');

  const peerContext = await browser.newContext({ ...localBrowserAuth(base), serviceWorkers: 'block' });
  await authenticateLocalContext(peerContext, base);
  await peerContext.route('**/api/**', mockApi);
  const peer = await peerContext.newPage();
  await peer.goto(`${base}/?session=${sessionId}`, { waitUntil: 'domcontentloaded' });
  // Separate browser storage; the API is the only shared channel.
  const peerResult = await peer.evaluate(async id => {
    const response = await fetch('/api/mcp/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, operation: { type: 'rename', bucketKey: JSON.stringify(['global']), id, name: 'Cross-tab research' } }) });
    return { ok: response.ok, local: localStorage.getItem('pi-web:mcp-categories') };
  }, groupId);
  assert.equal(peerResult.ok, true); assert.equal(peerResult.local, null);
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(category(global, 'Cross-tab research').locator('.mcp-category-server')).toHaveCount(1);
  await peerContext.close();
  pass('independent browser client shares server state; focus refresh keeps membership');

  const refresh = async () => {
    const before = mcpGets;
    await settings.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => mcpGets).toBeGreaterThan(before);
  };
  servers = [...servers, server('external-added')]; await refresh();
  await expect(global.locator('.mcp-category-section[data-category-id=""]').getByRole('button', { name: 'Move external-added to category', exact: true })).toBeVisible();
  servers = servers.filter(s => s !== shared); await refresh();
  await expect(member(global, 'shared')).toHaveCount(0);
  servers = [shared, ...servers]; await refresh();
  await expect(category(global, 'Cross-tab research').locator('.mcp-category-server')).toHaveCount(1);
  pass('mock external refresh: added server uncategorized; removed hidden; restored server returns to original group');

  const focusCategory = category(global, 'Cross-tab research');
  const focusTitle = focusCategory.locator('.mcp-category-title');
  if (await focusTitle.getAttribute('aria-expanded') === 'true') await focusTitle.click();
  const other = servers.find(s => s.scope === 'global' && s.name !== 'shared' && s.name !== 'external-added');
  await global.getByRole('button', { name: `Move ${other.name} to category`, exact: true }).click();
  await menuItem('Cross-tab research').click();
  await expect(focusTitle).toBeFocused();
  await expect(focusTitle).toHaveAttribute('aria-expanded', 'false');
  await focusTitle.click();
  await focusCategory.getByRole('button', { name: `Move ${other.name} to category`, exact: true }).click();
  await menuItem('Uncategorized').click();
  await expect(global.locator('.mcp-category-section[data-category-id=""]').getByRole('button', { name: `Move ${other.name} to category`, exact: true })).toBeVisible();
  await expect(menuItem('Uncategorized')).toHaveCount(0);
  pass('moving a non-selected server into a folded category restores focus to its visible heading');

  const geometry = [];
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(global).toBeVisible();
    const metrics = await settings.evaluate(el => {
      const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
      const rows = [...el.querySelectorAll('.mcp-category-server, .mcp-category-list, .mcp-category-section')].filter(visible);
      const overflow = rows.filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.className);
      const overlaps = [...el.querySelectorAll('.mcp-category-server')].filter(visible).filter(n => {
        const a = n.querySelector('.config-sidebar-item')?.getBoundingClientRect();
        const b = n.querySelector('button[aria-label^="Move "]')?.getBoundingClientRect();
        return a && b && a.right > b.left + 1 && a.bottom > b.top && b.bottom > a.top;
      }).map(n => n.textContent);
      return { overflow, overlaps, documentOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    geometry.push({ width, ...metrics });
    save('geometry.json', geometry);
    await page.screenshot({ path: join(artifacts, `responsive-${width}.png`) });
    assert.deepEqual(metrics.overflow, [], `${width}px category overflow`);
    assert.deepEqual(metrics.overlaps, [], `${width}px server/action overlap`);
    assert.equal(metrics.documentOverflow, false, `${width}px document overflow`);
    await global.getByRole('button', { name: 'Category actions: Cross-tab research', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(menuItem('Rename')).toBeVisible();
    await expect(menuItem('Rename')).toBeFocused();
    // Focus is a layout effect; keyboard listeners are passive effects. Let
    // the opening paint/effects settle before sending a synthetic Escape.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await menuItem('Rename').press('Escape');
    await expect(menuItem('Rename')).toHaveCount(0);
    await expect(settings).toBeVisible();
  }
  pass('320/390/768/1440px geometry; keyboard opens actions, Escape closes menu but not Settings');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await global.getByRole('button', { name: 'Category actions: Cross-tab research', exact: true }).click();
  await menuItem('Delete category').click();
  // Copy may be polished; require both semantic guarantees rather than exact prose.
  const deletionSurface = page.locator('.sidebar-menu, .sidebar-sheet').filter({ has: page.getByRole('button', { name: 'Delete category', exact: true }) });
  await expect(deletionSurface).toContainText(/category/i);
  await expect(deletionSurface).toContainText(/servers.*remain|servers.*not.*(remove|delete)/i);
  await deletionSurface.getByRole('button', { name: 'Delete category', exact: true }).click();
  await expect(global.locator(`.mcp-category-section[data-category-id="${groupId}"]`)).toHaveCount(0);
  await expect(global.locator('.mcp-category-section[data-category-id=""]').getByRole('button', { name: 'Move shared to category', exact: true })).toBeVisible();
  assert.deepEqual(requests.filter(r => r.path === '/api/mcp' && r.method !== 'GET'), []);
  assert.deepEqual(unexpectedWrites, [], 'Unexpected writes blocked; see unexpected-writes.json');
  pass('delete category returns server to uncategorized; no MCP or unexpected API writes');

  categoryState = { exists: false, preferences: EMPTY_MCP_CATEGORIES };
  await page.addInitScript(() => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      if (key === 'pi-web:mcp-categories') throw new DOMException('fixture storage blocked', 'SecurityError');
      return original.call(this, key);
    };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (!(await settings.isVisible())) {
    await page.getByRole('button', { name: 'Skills', exact: true }).first().click();
    await settings.waitFor();
    await settings.getByRole('button', { name: 'MCP', exact: true }).click();
  }
  const add = global.getByRole('button', { name: 'New category in global', exact: true });
  const skip = global.getByRole('button', { name: 'Continue without browser import…', exact: true });
  await expect(skip).toBeVisible(); await expect(add).toBeDisabled();
  const postsBeforeSkip = requests.filter(r => r.path === '/api/mcp/categories' && r.method === 'POST').length;
  await skip.click();
  const confirm = page.getByRole('button', { name: 'Use server storage', exact: true });
  await expect(confirm).toBeVisible();
  assert.equal(categoryState.exists, false, 'opening confirmation does not create a file or assume empty legacy data');
  await confirm.click(); await expect(add).toBeEnabled();
  assert.equal(requests.filter(r => r.path === '/api/mcp/categories' && r.method === 'POST').length, postsBeforeSkip);
  await create('global', 'Server-only recovery');
  await expect(category(global, 'Server-only recovery')).toBeVisible();
  assert.equal(categoryState.exists, true);
  await settings.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(category(global, 'Server-only recovery')).toBeVisible();
  assert.deepEqual(unexpectedWrites, []);
  pass('SecurityError recovery requires explicit confirmation, creates no placeholder, then saves server-only categories');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleMessages.filter(m => m.type === 'error'), []);
  pass('no browser page errors or console errors');
  summary.status = 'passed';
} catch (error) {
  if (summary.status !== 'blocked') summary.status = checks.length ? 'failed' : 'blocked';
  summary.error = error.stack || String(error);
  process.exitCode = 1;
  console.error(summary.error);
  if (page) {
    await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
    writeFileSync(join(artifacts, 'failure.html'), await page.content().catch(() => ''));
  }
} finally {
  if (!process.env.PI_WEB_PASSWORD) await context?.tracing.stop({ path: join(artifacts, 'trace.zip') }).catch(() => {});
  await browser?.close().catch(() => {});
  summary.mcpGetCount = mcpGets;
  save('summary.json', summary); save('requests.json', requests);
  save('unexpected-writes.json', unexpectedWrites); save('console.json', consoleMessages); save('pageerror.json', pageErrors);
  console.log(`${summary.status.toUpperCase()}: ${checks.length} checks; ${artifacts}`);
}
