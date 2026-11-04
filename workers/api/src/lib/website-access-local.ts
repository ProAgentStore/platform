/** Website questions for retained local browser runs; answering never starts another run. */
import type { Env } from "../types.js";
import { deepLinkFor } from "./console-links.js";
import { ensureWebsiteAccessRequest, listWebsiteDomainDecisions } from "./website-access.js";
import type { ApplyRun } from "./local-apply/store.js";
import type { LocalBrowserRun } from "./local-browser/store.js";
import { normalizeDomain } from "./local-browser/policy.js";

export interface WebsitePause { hostname: string; pauseKey: string; url?: string }
type ResumeWebsitePause<T> = (run: T, pause: WebsitePause, decision: "allow" | "deny") => Promise<T>;
export function parseWebsitePause(raw: unknown): WebsitePause | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const value = raw as Record<string, unknown>;
	const hostname = normalizeDomain(value.hostname);
	if (!hostname || typeof value.pauseKey !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.pauseKey)) return null;
	return { hostname, pauseKey: value.pauseKey };
}

export function applyWebsitePause(run: ApplyRun): WebsitePause | null {
	if (run.status !== "paused" || run.pause?.reason !== "external_redirect") return null;
	return parseWebsitePause({ hostname: run.pause.domain, pauseKey: run.pause.handoffRequestId });
}

/** A persisted agent-wide decision also releases another run waiting on the same website. */
async function rememberedDecision(env: Env, uid: string, instanceId: string, hostname: string, domains: string[]) {
	if (domains.includes(hostname)) return "allow" as const;
	return (await listWebsiteDomainDecisions(env, uid, instanceId)).find((item) => item.hostname === hostname)?.decision;
}

export async function syncApplyWebsiteQuestion(env: Env, uid: string, run: ApplyRun, resume: ResumeWebsitePause<ApplyRun>): Promise<ApplyRun> {
	const policy = run.policy.browserWebsiteAccess;
	const pause = applyWebsitePause(run);
	if (policy?.mode !== "ask_once" || !pause) return run;
	const decision = await rememberedDecision(env, uid, run.instanceId, pause.hostname, policy.domains);
	if (decision) {
		return resume(run, pause, decision);
	}
	await ensureWebsiteAccessRequest(env, {
		userId: uid, instanceId: run.instanceId, subjectKind: "local_apply_run", subjectId: run.id,
		hostname: pause.hostname, pauseKey: pause.pauseKey,
		subjectLink: deepLinkFor({ kind: "application", instanceId: run.instanceId, applicationId: run.applicationId }),
	});
	return run;
}

export async function syncResearchWebsiteQuestion(env: Env, uid: string, run: LocalBrowserRun, rawPause: unknown, resume: ResumeWebsitePause<LocalBrowserRun>, resumeKnown = true): Promise<LocalBrowserRun> {
	const policy = run.policy.browserWebsiteAccess;
	const pause = parseWebsitePause(rawPause);
	if (policy?.mode !== "ask_once" || run.status !== "paused" || run.pauseReason !== "consent_required" || !pause) return run;
	const decision = await rememberedDecision(env, uid, run.instanceId, pause.hostname, policy.domains);
	if (decision) {
		// Event ingestion may still be followed by reconciliation of the same old paused status.
		// Only that reconciliation's final step can resume without restoring stale paused state.
		if (!resumeKnown) return run;
		return resume(run, pause, decision);
	}
	await ensureWebsiteAccessRequest(env, {
		userId: uid, instanceId: run.instanceId, subjectKind: "local_browser_run", subjectId: run.id,
		hostname: pause.hostname, pauseKey: pause.pauseKey,
		subjectLink: deepLinkFor({ kind: "local-browser-run", instanceId: run.instanceId, runId: run.id }),
	});
	return run;
}
