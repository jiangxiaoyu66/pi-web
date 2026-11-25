import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./web-auth.ts");
}

function authorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

// Synchronous and restored even on assertion failure; no real host password
// reaches a test assertion or log, and no production auth code is changed.
function withPassword(password, check) {
  const previous = process.env.PI_WEB_PASSWORD;
  try {
    if (password === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = password;
    check();
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previous;
  }
}

test("enables password authentication only for a non-empty configured password", async () => {
  const { isWebPasswordEnabled, isValidBasicAuthorization } = await loadSubject();
  for (const configured of [undefined, "", "fixture-password"]) {
    withPassword(configured, () => {
      const enabled = configured === "fixture-password";
      // Omission and explicit undefined both use the environment default.
      assert.equal(isWebPasswordEnabled(), enabled);
      assert.equal(isWebPasswordEnabled(undefined), enabled);
      assert.equal(isWebPasswordEnabled(""), false);
      assert.equal(isWebPasswordEnabled("secret"), true);
      const valid = authorization("pi", "fixture-password");
      assert.equal(isValidBasicAuthorization(valid), enabled);
      assert.equal(isValidBasicAuthorization(valid, undefined), enabled);
      assert.equal(isValidBasicAuthorization(valid, ""), false);
      assert.equal(isValidBasicAuthorization(authorization("pi", "wrong")), false);
    });
  }
});

test("accepts only the fixed pi username and configured password", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  assert.equal(isValidBasicAuthorization(authorization("pi", "secret"), "secret"), true);
  assert.equal(isValidBasicAuthorization(authorization("admin", "secret"), "secret"), false);
  assert.equal(isValidBasicAuthorization(authorization("pi", "wrong"), "secret"), false);
});

test("supports UTF-8 passwords and colons in the password", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  const password = "口令:with:colons";
  assert.equal(isValidBasicAuthorization(authorization("pi", password), password), true);
});

test("rejects missing, malformed, and non-canonical authorization values", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  const valid = authorization("pi", "secret");

  assert.equal(isValidBasicAuthorization(null, "secret"), false);
  assert.equal(isValidBasicAuthorization("Bearer token", "secret"), false);
  assert.equal(isValidBasicAuthorization("Basic !!!", "secret"), false);
  assert.equal(isValidBasicAuthorization(`${valid}!`, "secret"), false);
  assert.equal(isValidBasicAuthorization(
    `Basic ${Buffer.from("missing-separator", "utf8").toString("base64")}`,
    "secret",
  ), false);
});

test("does not authenticate when password protection is disabled", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  assert.equal(isValidBasicAuthorization(authorization("pi", ""), ""), false);
  withPassword(undefined, () => {
    assert.equal(isValidBasicAuthorization(authorization("pi", "secret"), undefined), false);
  });
});

test("creates signed sessions that expire and cannot be altered", async () => {
  const {
    createWebSessionToken,
    isValidWebSessionToken,
    PI_WEB_SESSION_MAX_AGE,
  } = await loadSubject();
  const now = Date.UTC(2026, 8, 7);
  const token = createWebSessionToken("secret", now, "a".repeat(32));

  assert.equal(isValidWebSessionToken(token, "secret", now), true);
  assert.equal(isValidWebSessionToken(token, "wrong", now), false);
  assert.equal(isValidWebSessionToken(`${token.slice(0, -1)}0`, "secret", now), false);
  assert.equal(isValidWebSessionToken(token, "secret", now + PI_WEB_SESSION_MAX_AGE * 1000), false);
});
