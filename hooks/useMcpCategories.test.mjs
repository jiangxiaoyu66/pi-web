import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-categories-hook-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const api = await jiti.import("../app/api/mcp/categories/route.ts");
const clientModule = await jiti.import("../lib/mcp-categories-client.ts");
const data = await jiti.import("../lib/mcp-categories.ts");
const filename = fileURLToPath(new URL("./useMcpCategories.ts", import.meta.url));
const script = new Script(jiti.transform({ source: readFileSync(filename, "utf8"), filename, ts: true }));
const KEY = clientModule.MCP_CATEGORIES_STORAGE_KEY, MARKER = clientModule.MCP_CATEGORIES_MIGRATED_KEY;
const bucketKey = '["global"]';
const op = id => ({ type: "create", bucketKey, id, name: id });
const saved = id => JSON.stringify(data.updateMcpCategories(data.EMPTY_MCP_CATEGORIES, op(id)));
const path = join(root, "pi-web", "mcp-categories.json");
const ids = view => view.preferences.buckets[bucketKey]?.categories.map(c => c.id) ?? [];
const cleanups = [];
function fixture({ raw = null, ssr = false, readBlocked = false, writeBlocked = false } = {}) {
  const stored = new Map(raw === null ? [] : [[KEY, raw]]), events = new Map(), requests = [];
  let unsubscribe, getters, notifications = 0, failure = null, gate = null, storageReads = 0;
  const exports = {};
  const add = (type, listener) => { assert.equal(events.has(type), false); events.set(type, listener); };
  const remove = (type, listener) => { assert.equal(events.get(type), listener); events.delete(type); };
  const document = { visibilityState: "visible", addEventListener: add, removeEventListener: remove };
  script.runInNewContext({ exports, document, fetch: async (_url, init) => {
    requests.push(init);
    if (gate) await gate;
    if (failure === init.method) throw new Error("network-failed");
    return init.method === "GET" ? api.GET() : api.POST(new Request("http://localhost/api/mcp/categories", { ...init, headers: { ...init.headers, host: "localhost" } }));
  }, require(id) {
    if (id === "react") return { useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) {
      getters = { getSnapshot, getServerSnapshot };
      if (ssr) return getServerSnapshot();
      getSnapshot(); unsubscribe ??= subscribe(() => notifications++); return getSnapshot();
    } };
    if (id.endsWith("mcp-categories-client")) return clientModule;
    throw Error(`Unexpected import ${id}`);
  }, ...(!ssr && { window: { localStorage: {
    getItem(key) { storageReads++; if (readBlocked) throw new DOMException("storage-read-failed", "SecurityError"); return stored.get(key) ?? null; },
    setItem(key, value) { if (writeBlocked) throw Error("storage-write-failed"); stored.set(key, value); },
  }, addEventListener: add, removeEventListener: remove } }) });
  const view = () => exports.useMcpCategories();
  const unmount = () => { unsubscribe?.(); unsubscribe = null; };
  cleanups.push(unmount);
  return { view, stored, events, requests, document, unmount,
    refresh: exports.refreshMcpCategories,
    get getters() { return getters; }, get notifications() { return notifications; }, get storageReads() { return storageReads; },
    fail(method) { failure = method; }, blockRead(value) { readBlocked = value; },
    hold() { let release; gate = new Promise(resolve => { release = resolve; }); return () => { gate = null; release(); }; },
  };
}
beforeEach(async () => { cleanups.splice(0).forEach(fn => fn()); await rm(join(root, "pi-web"), { recursive: true, force: true }); });
after(async () => { cleanups.splice(0).forEach(fn => fn()); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });

test("SSR is stable and performs no fetch/storage access", () => {
  const store = fixture({ ssr: true, readBlocked: true });
  assert.equal(store.view().preferences, data.EMPTY_MCP_CATEGORIES);
  assert.equal(store.view().loading, true); assert.equal(store.view().ready, false);
  assert.equal(store.getters.getServerSnapshot(), store.getters.getServerSnapshot());
  assert.equal(store.requests.length, 0);
});

