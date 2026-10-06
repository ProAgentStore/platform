/**
 * Local CLI browser research: the wire contract between PAGS and the runner (#943, #945, #944).
 *
 * PAGS supervises a general agent; a Codex or Claude Code CLI signed in on the owner's machine
 * drives the runner's browser. This file is everything that crosses the relay: the task envelope
 * PAGS sends, the events the runner reports while it works, and the result envelope it returns.
 *
 * ── Why it is a file pair, not a package import
 *
 * The Worker and the runner each typecheck with `rootDir: "src"`, so neither can import the
 * other's source, and the runner ships inside the published CLI. The repo's answer to that is to
 * vendor (root CLAUDE.md, "Vendor, don't depend"). This file is therefore kept BYTE-IDENTICAL at
 *
 *   workers/api/src/lib/local-browser/contract.ts
 *   packages/browser-runner/src/local-browser/contract.ts
 *
 * and `local-browser-contract-copy.test.ts` fails the moment the two differ. Edit both together.
 * It must stay dependency-free (no imports) for the same reason.
 */

/**
 * The runner task type, and the runner endpoints PAGS calls.
 *
 * PULL, not push (#944): the relay carries only cloud→runner commands and their replies, and the
 * runner process holds no API token. So the runner keeps each run's events and result, and PAGS
 * reads them with `status` — when a run is read and from the per-minute cron.
 */
export const LOCAL_BROWSER_TASK_TYPE = "local_browser.research";
export const LOCAL_BROWSER_RUN_PATH = "/local-browser/run";
export const LOCAL_BROWSER_CANCEL_PATH = "/local-browser/cancel";
export const LOCAL_BROWSER_STATUS_PATH = "/local-browser/status";
export const LOCAL_BROWSER_RESUME_PATH = "/local-browser/resume";

export type LocalBrowserEngine = "claude" | "codex";
export const LOCAL_BROWSER_ENGINES: readonly LocalBrowserEngine[] = ["claude", "codex"];

/**
 * How the task engine signs in. `subscription` and `machine` never put a provider API key in the
 * engine's environment; `api-key` is the only per-token mode and is refused for an agent that
 * declares `subscriptionOnly` (the default).
 */
export type LocalBrowserAuthMode = "subscription" | "machine" | "api-key";
export const LOCAL_BROWSER_AUTH_MODES: readonly LocalBrowserAuthMode[] = ["subscription", "machine", "api-key"];

/** Only research ships first (#947): navigate, read, extract. No submissions, messages or purchases. */
export type LocalBrowserMode = "research_only";
export const LOCAL_BROWSER_MODES: readonly LocalBrowserMode[] = ["research_only"];

/** Where the CLI runs. Never a repository: a managed per-run scratch dir, or a home-relative path. */
export type LocalBrowserWorkspace = { kind: "scratch" } | { kind: "path"; path: string };

/** `isolated` = a throwaway profile; `default` = the owner's signed-in profile (needs consent). */
export type LocalBrowserProfile = "isolated" | "default";

export interface LocalBrowserLimits {
	maxMinutes: number;
	maxPages: number;
	maxActions: number;
	maxConcurrent: number;
}

export interface LocalBrowserResultSchema {
	id: string;
	version: number;
}

/** What PAGS sends the runner to start one run. Carries no credential of any kind. */
export interface LocalBrowserTaskEnvelope {
	type: typeof LOCAL_BROWSER_TASK_TYPE;
	runId: string;
	/** The caller's idempotency key: a retried start with the same id is the same run. */
	requestId: string;
	instanceId: string;
	objective: string;
	engine: LocalBrowserEngine;
	authMode: LocalBrowserAuthMode;
	workspace: LocalBrowserWorkspace;
	browserProfile: LocalBrowserProfile;
	policy: {
		mode: LocalBrowserMode;
		/** Empty = any public site, each new domain behind a consent pause. */
		allowDomains: string[];
		/** Always wins over an allow entry. */
		denyDomains: string[];
		/** Domains the owner has already consented to navigate. */
		consentedDomains: string[];
		/** Has the owner consented to the signed-in profile? Only meaningful for `default`. */
		profileConsented: boolean;
	};
	limits: LocalBrowserLimits;
	resultSchema: LocalBrowserResultSchema;
	/**
	 * Unused since #944: the runner cannot reach the API (see the PULL note above). Kept optional so
	 * an envelope from before the change still parses; PAGS no longer sends it.
	 */
	callback?: { eventsPath: string; resultPath: string };
}

/** Why a run stops and waits for a person. Each is a pause, never an obstacle to work around. */
export type LocalBrowserPauseReason = "login_required" | "captcha" | "consent_required" | "access_blocked" | "paywall" | "write_affordance";
export const LOCAL_BROWSER_PAUSE_REASONS: readonly LocalBrowserPauseReason[] = ["login_required", "captcha", "consent_required", "access_blocked", "paywall", "write_affordance"];

