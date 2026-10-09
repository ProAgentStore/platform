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
/** Read-only job-page check used before an email lead may enter material preparation. */
export const LOCAL_APPLY_PREFLIGHT_PATH = "/local-apply/preflight";
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

/** Typed, redacted evidence from a read-only job-page/apply-control check. */
export type LocalApplyPreflightResult =
	| { state: "live"; jobUrl: string; applyUrl: string; evidence: "apply_control_present" }
	| { state: "unavailable"; jobUrl: string; reason: "expired" | "unavailable" }
	| { state: "unverifiable"; jobUrl: string; reason: "navigation_failed" | "no_active_apply_path" | "access_blocked" };

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
	| "job_unavailable"
	/**
	 * The CLI ran and exited without ever calling the browser bridge (#975) — no navigation, no
	 * checkpoint, no fill. Distinct from `incomplete`, which means it started and stopped partway:
	 * this one did nothing on the page at all, and the two have different causes and different
	 * remedies, which a single reason could not tell an operator apart.
	 */
	| "bridge_unused";
export const LOCAL_APPLY_BLOCK_REASONS: readonly LocalApplyBlockReason[] = [
	...LOCAL_APPLY_PAUSE_REASONS,
	"submit_unconfirmed",
	"incomplete",
	"engine_not_signed_in",
	"api_key_refused",
	"source_unavailable",
	"artifact_changed",
	"job_unavailable",
	"bridge_unused",
];
/**
 * Why a run produced nothing on the page (#975) — a CLOSED vocabulary, never free text.
 *
 * The production case: the CLI authenticated, exited 0 after 51 seconds, and emitted no browser,
 * checkpoint, fill or review event. The outcome said `incomplete`, which is also what a half-filled
 * form says, so the operator had no way to tell "it did nothing" from "it stopped partway" — and no
 * way at all to learn WHY without reading a terminal on the machine.
 *
 * Deliberately NOT an output tail, redacted or otherwise. `redactText` removes credential SHAPES; it
 * cannot remove the owner's own résumé prose, their typed answers or a quoted source document, all
 * of which a CLI legitimately prints while it works. So nothing free-form is added here: every field
 * is a count, a code, or an id from {@link LOCAL_APPLY_SIGNALS} that the RUNNER chose by matching
 * its own output. The engine's closing sentence continues to cross as `summary`, where it already
 * did — redacted and capped — so this adds diagnosis without adding a new channel for content.
 */
/**
 * The first published CLI whose runner executes THIS contract (#977, raised at #989).
 *
 * An older runner is not broken; it simply predates the vocabulary. Left to run, it reports the
 * same failure in the PREVIOUS shape, which is indistinguishable from a run under the new contract
 * — exactly the live confusion #977 was filed from. So a machine below this is refused BEFORE
 * dispatch, naming the update, rather than silently producing the older behaviour (`apply.ts`
 * `runnerContractProblem`).
 *
 * ── Why it moved to 0.4.89 (#994)
 *
 * #994 makes a post-click confirmation observable and recognises SEEK's "application sent"
 * receipt wording. It also carries only closed-vocabulary evidence when a pressed submit remains
 * unconfirmed. Those changes live in `packages/browser-runner`, which ships INSIDE the published
 * CLI. A machine below this floor cannot provide that evidence, so it must not silently look
 * equivalent to a current runner.
 *
 * A behaviour change in the runner is a CONTRACT change, because the cloud's decisions assume it.
 * So this floor moves with it: a machine that cannot observe a post-submit receipt is refused
 * with a sentence that says so, rather than reporting an unhelpful `submit_unconfirmed` state.
 *
 * Bump this when the runner's half of the contract changes again, together with the CLI version
 * that ships it — `policy.test.ts` pins the pair, so the floor cannot name a release that has not
 * been published. `cliAtLeast` treats an unreported version as capable, which is the convention
 * every MIN_CLI gate here follows.
 */
export const LOCAL_APPLY_CONTRACT_MIN_CLI = "0.4.89";

export type LocalApplyDiagnosticCause = "bridge_unused" | "engine_exited_nonzero" | "timed_out" | "no_engine_output" | "submit_unconfirmed";
export const LOCAL_APPLY_DIAGNOSTIC_CAUSES: readonly LocalApplyDiagnosticCause[] = ["bridge_unused", "engine_exited_nonzero", "timed_out", "no_engine_output", "submit_unconfirmed"];

/**
 * WHY a submission was taken as confirmed — an id, never the text or URL that matched (#994).
 *
 * `page_text` is the site's own success wording; `url_receipt` is a confirmation URL the click
 * navigated TO (an unchanged one is the form, not a receipt); `already_applied_notice` is the
 * site's duplicate notice appearing only after this click, which is that site reporting the
 * application it has just taken. Every one is comparative or textual evidence the RUNNER verified
 * on the machine — the CLI cannot assert any of them as prose.
 */