test("loading disallows writes, then same-page consumers share confirmed state and stable snapshots", async () => {
  const store = fixture(); const release = store.hold();
  const first = store.view(), second = store.view();
  assert.equal(first.apply, second.apply); assert.equal(first.ready, false);
  await assert.rejects(first.apply(op("early")), /not-ready/);
  release(); await store.refresh();
  assert.equal(store.view().ready, true);
  await Promise.all([first.apply(op("a")), second.apply(op("b"))]);
  assert.deepEqual(ids(store.view()), ["a", "b"]);
  assert.equal(store.getters.getSnapshot(), store.getters.getSnapshot());
  assert.ok(store.notifications > 0);
});

test("independent clients concurrently increment shared server and focus/visibility refresh peers", async () => {
  const a = fixture(), b = fixture(); a.view(); b.view();
  await Promise.all([a.refresh(), b.refresh()]);
  await Promise.all([a.view().apply(op("a")), b.view().apply(op("b"))]);
  a.events.get("focus")(); await a.refresh();
  b.events.get("visibilitychange")(); await b.refresh();
  assert.deepEqual(ids(a.view()), ["a", "b"]); assert.deepEqual(ids(b.view()), ["a", "b"]);
  a.unmount(); assert.equal(a.events.size, 0);
  a.view(); await a.refresh(); assert.deepEqual(ids(a.view()), ["a", "b"]);
});

test("missing server imports nonempty legacy once, retains original backup and marks only successful import", async () => {
  const raw = saved("legacy"), store = fixture({ raw }); store.view(); await store.refresh();
  assert.deepEqual(ids(store.view()), ["legacy"]);
  assert.equal(store.stored.get(KEY), raw); assert.equal(store.stored.get(MARKER), "1");
  await store.refresh(); assert.equal(store.requests.filter(r => r.method === "POST").length, 1);
});

for (const raw of [null, '{"version":1,"buckets":{}}', '{"version":1,"buckets":{"[\\"global\\"]":{"categories":[],"assignments":{}}}}']) {
  test(`empty browser does not block a later migration: ${raw}`, async () => {
    const empty = fixture({ raw }); empty.view(); await empty.refresh();
    assert.equal(empty.requests.filter(r => r.method === "POST").length, 0);
    assert.equal(empty.stored.has(MARKER), false);
    await assert.rejects(readFile(path), { code: "ENOENT" });
    const other = fixture({ raw: saved("other") }); other.view(); await other.refresh();
    await empty.refresh(); assert.deepEqual(ids(empty.view()), ["other"]);
  });
}

test("existing authoritative file wins over stale browser data", async () => {
  await mkdir(join(root, "pi-web")); await writeFile(path, saved("server"));
  const store = fixture({ raw: saved("stale") }); store.view(); await store.refresh();
  assert.deepEqual(ids(store.view()), ["server"]);
  assert.equal(store.requests.filter(r => r.method === "POST").length, 0);
  assert.equal(store.stored.has(MARKER), false);
});

test("concurrent migrations return one winner to both independent clients", async () => {
  const a = fixture({ raw: saved("a") }), b = fixture({ raw: saved("b") });
  a.view(); b.view(); await Promise.all([a.refresh(), b.refresh()]);
  assert.deepEqual(ids(a.view()), ids(b.view()));
  assert.equal([a, b].filter(s => s.stored.has(MARKER)).length, 1);
});

test("failed migration is not marked, preserves backup and retries", async () => {
  const raw = saved("retry"), store = fixture({ raw }); store.fail("POST"); store.view(); await store.refresh();
  assert.equal(store.view().ready, false); assert.equal(store.view().storageUnavailable, true);
  assert.equal(store.stored.get(KEY), raw); assert.equal(store.stored.has(MARKER), false);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  store.fail(null); await store.refresh(); assert.deepEqual(ids(store.view()), ["retry"]);
  assert.equal(store.stored.get(MARKER), "1");
});

