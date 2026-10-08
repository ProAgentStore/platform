/**
 * Local application execution — the wire contract between PAGS and the runner (#957, epic #943).
 *
 * The Job Application Runner takes ONE application whose materials are ready (#956) and fills its
 * form in a real browser on the owner's machine, driven by a Codex or Claude Code CLI signed in on
 * that machine. The CLI reaches the page only through the runner's apply bridge, which enforces the
 * write policy below: every browser action belongs to an ACTION CLASS, and a class is allowed or
 * refused by the runner, not asked of the model.
 *
 *   read    — navigate, snapshot, wait, follow a link inside the allowed sites;
 *   fill    — type, select, tick, upload an approved artifact — each value grounded in the owner's
 *             own profile / answers / artifacts;
 *   review  — stop with the form filled and nothing sent (`awaiting_review`);
 *   submit  — the final external Submit. Only under `auto_submit`, only with the gate PAGS
 *             evaluated (`policy.submitGate`), and at most once per run.
 *
 * The default mode is `fill_and_review`, in which a submit-class action is never performed.
 *
 * Kept BYTE-IDENTICAL at
 *
 *   workers/api/src/lib/local-apply/contract.ts
 *   packages/browser-runner/src/local-apply/contract.ts
 *
 * (`contract.test.ts` fails the moment they differ) and imports nothing, so it can be vendored.
 *
 * PULL, not push: the runner holds no API token, so PAGS reads a run with `status` — when it is
 * read and from the per-minute cron — exactly like local browser research.
 */

export const LOCAL_APPLY_TASK_TYPE = "local_browser.apply";
export const LOCAL_APPLY_RUN_PATH = "/local-apply/run";
export const LOCAL_APPLY_STATUS_PATH = "/local-apply/status";
export const LOCAL_APPLY_RESUME_PATH = "/local-apply/resume";
export const LOCAL_APPLY_CANCEL_PATH = "/local-apply/cancel";
/** Delivers a cloud-persisted supervisory decision to one paused checkpoint. */
export const LOCAL_APPLY_DIRECTIVE_PATH = "/local-apply/directive";

export type LocalApplyEngine = "claude" | "codex";
export const LOCAL_APPLY_ENGINES: readonly LocalApplyEngine[] = ["claude", "codex"];

/** Subscription-only, like the Tailor: there is no `api-key` mode. */
export type LocalApplyAuthMode = "machine" | "subscription";
export const LOCAL_APPLY_AUTH_MODES: readonly LocalApplyAuthMode[] = ["machine", "subscription"];

export type LocalApplyMode = "fill_and_review" | "auto_submit";
export const LOCAL_APPLY_MODES: readonly LocalApplyMode[] = ["fill_and_review", "auto_submit"];

export type LocalApplyActionClass = "read" | "fill" | "review" | "submit";

/** `isolated` = a throwaway profile; `default` = the runner's own signed-in browser. */
export type LocalApplyProfile = "isolated" | "default";

export type LocalApplyArtifactKind = "resume" | "cover_letter";

/** An approved artifact by handle. The runner refuses to upload a file whose hash differs. */
export interface LocalApplyArtifact {
	kind: LocalApplyArtifactKind;
	/** `~/…`, as #956 reported it. */
	path: string;
	sha256: string;
}

/** The owner's answer sources, relative to the workspace (`profile` required, `answers` optional). */
export interface LocalApplySource {
	role: "profile" | "answers";
	path: string;
}

export interface LocalApplyLimits {
	maxMinutes: number;
	maxPages: number;
	maxActions: number;
}

/** What PAGS sends the runner to start one run. Carries no credential of any kind. */
export interface LocalApplyTaskEnvelope {
	type: typeof LOCAL_APPLY_TASK_TYPE;
	runId: string;
	/** Deterministic idempotency key (the materials_ready event id): a replayed start is the same run. */
	requestId: string;
	instanceId: string;
	applicationId: string;
	engine: LocalApplyEngine;
	authMode: LocalApplyAuthMode;
	browserProfile: LocalApplyProfile;
	/** The application page to start on. */
	applicationUrl: string;
	job: { title: string; company?: string; location?: string };
	/** `~/…` — where the owner's answer sources live. */
	workspace: string;
	sources: LocalApplySource[];
	artifacts: LocalApplyArtifact[];
	policy: {
		mode: LocalApplyMode;
		/** The sites the run may be on. Leaving them pauses (`external_redirect`). */
		allowDomains: string[];
		/** Present only under `auto_submit`: the PAGS policy decision that permits ONE final submit. */
		submitGate?: { gateId: string };
	};
	limits: LocalApplyLimits;
}

