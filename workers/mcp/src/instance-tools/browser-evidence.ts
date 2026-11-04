import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiBase, authRequired, authedCall, jsonText, text } from "../http.js";
import { apiRequestIdForCall, noteUpstreamStatus } from "../call-audit.js";
import { requirePermission } from "../safety.js";
import { WIRE_LIMIT_BYTES, WIRE_BUDGET_BYTES, wireBytes } from "../wire-budget.js";
import type { InstanceToolsCtx } from "./shared.js";

/** Browser evidence only. Refresh collects retained diagnostics; it never dispatches a browser action. */
export function registerBrowserEvidenceTools(server: McpServer, ctx: InstanceToolsCtx): void {
 const { env, tokenFor, safetyFor } = ctx;
 const address = { token: z.string().optional(), instance_id: z.string() };
 const subject = { ...address, subject_kind: z.enum(["runtime_task", "local_apply_run", "local_browser_run"]), subject_id: z.string() };
 const pagination = { cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(25).optional() };
 const refresh = z.boolean().optional().describe("Default true pulls read-only retained diagnostics, even for ended runs. False reads cloud storage only; no browser is launched or resumed.");
 const readEvidence = async (name: string, endpoint: string, args: { token?: string; instance_id: string; subject_kind: string; subject_id: string; cursor?: string; limit?: number; refresh?: boolean }) => {
  const { token, instance_id, subject_kind, subject_id, cursor, limit, refresh } = args;
  const session = tokenFor(token); if (!session) return authRequired();
  const denied = await requirePermission(safetyFor(token), "read", name, { instance_id, subject_kind, subject_id }); if (denied) return denied;
  const query = new URLSearchParams({ subject_kind, subject_id });
  if (endpoint !== "browser-runs/state") query.set("limit", String(limit ?? 25));
  if (cursor) query.set("cursor", cursor); if (refresh !== undefined) query.set("refresh", String(refresh));
  const requestPage = () => endpoint === "browser-runs/calls"
   ? authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/browser-runs/calls?${query}`, session, {}, env)
   : endpoint === "browser-runs/state"
    ? authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/browser-runs/state?${query}`, session, {}, env)
    : authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/browser-artifacts?${query}`, session, {}, env);
  let result = await requestPage();
  // Re-read a smaller durable page, never truncate records or lose the server's continuation cursor.
  while (endpoint !== "browser-runs/state" && wireBytes(JSON.stringify(result)) > WIRE_BUDGET_BYTES && Number(query.get("limit")) > 1) {
   query.set("limit", String(Math.max(1, Math.floor(Number(query.get("limit")) / 2))));
   if (endpoint === "browser-runs/calls") query.set("refresh", "false");
   result = await requestPage();
  }
  if (wireBytes(JSON.stringify(result)) > WIRE_LIMIT_BYTES) return text("Error: one retained evidence record exceeds this MCP client's text limit; evidence remains stored. No records were skipped.");
  return jsonText(result);
 };
 server.tool("browser_run_calls", "Read a run's ordered native calls, redacted arguments, outcomes and bounded errors. Check coverage: drops, restarts, invalid records and old-runner route refusal are explicit. An empty page never proves no action occurred. Refresh only retains diagnostics; no actions are replayed.", { ...subject, ...pagination, refresh }, args => readEvidence("browser_run_calls", "browser-runs/calls", args));
 server.tool("browser_run_state", "Read subject-bound native/MCP tab selection, pending chooser and observed dialog state. No tab selection, navigation or resume. Unavailable sources preserve the last captured snapshot and timestamp; old runners may not support state.", { ...subject, refresh }, args => readEvidence("browser_run_state", "browser-runs/state", args));
 server.tool("browser_run_screenshots", "List stored screenshots with capture timestamps, URL/action/target captions and pagination. Capture disabled and empty replay are distinct. Use browser_run_screenshot for actual pixels. Does not capture a new screenshot.", { ...subject, ...pagination }, args => readEvidence("browser_run_screenshots", "browser-artifacts", args));
 server.tool("browser_run_screenshot", "View one actual retained browser screenshot as MCP image content with its stored metadata. Owner, instance and original run are checked by the API. Pixels preserve the run's configured blur setting; this read neither takes a new screenshot nor changes privacy settings.", { ...address, artifact_id: z.string().describe("An artifact id returned by browser_run_screenshots.") }, async ({ token, instance_id, artifact_id }) => {
  const session = tokenFor(token); if (!session) return authRequired();
  const denied = await requirePermission(safetyFor(token), "read", "browser_run_screenshot", { instance_id, artifact_id }); if (denied) return denied;
  const path = `/v1/instances/${encodeURIComponent(instance_id)}/browser-artifacts/${encodeURIComponent(artifact_id)}`;
  const metadata = await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/browser-artifacts/${encodeURIComponent(artifact_id)}?metadata=true`, session, {}, env);
  if (!metadata || typeof metadata !== "object" || "error" in metadata) return jsonText(metadata);
  const requestId = apiRequestIdForCall();
  const response = await fetch(`${apiBase(env)}${path}`, { redirect: "error", signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${session}`, "X-PAGS-Client": "mcp", ...(requestId ? { "X-Request-Id": requestId } : {}) } });
  if (!response.ok) { noteUpstreamStatus(response.status); return text(`Error: screenshot unavailable (API ${response.status}).`); }
  const mimeType = response.headers.get("Content-Type")?.split(";")[0] ?? "";
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) return text("Error: screenshot response was not an image.");
  if (Number(response.headers.get("Content-Length") ?? 0) > 768 * 1024) return text("Error: screenshot exceeds the image limit.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 768 * 1024) return text("Error: screenshot is empty or exceeds the image limit.");
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return { content: [{ type: "text" as const, text: JSON.stringify(metadata) }, { type: "image" as const, data: btoa(binary), mimeType }] };
 });
}
