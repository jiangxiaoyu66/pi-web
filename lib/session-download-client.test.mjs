import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { downloadSession } from "./session-download-client.ts";

afterEach(() => { delete globalThis.window; delete globalThis.document; });

test("both formats prompt first, share directory memory and save the requested bytes", async t => {
  const ids = new Set();
  for (const format of ["md", "jsonl"]) {
    const events = [];
    globalThis.window = { async showSaveFilePicker({ id, suggestedName }) {
      ids.add(id);
      events.push(suggestedName);
      return { createWritable: () => new WritableStream({ write(bytes) { events.push(new TextDecoder().decode(bytes)); } }) };
    } };
    t.mock.method(globalThis, "fetch", async url => { events.push(url); return new Response("内容"); });
    await downloadSession("row 1", format, "?");
    assert.deepEqual(events, [`row 1.${format}`, `/api/sessions/row%201/download?format=${format}`, "内容"]);
  }
  assert.equal(ids.size, 1);
  assert.ok([...ids][0]);
});

test("cancelling either prompt sends no request; picker failures are not cancellations", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("unexpected request"));
  globalThis.window = { showSaveFilePicker() { throw new DOMException("", "AbortError"); } };
  await downloadSession("row", "md", "?");
  globalThis.window = { confirm: () => false };
  await downloadSession("row", "jsonl", "?");
  globalThis.window = { showSaveFilePicker() { throw new Error("permission denied"); } };
  await assert.rejects(downloadSession("row", "md", "?"), /permission denied/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("confirmed fallback downloads a blob, never an HTTP error", async t => {
  globalThis.window = { confirm: message => message === "Confirm?" };
  const link = { click: t.mock.fn() };
  globalThis.document = { createElement: () => link };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const revoke = t.mock.method(URL, "revokeObjectURL", () => {});
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("# Transcript"));
  await downloadSession("row", "md", "Confirm?");
  assert.equal(link.download, "row.md");
  assert.match(link.href, /^blob:/);
  t.mock.timers.runAll();
  assert.equal(revoke.mock.calls[0].arguments[0], link.href);
  fetch.mock.mockImplementation(async () => Response.json({ error: "Not found" }, { status: 404 }));
  await assert.rejects(downloadSession("row", "md", "Confirm?"), /Not found/);
  assert.equal(link.click.mock.callCount(), 1);
});