/** Why a run stops for a person. Each is a pause — never an obstacle to work around. */
export type LocalApplyPauseReason =
	| "captcha"
	| "login_required"
	| "consent_required"
	| "missing_answer"
	| "screening_ambiguity"
	| "external_redirect"
	| "duplicate_application"
	| "anti_bot"
	/** A cloud supervisor is deciding whether the local CLI may continue. */
	| "supervisor_checkpoint";
export const LOCAL_APPLY_PAUSE_REASONS: readonly LocalApplyPauseReason[] = [
	"captcha",
	"login_required",
	"consent_required",
	"missing_answer",
	"screening_ambiguity",
	"external_redirect",
	"duplicate_application",
	"anti_bot",
	"supervisor_checkpoint",
];

/** Why a run ENDED blocked: an unresolved pause, or one of these. */
export type LocalApplyBlockReason =
	| LocalApplyPauseReason
	| "submit_unconfirmed"
	| "incomplete"
	| "engine_not_signed_in"
	| "api_key_refused"
	| "source_unavailable"
	| "artifact_changed"
	/** The runner verified the listing's own unavailable/expired notice. */
	| "job_unavailable";
export const LOCAL_APPLY_BLOCK_REASONS: readonly LocalApplyBlockReason[] = [
	...LOCAL_APPLY_PAUSE_REASONS,
	"submit_unconfirmed",
	"incomplete",
	"engine_not_signed_in",
	"api_key_refused",
	"source_unavailable",
	"artifact_changed",
	"job_unavailable",
];

/** Why the site's own notice says this listing cannot be applied to. */
export type LocalApplyUnavailableReason = "expired" | "unavailable";
export const LOCAL_APPLY_UNAVAILABLE_REASONS: readonly LocalApplyUnavailableReason[] = ["expired", "unavailable"];

/**
 * Evidence from the application page, collected and verified by the runner — never supplied by
 * the CLI as prose. It deliberately records no page text: the URL, observed time and fixed
 * `source` identify the notice without copying potentially private page contents into the trace.
 */
export interface LocalApplyUnavailableEvidence {
	reason: LocalApplyUnavailableReason;
	url: string;
	observedAt: string;
	source: "page_notice";
}

export type LocalApplyEventType =
	| "engine.auth_checked"
	| "engine.started"
	| "engine.ended"
	| "source.read"
	| "browser.navigated"
	| "browser.blocked"
	| "policy.decision"
	| "field.filled"
	| "artifact.uploaded"
	| "review.ready"
	| "submit.attempted"
	| "submit.confirmed"
	| "submit.unconfirmed"
	| "job.unavailable"
	| "supervisor.checkpoint"
	| "supervisor.directive"
	| "run.paused"
	| "run.resumed"
	| "note";
export const LOCAL_APPLY_EVENT_TYPES: readonly LocalApplyEventType[] = [
	"engine.auth_checked",
	"engine.started",
	"engine.ended",
	"source.read",
	"browser.navigated",
	"browser.blocked",
	"policy.decision",
	"field.filled",
	"artifact.uploaded",
	"review.ready",
	"submit.attempted",
	"submit.confirmed",
	"submit.unconfirmed",
	"job.unavailable",
	"supervisor.checkpoint",
	"supervisor.directive",
	"run.paused",
	"run.resumed",
	"note",
];

/** Events PAGS records itself on the same trace — never accepted from a runner. */
export type LocalApplyPlatformEventType = "run.requested" | "policy.submit_gate" | "runner.dispatched" | "run.ended";

/**
 * A trace event. Detail is a WHITELIST of keys holding a class, a domain, a decision or a handle —
 * never a typed value, an answer, a page's text or a cookie, whatever the runner sends.
 */
export interface LocalApplyEvent {
	type: LocalApplyEventType;
	at: string;
	url?: string;
	domain?: string;
	pauseReason?: LocalApplyPauseReason;
	detail?: Record<string, string | number | boolean>;
}

export interface LocalApplyRunnerEvent extends LocalApplyEvent {
	seq: number;
}

export type LocalApplyEngineAuth = "machine-login" | "subscription" | "api-key" | "missing_login" | "unknown";
export const LOCAL_APPLY_ENGINE_AUTHS: readonly LocalApplyEngineAuth[] = ["machine-login", "subscription", "api-key", "missing_login", "unknown"];

export type LocalApplyOutcome = "awaiting_review" | "submitted" | "blocked" | "failed";

