import { isBrowserCallSubjectKind } from "./browser-call-recorder.js";
import type { LocalRunner } from "./runner.js";
import { RunnerInputError } from "./errors.js";

/** Both reads stay within the requested run and authenticated relay instance; neither selects a page. */
export async function browserObservation(runner: LocalRunner, path: string, raw: unknown, caller?: string): Promise<unknown> {
 const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
 const nested = body.subject && typeof body.subject === "object" ? body.subject as Record<string, unknown> : {};
 const kind = body.subjectKind ?? nested.kind, id = body.subjectId ?? nested.id;
 if (!isBrowserCallSubjectKind(kind) || typeof id !== "string" || !id.trim() || id.length > 300) throw new RunnerInputError("A browser subjectKind and subjectId are required");
 const afterSeq = typeof body.afterSeq === "number" && Number.isSafeInteger(body.afterSeq) && body.afterSeq >= 0 ? body.afterSeq : 0;
 const limit = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.max(1, Math.min(100, Math.floor(body.limit))) : 100;
 if (path === "/browser-state") {
  if (kind === "runtime_task") return runner.browserState(id);
  return kind === "local_apply_run" ? runner.localApply.browserState(id, caller) : runner.localBrowser.browserState(id, caller);
 }
 const page = kind === "runtime_task" ? await runner.browserCalls(id, afterSeq, limit) : kind === "local_apply_run" ? runner.localApply.browserCalls(id, afterSeq, caller, limit) : runner.localBrowser.browserCalls(id, afterSeq, caller, limit);
 return { ...page, subject: { kind, id } };
}
