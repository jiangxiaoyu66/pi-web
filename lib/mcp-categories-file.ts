import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { serializeByKey } from "./key-serializer";
import {
  EMPTY_MCP_CATEGORIES, MCP_CATEGORIES_MAX_BYTES, hasMcpCategoryData,
  parseMcpCategoriesRequest, updateMcpCategories, validateMcpCategories,
  type McpCategoriesResponse,
} from "./mcp-categories";

export class McpCategoriesFileError extends Error {
  constructor(public readonly reason: "invalid-request" | "unreadable" | "corrupt" | "too-large" | "locked") {
    super(`MCP categories: ${reason}`);
  }
}

export function getMcpCategoriesPath(): string {
  return join(getAgentDir(), "pi-web", "mcp-categories.json");
}

function readAt(path: string): McpCategoriesResponse {
  // Do not replace a dotfiles link or mistake a dangling link for absent data.
  try {
    if (!lstatSync(path).isFile()) throw new McpCategoriesFileError("unreadable");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, preferences: EMPTY_MCP_CATEGORIES };
    throw new McpCategoriesFileError("unreadable");
  }
  // Same bounded, nonblocking regular-file pattern as regular-file.ts, but keep
  // bytes until fatal UTF-8 decoding: its text API replaces malformed bytes.
  let bytes: Buffer;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0));
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > MCP_CATEGORIES_MAX_BYTES) throw new McpCategoriesFileError("unreadable");
    const buffer = Buffer.alloc(MCP_CATEGORIES_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MCP_CATEGORIES_MAX_BYTES) throw new McpCategoriesFileError("unreadable");
    bytes = buffer.subarray(0, length);
  } catch { throw new McpCategoriesFileError("unreadable"); }
  finally { if (fd !== undefined) closeSync(fd); }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new McpCategoriesFileError("corrupt"); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new McpCategoriesFileError("corrupt"); }
  if (!validateMcpCategories(parsed)) throw new McpCategoriesFileError("corrupt");
  return { exists: true, preferences: parsed };
}

/** No cache: a restarted process or independent client sees the same file. GET never creates it. */
export function readMcpCategories(): McpCategoriesResponse {
  return readAt(getMcpCategoriesPath());
}

/** Lock + fresh read + incremental change + atomic replace. Import is conditional inside the same lock. */
export async function updateMcpCategoriesFile(input: unknown): Promise<McpCategoriesResponse> {
  const request = parseMcpCategoriesRequest(input);
  if (!request) throw new McpCategoriesFileError("invalid-request");
  const configured = getMcpCategoriesPath();
  mkdirSync(dirname(configured), { recursive: true, mode: 0o700 });
  const path = join(realpathSync(dirname(configured)), "mcp-categories.json");
  return serializeByKey(Symbol.for("pi-web:mcp-categories-write-queue"), path, async () => {
    let compromised = false;
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(path, {
        realpath: false,
        // No lease expiry: a stopped event loop must never lose this lock and
        // resume its synchronous commit over a successor. proper-lockfile keeps
        // Infinity through its stale normalization; finite update avoids an
        // overflowing timer. Contract + SIGSTOP tests pin this package behavior.
        // A SIGKILL/crash can leave a lock: remove it ONLY with all writers stopped
        // (docs/agents/mcp-settings.md). Never mix timed-expiry writers on this file.
        stale: Infinity,
        update: 1000,
        retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
        onCompromised: () => { compromised = true; },
      });
    } catch { throw new McpCategoriesFileError("locked"); }
    try {
      const current = readAt(path);
      if ("action" in request && (current.exists || !hasMcpCategoryData(request.preferences))) {
        return { ...current, imported: false };
      }
      const preferences = "action" in request ? request.preferences : updateMcpCategories(current.preferences, request.operation);
      const text = JSON.stringify(preferences, null, 2) + "\n";
      if (Buffer.byteLength(text) > MCP_CATEGORIES_MAX_BYTES) throw new McpCategoriesFileError("too-large");
      if (compromised) throw new McpCategoriesFileError("locked");
      if (!current.exists || JSON.stringify(current.preferences) !== JSON.stringify(preferences)) writePrivateFileAtomicSync(path, text);
      return { exists: true, preferences, ...("action" in request ? { imported: true } : {}) };
    } finally { await release(); }
  });
}
