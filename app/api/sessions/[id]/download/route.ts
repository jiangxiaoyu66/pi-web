import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { contentDisposition } from "@/lib/content-disposition";
import { getRpcSession } from "@/lib/rpc-manager";
import { branchMarkdown, markdownFromDisk, readDownloadHeader } from "@/lib/session-download";
import { resolveSessionPath } from "@/lib/session-reader";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const format = new URL(req.url).searchParams.get("format");
  if (format !== "md" && format !== "jsonl") return Response.json({ error: "Expected format=md or jsonl" }, { status: 400 });
  const { id } = await params;
  const headers = {
    "Content-Type": `${format === "md" ? "text/markdown" : "application/x-ndjson"}; charset=utf-8`,
    "Content-Disposition": contentDisposition("attachment", `pi-session-${id}.${format}`, `session.${format}`),
    "Cache-Control": "private, no-store, no-transform",
    "X-Content-Type-Options": "nosniff",
  };
  const notFound = () => Response.json({ error: "Session not found" }, { status: 404 });
  const liveWrapper = () => {
    const rpc = getRpcSession(id);
    return rpc?.isAlive() ? rpc : undefined;
  };
  let file: FileHandle | undefined;
  try {
    const path = (format === "md" ? liveWrapper()?.sessionFile : undefined) || await resolveSessionPath(id);
    if (!path) {
      const rpc = format === "md" ? liveWrapper() : undefined;
      return rpc && !rpc.sessionFile ? new Response(branchMarkdown(rpc.inner.sessionManager), { headers }) : notFound();
    }
    // Nonblocking open lets us reject FIFOs without waiting for a writer.
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || !await readDownloadHeader(file, stat.size, id)) return notFound();
    if (format === "md") {
      const rpc = liveWrapper();
      if (rpc?.isRunning()) return new Response(branchMarkdown(rpc.inner.sessionManager), { headers });
      const text = await file.readFile("utf8"); // header probes use explicit offsets
      const markdown = markdownFromDisk(text, latestId => {
        const wrapper = liveWrapper();
        const manager = wrapper?.inner.sessionManager;
        // Match force-refresh's disk-ahead test, but don't evict any wrapper.
        if (wrapper && !wrapper.isRunning() && latestId && !manager?.getEntry(latestId)) return undefined;
        return manager;
      });
      return new Response(markdown, { headers });
    }
    // The stream owns the validated descriptor, including on cancellation.
    const stream = file.createReadStream({ start: 0, end: stat.size - 1 });
    const response = new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers });
    file = undefined;
    return response;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return notFound();
    return Response.json({ error: "Session download failed" }, { status: 500 });
  } finally {
    await file?.close();
  }
}
