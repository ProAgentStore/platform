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
		/**
		 * The id of each owner decision the lists above came from (#947), keyed by domain — `*` for
		 * the signed-in-profile decision — so the trace can name the decision that admitted or
		 * refused a site. Optional: an envelope from before #947 carries none.
		 */
		consentIds?: Record<string, string>;
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
export type LocalBrowserPlatformEventType = "run.requested" | "runner.dispatched" | "run.ended" | "review.decision";
export const LOCAL_BROWSER_PLATFORM_EVENT_TYPES: readonly LocalBrowserPlatformEventType[] = ["run.requested", "runner.dispatched", "run.ended", "review.decision"];

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

/**
 * WHY a run failed — named by the runner, which is the only party that knows (#944).
 *
 * The acceptance criterion this exists for: "a disconnected runner, missing browser, missing
 * subscription login, login/captcha, and expired consent all return explicit actionable states."
 * Most of those were already distinct, and one was not: the cloud derived the code from a single
 * fact — `engineAuth === "missing_login" ? "engine_not_signed_in" : "engine_failed"` — so every
 * other cause arrived as the generic `engine_failed` carrying whatever text the failure threw. A
 * browser that could not start was therefore indistinguishable from a CLI that crashed, and the
 * owner was told neither what happened nor what to do about it.
 *
 *   browser_unavailable  the runner could not start or reach a browser for the run. Actionable at
 *                        the machine (install Chrome, or stop whatever is holding the profile) and
 *                        nowhere else, which is exactly why it must not read as "the engine failed".
 *   engine_not_installed the CLI is not on this machine's PATH.
 *   engine_not_signed_in the CLI is installed but has no subscription login.
 *   bridge_unused        the CLI exited cleanly without making one browser call (#952's live shape).
 *   consent_declined     the owner was asked and said no — a decision, not a fault.
 *   time_limit           the run hit its own time cap with work still to do.
 *   cancelled            the owner stopped it.
 *   engine_failed        anything else the CLI did. The honest residue, not the default.
 */
export type LocalBrowserErrorCode = "browser_unavailable" | "engine_not_installed" | "engine_not_signed_in" | "bridge_unused" | "consent_declined" | "time_limit" | "cancelled" | "engine_failed";
export const LOCAL_BROWSER_ERROR_CODES: readonly LocalBrowserErrorCode[] = ["browser_unavailable", "engine_not_installed", "engine_not_signed_in", "bridge_unused", "consent_declined", "time_limit", "cancelled", "engine_failed"];

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
	/**
	 * Present when `outcome` is `failed`: WHICH cause (#944). Absent from a runner older than this
	 * contract, and the cloud falls back to its previous derivation for one of those — so an old
	 * machine keeps working and a current one is specific.
	 */
	errorCode?: LocalBrowserErrorCode;
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
	/** As on the envelope: decision ids keyed by domain, `*` for the profile (#947). */
	consentIds?: Record<string, string>;
}

export const LOCAL_BROWSER_CAPS = { findings: 200, sourceFailures: 200, text: 4000, fieldCount: 40 } as const;

const SENSITIVE_KEY = /cookie|password|passwd|secret|token|authorization|api[_-]?key|otp|form[_-]?values?|credential/i;

/** An env var NAME whose value is a credential. */
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION|AUTH/i;

