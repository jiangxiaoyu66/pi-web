// Reuse a password-protected local development server without disabling auth.
// Never print credentials, use them outside loopback, or record auth-bearing traces.
function loopbackOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("E2E credentials may only be sent to a loopback server");
  }
  return url.origin;
}

export function localBrowserAuth(base) {
  const origin = loopbackOrigin(base);
  const password = process.env.PI_WEB_PASSWORD;
  return password ? { httpCredentials: { username: "pi", password, origin, send: "always" } } : {};
}

// Call before installing route fixtures or starting a trace. The real login
// endpoint sets a session cookie in this isolated context; no user config changes.
export async function authenticateLocalContext(context, base) {
  loopbackOrigin(base);
  if (!process.env.PI_WEB_PASSWORD) return;
  const response = await context.request.post(`${new URL(base).origin}/api/web-auth`, {
    data: { password: process.env.PI_WEB_PASSWORD },
    maxRedirects: 0,
  });
  if (!response.ok()) throw new Error(`Local E2E login failed: HTTP ${response.status()}`);
}

export async function localServerFetch(url, init = {}) {
  loopbackOrigin(url);
  const headers = new Headers(init.headers);
  if (process.env.PI_WEB_PASSWORD) {
    headers.set("Authorization", `Basic ${Buffer.from(`pi:${process.env.PI_WEB_PASSWORD}`).toString("base64")}`);
  }
  // Refuse redirects rather than risk forwarding a credential to another origin.
  return fetch(url, { ...init, headers, redirect: "error" });
}
