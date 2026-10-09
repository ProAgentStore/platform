/**
 * Local artifact generation — the wire contract between PAGS and the runner (#956, epic #943).
 *
 * The Application Tailor turns an approved job lead (#955) into a tailored résumé and cover letter,
 * written by a Codex or Claude Code CLI signed in on the owner's machine, from source files the
 * owner keeps in a workspace folder (`~/jobs` by default). No repository, no browser, no Workers AI
 * and no provider API key: the CLI runs on the machine's own login or subscription only.
 *
 * Like `local-browser/contract.ts`, this file is kept BYTE-IDENTICAL at
 *
 *   workers/api/src/lib/local-artifact/contract.ts
 *   packages/browser-runner/src/local-artifact/contract.ts
 *
 * (`contract.test.ts` fails the moment they differ) and imports nothing, so it can be vendored.
 *
 * PULL, not push: the runner holds no API token, so PAGS reads a run's events and result with
 * `status` — when an application is read and from the per-minute cron.
 */

export const LOCAL_ARTIFACT_TASK_TYPE = "local_artifact.generate";
export const LOCAL_ARTIFACT_RUN_PATH = "/local-artifact/run";
export const LOCAL_ARTIFACT_STATUS_PATH = "/local-artifact/status";
export const LOCAL_ARTIFACT_CANCEL_PATH = "/local-artifact/cancel";

/** The readiness event a completed tailoring run emits, once, through the connection outbox. */
export const MATERIALS_READY_EVENT = "job.application.materials_ready";

export type LocalArtifactEngine = "claude" | "codex";
export const LOCAL_ARTIFACT_ENGINES: readonly LocalArtifactEngine[] = ["claude", "codex"];

/**
 * Subscription-only by construction: there is no `api-key` mode. `machine` uses the CLI's stored
 * login; `subscription` also lets a Claude Code subscription token through. Neither ever carries a
 * per-token provider key into the engine's environment.
 */
export type LocalArtifactAuthMode = "machine" | "subscription";
export const LOCAL_ARTIFACT_AUTH_MODES: readonly LocalArtifactAuthMode[] = ["machine", "subscription"];

/** The owner's source materials. `resume` and `profile` are required; `answers` is optional. */
export type LocalArtifactSourceRole = "resume" | "profile" | "answers";
export const LOCAL_ARTIFACT_SOURCE_ROLES: readonly LocalArtifactSourceRole[] = ["resume", "profile", "answers"];
export const REQUIRED_SOURCE_ROLES: readonly LocalArtifactSourceRole[] = ["resume", "profile"];

export interface LocalArtifactSource {
	role: LocalArtifactSourceRole;
	/** Relative to the workspace folder. Never absolute, never `..`. */
	path: string;
}

/** The approved lead, exactly as #955's `job.lead.apply_requested` envelope carries it. Immutable. */
export interface LocalArtifactLead {
	eventId: string;
	sourceInstanceId: string;
	leadId: string;
	leadUrl: string;
	lifecycleVersion: number;
	requestedAt: string;
	lead: { title: string; company?: string; location?: string; url?: string; source?: string; posted_date?: string; match_rationale?: string };
}

export interface LocalArtifactPolicy {
	/** Days to keep a run's generated folder; 0 = keep until the owner deletes it. */
	retainDays: number;
	maxMinutes: number;
	maxConcurrent: number;
}

/** What PAGS sends the runner to start one run. Carries no credential of any kind. */
export interface LocalArtifactTaskEnvelope {
	type: typeof LOCAL_ARTIFACT_TASK_TYPE;
	runId: string;
	/** Deterministic idempotency key: a replayed start with the same key is the same run. */
	requestId: string;
	instanceId: string;
	engine: LocalArtifactEngine;
	authMode: LocalArtifactAuthMode;
	/** `~/…`, under the machine's home folder. Artifacts go to `<workspace>/applications/<leadId>/<runId>/`. */
	workspace: string;
	sources: LocalArtifactSource[];
	lead: LocalArtifactLead;
	policy: LocalArtifactPolicy;
}

/** Why a run stops for a person instead of producing materials. Each is a pause, never a guess. */
export type LocalArtifactBlockReason =
	| "missing_source"
	| "malformed_lead"
	| "workspace_unavailable"
	| "missing_information"
	| "uncertain_claim"
	| "invalid_cli_output"
	| "engine_not_signed_in"
	| "api_key_refused";