export type LocalApplyConfirmationMarker = "page_text" | "url_receipt" | "already_applied_notice";
export const LOCAL_APPLY_CONFIRMATION_MARKERS: readonly LocalApplyConfirmationMarker[] = ["page_text", "url_receipt", "already_applied_notice"];

/**
 * Observations the runner may report, each an id this platform defines — not the text that matched.
 *
 *   approval_policy_blocked  the CLI refused the bridge for its own approval policy (#952's live
 *                            failure: "the browser bridge required approval, but this session's
 *                            approval policy is `never`"). The single most useful signal, because
 *                            it is invisible from the cloud and fixable by configuration.
 *   bridge_tools_missing     the CLI never saw the bridge toolset at all.
 *   auth_prompt              the CLI stopped on a sign-in prompt.
 *   no_output                the CLI printed nothing a parser could read.
 *   engine_refused_task      the CLI declined the task in its closing message.
 */
export type LocalApplySignal =
	| "approval_policy_blocked"
	| "bridge_tools_missing"
	| "auth_prompt"
	| "no_output"
	| "engine_refused_task"
	// #994 — what was seen after a submit that was pressed and not confirmed. They distinguish the
	// three cases an owner acts on differently: the page never moved (the click may not have
	// landed), it moved but said nothing this platform's vocabulary knows (a wording to add), or it
	// could not be read at all.
	| "confirmation_no_marker"
	| "confirmation_page_unreadable"
	| "confirmation_url_changed"
	| "confirmation_url_unchanged"
	| "confirmation_title_changed";
export const LOCAL_APPLY_SIGNALS: readonly LocalApplySignal[] = [
	"approval_policy_blocked",
	"bridge_tools_missing",
	"auth_prompt",
	"no_output",
	"engine_refused_task",
	"confirmation_no_marker",
	"confirmation_page_unreadable",
	"confirmation_url_changed",
	"confirmation_url_unchanged",
	"confirmation_title_changed",
];

export interface LocalApplyDiagnostic {
	cause: LocalApplyDiagnosticCause;
	/** Bridge tool calls the run made. 0 is the finding. */
	bridgeCalls: number;
	/** The CLI's exit code. */
	engineExit: number;
	/** How long the engine actually ran, ms — "exited after 51s having done nothing". */
	activeMs: number;
	/** Pages the bridge admitted, and fields it filled: 0/0 beside a non-zero activeMs is the shape of this bug. */
	pages: number;
	filled: number;
	signals: LocalApplySignal[];
}


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
	/** Why nothing reached the page (#975). Present only when there is something to diagnose. */
	diagnostic?: LocalApplyDiagnostic;
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

// `rule` is on this list from #989: the runner has emitted WHICH rule classified a click as the
// submit since #985, and this whitelist silently dropped it — so the one fact that tells "it
// refused the control that opens the form" from "it refused the real submit" never reached the
// cloud trace, which is where the live investigation needed it.
// `marker`, `looks`, `urlChanged` and `titleChanged` are #994's post-click evidence: a marker ID
// from `LOCAL_APPLY_CONFIRMATION_MARKERS`, how many times the page was read, and whether it moved.
// Each is an id, a count or a boolean — the same whitelist rule as everything else here, so no page
// text and no typed value can ride along on a `submit.confirmed` / `submit.unconfirmed` event.
const DETAIL_KEYS = new Set(["engine", "authMode", "engineAuth", "mode", "class", "tool", "decision", "reason", "rule", "role", "kind", "path", "sha256", "bytes", "gateId", "exitCode", "count", "status", "basis", "source", "checkpointId", "directive", "phase", "actions", "filled", "uploaded", "marker", "looks", "urlChanged", "titleChanged"]);

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
			// #994: `marker` is a runner-defined confirmation ID, never the success sentence the
			// page displayed. Keep the closed vocabulary closed even if a compromised/outdated
			// runner tries to use this otherwise-string field as a prose channel.
			if (k === "marker") {
				const marker = oneOf(LOCAL_APPLY_CONFIRMATION_MARKERS, v);
				if (marker) detail[k] = marker;
				continue;
			}
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
	// #975 — accepted ONLY as the closed vocabulary it declares. A runner that sends prose here gets
	// it dropped rather than stored: the whole point of a structured diagnostic is that no new
	// free-text channel opens between the machine and the owner's records.
	const d = o.diagnostic && typeof o.diagnostic === "object" && !Array.isArray(o.diagnostic) ? (o.diagnostic as Record<string, unknown>) : null;
	const cause = d ? oneOf(LOCAL_APPLY_DIAGNOSTIC_CAUSES, d.cause) : null;
	if (d && cause) {
		const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : 0);
		out.diagnostic = {
			cause,
			bridgeCalls: count(d.bridgeCalls),
			engineExit: typeof d.engineExit === "number" && Number.isInteger(d.engineExit) && d.engineExit >= -1 && d.engineExit <= 255 ? d.engineExit : 0,
			activeMs: count(d.activeMs),
			pages: count(d.pages),
			filled: count(d.filled),
			// Deduped from a closed 5-value vocabulary, so it is bounded by the enum itself — no cap needed.
			signals: [...new Set((Array.isArray(d.signals) ? d.signals : []).filter((x): x is LocalApplySignal => LOCAL_APPLY_SIGNALS.includes(x as LocalApplySignal)))],
		};
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

