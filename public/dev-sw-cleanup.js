// Development-only entry from fresh HTML. A previous production worker can
// otherwise keep serving cached development chunks even after a page refresh.
(() => {
  if (!("serviceWorker" in navigator)) return;
  const isOwnWorker = (worker) => {
    if (!worker) return false;
    const url = new URL(worker.scriptURL, location.origin);
    return url.origin === location.origin && url.pathname === "/sw.js";
  };
  void (async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const own = registrations.filter((registration) =>
      registration.scope === location.origin + "/" &&
      [registration.active, registration.waiting, registration.installing].some(isOwnWorker)
    );
    if (own.length === 0) return;
    const controlled = isOwnWorker(navigator.serviceWorker.controller);
    const removed = await Promise.all(own.map((registration) => registration.unregister()));
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith("pi-web-static-")).map((key) => caches.delete(key)));
      }
    } finally {
      // unregister() doesn't release this document's controller. One navigation
      // is needed; the next document has no registration, so it cannot loop.
      if (controlled && removed.some(Boolean)) location.reload();
    }
  })().catch(() => { /* Restricted browser storage must not break startup. */ });
})();
