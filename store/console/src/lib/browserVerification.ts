/**
 * Browser verification (#1031) — the console's half of `workers/api/src/routes/instances-browser-verification.ts`.
 * The same settings and machine facts MCP's get/set_instance_browser_verification and
 * list_eligible_browser_runtimes read; pure, so the card's sentences are tested here.
 */
export interface BrowserVerificationSettings {
	enabled: boolean;
	runtime: "pinned" | "any_eligible";
	fallback: "wait" | "mark_unverifiable";
	waitLimitMinutes: number;
	takeover: "prompt" | "never";
	allowMobile: boolean;
}

export interface BrowserVerificationView {
	settings: BrowserVerificationSettings;
	capability: { declared: boolean; engine: string | null; detail?: string };
	runnerNode: string | null;
	notificationEvents: string[];
}

export interface BrowserRuntimeMachine {
	node: string;
	aka?: string[];
	pinned: boolean;
	heartbeat: { lastSeenAt: string | null; fresh: boolean };
	attached: boolean;
	health: { state: string; error?: string };
	runnerVersion: string | null;
	eligible: boolean;
	reason?: "not_attached" | "unhealthy" | "runner_too_old" | "not_probed";
	detail?: string;
}

export interface BrowserRuntimesView {
	runtime: BrowserVerificationSettings["runtime"];
	runnerNode: string | null;
	machines: BrowserRuntimeMachine[];
	selected: string | null;
	fallback?: BrowserVerificationSettings["fallback"];
	detail?: string;
}

/** Only what changed, so a save cannot overwrite a field another surface changed meanwhile. */
export function changedFields(saved: BrowserVerificationSettings, form: BrowserVerificationSettings): Partial<BrowserVerificationSettings> {
	const out: Partial<BrowserVerificationSettings> = {};
	for (const k of Object.keys(form) as Array<keyof BrowserVerificationSettings>) {
		if (form[k] !== saved[k]) (out as Record<string, unknown>)[k] = form[k];
	}
	return out;
}

const REASON_WORDS: Record<NonNullable<BrowserRuntimeMachine["reason"]>, string> = {
	not_attached: "agent not attached",
	unhealthy: "connected, runner not answering",
	runner_too_old: "CLI too old",
	not_probed: "not checked",
};

/** One machine as a line on the card: its verdict, then the facts apart (#1032's split). */
export function machineLine(m: BrowserRuntimeMachine): { verdict: string; good: boolean; facts: string } {
	const verdict = m.eligible ? "eligible" : REASON_WORDS[m.reason ?? "not_probed"];
	const facts = [
		`heartbeat ${m.heartbeat.fresh ? "fresh" : "stale"}`,
		m.attached ? "attached (connection only)" : "not attached",
		`health ${m.health.state.replace(/_/g, " ")}`,
		m.runnerVersion ? `CLI ${m.runnerVersion}` : null,
	]
		.filter(Boolean)
		.join(" · ");
	return { verdict, good: m.eligible, facts };
}

export const EVENT_WORDS: Record<string, string> = {
	takeover_required: "a run needs you to take over",
	approval_required: "a run needs your approval",
	browser_verification_failed: "a verification failed",
	browser_verification_completed: "a verification finished",
};
