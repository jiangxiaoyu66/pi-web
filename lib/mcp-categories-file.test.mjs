import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";
import lockfile from "proper-lockfile";

const root = await mkdtemp(join(tmpdir(), "pi-mcp-categories-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const jiti = createJiti(import.meta.url);
const file = await jiti.import("./mcp-categories-file.ts");
const data = await jiti.import("./mcp-categories.ts");
const path = join(root, "pi-web", "mcp-categories.json");
const bucketKey = '["global"]';
const create = id => ({ version: 1, operation: { type: "create", bucketKey, id, name: id } });
const legacy = id => data.updateMcpCategories(data.EMPTY_MCP_CATEGORIES, create(id).operation);
const importData = id => ({ version: 1, action: "import", preferences: legacy(id) });
const ids = state => state.preferences.buckets[bucketKey]?.categories.map(c => c.id) ?? [];
const child = code => new Promise((resolve, reject) => {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", `import { createJiti } from 'jiti'; const j = createJiti(process.cwd() + '/package.json'); const f = await j.import('./lib/mcp-categories-file.ts'); ${code}`], { env: { ...process.env, PI_CODING_AGENT_DIR: root } });
  let out = "", err = "";
  proc.stdout.on("data", s => out += s); proc.stderr.on("data", s => err += s);
  proc.on("error", reject); proc.on("close", code => code === 0 ? resolve(out.trim()) : reject(Error(err)));
});
beforeEach(async () => { await rm(join(root, "pi-web"), { recursive: true, force: true }); });
after(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(root, { recursive: true, force: true });
});

test("missing GET and empty import never create a file; later browser can migrate", async () => {
  assert.equal(file.getMcpCategoriesPath(), path);
  assert.equal(file.readMcpCategories().exists, false);
  assert.deepEqual(await readdir(root), []);
  assert.equal((await file.updateMcpCategoriesFile({ version: 1, action: "import", preferences: data.EMPTY_MCP_CATEGORIES })).exists, false);
  assert.deepEqual(await readdir(join(root, "pi-web")), []);
  assert.equal((await file.updateMcpCategoriesFile(importData("later"))).imported, true);
});

test("real file persists membership, exact cwd buckets and folds across a fresh module and process", async () => {
  await file.updateMcpCategoriesFile(create("a"));
  await file.updateMcpCategoriesFile({ version: 1, operation: { type: "move", bucketKey, serverName: "absent", categoryId: "a" } });
  await file.updateMcpCategoriesFile({ version: 1, operation: { type: "collapse", bucketKey, id: "a", collapsed: true } });
  for (const cwd of ["/project", "/project/"]) await file.updateMcpCategoriesFile({ version: 1, operation: { ...create("a").operation, bucketKey: JSON.stringify(["project", cwd]) } });
  const fresh = await createJiti(import.meta.url, { moduleCache: false }).import("./mcp-categories-file.ts");
  const expected = file.readMcpCategories();
  assert.deepEqual(fresh.readMcpCategories(), expected);
  assert.deepEqual(JSON.parse(await child("console.log(JSON.stringify(f.readMcpCategories()))")), expected);
  assert.equal(expected.preferences.buckets[bucketKey].assignments.absent, "a");
  assert.deepEqual(expected.preferences.buckets[bucketKey].collapsed, ["a"]);
  assert.equal(Object.keys(expected.preferences.buckets).length, 3);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(root), ["pi-web"], "never writes mcp.json or settings.json");
  assert.deepEqual(await readdir(join(root, "pi-web")), ["mcp-categories.json"]);
});

test("concurrent read/modify/write retains all increments, including independent processes", async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => file.updateMcpCategoriesFile(create(`local-${i}`))));
  let running = true;
  const writers = Promise.all(Array.from({ length: 3 }, (_, i) => child(`await f.updateMcpCategoriesFile(${JSON.stringify(create(`child-${i}`))})`))).finally(() => { running = false; });
  let reads = 0;
  while (running) {
    const current = file.readMcpCategories();
    assert.ok(data.validateMcpCategories(current.preferences), "readers only see complete atomic snapshots");
    assert.ok(ids(current).length >= 20); reads++;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await writers;
  assert.ok(reads > 0);
  assert.equal(ids(file.readMcpCategories()).length, 23);
});

test("conditional imports race without overwriting the winning browser, even an existing empty file", async () => {
  const results = await Promise.all([file.updateMcpCategoriesFile(importData("one")), file.updateMcpCategoriesFile(importData("two"))]);
  assert.equal(results.filter(r => r.imported).length, 1);
  assert.deepEqual(ids(results[0]), ids(results[1]));
  await writeFile(path, JSON.stringify(data.EMPTY_MCP_CATEGORIES));
  assert.equal((await file.updateMcpCategoriesFile(importData("three"))).imported, false);
  assert.deepEqual(ids(file.readMcpCategories()), []);
});

for (const raw of ["{broken", '{"version":2,"buckets":{}}', '{"version":1,"buckets":{"bad":{}}}',
  ...["\ud800", "\udc00"].map(id => JSON.stringify({ version: 1, buckets: { [bucketKey]: { categories: [{ id, name: "valid" }], assignments: {} } } })),
]) {
  test(`corrupt file is reported and untouched by operations or migration: ${raw}`, async () => {
    await mkdir(join(root, "pi-web")); await writeFile(path, raw);
    assert.throws(() => file.readMcpCategories(), e => e.reason === "corrupt");
    for (const request of [create("a"), importData("a")]) await assert.rejects(file.updateMcpCategoriesFile(request), e => e.reason === "corrupt");
    assert.equal(await readFile(path, "utf8"), raw);
  });
}