test("failed server read never imports or replaces known state; successful refresh recovers", async () => {
  const store = fixture({ raw: saved("legacy") }); store.fail("GET"); store.view(); await store.refresh();
  assert.equal(store.view().loading, false); assert.equal(store.view().ready, false);
  assert.equal(store.requests.filter(r => r.method === "POST").length, 0);
  store.fail(null); await store.refresh(); const before = store.view().preferences;
  store.fail("GET"); await store.refresh(); assert.equal(store.view().preferences, before);
  await assert.rejects(store.view().apply(op("blocked")), /not-ready/);
});

for (const options of [{ raw: "{broken" }, { raw: '{"version":9,"buckets":{}}' }, { raw: saved("legacy"), readBlocked: true }]) {
  test(`bad or unreadable legacy cannot create server file: ${JSON.stringify(options)}`, async () => {
    const store = fixture(options); store.view(); await store.refresh();
    assert.equal(store.view().ready, false); assert.ok(store.view().error);
    assert.equal(store.stored.has(MARKER), false);
    await assert.rejects(readFile(path), { code: "ENOENT" });
    store.blockRead(false); store.stored.set(KEY, saved("fixed")); await store.refresh();
    assert.deepEqual(ids(store.view()), ["fixed"]);
  });
}

test("server corruption blocks operations and migration without destroying bytes", async () => {
  await mkdir(join(root, "pi-web")); await writeFile(path, "{broken");
  const store = fixture({ raw: saved("legacy") }); store.view(); await store.refresh();
  assert.equal(store.view().error, "corrupt"); assert.equal(store.view().ready, false);
  assert.equal(store.requests.filter(r => r.method === "POST").length, 0);
  assert.equal(await readFile(path, "utf8"), "{broken");
});

test("persistence failure rejects without optimistic success and requires successful refresh before retry", async () => {
  const store = fixture(); store.view(); await store.refresh();
  await store.view().apply(op("saved")); const before = store.view().preferences;
  store.fail("POST"); await assert.rejects(store.view().apply(op("lost")), /network-failed/);
  assert.equal(store.view().preferences, before); assert.equal(store.view().ready, false); assert.equal(store.view().saving, false);
  assert.deepEqual(ids({ preferences: JSON.parse(await readFile(path, "utf8")) }), ["saved"]);
  store.fail(null); await store.refresh(); await store.view().apply(op("retry"));
  assert.deepEqual(ids(store.view()), ["saved", "retry"]);
});

test("a real server persistence refusal preserves the last confirmed view and recovers after file repair", async () => {
  const store = fixture(); store.view(); await store.refresh(); await store.view().apply(op("saved"));
  const before = store.view().preferences, text = await readFile(path, "utf8");
  await writeFile(path, "{broken-between-read-and-write");
  await assert.rejects(store.view().apply(op("new")), /corrupt/);
  assert.equal(store.view().preferences, before); assert.equal(store.view().ready, false);
  assert.equal(await readFile(path, "utf8"), "{broken-between-read-and-write");
  await writeFile(path, text); await store.refresh(); await store.view().apply(op("new"));
  assert.deepEqual(ids(store.view()), ["saved", "new"]);
});

test("blocked browser storage needs explicit confirmation, then all server operations work without browser storage", async () => {
  const store = fixture({ raw: saved("unknown-backup"), readBlocked: true, writeBlocked: true });
  store.view(); await store.refresh(); await store.refresh();
  assert.equal(store.view().ready, false); assert.equal(store.view().migrationBlocked, true);
  await assert.rejects(store.view().apply(op("blocked")), /not-ready/);
  const reads = store.storageReads;
  await store.view().skipBrowserMigration();
  assert.equal(store.view().ready, true); assert.equal(store.view().migrationBlocked, false);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await store.refresh(); assert.equal(store.storageReads, reads, "confirmation bypasses storage for this page only");
  await store.view().apply(op("server-only")); await store.refresh();
  assert.deepEqual(ids(store.view()), ["server-only"]);
  assert.equal(store.storageReads, reads);
  assert.equal(store.stored.get(KEY), saved("unknown-backup")); assert.equal(store.stored.has(MARKER), false);
  const restarted = fixture({ readBlocked: true }); restarted.view(); await restarted.refresh();
  assert.deepEqual(ids(restarted.view()), ["server-only"]); assert.equal(restarted.storageReads, 0);
});