export const LOCAL_ARTIFACT_BLOCK_REASONS: readonly LocalArtifactBlockReason[] = [
	"missing_source",
	"malformed_lead",
	"workspace_unavailable",
	"missing_information",
	"uncertain_claim",
	"invalid_cli_output",
	"engine_not_signed_in",
	"api_key_refused",
];

export type LocalArtifactEventType =
	| "engine.auth_checked"
	| "engine.started"
	| "engine.ended"
	| "source.read"
	| "source.missing"
	| "claims.checked"
	| "artifact.written"
	| "run.needs_human"
	| "retention.swept"
	| "note";
export const LOCAL_ARTIFACT_EVENT_TYPES: readonly LocalArtifactEventType[] = [
	"engine.auth_checked",
	"engine.started",
	"engine.ended",
	"source.read",
	"source.missing",
	"claims.checked",
	"artifact.written",
	"run.needs_human",
	"retention.swept",
	"note",
];

/** Events PAGS records itself on the same trace — never accepted from a runner. */
export type LocalArtifactPlatformEventType = "run.requested" | "runner.dispatched" | "run.ended";

/**
 * A trace event. Its detail is a WHITELIST of handle-shaped keys — a path, a hash, a count — so no
 * résumé text, profile field or CLI output can ride into a trace, whatever the runner sends.
 */
export interface LocalArtifactEvent {
	type: LocalArtifactEventType;
	at: string;
	detail?: Record<string, string | number | boolean>;
}

export interface LocalArtifactRunnerEvent extends LocalArtifactEvent {
	seq: number;
}

/** The credential class the engine ran on — observed from its spawn env, never the credential. */
export type LocalArtifactEngineAuth = "machine-login" | "subscription" | "api-key" | "missing_login" | "unknown";
export const LOCAL_ARTIFACT_ENGINE_AUTHS: readonly LocalArtifactEngineAuth[] = ["machine-login", "subscription", "api-key", "missing_login", "unknown"];

export type LocalArtifactKind = "resume" | "cover_letter";

/** A generated file, by handle: its owner-visible path and content hash — never its content. */
export interface LocalArtifactFile {
	kind: LocalArtifactKind;
	path: string;
	sha256: string;
	bytes: number;
}

export interface LocalArtifactSourceHash {
	role: LocalArtifactSourceRole;
	path: string;
	sha256: string;
	bytes: number;
}

/** Safe parser/validation metadata. CLI or source text never crosses the runner boundary. */
export type LocalArtifactValidationError = "no_json_object" | "invalid_json" | "not_draft_object" | "incomplete_draft" | "unverified_claim";
/** Closed parser strategy names; never CLI or source text. */
export type LocalArtifactParseAttempt = "fenced_json" | "balanced_object";
export const LOCAL_ARTIFACT_PARSE_ATTEMPTS: readonly LocalArtifactParseAttempt[] = ["fenced_json", "balanced_object"];
export interface LocalArtifactValidationDiagnostic {
	validationError: LocalArtifactValidationError;
	parseAttempts: LocalArtifactParseAttempt[];
	rawOutputChars: number;
	runId: string;
	attemptNumber: number;
}

/** What the runner returns when a run ends. */
export interface LocalArtifactResultEnvelope {
	runId: string;
	outcome: "completed" | "needs_human" | "failed";
	artifacts: LocalArtifactFile[];
	sourceHashes: LocalArtifactSourceHash[];
	/** A hash over the source hashes: which version of the owner's materials the artifacts came from. */
	profileVersion: string | null;
	engineAuth: LocalArtifactEngineAuth;
	traceId: string;
	generatedAt?: string;
	/** Present when `outcome` is `needs_human`. */
	blockReason?: LocalArtifactBlockReason;
	/** What the owner must supply or confirm. Questions only — never a source excerpt. */
	questions?: string[];
	/** Safe diagnostic metadata for a rejected CLI draft; never CLI/source text. */
	diagnostic?: LocalArtifactValidationDiagnostic;
	/** Present when `outcome` is `failed`. */
	error?: string;
}

/** `POST /local-artifact/status {runId, afterSeq}`. */
export interface LocalArtifactStatusResponse {
	runId: string;
	state: "running" | "ended";
	events: LocalArtifactRunnerEvent[];
	lastSeq: number;
	result?: LocalArtifactResultEnvelope;
}