/** What the runner returns when a run ends. */
export interface LocalApplyResultEnvelope {
	runId: string;
	outcome: LocalApplyOutcome;
	mode: LocalApplyMode;
	traceId: string;
	engineAuth: LocalApplyEngineAuth;
	/** How many fill-class actions reached the page. */
	filled: number;
	uploaded: LocalApplyArtifactKind[];
	/** Was a final submit click performed? True even when its success could not be confirmed. */
	submitAttempted: boolean;
	/** Present only when `outcome` is `submitted`: the confirmed final page. */
	submitted?: { url: string; at: string; gateId: string };
	summary: string;
	/** Present when `outcome` is `blocked`. */
	blockReason?: LocalApplyBlockReason;
	questions?: string[];
	/** Present exactly when `blockReason` is `job_unavailable`. */
	unavailable?: LocalApplyUnavailableEvidence;
	/** Present when `outcome` is `failed`. */
	error?: string;
}

/** What the run is waiting on, as `status` reports it while paused. */
export interface LocalApplyPause {
	reason: LocalApplyPauseReason;
	url?: string;
	domain?: string;
	/** The question to answer, for `missing_answer` / `screening_ambiguity`. */
	question?: string;
	/** Present exactly for a `supervisor_checkpoint` pause. */
	checkpoint?: LocalApplySupervisorCheckpoint;
}

/** The only decisions a cloud supervisor may persist for a local checkpoint. */
export type LocalApplySupervisorDirective = "continue" | "request_review" | "stop";
export const LOCAL_APPLY_SUPERVISOR_DIRECTIVES: readonly LocalApplySupervisorDirective[] = ["continue", "request_review", "stop"];

/** A bounded phase label supplied by the CLI; page facts are independently derived by the runner. */
export type LocalApplySupervisorPhase = "initial" | "before_submit" | "post_navigation" | "uncertain";
export const LOCAL_APPLY_SUPERVISOR_PHASES: readonly LocalApplySupervisorPhase[] = ["initial", "before_submit", "post_navigation", "uncertain"];

/** Stable, non-prose signals a cloud supervisor may use to decide. */
export type LocalApplySupervisorBlocker = "captcha" | "login_required" | "anti_bot" | "missing_answer" | "screening_ambiguity" | "external_redirect" | "duplicate_application";
export interface LocalApplySupervisorFacts {
	phase: LocalApplySupervisorPhase;
	actions: number;
	filled: number;
	uploaded: number;
	blockers: LocalApplySupervisorBlocker[];
	url?: string;
	domain?: string;
	title?: string;
}

/** The durable identity and runner-derived facts for one bridge checkpoint. No model prose crosses this boundary. */
export interface LocalApplySupervisorCheckpoint {
	schemaVersion: 1;
	checkpointId: string;
	facts: LocalApplySupervisorFacts;
}

/** `POST /local-apply/directive` — PAGS persists this decision before delivering it to the runner. */
export interface LocalApplyDirectiveRequest extends Pick<LocalApplySupervisorCheckpoint, "schemaVersion" | "checkpointId"> {
	runId: string;
	directive: LocalApplySupervisorDirective;
}

/** `POST /local-apply/status {runId, afterSeq}`. */
export interface LocalApplyStatusResponse {
	runId: string;
	state: "running" | "paused" | "ended";
	pause?: LocalApplyPause;
	events: LocalApplyRunnerEvent[];
	lastSeq: number;
	result?: LocalApplyResultEnvelope;
}

/** `POST /local-apply/resume` — the owner has handled the pause; optionally with an answer or a newly allowed site. */
export interface LocalApplyResumeRequest {
	runId: string;
	answers?: Array<{ question: string; answer: string }>;
	allowDomains?: string[];
}

export const LOCAL_APPLY_CAPS = { questions: 20, questionChars: 300, answers: 20, answerChars: 2000, summary: 2000 } as const;

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (list.includes(v as T) ? (v as T) : null);
const isHttpUrl = (v: string) => /^https?:\/\/[^\s/]+/i.test(v);

const DETAIL_KEYS = new Set(["engine", "authMode", "engineAuth", "mode", "class", "tool", "decision", "reason", "role", "kind", "path", "sha256", "bytes", "gateId", "exitCode", "count", "status", "basis", "source", "checkpointId", "directive", "phase", "actions", "filled", "uploaded"]);

/** A validated event, or null. Detail keeps only whitelisted, primitive, bounded values. */
export function parseLocalApplyEvent(raw: unknown): LocalApplyEvent | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const type = oneOf(LOCAL_APPLY_EVENT_TYPES, o.type);
	const at = str(o.at, 40);
	if (!type || !at || Number.isNaN(Date.parse(at))) return null;
	const event: LocalApplyEvent = { type, at };
	const url = str(o.url, 2000);
	if (url && isHttpUrl(url)) event.url = url;
	const domain = str(o.domain, 253);
	if (domain) event.domain = domain.toLowerCase();
	const pauseReason = oneOf(LOCAL_APPLY_PAUSE_REASONS, o.pauseReason);
	if (type === "run.paused" && !pauseReason) return null;
	if (pauseReason) event.pauseReason = pauseReason;
	if (o.detail && typeof o.detail === "object" && !Array.isArray(o.detail)) {
		const detail: Record<string, string | number | boolean> = {};
		for (const [k, v] of Object.entries(o.detail as Record<string, unknown>)) {
			if (!DETAIL_KEYS.has(k)) continue;
			if (typeof v === "string") detail[k] = v.slice(0, 300);
			else if (typeof v === "number" || typeof v === "boolean") detail[k] = v;
		}
		if (Object.keys(detail).length) event.detail = detail;
	}
	return event;
}

