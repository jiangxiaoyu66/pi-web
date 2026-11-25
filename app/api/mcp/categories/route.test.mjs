import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";
const root = await mkdtemp(join(tmpdir(), "pi-categories-route-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { GET, POST } = await jiti.import("./route.ts");
const path = join(root, "pi-web", "mcp-categories.json");
const operation = { type: "create", bucketKey: '["global"]', id: "a", name: "Tools" };
const body = { version: 1, operation };
async function post(value, headers = {}) {
  return POST(new Request("http://localhost/api/mcp/categories", { method: "POST", headers: { host: "localhost", "content-type": "application/json", ...headers }, body: typeof value === "string" || value instanceof Uint8Array ? value : JSON.stringify(value) }));
}
beforeEach(async () => { await rm(join(root, "pi-web"), { force: true, recursive: true }); });
after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });

test("GET is no-store, missing is distinct from existing and POST returns persisted state", async () => {
  let response = await GET();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).exists, false);
  response = await post(body); assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.exists, true);
  assert.deepEqual(saved.preferences, JSON.parse(await readFile(path, "utf8")));
  assert.deepEqual(await (await GET()).json(), saved);
});

for (const [headers, status] of [[{ origin: "https://evil.invalid" }, 403], [{ host: "evil.invalid" }, 403], [{ "content-type": "text/plain" }, 415]]) {
  test(`request guards: ${JSON.stringify(headers)}`, async () => {
    assert.equal((await post(body, headers)).status, status);
    await assert.rejects(readFile(path), { code: "ENOENT" });
  });
}
for (const value of ["{", null, [], {}, { ...body, version: 2 }, { ...body, extra: 1 },
  { version: 1, preferences: { version: 1, buckets: {} } },
  ...[{ type: "unknown" }, { bucketKey: "bad" }, { name: " " }, { name: "x".repeat(81) }, { id: 42 }, { extra: true }].map(patch => ({ version: 1, operation: { ...operation, ...patch } })),
  { version: 1, operation: { type: "collapse", bucketKey: '["global"]', id: "", collapsed: "true" } },
  { version: 1, operation: { type: "move", bucketKey: '["global"]', serverName: "s", categoryId: 1 } },
  { version: 1, action: "import", preferences: { version: 9, buckets: {} } },
  ...["\ud800", "\udc00"].flatMap(bad => [
    { ...body, operation: { ...operation, id: bad } },
    { ...body, operation: { ...operation, name: bad } },
    { ...body, operation: { ...operation, bucketKey: JSON.stringify(["project", `/bad-${bad}`]) } },
    { version: 1, operation: { type: "move", bucketKey: operation.bucketKey, serverName: bad, categoryId: null } },
    { version: 1, action: "import", preferences: { version: 1, buckets: { [operation.bucketKey]: { categories: [{ id: bad, name: "valid" }], assignments: {} } } } },
  ]),
]) {
  test(`invalid request is rejected without writing: ${JSON.stringify(value).slice(0, 140)}`, async () => {
    assert.equal((await post(value)).status, 400);
    await assert.rejects(readFile(path), { code: "ENOENT" });
  });
}

test("bounds actual streamed body and declared Content-Length", async () => {
  assert.equal((await post(body, { "content-length": "999999" })).status, 413);
  assert.equal((await post(JSON.stringify({ padding: "x".repeat(524288) }))).status, 413);
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

for (const invalid of [[0xff], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80]]) {
  test(`invalid UTF-8 request bytes are rejected without writes: ${invalid}`, async () => {
    const raw = Buffer.concat([Buffer.from('{"version":1,"operation":{"type":"create","bucketKey":"[\\"global\\"]","id":"a","name":"'), Buffer.from(invalid), Buffer.from('"}}')]);
    const response = await post(raw);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).reason, "invalid-request");
    await assert.rejects(readFile(path), { code: "ENOENT" });
  });
}

test("valid multibyte UTF-8 split across request chunks remains readable", async () => {
  const bytes = Buffer.from(JSON.stringify({ ...body, operation: { ...operation, name: "研究🧪" } }));
  const response = await POST(new Request("http://localhost/api/mcp/categories", {
    method: "POST", headers: { host: "localhost", "content-type": "application/json" }, duplex: "half",
    body: new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).preferences.buckets[operation.bucketKey].categories[0].name, "研究🧪");
});

test("corrupt GET/POST surface a safe error and do not overwrite", async () => {
  await mkdir(join(root, "pi-web")); await writeFile(path, "{SECRET");
  for (const response of [await GET(), await post(body), await post({ version: 1, action: "import", preferences: { version: 1, buckets: {} } })]) {
    assert.equal(response.status, 409);
    const error = await response.json(); assert.equal(error.reason, "corrupt");
    assert.ok(!JSON.stringify(error).includes("SECRET"));
  }
  assert.equal(await readFile(path, "utf8"), "{SECRET");
});

test("increment conflicts use 409, no snapshot replacement endpoint", async () => {
  await post(body);
  assert.equal((await post(body)).status, 409);
  assert.equal((await post({ version: 1, operation: { type: "create", bucketKey: '["global"]', id: "b", name: "Tools" } })).status, 409);
});
