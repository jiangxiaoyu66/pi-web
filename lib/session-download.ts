import type { FileHandle } from "node:fs/promises";
import { migrateSessionEntries, parseSessionEntries, SessionManager, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { skillExpansionToCommand } from "./slash-display";

export async function readDownloadHeader(file: FileHandle, size: number, id: string): Promise<SessionHeader | null> {
  // A header is small metadata; don't buffer the transcript to reject an invalid file.
  const limit = Math.min(size, 64 * 1024);
  const prefix = Buffer.alloc(limit);
  let length = 0;
  while (length < limit) {
    const { bytesRead } = await file.read(prefix, length, Math.min(4096, limit - length), length);
    if (!bytesRead) return null;
    const newline = prefix.subarray(length, length + bytesRead).indexOf(10);
    length += newline < 0 ? bytesRead : newline;
    if (newline >= 0 || length === size) {
      try {
        const header = JSON.parse(prefix.toString("utf8", 0, length)) as SessionHeader | null;
        return header?.type === "session" && header.id === id ? header : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function markdownFromDisk(text: string, live: (latestId?: string) => SessionManager | undefined): string {
  const entries = parseSessionEntries(text).filter(entry => entry && typeof entry === "object");
  const header = entries.find(entry => entry.type === "session");
  const latest = entries.findLast(entry => entry.type !== "session" && typeof entry.id === "string" && entry.id);
  const liveManager = live(latest?.id);
  if (liveManager) return branchMarkdown(liveManager);
  migrateSessionEntries(entries);
  return branchMarkdown(SessionManager.inMemory(header?.cwd, undefined, entries));
}

export function branchMarkdown(sm: SessionManager): string {
  const sections: string[] = [];
  for (const entry of sm.getBranch()) {
    // Only user/assistant messages count, so a side boundary doesn't remove the inherited branch.
    if (entry.type !== "message" || !entry.message) continue;
    const { role } = entry.message;
    if (role !== "user" && role !== "assistant") continue;
    const { content } = entry.message;
    let text = typeof content === "string" ? content : Array.isArray(content)
      ? content.flatMap(block => block?.type === "text" && typeof block.text === "string" ? [block.text] : []).join(role === "user" ? "\n" : "\n\n")
      : "";
    if (role === "user") {
      text = text.replace(/\r\n?/g, "\n");
      text = skillExpansionToCommand(text) ?? text;
    }
    if (text.trim()) sections.push(`## ${role === "user" ? "User" : "Assistant"}\n\n${text}\n`);
  }
  return sections.join("\n");
}
