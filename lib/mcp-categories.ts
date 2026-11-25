/** Display preferences only; never changes MCP configuration or runtime membership. */
export type McpCategory = { id: string; name: string };
export type McpCategoryBucket = { categories: McpCategory[]; assignments: Record<string, string>; collapsed?: string[] };
export type McpCategoryPreferences = { version: 1; buckets: Record<string, McpCategoryBucket> };
export type McpCategoryOperation =
  | { type: "create"; bucketKey: string; id: string; name: string }
  | { type: "rename"; bucketKey: string; id: string; name: string }
  | { type: "delete"; bucketKey: string; id: string }
  | { type: "move"; bucketKey: string; serverName: string; categoryId: string | null }
  | { type: "collapse"; bucketKey: string; id: string; collapsed: boolean };

export class McpCategoryError extends Error {
  constructor(public readonly reason: "invalid-name" | "duplicate-name" | "missing-category" | "invalid-scope") {
    super(reason);
    this.name = "McpCategoryError";
  }
}

export const EMPTY_MCP_CATEGORIES: McpCategoryPreferences = Object.freeze({
  version: 1,
  buckets: Object.freeze({}),
});

/** JSON permits lone UTF-16 surrogates, but URI/DOM identifiers must be encodable. */
export function isMcpCategoryString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
}

function nonblank(value: unknown): value is string {
  return isMcpCategoryString(value) && value.trim().length > 0;
}

export function getMcpCategoryBucketKey(scope: "global" | "project", cwd?: string): string {
  if (scope === "global") return JSON.stringify(["global"]);
  if (scope === "project" && nonblank(cwd)) return JSON.stringify(["project", cwd]);
  throw new McpCategoryError("invalid-scope");
}

function validBucketKey(key: string): boolean {
  try {
    const tuple: unknown = JSON.parse(key);
    return Array.isArray(tuple) && (
      (tuple.length === 1 && tuple[0] === "global") ||
      (tuple.length === 2 && tuple[0] === "project" && nonblank(tuple[1]))
    ) && JSON.stringify(tuple) === key;
  } catch {
    return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedName(value: unknown): string | null {
  if (!isMcpCategoryString(value)) return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= 80 ? name : null;
}

/** Salvage valid entries, including assignments to servers currently removed (Undo). */
export function parseMcpCategories(raw: string | null): McpCategoryPreferences {
  if (raw === null) return EMPTY_MCP_CATEGORIES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed) || parsed.version !== 1 || !record(parsed.buckets)) return EMPTY_MCP_CATEGORIES;
    const buckets: Record<string, McpCategoryBucket> = {};
    for (const [key, value] of Object.entries(parsed.buckets)) {
      if (!validBucketKey(key) || !record(value) || !Array.isArray(value.categories) || !record(value.assignments)) continue;
      const categories: McpCategory[] = [];
      const ids = new Set<string>();
      const names = new Set<string>();
      for (const candidate of value.categories) {
        if (!record(candidate) || !nonblank(candidate.id)) continue;
        const name = normalizedName(candidate.name);
        if (name === null || ids.has(candidate.id) || names.has(name)) continue;
        ids.add(candidate.id);
        names.add(name);
        categories.push({ id: candidate.id, name });
      }
      const assignments = Object.fromEntries(Object.entries(value.assignments).filter(
        ([server, id]) => nonblank(server) && typeof id === "string" && ids.has(id),
      )) as Record<string, string>;
      const collapsed = Array.isArray(value.collapsed)
        ? [...new Set(value.collapsed.filter((id): id is string => typeof id === "string" && (id === "" || ids.has(id))))] : undefined;
      buckets[key] = { categories, assignments, ...(collapsed ? { collapsed } : {}) };
    }
    return Object.keys(buckets).length ? { version: 1, buckets } : EMPTY_MCP_CATEGORIES;
  } catch {
    return EMPTY_MCP_CATEGORIES;
  }
}

export const MCP_CATEGORIES_MAX_BYTES = 256 * 1024;
export type McpCategoriesRequest =
  | { version: 1; operation: McpCategoryOperation }
  | { version: 1; action: "import"; preferences: McpCategoryPreferences };
export type McpCategoriesResponse = { exists: boolean; preferences: McpCategoryPreferences; imported?: boolean };

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function identifier(value: unknown): value is string {
  return nonblank(value) && value.length <= 4096 && !value.includes("\0");
}

/** Strict at the server boundary: malformed/unknown versions must never become an empty file. */
export function validateMcpCategories(value: unknown): value is McpCategoryPreferences {
  if (!record(value) || value.version !== 1 || !record(value.buckets) || !keys(value, ["version", "buckets"])) return false;
  for (const [key, bucket] of Object.entries(value.buckets)) {
    if (key.length > 8192 || !validBucketKey(key) || !record(bucket) || !keys(bucket, ["categories", "assignments", "collapsed"]) ||
      !Array.isArray(bucket.categories) || !record(bucket.assignments)) return false;
    const ids = new Set<string>(), names = new Set<string>();
    for (const category of bucket.categories) {
      if (!record(category) || !keys(category, ["id", "name"]) || !identifier(category.id) ||
        normalizedName(category.name) !== category.name || typeof category.name !== "string" || ids.has(category.id) || names.has(category.name)) return false;
      ids.add(category.id); names.add(category.name);
    }
    if (Object.entries(bucket.assignments).some(([name, id]) => !identifier(name) || typeof id !== "string" || !ids.has(id))) return false;
    if (bucket.collapsed !== undefined && (!Array.isArray(bucket.collapsed) ||
      bucket.collapsed.some(id => typeof id !== "string" || (id !== "" && !ids.has(id))) || new Set(bucket.collapsed).size !== bucket.collapsed.length)) return false;
  }
  return true;
}