/** The closed event vocabulary of a run's trace. */
export type LocalBrowserEventType =
	| "engine.started"
	| "engine.auth_checked"
	| "engine.ended"
	| "browser.navigated"
	| "browser.snapshot"
	| "browser.blocked"
	| "policy.decision"
	| "consent.requested"
	| "finding.parsed"
	| "run.paused"
	| "run.resumed"
	| "note";
export const LOCAL_BROWSER_EVENT_TYPES: readonly LocalBrowserEventType[] = [
	"engine.started",
	"engine.auth_checked",
	"engine.ended",
	"browser.navigated",
	"browser.snapshot",
	"browser.blocked",
	"policy.decision",
	"consent.requested",
	"finding.parsed",
	"run.paused",
	"run.resumed",
	"note",
];

/**
 * Events PAGS itself records on the same trace: the request, the hand-off to the runner and the
 * end. Never accepted from a runner — a runner cannot claim a run was cancelled or dispatched.
 */
export type LocalBrowserPlatformEventType = "run.requested" | "runner.dispatched" | "run.ended";
export const LOCAL_BROWSER_PLATFORM_EVENT_TYPES: readonly LocalBrowserPlatformEventType[] = ["run.requested", "runner.dispatched", "run.ended"];

export interface LocalBrowserEvent {
	type: LocalBrowserEventType;
	/** ISO time on the runner's clock. */
	at: string;
	url?: string;
	domain?: string;
	/** Present on `run.paused`. */
	pauseReason?: LocalBrowserPauseReason;
	consentId?: string;
	/** Free-form, redacted by {@link redactDetail} on both sides of the relay. */
	detail?: Record<string, unknown>;
}

/** The credential class the engine actually ran on — observed, never the credential itself. */
export type LocalBrowserEngineAuth = "subscription" | "machine-login" | "api-key" | "missing_login" | "unknown";
export const LOCAL_BROWSER_ENGINE_AUTHS: readonly LocalBrowserEngineAuth[] = ["subscription", "machine-login", "api-key", "missing_login", "unknown"];

export interface LocalBrowserFinding {
	title: string;
	url: string;
	/** The text on the page the finding was extracted from. */
	evidence: string;
	fields: Record<string, string | number | boolean | null>;
}

export type LocalBrowserSourceFailureReason = "login_required" | "captcha" | "paywall" | "access_denied" | "robots" | "timeout" | "error";
export const LOCAL_BROWSER_SOURCE_FAILURE_REASONS: readonly LocalBrowserSourceFailureReason[] = ["login_required", "captcha", "paywall", "access_denied", "robots", "timeout", "error"];

export interface LocalBrowserSourceFailure {
	url: string;
	reason: LocalBrowserSourceFailureReason;
	detail?: string;
}

/** What the runner returns when a run ends. */
export interface LocalBrowserResultEnvelope {
	runId: string;
	outcome: "completed" | "failed";
	findings: LocalBrowserFinding[];
	sourceFailures: LocalBrowserSourceFailure[];
	summary: string;
	traceId: string;
	engineAuth: LocalBrowserEngineAuth;
	/** Present when `outcome` is `failed`. */
	error?: string;
}

/** A runner event with its position in the run's trace, as `status` returns it. */
export interface LocalBrowserRunnerEvent extends LocalBrowserEvent {
	seq: number;
}

/** `POST /local-browser/status {runId, afterSeq}` — what the runner holds for one run. */
export interface LocalBrowserStatusResponse {
	runId: string;
	state: "running" | "paused" | "ended";
	pauseReason?: LocalBrowserPauseReason;
	/** Events after `afterSeq`, in order. */
	events: LocalBrowserRunnerEvent[];
	/** The highest seq the runner holds — the next `afterSeq`. */
	lastSeq: number;
	/** Present once `state` is `ended`. */
	result?: LocalBrowserResultEnvelope;
}

/** `POST /local-browser/resume` — the owner's current decisions, sent when they unblock a pause. */
export interface LocalBrowserResumeRequest {
	runId: string;
	consentedDomains: string[];
	denyDomains: string[];
	profileConsented: boolean;
}

export const LOCAL_BROWSER_CAPS = { findings: 200, sourceFailures: 200, text: 4000, fieldCount: 40 } as const;

const SENSITIVE_KEY = /cookie|password|passwd|secret|token|authorization|api[_-]?key|otp|form[_-]?values?|credential/i;

/**
 * Drop sensitive keys and bound sizes. A trace is for a supervisor to read, so nothing in it may
 * carry a cookie, a password, a form value or a key — whatever the runner sent.
 */