/**
 * A validated result envelope, or the reason it is not one. A `submitted` outcome must carry the
 * confirmed page, the gate it ran under, and a run in `auto_submit` — anything less is not a
 * submission PAGS will record.
 */
export function parseLocalApplyResult(raw: unknown): { result: LocalApplyResultEnvelope } | { error: string } {
	if (!raw || typeof raw !== "object") return { error: "result must be an object" };
	const o = raw as Record<string, unknown>;
	const runId = str(o.runId, 100);
	if (!runId) return { error: "runId is required" };
	const outcome = oneOf<LocalApplyOutcome>(["awaiting_review", "submitted", "blocked", "failed"], o.outcome);
	if (!outcome) return { error: "outcome must be awaiting_review, submitted, blocked or failed" };
	const mode = oneOf(LOCAL_APPLY_MODES, o.mode);
	if (!mode) return { error: "mode is required" };
	const traceId = str(o.traceId, 100);
	if (!traceId) return { error: "traceId is required" };
	const engineAuth = oneOf(LOCAL_APPLY_ENGINE_AUTHS, o.engineAuth);
	if (!engineAuth) return { error: `engineAuth must be one of ${LOCAL_APPLY_ENGINE_AUTHS.join(", ")}` };
	const filled = typeof o.filled === "number" && Number.isInteger(o.filled) && o.filled >= 0 ? o.filled : 0;
	const uploaded = (Array.isArray(o.uploaded) ? o.uploaded : []).filter((k): k is LocalApplyArtifactKind => k === "resume" || k === "cover_letter");
	const out: LocalApplyResultEnvelope = { runId, outcome, mode, traceId, engineAuth, filled, uploaded: [...new Set(uploaded)], submitAttempted: o.submitAttempted === true, summary: str(o.summary, LOCAL_APPLY_CAPS.summary) ?? "" };
	if (outcome === "submitted") {
		const s = (o.submitted && typeof o.submitted === "object" ? o.submitted : {}) as Record<string, unknown>;
		const url = str(s.url, 2000);
		const at = str(s.at, 40);
		const gateId = str(s.gateId, 100);
		if (mode !== "auto_submit") return { error: "a submitted outcome requires a run in auto_submit mode" };
		if (!url || !isHttpUrl(url) || !at || Number.isNaN(Date.parse(at)) || !gateId) return { error: "a submitted outcome needs the confirmed url, its time and the gateId" };
		out.submitted = { url, at, gateId };
		out.submitAttempted = true;
	}
	if (outcome === "blocked") {
		out.blockReason = oneOf(LOCAL_APPLY_BLOCK_REASONS, o.blockReason) ?? "incomplete";
		out.questions = (Array.isArray(o.questions) ? o.questions : [])
			.filter((q): q is string => typeof q === "string" && q.trim() !== "")
			.slice(0, LOCAL_APPLY_CAPS.questions)
			.map((q) => q.trim().slice(0, LOCAL_APPLY_CAPS.questionChars));
		if (out.blockReason === "job_unavailable") {
			const evidence = (o.unavailable && typeof o.unavailable === "object" && !Array.isArray(o.unavailable) ? o.unavailable : {}) as Record<string, unknown>;
			const reason = oneOf(LOCAL_APPLY_UNAVAILABLE_REASONS, evidence.reason);
			const url = str(evidence.url, 2000);
			const observedAt = str(evidence.observedAt, 40);
			if (!reason || !url || !isHttpUrl(url) || !observedAt || Number.isNaN(Date.parse(observedAt)) || evidence.source !== "page_notice") {
				return { error: "a job_unavailable result needs runner-verified unavailable evidence (reason, url, observedAt, source)" };
			}
			out.unavailable = { reason, url, observedAt, source: "page_notice" };
		} else if (o.unavailable !== undefined) return { error: "unavailable evidence is only valid for a job_unavailable result" };
	}
	else if (o.unavailable !== undefined) return { error: "unavailable evidence is only valid for a job_unavailable result" };
	if (outcome === "failed") out.error = str(o.error, 1000) ?? "The run failed without a reason.";
	return { result: out };
}