// ── Which control is the FINAL submit, and which one opens the form (#985) ───────────────────

/**
 * ── The live failure
 *
 * Four consecutive fill-and-review runs on one SEEK posting ended `awaiting_review` with
 * `filled: 0`. The last of them (`286bbb8a…`, 2026-10-08) got everything right up to the last
 * step: the runner reported its `initial` checkpoint, the cloud's deterministic policy decided
 * `continue` (#982), the directive was delivered and acknowledged and the CLI resumed — and then,
 * three seconds later, the press that OPENS the application was classified as the final submit,
 * refused under `fill_and_review`, and the run ended at review having typed nothing.
 *
 * The cause was a borrowed vocabulary. The bridge tested the control's label against the runner's
 * `FALLBACK_COMMIT_RE` — the READ-ONLY floor, which matches bare `apply` deliberately, because for
 * an agent that may never act, refusing a filter button called "Apply" is the cheap error. For a
 * run whose entire capability is to fill the form it is the expensive one. The cloud's own
 * `commit-guard.ts` had already written the distinction down twice ("Apply/Next/Continue … are the
 * ENTRY button on most multi-page ATS"; the APPLY family is terminal "only after something has
 * been typed") — the apply bridge just had no list of its own to reach for.
 *
 * ── The three families, and why the order of the tests is the safety property
 *
 * 1. ONE-CLICK ({@link ONE_CLICK_SUBMIT_RE}) — "Quick apply", "Easy Apply", "Apply with your
 *    profile". On LinkedIn, and on a profile-apply SEEK listing, that control can send the
 *    application outright. Tested FIRST and always terminal, because the two families overlap in
 *    English and the overlap is only dangerous in one direction: reading "Quick apply" as an entry
 *    control is how an unapproved application reaches an employer.
 * 2. TERMINAL ({@link TERMINAL_APPLY_SUBMIT_RE}) — "Submit", "Send application", "Finish", in
 *    twenty languages: the control that sends what has been filled.
 * 3. ENTRY ({@link APPLY_ENTRY_RE}) — "Apply", "Apply for this job", "Next", "Continue", and their
 *    equivalents: the control that opens or advances the form. Only ever an entry while nothing has
 *    been entered yet and the control is not a POST submit; once a field is filled, the APPLY
 *    family becomes terminal again, which is the rule the cloud guard already states.
 *
 * Everything outside the three families is decided by the DOM, as before: a native POST submit is
 * a submit. The one case that changed is a POST submit labelled as a STEP with nothing filled yet
 * ("Save and continue" on page 1) — that stays walkable, because a multi-page ATS cannot be filled
 * otherwise, and the final page's control says SUBMIT.
 */
const applyWordish = (token: string) => `(?<![\\p{L}\\p{N}])${token}(?![\\p{L}\\p{N}])`;

/** A control that can SEND the application on its own. Terminal, whatever else it looks like. */
export const ONE_CLICK_SUBMIT_RE = new RegExp(
	[
		"quick apply|easy apply|instant apply|one[- ]?click|1[- ]?click|apply with (your )?(profile|r[ée]sum[ée]|cv|linkedin|indeed|seek)|apply using (your )?profile",
		...["schnellbewerbung", "postulation rapide", "candidatura rapida", "snelle sollicitatie"].map(applyWordish),
		...["快速申请", "簡単応募", "간편지원"],
	].join("|"),
	"iu",
);