export function redactDetail(detail: unknown, depth = 0): Record<string, unknown> | undefined {
	if (!detail || typeof detail !== "object" || Array.isArray(detail) || depth > 3) return undefined;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(detail as Record<string, unknown>).slice(0, 40)) {
		if (SENSITIVE_KEY.test(k)) continue;
		if (typeof v === "string") out[k] = v.slice(0, 1000);
		else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
		else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => (typeof x === "string" ? x.slice(0, 300) : typeof x === "number" || typeof x === "boolean" ? x : null));
		else if (typeof v === "object") {
			const nested = redactDetail(v, depth + 1);
			if (nested) out[k] = nested;
		}
	}
	return out;
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const isHttpUrl = (v: string) => /^https?:\/\/[^\s/]+/i.test(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (list.includes(v as T) ? (v as T) : null);

/** A validated event, or null. */
export function parseLocalBrowserEvent(raw: unknown): LocalBrowserEvent | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const type = oneOf(LOCAL_BROWSER_EVENT_TYPES, o.type);
	const at = str(o.at, 40);
	if (!type || !at || Number.isNaN(Date.parse(at))) return null;
	const event: LocalBrowserEvent = { type, at };
	const url = str(o.url, 2000);
	if (url && isHttpUrl(url)) event.url = url;
	const domain = str(o.domain, 253);
	if (domain) event.domain = domain.toLowerCase();
	const pauseReason = oneOf(LOCAL_BROWSER_PAUSE_REASONS, o.pauseReason);
	if (type === "run.paused" && !pauseReason) return null;
	if (pauseReason) event.pauseReason = pauseReason;
	const consentId = str(o.consentId, 100);
	if (consentId) event.consentId = consentId;
	const detail = redactDetail(o.detail);
	if (detail && Object.keys(detail).length) event.detail = detail;
	return event;
}

/**
 * A validated result envelope, or the reason it is not one.
 *
 * Wrapped as `{ result }` on purpose: a FAILED envelope carries its own `error` field, so returning
 * the envelope bare made `"error" in parsed` true for every failed run and rejected it as invalid.
 */
export function parseLocalBrowserResult(raw: unknown): { result: LocalBrowserResultEnvelope } | { error: string } {
	if (!raw || typeof raw !== "object") return { error: "result must be an object" };
	const o = raw as Record<string, unknown>;
	const runId = str(o.runId, 100);
	if (!runId) return { error: "runId is required" };
	const outcome = o.outcome === "completed" || o.outcome === "failed" ? o.outcome : null;
	if (!outcome) return { error: "outcome must be completed or failed" };
	const traceId = str(o.traceId, 100);
	if (!traceId) return { error: "traceId is required" };
	const engineAuth = oneOf(LOCAL_BROWSER_ENGINE_AUTHS, o.engineAuth);
	if (!engineAuth) return { error: `engineAuth must be one of ${LOCAL_BROWSER_ENGINE_AUTHS.join(", ")}` };
	if (!Array.isArray(o.findings) || !Array.isArray(o.sourceFailures)) return { error: "findings and sourceFailures must be arrays" };
	if (o.findings.length > LOCAL_BROWSER_CAPS.findings) return { error: `at most ${LOCAL_BROWSER_CAPS.findings} findings` };
	if (o.sourceFailures.length > LOCAL_BROWSER_CAPS.sourceFailures) return { error: `at most ${LOCAL_BROWSER_CAPS.sourceFailures} source failures` };
	const findings: LocalBrowserFinding[] = [];
	for (const [i, f] of o.findings.entries()) {
		const r = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
		const title = str(r.title, 500);
		const url = str(r.url, 2000);
		const evidence = str(r.evidence, LOCAL_BROWSER_CAPS.text);
		if (!title || !url || !isHttpUrl(url) || !evidence) return { error: `findings[${i}] needs title, an http(s) url and evidence` };
		const fields: LocalBrowserFinding["fields"] = {};
		const rawFields = r.fields && typeof r.fields === "object" && !Array.isArray(r.fields) ? (r.fields as Record<string, unknown>) : {};
		for (const [k, v] of Object.entries(rawFields).slice(0, LOCAL_BROWSER_CAPS.fieldCount)) {
			if (SENSITIVE_KEY.test(k)) continue;
			if (typeof v === "string") fields[k.slice(0, 100)] = v.slice(0, LOCAL_BROWSER_CAPS.text);
			else if (typeof v === "number" || typeof v === "boolean" || v === null) fields[k.slice(0, 100)] = v;
		}
		findings.push({ title, url, evidence, fields });
	}
	const sourceFailures: LocalBrowserSourceFailure[] = [];
	for (const [i, f] of o.sourceFailures.entries()) {
		const r = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
		const url = str(r.url, 2000);
		const reason = oneOf(LOCAL_BROWSER_SOURCE_FAILURE_REASONS, r.reason);
		if (!url || !reason) return { error: `sourceFailures[${i}] needs url and a known reason` };
		const detail = str(r.detail, 1000);
		sourceFailures.push(detail ? { url, reason, detail } : { url, reason });
	}
	const out: LocalBrowserResultEnvelope = { runId, outcome, findings, sourceFailures, summary: str(o.summary, LOCAL_BROWSER_CAPS.text) ?? "", traceId, engineAuth };
	const error = str(o.error, 1000);
	if (outcome === "failed") out.error = error ?? "The run failed without a reason.";
	return { result: out };
}
