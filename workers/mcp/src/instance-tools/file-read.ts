/** #1504: original private file text, independent of extraction/indexing; no URL or local-path input. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiBase, authRequired, authedCall, jsonText, text } from "../http.js";
import { apiRequestIdForCall, noteUpstreamStatus } from "../call-audit.js";
import { requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

export const INSTANCE_TEXT_MAX_BYTES = 1024 * 1024;
const object = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const bounded = (v: unknown, max = 512) => typeof v === "string" && v.length <= max ? v : null;
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/i.test(v) ? v.toLowerCase() : null;
const textType = (v: unknown) => typeof v === "string" && /^(text\/[^;]+|application\/(?:json|xml|yaml|x-yaml|toml))(?:;|$)/i.test(v);
async function boundedBytes(response: Response): Promise<Uint8Array | null> {
 if (!response.body) return new Uint8Array();
 const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
 try {
  while (true) {
   const part = await reader.read(); if (part.done) break;
   length += part.value.byteLength;
   if (length > INSTANCE_TEXT_MAX_BYTES) { await reader.cancel().catch(() => undefined); return null; }
   chunks.push(part.value);
  }
 } finally { reader.releaseLock(); }
 const bytes = new Uint8Array(length); let offset = 0;
 for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
 return bytes;
}
export function registerFileReadTools(server: McpServer, ctx: InstanceToolsCtx): void {
 const { env, tokenFor, safetyFor } = ctx;
 server.tool("read_instance_file", "Read original UTF-8 text from one owner's private instance file, including generated Markdown with extractionStatus none. Uses the stored file id, never a URL/local path or credential API. Returns complete bounded text pages and actual SHA-256 plus closed metadata provenance. Max file 1MiB; binary/invalid UTF-8/oversize files are explicitly refused. Offsets count UTF-16 code units; use nextOffset and the returned sha256 as expected_sha256 for continuation to reject changed files. No extraction, indexing, writes or browser actions.", {
  token: z.string().optional(), instance_id: z.string().min(1).max(200), file_id: z.string().min(1).max(200),
  offset: z.coerce.number().int().min(0).max(INSTANCE_TEXT_MAX_BYTES).optional().describe("UTF-16 code-unit offset. Omit for first page; copy nextOffset for continuation."),
  max_chars: z.coerce.number().int().min(2).max(6000).optional().describe("Maximum UTF-16 code units per page, default6000; may return one fewer to preserve a surrogate pair."),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional().describe("Expected SHA-256 of the complete original bytes. Required when offset>0; use returned sha256 to prevent mixing versions."),
 }, async ({ token, instance_id, file_id, offset = 0, max_chars = 6000, expected_sha256 }) => {
  const session = tokenFor(token); if (!session) return authRequired();
  const denied = await requirePermission(safetyFor(token), "read", "read_instance_file", { instance_id, file_id }); if (denied) return denied;
  if (offset > 0 && !expected_sha256) return text("Error: expected_sha256 is required for continuation; use the first page's sha256.");
  const listed = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/files`, session, {}, env);
  const listing = object(listed); if (!listing || "error" in listing) return jsonText(listed);
  const meta = Array.isArray(listing.files) ? listing.files.map(object).find(f => f?.id === file_id) : null;
  if (!meta) return text("Error: file not found on this instance.");
  if (!textType(meta.mimeType)) return text("Error: file is not a supported original UTF-8 text format; binary extraction is not performed by this reader.");
  if (typeof meta.size === "number" && meta.size > INSTANCE_TEXT_MAX_BYTES) return text("Error: original file exceeds the 1MiB text-read limit; no partial file was returned.");
  const requestId = apiRequestIdForCall();
  try {
   const response = await fetch(`${apiBase(env)}/v1/instances/${encodeURIComponent(instance_id)}/files/${encodeURIComponent(file_id)}`, { redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${session}`, "X-PAGS-Client": "mcp", ...(requestId ? { "X-Request-Id": requestId } : {}) } });
   if (!response.ok) { noteUpstreamStatus(response.status); return text(`Error: original file unavailable (API ${response.status}).`); }
   if (!textType(response.headers.get("Content-Type"))) { await response.body?.cancel().catch(() => undefined); return text("Error: original download is not a supported UTF-8 text format."); }
   if (Number(response.headers.get("Content-Length")) > INSTANCE_TEXT_MAX_BYTES) { await response.body?.cancel().catch(() => undefined); return text("Error: original file exceeds the 1MiB text-read limit; no partial file was returned."); }
   const bytes = await boundedBytes(response);
   if (!bytes) return text("Error: original file exceeds the 1MiB text-read limit; no partial file was returned.");
   const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
   const registeredSha256 = hash(meta.originalSha256);
   if (expected_sha256 && expected_sha256.toLowerCase() !== sha256) return jsonText({ error: "Original file SHA-256 changed or does not match the selected file; no content returned.", instanceId: instance_id, fileId: file_id, sha256 });
   if (registeredSha256 && registeredSha256 !== sha256) return jsonText({ error: "Original bytes do not match their registered provenance; no content returned.", instanceId: instance_id, fileId: file_id, sha256, registeredSha256 });
   let content: string;
   try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return text("Error: original file is not valid UTF-8; no replacement or partial text returned."); }
   if (content.includes("\0")) return text("Error: original file contains binary NUL bytes; no text returned.");
   if (offset > content.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(content[offset] ?? "") && /[\uD800-\uDBFF]/.test(content[offset - 1]))) return text("Error: offset is outside the text or splits a Unicode character; use nextOffset.");
   let end = Math.min(content.length, offset + max_chars);
   if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]) && /[\uDC00-\uDFFF]/.test(content[end])) end--;
   return jsonText({ instanceId: instance_id, fileId: file_id, name: bounded(meta.name), mimeType: bounded(meta.mimeType, 150), source: "original_stored_utf8", bytes: bytes.byteLength, sha256,
    provenance: { metadataSource: "owner_scoped_file_list", registeredSha256, matchesRegisteredHash: registeredSha256 ? true : null, metadataR2Version: bounded(meta.r2Version), metadataR2Etag: bounded(meta.r2Etag), extractionStatus: bounded(meta.extractionStatus, 30), updatedAt: bounded(meta.updatedAt, 50) },
    page: { offset, endOffset: end, nextOffset: end < content.length ? end : null, totalCodeUnits: content.length, complete: end === content.length, unit: "UTF-16 code units" },
    // Explicit page boundaries above account for every omitted character; never silently cut a file.
    content: content.slice(offset, end),
   });
  } catch { return text("Error: original file download failed or timed out; no partial content returned."); }
 });
}
