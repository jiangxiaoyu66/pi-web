import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const DEV_SERVICE_WORKER_CLEANUP_SCRIPT = await readFile(new URL("../public/dev-sw-cleanup.js", import.meta.url), "utf8");

async function run({ registrations = [], controller = null, keys = [], fail = false, cacheFail = false } = {}) {
  const calls = { removed: [], deleted: [], reloads: 0 };
  const mapped = registrations.map(({ script = "/sw.js?v=0.17.0", scope = "http://localhost/", active = true, result = true }, index) => ({
    scope, [active ? "active" : "waiting"]: { scriptURL: new URL(script, "http://localhost").href },
    unregister: async () => { calls.removed.push(index); return result; },
  }));
  vm.runInNewContext(DEV_SERVICE_WORKER_CLEANUP_SCRIPT, {
    navigator: { serviceWorker: { controller: controller ? { scriptURL: controller } : null, getRegistrations: async () => { if (fail) throw Error("denied"); return mapped; } } },
    location: { origin: "http://localhost", reload: () => { calls.reloads++; } },
    window: { caches: {} }, URL,
    caches: { keys: async () => { if (cacheFail) throw Error("cache denied"); return keys; }, delete: async (key) => { calls.deleted.push(key); return true; } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return calls;
}

test("development releases only Pi Web root worker and cached assets, then reloads once", async () => {
  const result = await run({ registrations: [{}], controller: "http://localhost/sw.js?v=0.17.0", keys: ["pi-web-static-0.17.0", "pi-web-user-data", "another-cache"] });
  assert.deepEqual(result, { removed: [0], deleted: ["pi-web-static-0.17.0"], reloads: 1 });
  assert.deepEqual(await run(), { removed: [], deleted: [], reloads: 0 });
});
test("does not unregister other workers/scopes or wipe their caches", async () => {
  assert.deepEqual(await run({ registrations: [{ script: "/other.js" }, { scope: "http://localhost/other/" }], controller: "http://localhost/other.js", keys: ["pi-web-static-old"] }), { removed: [], deleted: [], reloads: 0 });
});
test("waiting workers and failed unregistration never reload an uncontrolled document", async () => {
  assert.equal((await run({ registrations: [{ active: false }] })).reloads, 0);
  assert.equal((await run({ registrations: [{ result: false }], controller: "http://localhost/sw.js" })).reloads, 0);
});
test("cache access failure still releases an unregistered controller through navigation", async () => {
  assert.equal((await run({ registrations: [{}], controller: "http://localhost/sw.js", cacheFail: true })).reloads, 1);
});
test("restricted storage and missing service worker do not crash startup", async () => {
  assert.deepEqual(await run({ fail: true }), { removed: [], deleted: [], reloads: 0 });
  vm.runInNewContext(DEV_SERVICE_WORKER_CLEANUP_SCRIPT, { navigator: {} });
});
test("cleanup is delivered in HTML only in development, independent of cached React chunks", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /process\.env\.NODE_ENV === "development"/);
  assert.match(layout, /src="\/dev-sw-cleanup\.js" async/);
});
