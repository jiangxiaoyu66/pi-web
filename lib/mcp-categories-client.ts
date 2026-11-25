import {
  EMPTY_MCP_CATEGORIES, McpCategoryError, hasMcpCategoryData, validateMcpCategories,
  type McpCategoryOperation, type McpCategoryPreferences, type McpCategoriesRequest, type McpCategoriesResponse,
} from "./mcp-categories";

export const MCP_CATEGORIES_STORAGE_KEY = "pi-web:mcp-categories";
export const MCP_CATEGORIES_MIGRATED_KEY = `${MCP_CATEGORIES_STORAGE_KEY}:migrated`;
export type McpCategoriesSnapshot = {
  preferences: McpCategoryPreferences;
  loading: boolean;
  ready: boolean;
  saving: boolean;
  error: string | null;
  storageUnavailable: boolean;
  /** Only true after a successful absent-file GET and a blocked/invalid legacy read. */
  migrationBlocked: boolean;
};
export const MCP_CATEGORIES_SERVER_SNAPSHOT: McpCategoriesSnapshot = {
  preferences: EMPTY_MCP_CATEGORIES, loading: true, ready: false, saving: false, error: null, storageUnavailable: false, migrationBlocked: false,
};

/** One instance per page; factory also models independent browsers in tests. No optimistic writes. */
export function createMcpCategoriesClient(options: {
  fetch: typeof fetch;
  storage: () => Pick<Storage, "getItem" | "setItem">;
}) {
  let snapshot = MCP_CATEGORIES_SERVER_SNAPSHOT;
  const listeners = new Set<() => void>();
  let tail: Promise<unknown> = Promise.resolve();
  let refreshing: Promise<void> | null = null;
  // Explicit, page-lifetime user decision. No browser write or empty server file
  // is required; a reload asks again if the server is still absent.
  let skipLegacyMigration = false;
  const publish = (patch: Partial<McpCategoriesSnapshot>) => {
    const next = { ...snapshot, ...patch };
    if (JSON.stringify(next.preferences) === JSON.stringify(snapshot.preferences)) next.preferences = snapshot.preferences;
    if (Object.keys(next).every(key => next[key as keyof McpCategoriesSnapshot] === snapshot[key as keyof McpCategoriesSnapshot])) return;
    snapshot = next;
    listeners.forEach(listener => listener());
  };
  const enqueue = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
  async function request(body?: McpCategoriesRequest): Promise<McpCategoriesResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await options.fetch("/api/mcp/categories", {
        method: body ? "POST" : "GET", cache: "no-store", signal: controller.signal,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const value = await response.json();
      if (!response.ok) {
        if (["invalid-name", "duplicate-name", "missing-category", "invalid-scope"].includes(value.reason)) throw new McpCategoryError(value.reason);
        throw new Error(typeof value.reason === "string" ? value.reason : "request-failed");
      }
      if (typeof value.exists !== "boolean" || !validateMcpCategories(value.preferences)) throw new Error("invalid-response");
      return value;
    } finally { clearTimeout(timer); }
  }
  const failed = (error: unknown, migrationBlocked = false) => publish({ loading: false, saving: false, ready: false,
    error: error instanceof Error ? error.message : "request-failed", storageUnavailable: true, migrationBlocked });

  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing;
    refreshing = enqueue(async () => {
      publish({ loading: true, ready: false, migrationBlocked: false });
      let migrationBlocked = false;
      try {
        let result = await request();
        let warning: string | null = null;
        if (!result.exists && !skipLegacyMigration) {
          // Do not silently discard unknown legacy data. A blocked/invalid read
          // needs explicit UI confirmation before bypassing migration.
          migrationBlocked = true;
          const raw = options.storage().getItem(MCP_CATEGORIES_STORAGE_KEY);
          if (raw !== null) {
            let legacy: unknown;
            try { legacy = JSON.parse(raw); } catch { throw new Error("migration-invalid"); }
            if (!validateMcpCategories(legacy)) throw new Error("migration-invalid");
            migrationBlocked = false;
            if (hasMcpCategoryData(legacy)) {
              result = await request({ version: 1, action: "import", preferences: legacy });
              // A competing import may have won. Its response is authoritative; never replace it.
              if (result.imported === true) {
                try { options.storage().setItem(MCP_CATEGORIES_MIGRATED_KEY, "1"); }
                catch { warning = "migration-marker"; }
              }
            }
          }
        }
        publish({ preferences: result.preferences, loading: false, ready: true, error: warning, storageUnavailable: warning !== null, migrationBlocked: false });
      } catch (error) { failed(error, migrationBlocked); }
    }).finally(() => { refreshing = null; });
    return refreshing;
  };
  /** Called only by the explicit confirmation UI, never as an error fallback. */
  const skipBrowserMigration = (): Promise<void> => {
    if (!snapshot.migrationBlocked || snapshot.loading) return Promise.reject(new Error("migration-not-blocked"));
    return enqueue(async () => {
      if (!snapshot.migrationBlocked || snapshot.loading) throw new Error("migration-not-blocked");
      publish({ loading: true, ready: false, migrationBlocked: false });
      try {
        // Re-read: another client may have imported, or the file may now be
        // corrupt/unreadable. Confirmation must not bypass server read errors.
        const result = await request();
        skipLegacyMigration = true;
        publish({ preferences: result.preferences, loading: false, ready: true, error: null, storageUnavailable: false, migrationBlocked: false });
      } catch (error) { failed(error); throw error; }
    });
  };
  const apply = (operation: McpCategoryOperation): Promise<void> => {
    if (!snapshot.ready) return Promise.reject(new Error("categories-not-ready"));
    return enqueue(async () => {
      if (!snapshot.ready) throw new Error("categories-not-ready");
      publish({ saving: true });
      try {
        const result = await request({ version: 1, operation });
        publish({ preferences: result.preferences, saving: false, error: null, storageUnavailable: false });
      } catch (error) { failed(error); throw error; }
    });
  };
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => MCP_CATEGORIES_SERVER_SNAPSHOT,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh, apply, skipBrowserMigration,
  };
}