/** The control that SENDS a filled application. Mirrors the cloud guard's terminal English set. */
export const TERMINAL_APPLY_SUBMIT_RE = new RegExp(
	[
		"\\b(submit|finish|done|complete|confirm)\\b|send application|submit application|send my application",
		...[
			"envoyer", "soumettre", "valider", "finaliser", "terminer", "confirmer",
			"absenden", "abschicken", "senden", "einreichen", "best[äa]tigen", "abschlie[sß]en", "fertigstellen",
			"enviar", "confirmar", "finalizar", "completar", "submeter", "concluir",
			"invia", "inviare", "conferma", "confermare", "completa", "termina", "finalizza",
			"verstuur", "versturen", "verzenden", "indienen", "bevestig", "bevestigen", "voltooien", "afronden",
			"skicka", "sende", "bekr[äae]fta", "bekreft", "bekr[æa]ft", "slutf[öo]r", "fullf[øo]r", "afslut",
			"wy[śs]lij", "z[łl]ó[żz]", "potwierd[źz]", "zako[ńn]cz", "odeslat", "potvrdit", "dokon[čc]it",
			"g[öo]nder", "onayla", "tamamla", "kirim", "kirimkan", "ajukan", "konfirmasi",
			"g[ửu]i", "n[ộo]p", "отправить", "подтвердить", "завершить", "подать",
		].map(applyWordish),
		...["提交", "送出", "确认", "確認", "完成", "送信", "提出", "完了", "제출", "보내기", "확인", "완료", "إرسال", "تقديم", "تأكيد"],
	].join("|"),
	"iu",
);

/** The control that OPENS or ADVANCES the form — never the one that sends it. */
export const APPLY_ENTRY_RE = new RegExp(
	[
		"\\b(apply|apply now|apply for this job|apply for this role|view (and )?apply|start( your)? application|begin( your)? application|next|continue|save and continue|start)\\b",
		...["postuler", "candidater", "bewerben", "candidati", "solliciteer", "aplikuj", "aplicar", "postular", "candidatar", "ans[øo]g", "başvur", "lamar", "откликнуться"].map(applyWordish),
		...["申请", "应聘", "応募する", "応募", "지원하기", "التقديم"],
	].join("|"),
	"iu",
);

/** What the application bridge may do with one click. */
export type ApplyClickClass =
	/** The final submit: gated by the run's policy, and refused under fill_and_review. */
	| "submit"
	/** Opens or advances the form: allowed, counted as a page move, and re-checkpointed after. */
	| "entry"
	/** A within-form step (Next, Upload, Add) that does not submit. */
	| "step"
	/** Not a control an application run may press. */
	| "other";

/** What the bridge knows about one click when it classifies it. */
export interface ApplyClickInput {
	/** The accessibility role from the snapshot the CLI decided from. */
	role: string;
	/** Every name the click came with: the page's, the snapshot's, the CLI's claim. */
	names: Array<string | undefined>;
	/** Does the DOM say this control submits a form, and with what method? Null when unprobeable. */
	submits: boolean;
	method: string;
	/** Fields filled and artifacts uploaded SO FAR — the state that makes the APPLY family terminal. */
	filled: number;
	uploaded: number;
}

/**
 * Classify one click. PURE, so the rule that decides whether a real application is sent is
 * assertable without a browser — and identical in both copies of this file.
 *
 * Order is the specification: one-click first (it can send), then terminal, then the DOM's own
 * verdict once anything has been entered, then entry/step.
 */
export function classifyApplyClick(input: ApplyClickInput): { klass: ApplyClickClass; reason: string } {
	const names = input.names.map((n) => (n ?? "").trim()).filter((n) => n.length > 0);
	const hit = (re: RegExp) => names.find((n) => re.test(n));
	const entered = input.filled > 0 || input.uploaded > 0;

	const oneClick = hit(ONE_CLICK_SUBMIT_RE);
	if (oneClick) return { klass: "submit", reason: "one_click_apply" };
	const terminal = hit(TERMINAL_APPLY_SUBMIT_RE);
	if (terminal) return { klass: "submit", reason: "terminal_label" };
	// A native POST submit, once something HAS been entered: there is an application to send, so
	// the benefit of the doubt goes to the employer rather than to the run.
	if (input.submits && input.method === "post" && entered) return { klass: "submit", reason: "post_submit_after_fill" };
	const entry = hit(APPLY_ENTRY_RE);
	// Nothing entered yet: an APPLY/NEXT control opens the form. This is the press that ended four
	// live runs at `filled: 0` — and it cannot be the final submit, because nothing has been typed.
	if (entry && !entered) return { klass: "entry", reason: input.submits ? "entry_post_form_nothing_filled" : "entry_label_nothing_filled" };
	if (entry) return { klass: "step", reason: "step_after_fill" };
	// A POST submit with no recognised label and nothing entered is a page-advance on a multi-page
	// form; with something entered it was caught above.
	if (input.submits && input.method === "post") return { klass: "step", reason: "post_submit_nothing_filled" };
	return { klass: "other", reason: "unrecognised" };
}
