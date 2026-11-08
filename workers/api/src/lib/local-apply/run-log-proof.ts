/**
 * A Full-mode run's OWN retained native-call log as proof that it sent nothing (#1579).
 *
 * Deliberately conservative: it only ever answers "proven no submission" when the log is complete
 * (retained, nothing dropped, not truncated, no invalid or foreign record, count equals what the
 * runner measured) AND every call is on an allowlist that cannot enter data or run arbitrary code.
 * Any doubt leaves the attempt uncertain. It never clears `submit_attempted_at` or a
 * `submit_unconfirmed` block.
 */
import { type StoredBrowserCall, sanitizeBrowserCall } from "../browser-evidence-contract.js";
import type { JobApplication } from "../local-artifact/store.js";
import type { ApplyRun } from "./store.js";
import type { Env } from "../../types.js";

type DB = Pick<Env, "DB">;

/** Navigation and observation tools, plus click/press_key which are vetted per call below. */
const SAFE_TOOLS = new Set([
	"browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_take_screenshot", "browser_wait_for",
	"browser_find", "find", "browser_click", "browser_press_key", "browser_hover", "browser_tabs", "browser_resize",
	"browser_console_messages", "browser_network_requests",
]);
/** A click that names a final-action control is not provably harmless. */
const FINAL_ACTION = /submit|send|finish|confirm|complete|place|pay|purchase|accept and|agree and/i;
const MAX_CALLS = 2000;

function safeCall(call: StoredBrowserCall): boolean {
	if (!SAFE_TOOLS.has(call.tool)) return false;
	if (call.tool === "browser_click") return typeof call.args.element === "string" && !FINAL_ACTION.test(call.args.element) && !FINAL_ACTION.test(String(call.args.target ?? ""));
	if (call.tool === "browser_press_key") return typeof call.args.key === "string" && !/enter|return|space/i.test(call.args.key);
	return true;
}

const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** True only when this exact run's complete retained log shows no submission was possible. */
export async function runLogProvesNoSubmission(env: DB, uid: string, app: Pick<JobApplication, "id" | "fillRunId" | "submitAttemptedAt">, run: ApplyRun): Promise<boolean> {
	if (run.policy.toolAccess !== "full" || app.fillRunId !== run.id || app.id !== run.applicationId || app.submitAttemptedAt != null) return false;
	const result = record(run.result);
	const native = record(record(result?.executionEvidence)?.nativeCalls);
	if (!result || !native || result.outcome === "submitted" || result.submitAttempted !== false || result.filled !== 0 || !Array.isArray(result.uploaded) || result.uploaded.length !== 0) return false;
	if (native.coverage !== "retained" || native.dropped !== 0 || native.truncated !== false || !Number.isSafeInteger(native.attempted) || (native.attempted as number) < 1 || (native.attempted as number) > MAX_CALLS) return false;

	const target = { userId: uid, instanceId: run.instanceId, subjectKind: "local_apply_run" as const, subjectId: run.id };
	const scope = [uid, run.instanceId, target.subjectKind, run.id];
	const evidence = await env.DB.prepare("SELECT coverage FROM browser_run_evidence WHERE user_id = ?1 AND instance_id = ?2 AND subject_kind = ?3 AND subject_id = ?4").bind(...scope).first<{ coverage: string }>().catch(() => null);
	let coverage: Record<string, unknown> | null = null;
	try { coverage = record(JSON.parse(evidence?.coverage ?? "null")); } catch { /* unreadable stays uncertain */ }
	if (coverage?.status !== "available" || coverage.dropped !== 0 || coverage.priorEpochDropped !== 0 || coverage.invalidRecords !== 0 || coverage.restartObserved !== false || coverage.legacyEpochUnknown !== false || coverage.pageLimitReached !== false) return false;

	const rows = await env.DB.prepare("SELECT record FROM browser_run_calls WHERE user_id = ?1 AND instance_id = ?2 AND subject_kind = ?3 AND subject_id = ?4 ORDER BY id LIMIT ?5").bind(...scope, MAX_CALLS + 1).all<{ record: string }>().catch(() => null);
	if (!rows || rows.results.length > MAX_CALLS) return false;
	let counted = 0;
	for (const row of rows.results) {
		let parsed: unknown;
		try { parsed = JSON.parse(row.record); } catch { return false; }
		const call = sanitizeBrowserCall(parsed, target);
		if (!call) return false;
		// The runner's own count excludes its internal bookkeeping and recovery calls, but those are still vetted.
		if (call.tool === "browser_recover") continue;
		if (!safeCall(call)) return false;
		if (!call.internal) counted++;
	}
	return counted === native.attempted;
}