test("skip confirmation re-reads the server and adopts a concurrent browser import without creating an empty file", async () => {
  const blocked = fixture({ readBlocked: true }); blocked.view(); await blocked.refresh();
  const peer = fixture({ raw: saved("peer") }); peer.view(); await peer.refresh();
  await blocked.view().skipBrowserMigration(); assert.deepEqual(ids(blocked.view()), ["peer"]);
  assert.deepEqual(ids({ preferences: JSON.parse(await readFile(path, "utf8")) }), ["peer"]);
});

test("skip cannot bypass server read failure or corruption and failed confirmation must be retried safely", async () => {
  const store = fixture({ readBlocked: true }); store.fail("GET"); store.view(); await store.refresh();
  assert.equal(store.view().migrationBlocked, false);
  await assert.rejects(store.view().skipBrowserMigration(), /migration-not-blocked/);
  store.fail(null); await store.refresh(); assert.equal(store.view().migrationBlocked, true);
  store.fail("GET"); await assert.rejects(store.view().skipBrowserMigration(), /network-failed/);
  assert.equal(store.view().ready, false); assert.equal(store.view().migrationBlocked, false);
  store.fail(null); await store.refresh();
  await mkdir(join(root, "pi-web")); await writeFile(path, "{broken");
  await assert.rejects(store.view().skipBrowserMigration(), /corrupt/);
  assert.equal(store.view().ready, false); assert.equal(await readFile(path, "utf8"), "{broken");
  await rm(path); await store.refresh(); await store.view().skipBrowserMigration();
  assert.equal(store.view().ready, true);
});

test("skip choice does not mark migration or silently persist across page reloads while the server is absent", async () => {
  const first = fixture({ readBlocked: true }); first.view(); await first.refresh(); await first.view().skipBrowserMigration();
  const next = fixture({ readBlocked: true }); next.view(); await next.refresh();
  assert.equal(next.view().ready, false); assert.equal(next.view().migrationBlocked, true);
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("invalid surrogate in a legacy backup blocks migration instead of crashing a rendered category", async () => {
  const raw = JSON.stringify({ version: 1, buckets: { [bucketKey]: { categories: [{ id: "\ud800", name: "valid" }], assignments: {} } } });
  const store = fixture({ raw }); store.view(); await store.refresh();
  assert.equal(store.view().ready, false); assert.equal(store.view().migrationBlocked, true);
  assert.equal(store.view().error, "migration-invalid"); assert.deepEqual(ids(store.view()), []);
  assert.equal(store.stored.get(KEY), raw); assert.equal(store.stored.has(MARKER), false);
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("migration marker is advisory: deleting the server file may reimport the preserved older backup", async () => {
  const store = fixture({ raw: saved("legacy") }); store.view(); await store.refresh();
  await store.view().apply({ type: "rename", bucketKey, id: "legacy", name: "current" });
  assert.equal(store.stored.get(MARKER), "1");
  await rm(path); await store.refresh();
  assert.equal(store.view().preferences.buckets[bucketKey].categories[0].name, "legacy");
});

test("failed migration marker write warns but never discards the confirmed server data or original backup", async () => {
  const store = fixture({ raw: saved("a"), writeBlocked: true }); store.view(); await store.refresh();
  assert.equal(store.view().ready, true); assert.equal(store.view().error, "migration-marker");
  assert.deepEqual(ids(store.view()), ["a"]); assert.equal(store.stored.get(KEY), saved("a"));
});
