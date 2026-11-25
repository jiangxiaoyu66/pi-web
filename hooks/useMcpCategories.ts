import { useSyncExternalStore } from "react";
import { createMcpCategoriesClient } from "../lib/mcp-categories-client";
export { MCP_CATEGORIES_STORAGE_KEY } from "../lib/mcp-categories-client";

const client = createMcpCategoriesClient({
  fetch: (...args) => fetch(...args),
  storage: () => window.localStorage,
});
let subscriptions = 0;
const onFocus = () => { void client.refresh(); };
const onVisibility = () => { if (document.visibilityState === "visible") onFocus(); };
function subscribe(listener: () => void): () => void {
  const unsubscribe = client.subscribe(listener);
  if (++subscriptions === 1) {
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    void client.refresh();
  }
  return () => {
    unsubscribe();
    if (--subscriptions === 0) {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

export const refreshMcpCategories = client.refresh;

export function useMcpCategories() {
  const current = useSyncExternalStore(subscribe, client.getSnapshot, client.getServerSnapshot);
  return { ...current, apply: client.apply, refresh: client.refresh, skipBrowserMigration: client.skipBrowserMigration };
}