test("refuses nonregular, oversized and dangling-link files without replacing them", async () => {
  await mkdir(path, { recursive: true });
  await assert.rejects(file.updateMcpCategoriesFile(create("a")), e => e.reason === "unreadable");
  await rm(path, { recursive: true });
  await writeFile(path, " ".repeat(data.MCP_CATEGORIES_MAX_BYTES + 1));
  await assert.rejects(file.updateMcpCategoriesFile(importData("a")), e => e.reason === "unreadable");
  assert.equal((await stat(path)).size, data.MCP_CATEGORIES_MAX_BYTES + 1);
  await rm(path); await symlink(join(root, "missing"), path);
  await assert.rejects(file.updateMcpCategoriesFile(create("a")), e => e.reason === "unreadable");
  await assert.rejects(stat(join(root, "missing")), { code: "ENOENT" });
});

test("held file lock refuses migration without marking/writing and retry succeeds after release", async () => {
  await mkdir(join(root, "pi-web"));
  const release = await lockfile.lock(path, { realpath: false });
  try {
    await assert.rejects(file.updateMcpCategoriesFile(importData("retry")), e => e.reason === "locked");
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally { await release(); }
  assert.equal((await file.updateMcpCategoriesFile(importData("retry"))).imported, true);
});

for (const invalid of [[0xff], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80]]) {
  test(`invalid UTF-8 file is corrupt and never repaired/overwritten: ${invalid}`, async () => {
    await mkdir(join(root, "pi-web"));
    const raw = Buffer.concat([Buffer.from('{"version":1,"buckets":{"[\\"global\\"]":{"categories":[{"id":"old","name":"'), Buffer.from(invalid), Buffer.from('"}],"assignments":{}}}}')]);
    await writeFile(path, raw);
    assert.throws(() => file.readMcpCategories(), e => e.reason === "corrupt");
    for (const request of [create("new"), importData("legacy")]) await assert.rejects(file.updateMcpCategoriesFile(request), e => e.reason === "corrupt");
    assert.deepEqual(await readFile(path), raw);
  });
}

test("an arbitrarily old abandoned lock is not reaped by elapsed time", async () => {
  await mkdir(`${path}.lock`, { recursive: true });
  const { utimes } = await import("node:fs/promises");
  await utimes(`${path}.lock`, new Date(0), new Date(0));
  await assert.rejects(file.updateMcpCategoriesFile(create("blocked")), e => e.reason === "locked");
  assert.equal((await stat(`${path}.lock`)).mtimeMs, 0);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  // Test-owned directory, with no live owner. Production recovery requires ALL writers stopped.
  await rm(`${path}.lock`, { recursive: true });
  await file.updateMcpCategoriesFile(create("recovered"));
  assert.deepEqual(ids(file.readMcpCategories()), ["recovered"]);
});

test("SIGSTOP beyond the old stale threshold cannot transfer ownership or lose a competing update", { timeout: 45000 }, async () => {
  const marker = join(root, "paused");
  const source = `import fs from 'node:fs'; import lockfile from 'proper-lockfile';
    import { createRequire } from 'node:module'; import { createJiti } from 'jiti';
    const require = createRequire(process.cwd() + '/package.json');
    const locks = require('proper-lockfile/lib/lockfile.js').getLocks();
    const j = createJiti(process.cwd() + '/package.json'); const f = await j.import('./lib/mcp-categories-file.ts');
    const stringify = JSON.stringify;
    JSON.stringify = function(value, replacer, space) {
      if (space === 2 && value?.version === 1) {
        const lock = Object.values(locks)[0];
        if (lock.options.stale !== Infinity || lock.options.update !== 1000) throw Error('lock contract changed');
        fs.writeFileSync(${JSON.stringify(marker)}, 'paused-after-locked-read');
        process.kill(process.pid, 'SIGSTOP');
      }
      return stringify.apply(this, arguments);
    };
    await f.updateMcpCategoriesFile(${JSON.stringify(create("A"))});`;
  const proc = spawn(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, PI_CODING_AGENT_DIR: root } });
  let stderr = ""; proc.stderr.on("data", chunk => stderr += chunk);
  const done = new Promise((resolve, reject) => { proc.on("error", reject); proc.on("close", code => resolve(code)); });
  try {
    const deadline = Date.now() + 20000;
    while (true) {
      try { await readFile(marker); break; } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (proc.exitCode !== null || Date.now() > deadline) throw Error(`writer did not pause: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await new Promise(resolve => setTimeout(resolve, 11000));
    await assert.rejects(file.updateMcpCategoriesFile(create("B")), e => e.reason === "locked");
    assert.equal(file.readMcpCategories().exists, false, "B cannot take over and report success while A is paused");
    proc.kill("SIGCONT"); assert.equal(await done, 0, stderr);
    assert.equal(stderr.includes("TimeoutOverflowWarning"), false, "heartbeat uses a finite interval");
    await file.updateMcpCategoriesFile(create("B"));
    assert.deepEqual(ids(file.readMcpCategories()), ["A", "B"]);
  } finally {
    if (proc.exitCode === null) { proc.kill("SIGCONT"); proc.kill("SIGKILL"); await done; }
    await rm(marker, { force: true });
  }
});

test("failed operation leaves bytes unchanged and queue recovers for retry", async () => {
  await file.updateMcpCategoriesFile(create("a"));
  const before = await readFile(path, "utf8");
  await assert.rejects(file.updateMcpCategoriesFile(create("a")), e => e.reason === "missing-category");
  assert.equal(await readFile(path, "utf8"), before);
  await file.updateMcpCategoriesFile(create("b"));
  assert.deepEqual(ids(file.readMcpCategories()), ["a", "b"]);
});