export const LOCAL_ARTIFACT_CAPS = { questions: 20, questionChars: 300, sources: 6, sourceBytes: 256 * 1024 } as const;

/** An id used as a folder name: no separators, no dots, nothing a path could be built out of. */
export const PATH_SEGMENT = /^[A-Za-z0-9_-]{1,100}$/;

/** A source path inside the workspace: relative, no `..`, no absolute, no NUL, no backslash. */
export function isWorkspaceRelative(path: string): boolean {
	if (!path || path.length > 300 || path.startsWith("/") || path.startsWith("~") || /[\0\\]/.test(path)) return false;
	return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** A workspace folder: `~/…` with the same segment rules. */
export function isHomeRelative(path: string): boolean {
	return typeof path === "string" && path.startsWith("~/") && isWorkspaceRelative(path.slice(2));
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (list.includes(v as T) ? (v as T) : null);
const LEAD_FIELDS = ["company", "location", "url", "source", "posted_date", "match_rationale"] as const;
const HASH = /^[a-f0-9]{64}$/;

/**
 * The approved lead, validated — or why it is not one. A malformed lead never reaches a CLI: it
 * pauses the application instead, because a résumé tailored to a half-read lead is a plausible guess.
 */
export function parseLocalArtifactLead(raw: unknown): { lead: LocalArtifactLead } | { error: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "the lead must be an object" };
	const o = raw as Record<string, unknown>;
	const eventId = str(o.eventId, 300);
	if (!eventId) return { error: "the lead has no eventId" };
	const sourceInstanceId = str(o.sourceInstanceId, 100);
	if (!sourceInstanceId) return { error: "the lead has no sourceInstanceId" };
	const leadId = str(o.leadId, 100);
	if (!leadId || !PATH_SEGMENT.test(leadId)) return { error: "the lead has no usable leadId" };
	const lifecycleVersion = o.lifecycleVersion;
	if (typeof lifecycleVersion !== "number" || !Number.isInteger(lifecycleVersion) || lifecycleVersion < 1) return { error: "the lead has no lifecycleVersion" };
	const leadUrl = str(o.leadUrl, 2000) ?? "";
	if (leadUrl && !/^https?:\/\/[^\s/]+/i.test(leadUrl)) return { error: "the lead's URL is not an http(s) URL" };
	const requestedAt = str(o.requestedAt, 40);
	if (!requestedAt || Number.isNaN(Date.parse(requestedAt))) return { error: "the lead has no requestedAt time" };
	const body = o.lead && typeof o.lead === "object" && !Array.isArray(o.lead) ? (o.lead as Record<string, unknown>) : null;
	const title = body ? str(body.title, 300) : null;
	if (!body || !title) return { error: "the lead has no job title" };
	const lead: LocalArtifactLead["lead"] = { title };
	for (const f of LEAD_FIELDS) {
		const v = str(body[f], f === "match_rationale" ? 2000 : 500);
		if (v) lead[f] = v;
	}
	return { lead: { eventId, sourceInstanceId, leadId, leadUrl, lifecycleVersion, requestedAt, lead } };
}

const DETAIL_KEYS = new Set(["engine", "authMode", "engineAuth", "role", "path", "sha256", "bytes", "kind", "total", "unmatched", "reason", "exitCode", "count", "removed", "status", "validationError", "parseAttempts", "rawOutputChars", "runId", "attemptNumber"]);

/** A validated event, or null. Detail keeps only whitelisted, primitive, bounded values. */
export function parseLocalArtifactEvent(raw: unknown): LocalArtifactEvent | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const type = oneOf(LOCAL_ARTIFACT_EVENT_TYPES, o.type);
	const at = str(o.at, 40);
	if (!type || !at || Number.isNaN(Date.parse(at))) return null;
	const event: LocalArtifactEvent = { type, at };
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

/** A validated result envelope, or the reason it is not one. */
export function parseLocalArtifactResult(raw: unknown): { result: LocalArtifactResultEnvelope } | { error: string } {
	if (!raw || typeof raw !== "object") return { error: "result must be an object" };
	const o = raw as Record<string, unknown>;
	const runId = str(o.runId, 100);
	if (!runId) return { error: "runId is required" };
	const outcome = o.outcome === "completed" || o.outcome === "needs_human" || o.outcome === "failed" ? o.outcome : null;
	if (!outcome) return { error: "outcome must be completed, needs_human or failed" };
	const traceId = str(o.traceId, 100);
	if (!traceId) return { error: "traceId is required" };
	const engineAuth = oneOf(LOCAL_ARTIFACT_ENGINE_AUTHS, o.engineAuth);
	if (!engineAuth) return { error: `engineAuth must be one of ${LOCAL_ARTIFACT_ENGINE_AUTHS.join(", ")}` };
	if (!Array.isArray(o.artifacts) || !Array.isArray(o.sourceHashes)) return { error: "artifacts and sourceHashes must be arrays" };
	const artifacts: LocalArtifactFile[] = [];
	for (const [i, a] of o.artifacts.slice(0, 10).entries()) {
		const r = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
		const kind = r.kind === "resume" || r.kind === "cover_letter" ? r.kind : null;
		const path = str(r.path, 500);
		const sha256 = str(r.sha256, 64);
		if (!kind || !path || !isHomeRelative(path) || !sha256 || !HASH.test(sha256) || typeof r.bytes !== "number") return { error: `artifacts[${i}] needs a kind, a ~/ path, a sha256 and bytes` };
		artifacts.push({ kind, path, sha256, bytes: r.bytes });
	}
	const sourceHashes: LocalArtifactSourceHash[] = [];
	for (const [i, s] of o.sourceHashes.slice(0, LOCAL_ARTIFACT_CAPS.sources).entries()) {
		const r = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
		const role = oneOf(LOCAL_ARTIFACT_SOURCE_ROLES, r.role);
		const path = str(r.path, 500);
		const sha256 = str(r.sha256, 64);
		if (!role || !path || !sha256 || !HASH.test(sha256) || typeof r.bytes !== "number") return { error: `sourceHashes[${i}] needs a role, a path, a sha256 and bytes` };
		sourceHashes.push({ role, path, sha256, bytes: r.bytes });
	}
	if (outcome === "completed" && (!artifacts.some((a) => a.kind === "resume") || !artifacts.some((a) => a.kind === "cover_letter"))) {
		return { error: "a completed run must report both a resume and a cover_letter artifact" };
	}
	const out: LocalArtifactResultEnvelope = { runId, outcome, artifacts, sourceHashes, profileVersion: str(o.profileVersion, 100), engineAuth, traceId };
	const generatedAt = str(o.generatedAt, 40);
	if (generatedAt && !Number.isNaN(Date.parse(generatedAt))) out.generatedAt = generatedAt;
	if (outcome === "needs_human") {
		out.blockReason = oneOf(LOCAL_ARTIFACT_BLOCK_REASONS, o.blockReason) ?? "missing_information";
		out.questions = (Array.isArray(o.questions) ? o.questions : [])
			.filter((q): q is string => typeof q === "string" && q.trim() !== "")
			.slice(0, LOCAL_ARTIFACT_CAPS.questions)
			.map((q) => q.trim().slice(0, LOCAL_ARTIFACT_CAPS.questionChars));
		const diagnostic = o.diagnostic && typeof o.diagnostic === "object" ? o.diagnostic as Record<string, unknown> : null;
		const validationError = diagnostic?.validationError;
		if (diagnostic && (validationError === "no_json_object" || validationError === "invalid_json" || validationError === "not_draft_object" || validationError === "incomplete_draft" || validationError === "unverified_claim")) {
			const parseAttempts: LocalArtifactParseAttempt[] = [];
			if (Array.isArray(diagnostic.parseAttempts)) {
				for (let index = 0; index < diagnostic.parseAttempts.length && index < 8; index += 1) {
					const parseAttempt = oneOf(LOCAL_ARTIFACT_PARSE_ATTEMPTS, diagnostic.parseAttempts[index]);
					if (parseAttempt && !parseAttempts.includes(parseAttempt)) parseAttempts.push(parseAttempt);
				}
			}
			out.diagnostic = {
				validationError,
				parseAttempts,
				rawOutputChars: typeof diagnostic.rawOutputChars === "number" ? Math.max(0, Math.min(diagnostic.rawOutputChars, 200_000)) : 0,
				runId: str(diagnostic.runId, 100) ?? runId,
				attemptNumber: typeof diagnostic.attemptNumber === "number" && Number.isInteger(diagnostic.attemptNumber) && diagnostic.attemptNumber > 0 ? diagnostic.attemptNumber : 1,
			};
		}
	}
	if (outcome === "failed") out.error = str(o.error, 1000) ?? "The run failed without a reason.";
	return { result: out };
}