/** Credential-shaped text, wherever it appears — the patterns a CLI or a page tends to print. */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
	// NAME=value for a credential-named variable: keep the name, drop the value.
	[/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*["']?[^\s"']+["']?/g, "$1=[REDACTED]"],
	[/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{10,}/gi, "$1 [REDACTED]"],
	[/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
	[/\b(?:ghp|gho|ghs|ghu|github_pat|xox[abpr])_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
	// Base64-ish runs over 40 characters: keys, tokens, session blobs.
	[/[A-Za-z0-9+/_-]{41,}={0,2}/g, "[REDACTED]"],
];

/**
 * The values of credential-named variables in an environment, longest first — what `redactText`
 * must never let through even when the value has no recognisable shape.
 */
export function secretEnvValues(env: Record<string, string | undefined>): string[] {
	return Object.entries(env)
		.filter(([k, v]) => SECRET_ENV_NAME.test(k) && typeof v === "string" && v.trim().length >= 8)
		.map(([, v]) => (v as string).trim())
		.sort((a, b) => b.length - a.length);
}

/**
 * Remove credentials from free text before it is stored (#947): first every known secret value,
 * verbatim, then anything credential-shaped. Used on CLI output that becomes an error, on result
 * text, and on every string in a trace detail.
 */
export function redactText(text: string, secrets: readonly string[] = []): string {
	let out = text;
	for (const s of secrets) if (s.length >= 8) out = out.split(s).join("[REDACTED]");
	for (const [re, sub] of SECRET_PATTERNS) out = out.replace(re, sub);
	return out;
}

/**
 * Drop sensitive keys, redact credential-shaped values and bound sizes. A trace is for a supervisor
 * to read, so nothing in it may carry a cookie, a password, a form value or a key — whatever the
 * runner sent.
 */
export function redactDetail(detail: unknown, depth = 0, secrets: readonly string[] = []): Record<string, unknown> | undefined {
	if (!detail || typeof detail !== "object" || Array.isArray(detail) || depth > 3) return undefined;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(detail as Record<string, unknown>).slice(0, 40)) {
		if (SENSITIVE_KEY.test(k)) continue;
		if (typeof v === "string") out[k] = redactText(v.slice(0, 1000), secrets);
		else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
		else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => (typeof x === "string" ? redactText(x.slice(0, 300), secrets) : typeof x === "number" || typeof x === "boolean" ? x : null));
		else if (typeof v === "object") {
			const nested = redactDetail(v, depth + 1, secrets);
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
 * A finding, with every free-text part redacted (#947).
 *
 * The gap this closes: the result envelope's `summary` and `error` went through {@link redactText}
 * and its FINDINGS did not. `title`, `evidence` and `detail` were length-capped only, and `fields`
 * was filtered by KEY ({@link SENSITIVE_KEY}) — so a credential-shaped value under an innocuous key
 * (`{"note": "sk-ant-api03-…"}`) survived, and a secret environment value quoted into `evidence`
 * survived verbatim. Both are written by the same CLI, on the same machine, in the same envelope as
 * the summary that WAS cleaned, and findings are the part that persists furthest: the run's result
 * row, the console, MCP, and then the owner's own collection record. #947's observability rule —
 * "do not retain … secret environment values" — was therefore breached on the longest-lived path.
 *
 * One definition, used by the runner (which knows the machine's secret env values and passes them)
 * and again by the API when it parses what arrived (which does not, and catches shapes). Defence in
 * depth on purpose: the runner is where secrets are knowable, and the cloud is where a runner that
 * skipped the step is still caught.
 */
export function redactFinding(f: LocalBrowserFinding, secrets: readonly string[] = []): LocalBrowserFinding {
	const fields: LocalBrowserFinding["fields"] = {};
	for (const [k, v] of Object.entries(f.fields ?? {})) {
		if (SENSITIVE_KEY.test(k)) continue;
		fields[k] = typeof v === "string" ? redactText(v, secrets) : v;
	}
	return { title: redactText(f.title, secrets), url: f.url, evidence: redactText(f.evidence, secrets), fields };
}

/** The same for a source failure's free text; its `reason` is a closed vocabulary and its url is a url. */
export function redactSourceFailure(f: LocalBrowserSourceFailure, secrets: readonly string[] = []): LocalBrowserSourceFailure {
	return f.detail === undefined ? f : { ...f, detail: redactText(f.detail, secrets) };
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
		// #947: capped and key-filtered is not redacted. A finding is the longest-lived thing a run
		// produces, and its free text was the one part of this envelope nothing cleaned.
		findings.push(redactFinding({ title, url, evidence, fields }));
	}
	const sourceFailures: LocalBrowserSourceFailure[] = [];
	for (const [i, f] of o.sourceFailures.entries()) {
		const r = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
		const url = str(r.url, 2000);
		const reason = oneOf(LOCAL_BROWSER_SOURCE_FAILURE_REASONS, r.reason);
		if (!url || !reason) return { error: `sourceFailures[${i}] needs url and a known reason` };
		const detail = str(r.detail, 1000);
		sourceFailures.push(redactSourceFailure(detail ? { url, reason, detail } : { url, reason }));
	}
	const out: LocalBrowserResultEnvelope = { runId, outcome, findings, sourceFailures, summary: redactText(str(o.summary, LOCAL_BROWSER_CAPS.text) ?? ""), traceId, engineAuth };
	// Redacted again here, whatever the runner did: an error is CLI output, and CLIs print keys.
	const rawError = str(o.error, 1000);
	const error = rawError === null ? null : redactText(rawError);
	if (outcome === "failed") {
		out.error = error ?? "The run failed without a reason.";
		// #944: the runner's own name for the cause, when it gave one. An unrecognised code is
		// dropped rather than passed through, so the stored vocabulary stays closed.
		const code = oneOf(LOCAL_BROWSER_ERROR_CODES, o.errorCode);
		if (code) out.errorCode = code;
	}
	return { result: out };
}
