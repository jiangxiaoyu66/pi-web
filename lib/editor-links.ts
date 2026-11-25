/** Client-side desktop protocol links, not filesystem access or proof of locality. */
export type Editor = "vscode" | "cursor";
export interface EditorTarget {
  path?: string | null;
  cwd?: string;
  isDirectory?: boolean;
}

export function isEditor(value: unknown): value is Editor {
  return value === "vscode" || value === "cursor";
}

/** Strict filesystem paths only. Never interpret a supplied string as a URI. */
export function resolveEditorPath({ path, cwd }: EditorTarget): string | null {
  if (!path || /[\x00-\x1f\x7f]/.test(path) || path.startsWith("~")) return null;
  const windows = /^[a-z]:[\\/]/i.test(path) || !!cwd && /^[a-z]:[\\/]/i.test(cwd);
  const slashes = (value: string) => windows ? value.replace(/\\/g, "/") : value;
  const raw = slashes(path);
  // UNC/network targets and device namespaces are outside same-machine support.
  if (raw.startsWith("//") || path.startsWith("\\\\")) return null;
  const drive = /^[a-z]:\//i.test(raw);
  if (!drive && /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  // A POSIX absolute path under a Windows cwd has no unambiguous drive.
  if (windows && raw.startsWith("/") && !drive) return null;
  const absolute = drive || raw.startsWith("/");
  let base: string | null = null;
  if (!absolute) {
    base = cwd ? resolveEditorPath({ path: cwd }) : null;
    if (!base) return null;
    if (raw.includes("\\") && !windows) return null;
  }
  const candidate = absolute ? raw : `${base}/${raw}`;
  const root = /^[a-z]:\//i.test(candidate) ? candidate.slice(0, 2).toUpperCase() : "";
  const parts: string[] = [];
  for (const part of candidate.slice(root.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  const resolved = `${root}/${parts.join("/")}`;
  if (base) {
    const compare = (value: string) => windows ? value.toLowerCase() : value;
    const boundary = compare(base).replace(/\/$/, "");
    if (compare(resolved) !== boundary && !compare(resolved).startsWith(`${boundary}/`)) return null;
  }
  // Invalid surrogate sequences cannot be safely represented in a protocol URI.
  try { encodeURIComponent(resolved); } catch { return null; }
  return resolved;
}

export function editorUri(editor: Editor, target: EditorTarget): string | null {
  if (!isEditor(editor)) return null;
  const path = resolveEditorPath(target);
  if (!path) return null;
  const encoded = path.split("/").map((part, index) => index === 0 && /^[A-Z]:$/.test(part)
    ? part : encodeURIComponent(part)).join("/");
  return `${editor}://file${encoded.startsWith("/") ? "" : "/"}${encoded}${target.isDirectory && !encoded.endsWith("/") ? "/" : ""}${target.isDirectory ? "?windowId=_blank" : ""}`;
}
