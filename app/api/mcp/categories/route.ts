import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { McpCategoryError, MCP_CATEGORIES_MAX_BYTES, parseMcpCategoriesRequest } from "@/lib/mcp-categories";
import { McpCategoriesFileError, readMcpCategories, updateMcpCategoriesFile } from "@/lib/mcp-categories-file";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const refusal = (reason: string, status: number) => json({ reason, error: `MCP categories: ${reason}` }, status);
function failure(error: unknown) {
  if (error instanceof McpCategoryError) return refusal(error.reason, 409);
  if (error instanceof McpCategoriesFileError) {
    return refusal(error.reason, error.reason === "invalid-request" ? 400 : error.reason === "too-large" ? 413 : error.reason === "unreadable" ? 500 : 409);
  }
  return refusal("internal", 500);
}

export async function GET() {
  try { return json(readMcpCategories()); } catch (error) { return failure(error); }
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal("request-denied", 403);
  if (!hasJsonContentType(req)) return refusal("content-type", 415);
  // Bound streamed bytes too: Content-Length is optional and not trustworthy.
  const maxBytes = MCP_CATEGORIES_MAX_BYTES * 2;
  if (Number(req.headers.get("content-length")) > maxBytes) return refusal("too-large", 413);
  let body: unknown;
  const reader = req.body?.getReader();
  if (!reader) return refusal("invalid-request", 400);
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => {});
        return refusal("too-large", 413);
      }
      chunks.push(value);
    }
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
  } catch { return refusal("invalid-request", 400); }
  finally { reader.releaseLock(); }
  const request = parseMcpCategoriesRequest(body);
  if (!request) return refusal("invalid-request", 400);
  try { return json(await updateMcpCategoriesFile(request)); } catch (error) { return failure(error); }
}
