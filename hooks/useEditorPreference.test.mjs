import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync(new URL("./useEditorPreference.ts", import.meta.url), "utf8");
// Keep the store tests runnable with Node alone, including during dependency recovery.
const script = new Script(stripTypeScriptTypes(source
  .replace(/^import .*;$/gm, "")
  .replace(/export (const|function) /g, "$1 ")
  + "\nObject.assign(exports, { useEditorPreference, setEditorPreference });"));
const KEY = "pi-web:editor";
function fixture({ initial = null, blocked = false, server = false } = {}) {
  let value = initial;
  let unsubscribe;
  let notifications = 0;
  const events = new Map();
  const exports = {};
  script.runInNewContext({
    exports,
    useSyncExternalStore(subscribe, snapshot, ssr) {
      if (server) return ssr();
      unsubscribe ??= subscribe(() => notifications++);
      return snapshot();
    },
    ...(!server && { window: {
      localStorage: {
        getItem(key) { assert.equal(key, KEY); if (blocked) throw Error("blocked"); return value; },
        setItem(key, next) { assert.equal(key, KEY); if (blocked) throw Error("blocked"); value = next; },
      },
      addEventListener(type, cb) { events.set(type, cb); },
      removeEventListener(type) { events.delete(type); },
    } }),
  });
  return { ...exports, events, get value() { return value; }, get notifications() { return notifications; },
    external(next, key = KEY) { value = next; events.get("storage")?.({ key }); },
    unmount() { unsubscribe?.(); unsubscribe = null; },
  };
}

test("SSR and an unchosen or invalid editor never silently select an application", () => {
  assert.equal(fixture({ server: true }).useEditorPreference(), null);
  for (const initial of [null, "", "evil", "VSCode"]) assert.equal(fixture({ initial }).useEditorPreference(), null);
});
test("selection persists, notifies same-page consumers and follows other tabs", () => {
  const f = fixture();
  assert.equal(f.useEditorPreference(), null);
  f.setEditorPreference("cursor");
  assert.equal(f.useEditorPreference(), "cursor");
  assert.equal(f.value, "cursor");
  assert.equal(f.notifications, 1);
  f.external("vscode", "unrelated");
  assert.equal(f.useEditorPreference(), "cursor");
  f.external("vscode");
  assert.equal(f.useEditorPreference(), "vscode");
  f.external(null, null);
  assert.equal(f.useEditorPreference(), null);
  f.unmount();
  assert.equal(f.events.size, 0);
});
test("blocked storage still remembers the page's choice after remount", () => {
  const f = fixture({ blocked: true });
  f.useEditorPreference();
  f.setEditorPreference("cursor");
  f.unmount();
  assert.equal(f.useEditorPreference(), "cursor");
});
