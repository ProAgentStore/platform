import type { Hono, Context } from "hono";
import type { Env } from "../types.js";
import { HttpError, requireUser } from "../lib/auth.js";
import { isBrowserArtifactSubject, subjectBelongsTo } from "../lib/browser-artifacts.js";
import { BROWSER_EVIDENCE_TIMEOUT_MS, listBrowserCalls, readBrowserState, refreshBrowserEvidence, type EvidenceFetch } from "../lib/browser-evidence.js";
import type { BrowserEvidenceTarget } from "../lib/browser-evidence-contract.js";
import { callRuntime, getLiveRuntime, requireOwnedInstance } from "./instances-runtime.js";

export type BrowserEvidenceFetcher = (env: Env, target: BrowserEvidenceTarget) => Promise<EvidenceFetch | null>;
const nativeFetcher: BrowserEvidenceFetcher = async (env, target) => {
 const runtime = await getLiveRuntime(env, target.instanceId, target.userId).catch(() => null);
 return runtime ? (path, body) => callRuntime(env, runtime, path, { method: "POST", body: JSON.stringify(body) }, { timeoutMs: BROWSER_EVIDENCE_TIMEOUT_MS }) : null;
};
export function registerBrowserEvidenceRoutes(router: Hono<{ Bindings: Env }>, fetcher: BrowserEvidenceFetcher = nativeFetcher): void {
 const handler = (kind: "calls" | "state") => async (c: Context<{ Bindings: Env }>) => {
  const { uid } = await requireUser(c); const instanceId = c.req.param("instanceId") ?? "";
  await requireOwnedInstance(c.env, instanceId, uid);
  const subjectKind = c.req.query("subject_kind"); const subjectId = c.req.query("subject_id");
  if (!isBrowserArtifactSubject(subjectKind) || !subjectId) throw new HttpError(400, "subject_kind and subject_id are required");
  const target = { userId: uid, instanceId, subjectKind, subjectId };
  if (!(await subjectBelongsTo(c.env, uid, instanceId, subjectKind, subjectId))) throw new HttpError(404, "Browser run not found");
  const refresh = c.req.query("refresh") !== "false";
  if (refresh) await refreshBrowserEvidence(c.env, target, await fetcher(c.env, target));
  const result = kind === "calls" ? await listBrowserCalls(c.env, target, c.req.query("cursor"), Number(c.req.query("limit") ?? 25)) : await readBrowserState(c.env, target, refresh);
  return c.json(result, 200, { "Cache-Control": "no-store" });
 };
 router.get("/:instanceId/browser-runs/calls", handler("calls"));
 router.get("/:instanceId/browser-runs/state", handler("state"));
}
