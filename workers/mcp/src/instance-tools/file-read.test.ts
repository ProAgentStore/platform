import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerFileReadTools, INSTANCE_TEXT_MAX_BYTES } from "./file-read.js";
import type { SafetyContext } from "../safety.js";
type Result = { content: Array<{ type: string; text: string }> };
const digest = async (value: string | Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof value === "string" ? new TextEncoder().encode(value) : value)), b => b.toString(16).padStart(2, "0")).join("");
function fixture(fetcher: (url: string, init?: RequestInit) => Promise<Response>, opts: { auth?: boolean; scopes?: SafetyContext["scopes"] } = {}) {
 vi.stubGlobal("fetch", fetcher); let handler!: (args: Record<string, unknown>) => Promise<Result>; let schema!: z.ZodObject<z.ZodRawShape>;
 const env = { API_BASE: "https://api.test" };
 registerFileReadTools({ tool: (_name: string, _description: string, shape: z.ZodRawShape, fn: typeof handler) => { handler = fn; schema = z.object(shape); } } as never, { env, tokenFor: () => opts.auth === false ? null : "session", safetyFor: () => ({ env, scopes: opts.scopes ?? ["read"] }), groups: new Set() });
 return async (input: Record<string, unknown> = {}) => (await handler(schema.parse({ instance_id: "i1", file_id: "f1", ...input }))).content[0].text;
}
const meta = (extra: Record<string, unknown> = {}) => ({ id: "f1", name: "approved-resume.md", mimeType: "text/markdown", size: 12, extractionStatus: "none", r2Key: "PRIVATE/storage-key", r2Version: "v1", ...extra });
const listed = (extra: Record<string, unknown> = {}) => Response.json({ files: [meta(extra)] });
afterEach(() => vi.unstubAllGlobals());
it("reads original generated text despite no extraction, with actual hash and closed provenance", async () => {
 const content = "# Resume\nOwner facts\n"; const sha = await digest(content); const requests: Array<{ url: string; auth: string | null; method: string; redirect?: RequestInit["redirect"] }> = [];
 const read = fixture(async (url, init) => { requests.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization"), method: init?.method ?? "GET", redirect: init?.redirect }); return String(url).endsWith("/files") ? listed({ originalSha256: sha }) : new Response(content, { headers: { "Content-Type": "text/markdown" } }); });
 const result = JSON.parse(await read({ expected_sha256: sha }));
 expect(result).toMatchObject({ content, sha256: sha, source: "original_stored_utf8", provenance: { matchesRegisteredHash: true, metadataR2Version: "v1", extractionStatus: "none" }, page: { nextOffset: null, complete: true } });
 expect(JSON.stringify(result)).not.toContain("PRIVATE");
 expect(requests.map(r => r.url)).toEqual(["https://api.test/v1/instances/i1/files", "https://api.test/v1/instances/i1/files/f1"]);
 expect(requests.every(r => r.auth === "Bearer session" && r.method === "GET")).toBe(true); expect(requests[1].redirect).toBe("manual");
});
it("pages Unicode without splitting pairs and requires the same original hash for continuation", async () => {
 let value = "A😀BC"; const sha = await digest(value);
 const read = fixture(async url => String(url).endsWith("/files") ? listed() : new Response(value, { headers: { "Content-Type": "text/plain" } }));
 const first = JSON.parse(await read({ max_chars: "2" })); expect(first).toMatchObject({ content: "A", page: { nextOffset: 1 } });
 expect(await read({ offset: 1 })).toContain("expected_sha256 is required");
 expect(JSON.parse(await read({ offset: 1, max_chars: 2, expected_sha256: sha }))).toMatchObject({ content: "😀", page: { nextOffset: 3 } });
 expect(await read({ offset: 2, expected_sha256: sha })).toContain("splits a Unicode");
 value = "changed"; expect(JSON.parse(await read({ offset: 3, expected_sha256: sha })).error).toContain("SHA-256 changed");
});
it("refuses registered provenance mismatch without returning file content", async () => {
 const read = fixture(async url => String(url).endsWith("/files") ? listed({ originalSha256: "a".repeat(64) }) : new Response("PRIVATE CONTENT", { headers: { "Content-Type": "text/plain" } }));
 const result = JSON.parse(await read()); expect(result.error).toContain("registered provenance"); expect(JSON.stringify(result)).not.toContain("PRIVATE CONTENT");
});
it.each([401, 404])("owner API refusal (%i) prevents any original-byte fetch", async status => {
 const requests: string[] = []; const read = fixture(async url => { requests.push(String(url)); return Response.json({ error: "Not found" }, { status }); });
 expect(JSON.parse(await read()).error).toBeTruthy(); expect(requests).toHaveLength(1);
});
it("requires auth/read scope and exact instance membership before a download", async () => {
 const spy = vi.fn(async () => listed()); expect(await fixture(spy, { auth: false })()).toContain("authentication required");
 expect(await fixture(spy, { scopes: ["write"] })()).toContain("requires MCP scope"); expect(spy).not.toHaveBeenCalled();
 const read = fixture(spy); expect(await read({ file_id: "another-instance-file" })).toContain("not found on this instance"); expect(spy).toHaveBeenCalledTimes(1);
});
it.each(["metadata", "header", "stream"])("refuses oversize %s truthfully and cancels a streaming body", async kind => {
 let cancelled = false;
 const read = fixture(async url => {
  if (String(url).endsWith("/files")) return listed({ size: kind === "metadata" ? INSTANCE_TEXT_MAX_BYTES + 1 : 1 });
  return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(INSTANCE_TEXT_MAX_BYTES + 1)); }, cancel() { cancelled = true; } }), { headers: { "Content-Type": "text/plain", ...(kind === "header" ? { "Content-Length": String(INSTANCE_TEXT_MAX_BYTES + 1) } : {}) } });
 });
 expect(await read()).toContain("exceeds the 1MiB"); if (kind !== "metadata") expect(cancelled).toBe(true);
});
it.each(["mime", "utf8", "nul"])("refuses %s bytes instead of fabricating extracted text", async kind => {
 const read = fixture(async url => String(url).endsWith("/files") ? listed({ mimeType: kind === "mime" ? "application/pdf" : "text/plain" }) : new Response(kind === "utf8" ? new Uint8Array([255]) : "a\0b", { headers: { "Content-Type": "text/plain" } }));
 expect(await read()).toMatch(/^Error: /);
});
it("rejects redirects and network failures without leaking raw errors or forwarding auth", async () => {
 const requests: string[] = []; const read = fixture(async (url, init) => { requests.push(String(url)); if (String(url).endsWith("/files")) return listed(); expect(init?.redirect).toBe("manual"); return new Response(null, { status: 302, headers: { Location: "https://outside.test/collect" } }); });
 expect(await read()).toContain("API 302"); expect(requests).toHaveLength(2);
 const broken = fixture(async url => { if (String(url).endsWith("/files")) return listed(); throw Error("SECRET network details"); });
 const error = await broken(); expect(error).toMatch(/^Error: original file download failed/); expect(error).not.toContain("SECRET");
});
it("encodes opaque ids and never treats them as external URLs", async () => {
 const urls: string[] = []; const read = fixture(async url => { urls.push(String(url)); return listed({ id: "https://outside.test/a" }); });
 await read({ instance_id: "i/1", file_id: "https://outside.test/a" }); expect(urls.every(url => url.startsWith("https://api.test/v1/instances/i%2F1/"))).toBe(true);
});
