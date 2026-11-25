import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticateLocalContext, localBrowserAuth, localServerFetch } from "../e2e/local-server-auth.mjs";

function password(t, value) {
  const previous = process.env.PI_WEB_PASSWORD;
  if (value === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = value;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previous;
  });
}

test("local E2E auth is scoped to the exact loopback origin", t => {
  password(t, "fixture-only");
  assert.deepEqual(localBrowserAuth("http://127.0.0.1:30141/"), {
    httpCredentials: { username: "pi", password: "fixture-only", origin: "http://127.0.0.1:30141", send: "always" },
  });
  assert.throws(() => localBrowserAuth("https://example.invalid"), /loopback/);
});

test("local E2E fetch preserves headers and refuses redirects", async t => {
  password(t, "fixture-only");
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.get("Accept"), "application/json");
    assert.equal(options.headers.get("Authorization"), `Basic ${Buffer.from("pi:fixture-only").toString("base64")}`);
    return new Response("{}");
  });
  await localServerFetch("http://localhost:30141/api/sessions", { headers: { Accept: "application/json" } });
  await assert.rejects(localServerFetch("https://example.invalid"), /loopback/);
});

test("local browser login uses the real same-origin endpoint without redirects", async t => {
  password(t, "fixture-only");
  const context = { request: { post: async (url, options) => {
    assert.equal(url, "http://localhost:30141/api/web-auth");
    assert.equal(options.maxRedirects, 0);
    assert.deepEqual(options.data, { password: "fixture-only" });
    return { ok: () => true };
  } } };
  await authenticateLocalContext(context, "http://localhost:30141");
  await assert.rejects(authenticateLocalContext(context, "https://example.invalid"), /loopback/);
  await assert.rejects(authenticateLocalContext({ request: { post: async () => ({ ok: () => false, status: () => 401 }) } }, "http://localhost:30141"), /HTTP 401/);
});

test("unprotected local servers need no credentials", t => {
  password(t, undefined);
  assert.deepEqual(localBrowserAuth("http://[::1]:30141"), {});
});