export function hasMcpCategoryData(value: McpCategoryPreferences): boolean {
  return Object.values(value.buckets).some(bucket => bucket.categories.length > 0 || (bucket.collapsed?.length ?? 0) > 0);
}

export function parseMcpCategoriesRequest(value: unknown): McpCategoriesRequest | null {
  if (!record(value) || value.version !== 1) return null;
  if (value.action === "import") {
    return keys(value, ["version", "action", "preferences"]) && validateMcpCategories(value.preferences)
      ? value as McpCategoriesRequest : null;
  }
  if (!keys(value, ["version", "operation"]) || !record(value.operation)) return null;
  const op = value.operation;
  if (typeof op.bucketKey !== "string" || op.bucketKey.length > 8192 || !validBucketKey(op.bucketKey)) return null;
  const base = ["type", "bucketKey"];
  switch (op.type) {
    case "create": case "rename":
      if (!keys(op, [...base, "id", "name"]) || !identifier(op.id) || normalizedName(op.name) === null) return null;
      break;
    case "delete":
      if (!keys(op, [...base, "id"]) || !identifier(op.id)) return null;
      break;
    case "move":
      if (!keys(op, [...base, "serverName", "categoryId"]) || !identifier(op.serverName) || (op.categoryId !== null && !identifier(op.categoryId))) return null;
      break;
    case "collapse":
      if (!keys(op, [...base, "id", "collapsed"]) || (op.id !== "" && !identifier(op.id)) || typeof op.collapsed !== "boolean") return null;
      break;
    default: return null;
  }
  return value as McpCategoriesRequest;
}

export function categoryForServer(bucket: McpCategoryBucket, name: string): string | null {
  if (!Object.hasOwn(bucket.assignments, name)) return null;
  const id = bucket.assignments[name];
  return bucket.categories.some(category => category.id === id) ? id : null;
}

/** All validation happens before returning a new bucket; untouched buckets retain identity. */
export function updateMcpCategories(state: McpCategoryPreferences, operation: McpCategoryOperation): McpCategoryPreferences {
  const { bucketKey } = operation;
  if (!validBucketKey(bucketKey)) throw new McpCategoryError("invalid-scope");
  const bucket = Object.hasOwn(state.buckets, bucketKey)
    ? state.buckets[bucketKey] : { categories: [], assignments: {} };
  let categories = bucket.categories;
  let assignments = bucket.assignments;
  let collapsed = bucket.collapsed;
  const hasCategory = (id: string) => nonblank(id) && categories.some(category => category.id === id);
  if (operation.type === "collapse") {
    if (operation.id !== "" && !hasCategory(operation.id)) throw new McpCategoryError("missing-category");
    const next = new Set(collapsed ?? []);
    if (operation.collapsed) next.add(operation.id); else next.delete(operation.id);
    collapsed = [...next];
  } else if (operation.type === "move") {
    if (operation.categoryId !== null && !hasCategory(operation.categoryId)) throw new McpCategoryError("missing-category");
    if (!nonblank(operation.serverName)) throw new McpCategoryError("invalid-name");
    assignments = { ...assignments };
    if (operation.categoryId === null) delete assignments[operation.serverName];
    else Object.defineProperty(assignments, operation.serverName, {
      value: operation.categoryId, enumerable: true, configurable: true, writable: true,
    });
  } else {
    if (!nonblank(operation.id)) throw new McpCategoryError("missing-category");
    const exists = hasCategory(operation.id);
    if ((operation.type === "create" && exists) || (operation.type !== "create" && !exists)) {
      throw new McpCategoryError("missing-category");
    }
    if (operation.type === "delete") {
      categories = categories.filter(category => category.id !== operation.id);
      collapsed = collapsed?.filter(id => id !== operation.id);
      assignments = Object.fromEntries(Object.entries(assignments).filter(([, id]) => id !== operation.id));
    } else {
      const name = normalizedName(operation.name);
      if (name === null) throw new McpCategoryError("invalid-name");
      if (categories.some(category => category.name === name && category.id !== operation.id)) throw new McpCategoryError("duplicate-name");
      categories = operation.type === "create"
        ? [...categories, { id: operation.id, name }]
        : categories.map(category => category.id === operation.id ? { id: category.id, name } : category);
    }
  }
  return { version: 1, buckets: { ...state.buckets, [bucketKey]: { categories, assignments, ...(collapsed ? { collapsed } : {}) } } };
}
