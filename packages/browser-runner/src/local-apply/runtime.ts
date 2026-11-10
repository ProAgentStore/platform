import { finalAnswerLease, finalAnswerPageAvailable, finalAnswerTimeout, finalAnswerUnavailable, readFinalAnswerPage, resumeAnswerSources, type FinalAnswerLease, type FinalAnswerPauseOptions } from "./final-answer-wait.js";
import { reviewApprovalFailure, sameReviewAuthorization, validateReviewAuthorization, type ReviewApprovalLease } from "./review-approval.js";
import { parseToolAccess, FULL_SUBMISSION_UNKNOWN } from "./full-tools.js";
import { parseEscalationLevel } from "./answer-decision.js";
import { parseOwnerFacts } from "./owner-facts.js";
import { executionEvidence } from "./execution-evidence.js";
import { CodexModelObserver } from "../local-browser/model-observation.js";
import { modelConfigurationProblem, requestedModelEvidence } from "../local-browser/model-config.js";
import type { BrowserStateObservation } from "../browser-state-contract.js";
/**
 * Local application execution on the runner (#957) — the Job Application Runner's hands.
 *
 * One run = one Codex or Claude Code process, signed in on this machine, filling ONE application
 * through the apply bridge (bridge.ts) in a real browser. The runtime owns what PAGS later pulls
 * with `status`, as local browser research does (`local-browser/runtime.ts`):
 *
 *  - idempotency: a start with a requestId this runner already holds returns that run, so a
 *    replayed materials_ready event can never fill — or upload, or submit — a second time;
 *  - one active application run per instance;
 *  - the owner's answer sources and approved artifacts, read and hashed HERE before the CLI starts.
 *    An artifact whose hash no longer matches what #956 reported is refused, not uploaded;
 *  - pauses: the bridge holds a call until `resume` (with the owner's answer or a newly allowed
 *    site), cancel, or the time limit — active time only, so waiting on the owner is not counted;
 *  - the result: `awaiting_review`, `submitted` (only with the site's confirmation), `blocked`
 *    with the reason, or `failed`.
 *
 * Active runs live in memory: a runner restart loses them, and `status` answers 404, which PAGS
 * reads as "the runner lost this run". Terminal typed/redacted results are journaled locally so a
 * restart after completion does not erase observed evidence before PAGS pulls it.
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { RunnerInputError } from "../errors.js";
import type { BrowserCallsPage } from "../browser-call-recorder.js";
import { isHomeRelative, isWorkspaceRelative } from "../local-artifact/contract.js";
import { type BrowserTools, domainWithin } from "../local-browser/bridge.js";
import { BRIDGE_ENV } from "../local-browser/bridge-stdio.js";
import { redactText, secretEnvValues } from "../local-browser/contract.js";
import { redactReplayText } from "./apply-replay.js";
import { finalText, missingLogin, signInHelp } from "../local-browser/engine.js";
import { Blocked, clearCloudDocuments, parseCloudDocuments } from "./documents.js";
import { ApplyBridge } from "./bridge.js";
import { validatePreferences } from "../instance-preferences.js";
import type { DocumentPdfRenderer } from "./document-pdf.js";
import { DocumentPreflightRefusal, prepareApplySources } from "./preflight.js";
import { resumeDomainGrants } from "./resume-domains.js";
import { parseBrowserWebsiteAccess, websiteDecision, websiteResumePolicy, websiteAccessBlock, type BrowserWebsiteAccess } from "../browser-website-access.js";
import { claimApplyStart, rememberApplyStart } from "./start-claim.js";
import { siteKeyOf, type SiteSessionLedger } from "./site-session.js";
import { APPLY_SHOT_CAP, ShotRecorder, type ReplayShotsPage } from "../local-browser/replay.js";
import { confirmationSignals } from "./confirmation.js";
import { listingUnavailableReason } from "./unavailable.js";
import {
	type LocalApplySignal,
	type LocalApplyDiagnosticCause,
	type LocalApplyDiagnostic,
	LOCAL_APPLY_AUTH_MODES,
	LOCAL_APPLY_CAPS,
	LOCAL_APPLY_ENGINES,
	LOCAL_APPLY_MODES,
	LOCAL_APPLY_SIGN_IN_SECRET_NAMES,
	LOCAL_APPLY_TASK_TYPE,
	type LocalApplySignInSecretName,
	type LocalApplySignInSecretsRequest,
	type LocalApplyArtifact,
	type LocalApplyDirectiveRequest,
	type LocalApplyEngineAuth,
	type LocalApplyEvent,
	type LocalApplyPause,
	type LocalApplyPreflightResult,
	type LocalApplyPreflightFailure,
	type LocalApplyProfile,
	type LocalApplyResultEnvelope,
	type LocalApplyRunnerEvent,
	type LocalApplySource,
	type LocalApplyStatusResponse,
	type LocalApplySupervisorCheckpoint,
	type LocalApplySupervisorDirective,
	type LocalApplyTaskEnvelope,
	parseLocalApplyResult,
	traceUrl,
} from "./contract.js";
import type { LocalApplyHandoffStatus } from "./handoff-contract.js";
import { type SourceBlock, applyPrompt, buildApplyEngineSpec, observedApplyAuth } from "./engine.js";
import { LocalApplyHandoffRuntime, type LocalApplyTakeoverAdapter } from "./runtime-handoff.js";
import { requestOwnerPause } from "./owner-pause.js";
import { killApplyEngine } from "./engine-process.js";

/** The run browser's native secret placeholders (#1412) — what `McpRuntime` provides. */
export interface SecretStore {
	provideSecrets(map: Record<string, string>): void;
	clearSecrets(): void;
	secretNames(): string[];
}

export interface RunBrowser {
	tools: BrowserTools;
	/** Absent on a browser that cannot take placeholders (a test stub): the sign-in secrets route refuses. */
	secrets?: SecretStore;
	stop(): Promise<void>;
	/** The currently live page in this run's own browser context, if it has one. */
	handoffPage?(): Page | null;
	/** This profile's site sign-in ledger (#1094): names and expiry of session cookies, never values. */
	sessions?: SiteSessionLedger;
}

export interface LocalApplyRuntimeDeps {
	/** Tests/embedders may supply an offline PDF renderer; output must still be a complete PDF. */
	renderPdf?: DocumentPdfRenderer;
	dataDir: string;
	selfUrl(): string | null;
	browserFor(profile: LocalApplyProfile, runDir: string): Promise<RunBrowser>;
	spawn?: typeof nodeSpawn;
	now?: () => number;
	homeDir?: string;
	retentionMs?: number;
	bridgeScript?: string;
	takeover?: LocalApplyTakeoverAdapter;
	handoffTtlMs?: number;
}

const MAX_EVENTS = 1000;
const OUTPUT_LINES = 400;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,300}$/;
const HASH = /^[a-f0-9]{64}$/;
/** One application at a time per agent: two runs on one employer's form is how duplicates happen. */
const MAX_ACTIVE = 1;
/** Ordinary immediate questions park; only the final-review answer handoff retains a bounded live session. */
const PARKABLE_PAUSES: ReadonlySet<LocalApplyPause["reason"]> = new Set(["missing_answer", "screening_ambiguity"]);
/** How a pause ends: the owner resumed, the run stopped, or the cloud provisioned sign-in secrets (#1412). */
/** What the agent can ask the cloud broker to provision mid sign-in (#1412 the emailed code; #1619 a generated new password and a mailbox link). */
type SignInRequest = "code" | "newPassword" | "link";
export type PauseOutcome = "resumed" | "stopped" | "sign_in";
/** How long the CLI's `request_sign_in_code` waits for the cloud to read the mailbox — the cloud's own code wait. */
const SIGN_IN_CODE_WAIT_MS = 5 * 60_000;

interface Run {
	documentPreparation?: AbortController;
	envelope: LocalApplyTaskEnvelope;
	dir: string;
	token: string;
	state: "running" | "paused" | "ended";
	pause?: LocalApplyPause;
	events: LocalApplyRunnerEvent[];
	seq: number;
	result?: LocalApplyResultEnvelope;
	child?: ChildProcess;
	browser?: RunBrowser;
	bridge?: ApplyBridge;
	/** Replay frames (#1063), form controls blurred, in memory until the cloud pulls them. */
	shots: ShotRecorder;
	allow: Set<string>;
	/** Source text, approved materials and the owner's answers — what a value may be grounded in. */
	grounding: SourceBlock[];
	secrets: string[];
	/** The agent-driven sign-in in progress (#1412): the NAMES provisioned, never a value. */
	signIn?: { origin: string; names: LocalApplySignInSecretName[]; requested: Set<SignInRequest>; link?: string; linkDelivered: boolean; waiters: Array<{ kind: SignInRequest; done: (ok: boolean) => void }> };
	activeSince: number;
	activeMs: number;
	waiters: Array<(outcome: PauseOutcome) => void>;
	output: string[];
	engineAuth: LocalApplyEngineAuth;
	cancelled: boolean;
	timedOut: boolean;
	/** Directives are recorded before they can release a checkpoint, including a delivery-before-wait race. */
	checkpoints: Map<string, { checkpoint?: LocalApplySupervisorCheckpoint; directive?: LocalApplySupervisorDirective }>;
	endedAt?: number;
	timer?: ReturnType<typeof setInterval>;
	handoff?: { handoffRequestId?: string; handoffId: string; expiresAt: number; state: "ready" | "closed"; terminalReason?: import("./handoff-contract.js").LocalApplyHandoffTerminalReason };
	ownerPauseReady?: boolean;
	finalAnswerLease?: FinalAnswerLease;
	reviewApprovalLease?: ReviewApprovalLease;
}

/**
 * The only runner state that survives a process restart.  In particular this deliberately does
 * not include CLI output, source text, answers, browser snapshots, or the bridge token.  The
 * cloud already has a typed/redacted result contract; retaining that contract locally lets it
 * fetch an outcome which completed just before the runner was updated or restarted.
 */
interface TerminalJournal {
	version: 1;
	envelope: LocalApplyTaskEnvelope;
	events: LocalApplyRunnerEvent[];
	seq: number;
	result: LocalApplyResultEnvelope;
	endedAt: number;
}

const posInt = (v: unknown, max: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean) : []);

/** The envelope, validated at the runner's boundary. */
export function parseApplyEnvelope(raw: unknown): LocalApplyTaskEnvelope {
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const bad = (what: string) => new RunnerInputError(`Invalid application task: ${what}`);
	if (o.type !== LOCAL_APPLY_TASK_TYPE) throw bad(`type must be ${LOCAL_APPLY_TASK_TYPE}`);
	for (const k of ["runId", "requestId", "instanceId", "applicationId"]) if (typeof o[k] !== "string" || !SAFE_ID.test(o[k] as string)) throw bad(`${k} is required`);
	if (!/^[A-Za-z0-9_-]{1,100}$/.test(o.runId as string)) throw bad("runId must be a plain id");
	if (!LOCAL_APPLY_ENGINES.includes(o.engine as never)) throw bad("engine must be claude or codex");
	const modelProblem = modelConfigurationProblem(o as { engine: unknown });
	if (modelProblem) throw bad(modelProblem);
	if (!LOCAL_APPLY_AUTH_MODES.includes(o.authMode as never)) throw bad("authMode must be machine or subscription — a provider API key is never used");
	if (o.browserProfile !== "isolated" && o.browserProfile !== "default") throw bad("browserProfile must be isolated or default");
	if (typeof o.applicationUrl !== "string" || !/^https?:\/\/[^\s/]+/i.test(o.applicationUrl) || o.applicationUrl.length > 2000) throw bad("applicationUrl must be an http(s) URL");
	const job = (o.job && typeof o.job === "object" ? o.job : {}) as Record<string, unknown>;
	if (typeof job.title !== "string" || !job.title.trim()) throw bad("job.title is required");
	if (typeof o.workspace !== "string" || !isHomeRelative(o.workspace)) throw bad('workspace must be a folder written "~/…"');
	const sources: LocalApplySource[] = [];
	for (const s of Array.isArray(o.sources) ? o.sources.slice(0, 4) : []) {
		const r = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
		if ((r.role !== "profile" && r.role !== "answers") || typeof r.path !== "string" || !isWorkspaceRelative(r.path) || r.path.split("/")[0] === "applications") throw bad("each source needs a role (profile, answers) and a path inside the workspace");
		sources.push({ role: r.role, path: r.path });
	}
	const artifacts: LocalApplyArtifact[] = [];
	for (const a of Array.isArray(o.artifacts) ? o.artifacts.slice(0, 2) : []) {
		const r = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
		if ((r.kind !== "resume" && r.kind !== "cover_letter") || typeof r.path !== "string" || !isHomeRelative(r.path) || typeof r.sha256 !== "string" || !HASH.test(r.sha256)) throw bad("each artifact needs a kind, a ~/ path and a sha256");
		if (artifacts.some((x) => x.kind === r.kind)) throw bad(`artifact ${r.kind} is listed twice`);
		artifacts.push({ kind: r.kind, path: r.path, sha256: r.sha256 });
	}
	const p = (o.policy && typeof o.policy === "object" ? o.policy : {}) as Record<string, unknown>;
	if (p.browserCommandTimeoutSeconds !== undefined && !posInt(p.browserCommandTimeoutSeconds, 3600)) throw bad("policy.browserCommandTimeoutSeconds must be a whole number from 1 to 3600 seconds");
	if (!LOCAL_APPLY_MODES.includes(p.mode as never)) throw bad("policy.mode must be fill_and_review or auto_submit");
	const gate = (p.submitGate && typeof p.submitGate === "object" ? p.submitGate : null) as Record<string, unknown> | null;
	const gateId = gate && typeof gate.gateId === "string" && SAFE_ID.test(gate.gateId) ? gate.gateId : null;
	// auto_submit without the gate PAGS evaluated is not a mode this runner will run.
	if (p.mode === "auto_submit" && !gateId) throw bad("auto_submit requires policy.submitGate");
	const allowDomains = strList(p.allowDomains);
	const browserWebsiteAccess = parseBrowserWebsiteAccess(p.browserWebsiteAccess);
	if (!allowDomains.length && !browserWebsiteAccess) throw bad("policy.allowDomains must name the application's site");
	const l = (o.limits && typeof o.limits === "object" ? o.limits : {}) as Record<string, unknown>;
	const limits = { maxMinutes: posInt(l.maxMinutes, 60) ?? 0, maxPages: posInt(l.maxPages, 200) ?? 0, maxActions: posInt(l.maxActions, 1000) ?? 0 };
	if (Object.values(limits).some((v) => !v)) throw bad("limits are out of range");
	const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : undefined);
	// #1079: the owner's kept answers, within a resume's bounds — never an instruction. One over a bound is
	// dropped, never cut: a shortened answer would be grounding the owner never wrote.
	const ownerAnswers: Array<{ question: string; answer: string }> = [];
	for (const a of Array.isArray(o.ownerAnswers) ? o.ownerAnswers : []) {
		if (ownerAnswers.length >= LOCAL_APPLY_CAPS.answers) break;
		const r = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
		const question = typeof r.question === "string" ? r.question.trim() : "";
		const answer = typeof r.answer === "string" ? r.answer.trim() : "";
		if (question && answer && question.length <= LOCAL_APPLY_CAPS.questionChars && answer.length <= LOCAL_APPLY_CAPS.answerChars) ownerAnswers.push({ question, answer });
	}
	return {
		type: LOCAL_APPLY_TASK_TYPE,
		runId: o.runId as string,
		requestId: o.requestId as string,
		instanceId: o.instanceId as string,
		applicationId: o.applicationId as string,
		engine: o.engine as LocalApplyTaskEnvelope["engine"],
		...(o.model !== undefined ? { model: o.model as string | null } : {}),
		...(o.reasoningEffort !== undefined ? { reasoningEffort: o.reasoningEffort as string | null } : {}),
		authMode: o.authMode as LocalApplyTaskEnvelope["authMode"],
		browserProfile: o.browserProfile,
		applicationUrl: o.applicationUrl,
		job: { title: job.title.trim().slice(0, 300), company: opt(job.company), location: opt(job.location) },
		workspace: o.workspace,
		sources,
		artifacts,
		...(o.cloudDocuments !== undefined ? { cloudDocuments: parseCloudDocuments(o.cloudDocuments, artifacts) } : {}),
		policy: { ...parseToolAccess(p, o.instanceId as string), ...(p.accountOperations === true ? { accountOperations: true } : {}), ...(p.browserCommandTimeoutSeconds !== undefined ? { browserCommandTimeoutSeconds: p.browserCommandTimeoutSeconds as number } : {}), mode: p.mode as LocalApplyTaskEnvelope["policy"]["mode"], escalationLevel: parseEscalationLevel(p.escalationLevel), allowDomains, ...(browserWebsiteAccess ? { browserWebsiteAccess } : {}), ...(p.mode === "auto_submit" && gateId ? { submitGate: { gateId } } : {}), ...(p.screenshots === false ? { screenshots: false as const } : {}), blurFormFields: p.blurFormFields !== false },
		limits,
		...(ownerAnswers.length ? { ownerAnswers } : {}),
		...(o.ownerFacts !== undefined ? { ownerFacts: parseOwnerFacts(o.ownerFacts, { instanceId: o.instanceId as string, applicationId: o.applicationId as string, runId: o.runId as string }) } : {}),
		...(o.instancePreferences !== undefined ? { instancePreferences: validatePreferences(o.instancePreferences, o.instanceId as string) } : {}),
	};
}

/**
 * What to tell the owner when the CLI put nothing on the page (#975) — built from the diagnostic's
 * own ids, so the advice follows the observation rather than guessing at it.
 */
function bridgeUnusedHelp(engine: string, d: LocalApplyDiagnostic): string {
	if (d.signals.includes("approval_policy_blocked")) return `The ${engine} CLI would not use the browser tools because its own approval policy refused them. Allow the PAGS bridge toolset for this session, then retry.`;
	if (d.signals.includes("bridge_tools_missing")) return `The ${engine} CLI never saw the browser tools. Update the CLI (npm i -g @proagentstore/cli), run \`pags up\` again, then retry.`;
	if (d.signals.includes("auth_prompt")) return `The ${engine} CLI stopped on a sign-in prompt before opening the page. Sign it in on this machine, then retry.`;
	if (d.signals.includes("no_output")) return `The ${engine} CLI produced no output at all before exiting. Check that it runs on this machine, then retry.`;
	if (d.signals.includes("engine_refused_task")) return `The ${engine} CLI declined the task and never opened the page. Its own closing message is on this run's summary.`;
	return `The ${engine} CLI ran for ${Math.round(d.activeMs / 1000)}s and exited (code ${d.engineExit}) without opening the application page — no navigation, no checkpoint, no fill. Nothing was submitted. Retry, or run the CLI by hand on this machine to see why it stops.`;
}

export class LocalApplyRuntime {
	private readonly runs = new Map<string, Run>();
	private readonly handoffs: LocalApplyHandoffRuntime<Run>;

	/** Application fills that a restart would lose (#896) — their state is in this process. */
	browserBusy(instanceId: string): boolean { return [...this.runs.values()].some((r) => r.envelope.instanceId === instanceId && r.state !== "ended"); }

	liveWork(): string[] {
		return [...this.runs.values()].filter((r) => r.state !== "ended").map((r) => `an application fill (${r.envelope.applicationId.slice(0, 8)})`);
	}
	private readonly root: string;
	private readonly startClaimsRoot: string;
	private readonly now: () => number;
	private readonly spawn: typeof nodeSpawn;
	private readonly retentionMs: number;

	constructor(private readonly deps: LocalApplyRuntimeDeps) {
		this.root = join(deps.dataDir, "local-apply");
		// Id-only start claims outlive scratch/profile retention; deleting them would permit replay.
		this.startClaimsRoot = join(deps.dataDir, "local-apply-start-claims");
		this.now = deps.now ?? Date.now;
		this.spawn = deps.spawn ?? nodeSpawn;
		this.retentionMs = deps.retentionMs ?? 24 * 60 * 60 * 1000;
		this.handoffs = new LocalApplyHandoffRuntime({ get: (runId) => this.get(runId), now: this.now, takeover: deps.takeover, handoffTtlMs: deps.handoffTtlMs });
		this.hydrateTerminalJournals();
	}

	/**
	 * Read a specific job page before an email alert can cause any materials to be generated.
	 * This deliberately creates no application run, launches no CLI, and never clicks/fills: the
	 * only evidence it returns is a closed, redacted vocabulary the API can durably record.
	 */
	async preflight(raw: unknown, websitePolicy?: BrowserWebsiteAccess): Promise<LocalApplyPreflightResult> {
		const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
		const jobUrl = typeof input.jobUrl === "string" ? input.jobUrl.trim() : "";
		let parsed: URL;
		try {
			parsed = new URL(jobUrl);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
		} catch {
			return { state: "unverifiable", jobUrl, reason: "navigation_failed" };
		}
		const blockedWebsite = websitePolicy ? websiteAccessBlock(websitePolicy, parsed.toString()) : null;
		if (blockedWebsite) return { state: "unverifiable", jobUrl: parsed.toString(), reason: "access_blocked", websiteAccess: blockedWebsite };
		const profile = input.browserProfile === "default" ? "default" : "isolated";
		const dir = join(this.root, "preflight", randomBytes(12).toString("hex"));
		let browser: RunBrowser | null = null;
		try {
			browser = await this.deps.browserFor(profile, dir);
			browser.tools.setCallPolicy?.({ websiteAccess: () => websitePolicy, guard: { mode: "read_only" } });
			const navigated = await browser.tools.callTool("browser_navigate", { url: parsed.toString() });
			if (navigated.isError) return { state: "unverifiable", jobUrl: parsed.toString(), reason: navigated.websiteAccess ? "access_blocked" : "navigation_failed", ...(navigated.websiteAccess ? { websiteAccess: navigated.websiteAccess } : {}) };
			const snapshot = await browser.tools.callTool("browser_snapshot");
			if (snapshot.websiteAccess) return { state: "unverifiable", jobUrl: parsed.toString(), reason: "access_blocked", websiteAccess: snapshot.websiteAccess };
			const page = (snapshot.content ?? []).map((part) => part.text ?? "").join("\n");
			if (snapshot.isError || /captcha|verify (?:you(?:'| a)re|that you are) human|access denied|unusual traffic|checking (?:if )?your browser/i.test(page)) {
				return { state: "unverifiable", jobUrl: parsed.toString(), reason: "access_blocked" };
			}
			const gone = listingUnavailableReason(page);
			if (gone) return { state: "unavailable", jobUrl: parsed.toString(), reason: gone };
			// An accessible Apply control is an active path, unlike a generic careers/search URL.
			if (/(?:button|link)\s+"[^"]{0,80}\bapply(?: now| for| here)?\b|\bapply (?:now|for (?:this )?(?:job|role|position))\b|\bstart application\b/i.test(page)) {
				const title = page.match(/^\s*-?\s*Page Title:\s*(.+)$/m)?.[1]?.trim().slice(0, 300); // names a posting pasted with none (#1098)
				return { state: "live", jobUrl: parsed.toString(), applyUrl: parsed.toString(), evidence: "apply_control_present", ...(title ? { title } : {}) };
			}
			return { state: "unverifiable", jobUrl: parsed.toString(), reason: "no_active_apply_path" };
		} catch {
			return { state: "unverifiable", jobUrl: parsed.toString(), reason: "navigation_failed" };
		} finally {
			await browser?.stop().catch(() => undefined);
		}
	}

	private journalPath(dir: string): string {
		return join(dir, "terminal-result.json");
	}

	/** Write-before-return: a terminal result is durable before `status` can expose it. */
	private persistTerminal(run: Run): void {
		if (!run.result || !run.endedAt) return;
		const journal: TerminalJournal = { version: 1, envelope: run.envelope, events: run.events, seq: run.seq, result: run.result, endedAt: run.endedAt };
		const path = this.journalPath(run.dir);
		const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
		writeFileSync(tmp, JSON.stringify(journal), { mode: 0o600 });
		renameSync(tmp, path);
	}

	/** Hydrate terminal-only records. Interrupted runs remain deliberately unrecoverable. */
	private hydrateTerminalJournals(): void {
		if (!existsSync(this.root)) return;
		for (const instance of readdirSync(this.root)) {
			const instanceDir = join(this.root, instance);
			let runIds: string[];
			try { runIds = readdirSync(instanceDir); } catch { continue; }
			for (const runId of runIds) {
				const dir = join(instanceDir, runId);
				const path = this.journalPath(dir);
				if (!existsSync(path)) continue;
				try {
					const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TerminalJournal>;
					if (raw.version !== 1 || !raw.envelope || !raw.result || !Array.isArray(raw.events) || typeof raw.seq !== "number" || typeof raw.endedAt !== "number") continue;
					const envelope = parseApplyEnvelope(raw.envelope);
					const parsed = parseLocalApplyResult(raw.result);
					if ("error" in parsed || parsed.result.runId !== envelope.runId) continue;
					const checked = parsed.result;
					this.runs.set(envelope.runId, {
						// Replay frames are memory-only by design (#1063): a run reloaded after a restart has none.
						envelope, dir, token: "", state: "ended", events: raw.events as LocalApplyRunnerEvent[], seq: raw.seq, shots: new ShotRecorder(0),
						result: checked, allow: new Set(envelope.policy.allowDomains), grounding: [], secrets: [], activeSince: raw.endedAt,
						activeMs: 0, waiters: [], output: [], engineAuth: checked.engineAuth, cancelled: false, timedOut: false,
						checkpoints: new Map(), endedAt: raw.endedAt,
					});
				} catch { /* a corrupt local cache is never an authority */ }
			}
		}
	}

	/** A known request may read its receipt while the same browser lease remains held. */
	hasRequest(raw: unknown): boolean {
		const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
		return [...this.runs.values()].some(({ envelope: e }) => e.instanceId === o.instanceId && e.requestId === o.requestId);
	}

	start(raw: unknown): { runId: string; taskId: string; status: Run["state"]; existing: boolean } {
		const envelope = parseApplyEnvelope(raw);
		this.sweep();
		const same = [...this.runs.values()].find((r) => r.envelope.instanceId === envelope.instanceId && r.envelope.requestId === envelope.requestId);
		if (same) return { runId: same.envelope.runId, taskId: same.envelope.runId, status: same.state, existing: true };
		if (this.runs.has(envelope.runId)) throw new RunnerInputError(`Run ${envelope.runId} already exists with another requestId`, 409);
		const active = [...this.runs.values()].filter((r) => r.envelope.instanceId === envelope.instanceId && r.state !== "ended").length;
		if (active >= MAX_ACTIVE) throw new RunnerInputError("This machine is already filling an application for this agent; one at a time.", 409);
		const selfUrl = this.deps.selfUrl();
		if (!selfUrl) throw new RunnerInputError("The runner is still starting; try again in a moment.", 409);

		const dir = join(this.root, envelope.instanceId.replace(/[^A-Za-z0-9_-]/g, "_"), envelope.runId);
		claimApplyStart(this.startClaimsRoot, dir, envelope);
		mkdirSync(join(dir, "scratch"), { recursive: true });
		const run: Run = {
			envelope,
			dir,
			token: randomBytes(24).toString("hex"),
			state: "running",
			events: [],
			// Screenshots off (#1064): zero cap for `/shots`, and no recorder handed to the bridge below.
			shots: new ShotRecorder(envelope.policy.screenshots === false ? 0 : APPLY_SHOT_CAP, () => this.now(), envelope.policy.blurFormFields),
			seq: 0,
			allow: new Set(envelope.policy.allowDomains),
			grounding: [],
			secrets: secretEnvValues(process.env),
			activeSince: this.now(),
			activeMs: 0,
			waiters: [],
			output: [],
			engineAuth: "unknown",
			cancelled: false,
			timedOut: false,
			checkpoints: new Map(),
		};
		this.runs.set(envelope.runId, run);
		void this.launch(run, selfUrl).catch((err) => {
			if (err instanceof Blocked) this.end(run, { outcome: "blocked", blockReason: err.reason, questions: err.questions });
			else this.end(run, { outcome: "failed", error: err instanceof Error ? err.message : String(err) });
		});
		return { runId: envelope.runId, taskId: envelope.runId, status: run.state, existing: false };
	}

	private async launch(run: Run, selfUrl: string): Promise<void> {
		const e = run.envelope;
		const home = this.deps.homeDir ?? homedir();
		run.documentPreparation = new AbortController();
		const documentSignal = AbortSignal.any([run.documentPreparation.signal, AbortSignal.timeout(Math.min(e.limits.maxMinutes * 60000, (e.policy.browserCommandTimeoutSeconds ?? 600) * 1000))]);
		let prepared: Awaited<ReturnType<typeof prepareApplySources>>;
		try { prepared = await prepareApplySources(e, run.dir, home, this.now(), (event) => this.emit(run, event), this.deps.renderPdf, documentSignal); }
		catch (error) {
			if (run.result) { clearCloudDocuments(e, run.dir); return; }
			if (!(error instanceof DocumentPreflightRefusal)) throw error;
			this.end(run, { outcome: "blocked", blockReason: error.reason, questions: error.questions }, error.receipt);
			return;
		}
		if (run.result) { clearCloudDocuments(e, run.dir); return; }
		delete run.documentPreparation;
		const { blocks, artifactPath } = prepared;
		run.grounding = blocks;
		const bridgeScript = this.deps.bridgeScript ?? fileURLToPath(new URL("../local-browser/bridge-stdio.js", import.meta.url));
		let spec = buildApplyEngineSpec(e, applyPrompt(e, blocks), { command: process.execPath, args: [bridgeScript], env: { [BRIDGE_ENV.url]: selfUrl, [BRIDGE_ENV.runId]: e.runId, [BRIDGE_ENV.token]: run.token } }, join(run.dir, "mcp.json"));
		run.secrets = secretEnvValues({ ...process.env, ...spec.env });
		run.engineAuth = observedApplyAuth(e.engine, spec.env);
		this.emit(run, { type: "engine.auth_checked", detail: { engine: e.engine, authMode: e.authMode, engineAuth: run.engineAuth, mode: e.policy.mode } });
		if (run.engineAuth === "api-key") throw new Blocked("api_key_refused", ["A provider API key would reach the CLI. Applications run on this machine's sign-in only — remove the key from the runner's environment."]);

		run.browser = await this.deps.browserFor(e.browserProfile, run.dir);
		if (run.cancelled || run.state === "ended") {
			await run.browser.stop();
			return;
		}
		if (e.policy.toolAccess === "full" && !run.browser.tools.configureToolAccess) throw new Error("This browser cannot expose full native tools.");
		if (e.policy.browserCommandTimeoutSeconds !== undefined && !run.browser.tools.configureCommandTimeout) throw new Error("This browser cannot configure its native command timeout.");
		run.browser.tools.configureCommandTimeout?.(e.policy.browserCommandTimeoutSeconds ?? 600);
		await run.browser.tools.configureToolAccess?.(e.policy.toolAccess ?? "guarded", run.dir);
		run.browser.tools.setSubject?.({ kind: "local_apply_run", id: e.runId });
		// Configured site families keep their subdomain scope. A temporary owner grant admits
		// only the exact paused hostname, never its descendants or another run's allowlist.
		const isAllowedDomain = (host: string) => e.policy.browserWebsiteAccess ? websiteDecision(e.policy.browserWebsiteAccess, host) === "allow" : e.policy.allowDomains.some((domain) => domainWithin(host, domain)) || run.allow.has(host);
		run.browser.tools.setCallPolicy?.({
			toolAccess: e.policy.toolAccess,
			approvedUploadPaths: () => e.artifacts.map(({ kind }) => { const approved = artifactPath(kind); if ("error" in approved) throw new Error(approved.error); return approved.path; }),
			isCancelled: () => run.cancelled || run.timedOut || run.state === "ended",
			isDomainAllowed: isAllowedDomain,
			requestDomainApproval: (url) => run.bridge?.admitDomain(url) ?? Promise.resolve(false),
			websiteAccess: () => e.policy.browserWebsiteAccess,
			requestWebsiteApproval: async (block) => { await run.bridge?.admitDomain(block.url); },
		});
		run.bridge = new ApplyBridge(run.browser.tools, {
			runId: e.runId,
			...(run.browser.tools.recover ? { recoverBrowser: () => run.browser!.tools.recover!() } : {}),
			emit: (ev) => this.emit(run, ev),
			pause: (p, options) => this.pause(run, p, options),
			beginFinalAnswerWait: (options) => { run.finalAnswerLease = finalAnswerLease(run.finalAnswerLease, options, readFinalAnswerPage(() => run.browser?.handoffPage?.())); },
			finishFinalAnswerWait: (key, expired) => { if (run.finalAnswerLease?.key === key) { const timeout = expired ? finalAnswerTimeout(run.finalAnswerLease, this.now(), run.bridge?.unresolvedQuestions ?? []) : null; if (timeout) this.end(run, timeout); delete run.finalAnswerLease; } },
			waitForReviewApproval: () => this.waitForReviewApproval(run),
			supervisorCheckpoint: (checkpointId) => this.supervisorCheckpoint(run, checkpointId),
			isAllowed: isAllowedDomain,
			websiteAccess: () => e.policy.browserWebsiteAccess,
			grounding: () => run.grounding.map((source) => source.text).join("\n"),
			groundingSources: () => run.grounding,
			instancePreferences: () => e.instancePreferences,
			artifactPath,
			resolveUploadPath: (path) => resolve(run.dir, path),
			overTime: () => this.activeMs(run) >= e.limits.maxMinutes * 60_000,
			isStopped: () => run.cancelled || run.timedOut || run.state === "ended",
			now: this.now,
			limits: e.limits,
			mode: e.policy.mode, escalationLevel: e.policy.escalationLevel, toolAccess: e.policy.toolAccess,
			gateId: e.policy.submitGate?.gateId,
			sessions: run.browser.sessions,
			signInSecrets: () => [...(run.signIn?.names ?? [])],
			requestSignInCode: () => this.awaitSignIn(run, "code"),
			accountOperations: e.policy.accountOperations === true,
			requestNewPassword: () => this.awaitSignIn(run, "newPassword"),
			openSignInLink: () => this.openSignInLink(run),
			signInDone: () => this.signInDone(run),
			page: () => run.browser?.handoffPage?.() ?? null,
			redact: (value) => redactReplayText(value, run.secrets),
		}, e.policy.screenshots === false ? undefined : run.shots);
		if (e.policy.toolAccess === "full") {
			const toolNames = (await run.bridge.listTools()).map((tool) => tool.name);
			spec = buildApplyEngineSpec(e, applyPrompt(e, blocks), { command: process.execPath, args: [bridgeScript], env: { [BRIDGE_ENV.url]: selfUrl, [BRIDGE_ENV.runId]: e.runId, [BRIDGE_ENV.token]: run.token } }, join(run.dir, "mcp.json"), toolNames);
			this.emit(run, { type: "policy.decision", detail: { toolAccess: "full", nativeToolCount: (await run.browser.tools.listTools()).length, decision: "owner_accepted" } });
		}
		if (spec.mcpConfig) writeFileSync(spec.mcpConfig.path, spec.mcpConfig.json, { mode: 0o600 });

		if (run.cancelled || run.endedAt !== undefined) return;
		const child = this.spawn(spec.command, spec.args, { cwd: join(run.dir, "scratch"), env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
		run.child = child;
		this.emit(run, { type: "engine.started", detail: { engine: e.engine, mode: e.policy.mode, ...requestedModelEvidence(e) } });
		const modelObserver = e.engine === "codex" ? new CodexModelObserver(spec.env.CODEX_HOME || join(spec.env.HOME || home, ".codex"), join(run.dir, "scratch"), this.now()) : null;
		const observeModel = () => { const detail = modelObserver?.read(); if (detail) this.emit(run, { type: "engine.model_observed", detail }); };
		let buf = "";
		const rememberOutput = (line: string) => run.output.push(line.length > 20_000 ? `${line.slice(0, 20_000)}…[truncated]` : line);
		const keep = (chunk: Buffer | string) => {
			buf += chunk.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) { rememberOutput(line); modelObserver?.acceptLine(line); }
			observeModel();
			if (run.output.length > OUTPUT_LINES) run.output.splice(0, run.output.length - OUTPUT_LINES);
		};
		child.stdout?.on("data", keep);
		child.stderr?.on("data", (chunk: Buffer | string) => { rememberOutput(chunk.toString()); if (run.output.length > OUTPUT_LINES) run.output.shift(); });
		child.on("error", (err: NodeJS.ErrnoException) => {
			this.end(run, { outcome: "failed", error: err.code === "ENOENT" ? `The ${e.engine === "claude" ? "Claude Code" : "Codex"} CLI is not installed on this machine (\`${spec.command}\` was not found).` : err.message });
		});
		child.on("close", (code) => {
			if (buf.trim()) { run.output.push(buf); modelObserver?.acceptLine(buf); }
			observeModel();
			this.emit(run, { type: "engine.ended", detail: { exitCode: code ?? -1 } });
			this.end(run, this.outcomeOf(run, code ?? -1));
		});
		run.timer = setInterval(() => {
			observeModel();
			const answerTimeout = finalAnswerTimeout(run.finalAnswerLease, this.now(), run.bridge?.unresolvedQuestions ?? []); if (answerTimeout) this.end(run, answerTimeout);
			const reviewFailure = reviewApprovalFailure(run.reviewApprovalLease, run.browser?.handoffPage?.(), this.now()); if (reviewFailure) this.end(run, { outcome: "blocked", blockReason: "incomplete", summary: `${reviewFailure} External effects remain unverified; no replay is authorized.` });
			if (run.state !== "ended" && this.activeMs(run) >= e.limits.maxMinutes * 60_000 + 60_000) {
				run.timedOut = true;
				this.kill(run);
			}
		}, 5_000);
		run.timer.unref?.();
	}

	/**
	 * What the runner OBSERVED about its own CLI (#975), as ids this platform defines.
	 *
	 * Matched against the engine's structured output on the machine; only the matching signal's ID
	 * crosses the contract, never the line that matched it. That is what makes a diagnostic safe to
	 * persist: a CLI prints the owner's résumé prose and their typed answers while it works, and no
	 * redaction can reliably tell those from the rest of its chatter.
	 */
	private signalsOf(run: Run): LocalApplySignal[] {
		const text = run.output.join("\n");
		const out: LocalApplySignal[] = [];
		if (!text.trim()) out.push("no_output");
		// #952's live failure, invisible from the cloud and fixable by configuration.
		if (/approval policy is\s*[`'"]?never|requires? approval|permission denied for tool|not allowed to use/i.test(text)) out.push("approval_policy_blocked");
		if (/browser_navigate.{0,40}(not found|unknown tool|unavailable)|no such tool|tool .{0,40}is not available/i.test(text)) out.push("bridge_tools_missing");
		if (missingLogin(run.envelope.engine, text)) out.push("auth_prompt");
		if (/\b(i (cannot|can't|won't)|unable to) (help|assist|complete|do that|proceed)/i.test(text)) out.push("engine_refused_task");
		return [...new Set(out)];
	}

	/** The bounded, closed-vocabulary diagnostic for a run that put nothing on the page (#975). */
	private diagnosticOf(run: Run, code: number, cause: LocalApplyDiagnosticCause): LocalApplyDiagnostic {
		return {
			cause,
			bridgeCalls: run.bridge?.actions ?? 0,
			engineExit: Number.isInteger(code) && code >= -1 && code <= 255 ? code : 0,
			activeMs: this.activeMs(run),
			pages: run.bridge?.pages ?? 0,
			filled: run.bridge?.filled ?? 0,
			signals: this.signalsOf(run),
		};
	}

	/** What the run amounts to when the CLI exits — decided by what the bridge did, not what the CLI says. */
	private outcomeOf(run: Run, code: number): Omit<LocalApplyResultEnvelope, "runId" | "mode" | "traceId" | "engineAuth" | "filled" | "uploaded" | "submitAttempted"> & { engineAuth?: LocalApplyEngineAuth } {
		const e = run.envelope;
		const b = run.bridge;
		const summary = b?.summary ?? finalText(e.engine, run.output);
		if (run.cancelled) return { outcome: "failed", summary, error: "Cancelled by the owner" };
		if (b?.submitted) return { outcome: "submitted", summary, submitted: b.submitted };
		if (b?.unavailable) return { outcome: "blocked", summary, blockReason: "job_unavailable", unavailable: b.unavailable };
		// #994: a pressed submit nobody confirmed now SAYS what was seen. The outcome is unchanged —
		// terminal, no retry, the owner told to check the employer's site — because that safety is
		// correct; what was missing was any way to tell "the click never moved the page" from "the
		// page moved and said something this platform does not recognise yet".
		if (b?.submitAttempted) {
			const d = this.diagnosticOf(run, code, "submit_unconfirmed");
			return {
				outcome: "blocked",
				summary,
				blockReason: "submit_unconfirmed",
				questions: b.blocked?.questions ?? [],
				diagnostic: { ...d, signals: [...d.signals, ...(b.confirmation ? (confirmationSignals(b.confirmation) as LocalApplySignal[]) : [])] },
			};
		}
		if (b?.unresolvedQuestions.length) return { outcome: "blocked", summary: [summary, e.policy.toolAccess === "full" ? `Incomplete: unresolved owner questions. ${FULL_SUBMISSION_UNKNOWN}` : "Incomplete: unresolved owner questions; nothing was submitted."].filter(Boolean).join("\n"), blockReason: "incomplete", questions: [...b.unresolvedQuestions] };
		if (b?.reviewReady) return { outcome: "awaiting_review", summary };
		if (!b?.filled && missingLogin(e.engine, run.output.join("\n"))) return { outcome: "blocked", summary, blockReason: "engine_not_signed_in", questions: [signInHelp(e.engine)], engineAuth: "missing_login" };
		if (b?.blocked) {
			// #1464: the CLI can describe a live pause after its held tool times out. This result is terminal.
			const blockedSummary = b.blocked.reason === "login_required" && e.policy.toolAccess !== "full" ? "This run ended at the sign-in page before sign-in was completed. Nothing was submitted. Check the action log for sign-in details, then start a new run when access is ready." : summary;
			return { outcome: "blocked", summary: blockedSummary, blockReason: b.blocked.reason, questions: b.blocked.questions };
		}
		if (run.timedOut) {
			return { outcome: "blocked", summary, blockReason: "incomplete", questions: [`Stopped at the ${e.limits.maxMinutes}-minute limit before the form was ready for review.`], diagnostic: this.diagnosticOf(run, code, "timed_out") };
		}
		// #975: a CLI that never called the bridge did NOTHING on the page, which is a different
		// failure from stopping partway — different cause, different fix — and saying `incomplete`
		// for both left the owner with a 51-second run they could not explain. The diagnostic says
		// how long it ran, how many bridge calls it made (0) and what the runner saw it print.
		const calls = b?.actions ?? 0;
		if (calls === 0) {
			const diagnostic = this.diagnosticOf(run, code, !run.output.join("").trim() ? "no_engine_output" : code !== 0 ? "engine_exited_nonzero" : "bridge_unused");
			return { outcome: "blocked", summary, blockReason: "bridge_unused", questions: [bridgeUnusedHelp(e.engine, diagnostic)], diagnostic };
		}
		const tail = code !== 0 ? ` (the ${e.engine} CLI exited with code ${code})` : "";
		return {
			outcome: "blocked",
			summary,
			blockReason: "incomplete",
			questions: [`The CLI stopped before marking the form ready for review${tail}. Review the form yourself, or retry.`],
			diagnostic: this.diagnosticOf(run, code, code !== 0 ? "engine_exited_nonzero" : "bridge_unused"),
		};
	}

	private async waitForReviewApproval(run: Run): Promise<boolean> {
		const page = run.browser?.handoffPage?.();
		if (!page || page.isClosed() || run.reviewApprovalLease || run.state !== "running") { this.end(run, { outcome: "blocked", blockReason: "incomplete", summary: "This run cannot retain an exact live page for owner review. No submission or replay is authorized." }); return false; }
		const budgetMs = Math.floor(run.envelope.limits.maxMinutes * 60_000 * 0.9);
		const lease: ReviewApprovalLease = { checkpointId: crypto.randomUUID(), page, url: page.url(), budgetMs, expiresAt: this.now() + budgetMs };
		run.reviewApprovalLease = lease;
		const directive = await this.supervisorCheckpoint(run, { schemaVersion: 1, checkpointId: lease.checkpointId, facts: { phase: "before_submit", reviewWait: { expiresAt: lease.expiresAt, budgetMs }, actions: run.bridge?.actions ?? 0, ...(run.envelope.policy.toolAccess === "full" ? {} : { filled: run.bridge?.filled ?? 0 }), uploaded: run.bridge?.uploaded.size ?? 0, blockers: [], url: lease.url, domain: new URL(lease.url).hostname } });
		return directive === "continue" && !!lease.authorization && !run.result && !run.cancelled;
	}

	private activeMs(run: Run): number {
		return run.activeMs + (run.state === "running" ? this.now() - run.activeSince : 0);
	}

	private emit(run: Run, ev: Omit<LocalApplyEvent, "at">): void {
		if (run.events.length >= MAX_EVENTS) return;
		// Origin and path only (#1069): a sign-in page's query carries OAuth state and session ids.
		const url = ev.url ? traceUrl(ev.url) : "";
		const { url: _raw, ...rest } = ev;
		run.events.push({ ...rest, ...(url ? { url } : {}), at: new Date(this.now()).toISOString(), seq: ++run.seq });
	}

	private pause(run: Run, p: LocalApplyPause, options?: FinalAnswerPauseOptions): Promise<PauseOutcome> {
		if (run.state === "ended" || run.cancelled) return Promise.resolve("stopped");
		if (options?.finalReviewAnswers) {
			run.finalAnswerLease = finalAnswerLease(run.finalAnswerLease, options, readFinalAnswerPage(() => run.browser?.handoffPage?.()));
			const timeout = finalAnswerTimeout(run.finalAnswerLease, this.now(), run.bridge?.unresolvedQuestions ?? []) ?? finalAnswerUnavailable(run.finalAnswerLease, readFinalAnswerPage(() => run.browser?.handoffPage?.()), run.bridge?.unresolvedQuestions ?? []); if (timeout) { this.end(run, timeout); return Promise.resolve("stopped"); }
			p = { ...p, answerWait: { kind: "final_review", expiresAt: run.finalAnswerLease.expiresAt, budgetMs: run.finalAnswerLease.budgetMs, questions: [...options.finalReviewAnswers.questions] } };
		}
		// Ordinary immediate questions still park (#1121); final review retains this exact browser.
		if (run.state === "running" && PARKABLE_PAUSES.has(p.reason) && !p.answerWait && !run.bridge?.submitAttempted) {
			this.emit(run, { type: "run.paused", pauseReason: p.reason });
			this.end(run, {
				outcome: "blocked",
				blockReason: p.reason,
				questions: p.question ? [p.question] : [],
				summary: "Parked for the owner's answer; this machine was freed. Nothing was submitted.",
			});
			return Promise.resolve("stopped");
		}
		if (run.state === "running") {
			run.activeMs += this.now() - run.activeSince;
			run.state = "paused";
			const url = p.url ? traceUrl(p.url) : "";
			const { url: _raw, ...rest } = p;
			run.pause = { ...rest, ...(url ? { url } : {}), handoffRequestId: crypto.randomUUID() };
			this.emit(run, { type: "run.paused", pauseReason: p.reason, ...(url ? { url } : {}), ...(p.domain ? { domain: p.domain } : {}) });
		}
		return new Promise((done) => run.waiters.push(done));
	}

	/**
	 * Wait for a cloud-brain decision without accepting a model's prose as permission. A directive
	 * can be stored before this call reaches its pause (the delivery race), but a normal `resume`
	 * can never release this pause.
	 */
	private supervisorCheckpoint(run: Run, supervisor: LocalApplySupervisorCheckpoint): Promise<LocalApplySupervisorDirective> {
		const { checkpointId } = supervisor;
		let checkpoint = run.checkpoints.get(checkpointId);
		if (!checkpoint) {
			checkpoint = {};
			run.checkpoints.set(checkpointId, checkpoint);
		}
		if (!checkpoint.checkpoint) {
			checkpoint.checkpoint = supervisor;
			this.emit(run, {
				type: "supervisor.checkpoint",
				...(supervisor.facts.url ? { url: supervisor.facts.url } : {}),
				...(supervisor.facts.domain ? { domain: supervisor.facts.domain } : {}),
				detail: { checkpointId, phase: supervisor.facts.phase, actions: supervisor.facts.actions, ...(supervisor.facts.filled === undefined ? {} : { filled: supervisor.facts.filled }), uploaded: supervisor.facts.uploaded },
			});
		}
		if (checkpoint.directive) {
			if (checkpoint.directive !== "continue") this.finishSupervisorDirective(run, checkpoint.directive, checkpointId, supervisor);
			return Promise.resolve(checkpoint.directive);
		}
		return this.pause(run, { reason: "supervisor_checkpoint", checkpoint: supervisor }).then(() => run.checkpoints.get(checkpointId)?.directive ?? "stop");
	}

	/** Cached and waiting terminal directives have the same observed outcome (#1488). */
	private finishSupervisorDirective(run: Run, directive: "request_review" | "stop", checkpointId: string, checkpoint?: LocalApplySupervisorCheckpoint): void {
		if (directive === "stop") {
			this.end(run, run.bridge?.unresolvedQuestions.length ? this.outcomeOf(run, run.child?.exitCode ?? -1) : { outcome: "blocked", blockReason: "incomplete", questions: ["The supervisor stopped this run before it could continue."] });
			return;
		}
		const bridge = run.bridge;
		if (bridge?.submitAttempted || bridge?.unresolvedQuestions.length) this.end(run, this.outcomeOf(run, run.child?.exitCode ?? -1));
		else if (run.envelope.policy.toolAccess === "full") this.end(run, { outcome: "awaiting_review", summary: `The supervisor requested owner review. ${FULL_SUBMISSION_UNKNOWN}` });
		else if (!bridge?.filled && !bridge?.uploaded.size) {
			// #1484: requesting human attention is not evidence that a form was populated.
			// Preserve the observed blocker and checkpoint instead of inviting approval of an empty form.
			const reason = bridge?.blocked?.reason ?? "incomplete";
			const phase = checkpoint?.facts.phase ?? "uncertain";
			const summary = `The supervisor requested review at the ${phase} checkpoint, but no fields were filled and no files were selected. Nothing was submitted. The run ended ${reason.replace(/_/g, " ")}; check the browser action log and resolve the blocker before retrying.`;
			this.emit(run, { type: "policy.decision", detail: { tool: "supervisor_checkpoint", class: "review", decision: "refused", reason, count: 0, checkpointId, phase } });
			this.end(run, { outcome: "blocked", blockReason: reason, summary, questions: bridge?.blocked?.questions.length ? bridge.blocked.questions : [summary] });
		} else this.end(run, { outcome: "awaiting_review", summary: "The supervisor requested an owner review." });
	}

	private release(run: Run, outcome: PauseOutcome): void {
		if (run.state === "paused") {
			run.state = "running";
			run.pause = undefined;
			run.activeSince = this.now();
			if (outcome === "resumed") this.emit(run, { type: "run.resumed" });
		}
		for (const w of run.waiters.splice(0)) w(outcome);
	}

	/**
	 * `POST /local-apply/sign-in-secrets` (#1412): the cloud hands the paused run the NAMED secrets it may use to
	 * sign in. They go into the run's own Playwright MCP and into the result redaction list, nowhere else — not the
	 * trace, not the store, not a log. The first call releases `login_required` into `signing_in`; a later one adds
	 * the emailed code and wakes the CLI waiting on `request_sign_in_code`.
	 */
	signInSecrets(raw: unknown): LocalApplyStatusResponse {
		const o = (raw && typeof raw === "object" ? raw : {}) as Partial<LocalApplySignInSecretsRequest>;
		const run = this.get(String(o.runId ?? ""));
		const given = o.secrets && typeof o.secrets === "object" ? (o.secrets as Record<string, unknown>) : {};
		const map: Record<string, string> = {};
		for (const name of LOCAL_APPLY_SIGN_IN_SECRET_NAMES) {
			const v = given[name];
			if (typeof v === "string" && v.length > 0 && v.length <= 512) map[name] = v;
		}
		if (!Object.keys(map).length && o.link === undefined) throw new RunnerInputError(`secrets must carry at least one of ${LOCAL_APPLY_SIGN_IN_SECRET_NAMES.join(", ")}`);
		const paused = run.state === "paused" && run.pause?.reason === "login_required";
		if (!paused && !(run.state === "running" && run.signIn)) throw new RunnerInputError("The run is not paused for a sign-in", 409, "sign_in_not_at_wall");
		if (!run.browser?.secrets) throw new RunnerInputError("This run's browser cannot take secret placeholders", 409, "sign_in_secrets_unavailable");
		// #1619: a mailbox link is for the page already signing in, and only on that sign-in's own site.
		let link: string | undefined;
		if (o.link !== undefined) {
			const host = run.signIn?.origin ?? "";
			try {
				const u = new URL(String(o.link));
				if (!run.signIn || !host || (u.protocol !== "https:" && u.protocol !== "http:") || siteKeyOf(u.hostname) !== siteKeyOf(host) || String(o.link).length > 4096) throw new Error("link");
				link = u.href;
			} catch {
				throw new RunnerInputError("link must be an http(s) URL on the sign-in site", 400);
			}
		}
		if (Object.keys(map).length) run.browser.secrets.provideSecrets(map);
		// The values, so a result that somehow quotes one is scrubbed (`end()`); the names are what the trace sees.
		run.secrets.push(...Object.values(map), ...(link ? [link] : []));
		const names = Object.keys(map) as LocalApplySignInSecretName[];
		if (paused) {
			run.signIn = { origin: run.pause?.domain ?? "", names, requested: new Set(), linkDelivered: false, waiters: [] };
			this.emit(run, { type: "policy.decision", domain: run.signIn.origin || undefined, detail: { tool: "agent_sign_in", class: "session", source: "platform", decision: "started", reason: names.join(",") } });
			this.release(run, "sign_in");
		} else if (run.signIn) {
			for (const n of names) if (!run.signIn.names.includes(n)) run.signIn.names.push(n);
			if (link) run.signIn.link = link;
			this.emit(run, { type: "policy.decision", domain: run.signIn.origin || undefined, detail: { tool: "agent_sign_in", class: "session", source: "platform", decision: "provisioned", reason: [...names, ...(link ? ["link"] : [])].join(",") } });
			const wake = (kind: SignInRequest) => { for (const w of run.signIn!.waiters.filter((x) => x.kind === kind)) w.done(true); run.signIn!.waiters = run.signIn!.waiters.filter((x) => x.kind !== kind); };
			if (map.PAGS_LOGIN_CODE) wake("code");
			if (map.PAGS_NEW_PASSWORD) wake("newPassword");
			if (link) wake("link");
		}
		return this.status({ runId: run.envelope.runId, afterSeq: run.seq });
	}

	/** The CLI asked the cloud for something mid sign-in: wait for it to be provisioned, bounded. */
	private awaitSignIn(run: Run, kind: SignInRequest): Promise<boolean> {
		const s = run.signIn;
		if (!s) return Promise.resolve(false);
		if (kind === "code" && s.names.includes("PAGS_LOGIN_CODE") || kind === "newPassword" && s.names.includes("PAGS_NEW_PASSWORD") || kind === "link" && s.link) return Promise.resolve(true);
		// One mailbox link per run: a second request would be a blind retry of a reset or verification.
		if (kind === "link" && s.linkDelivered) return Promise.resolve(false);
		s.requested.add(kind);
		return new Promise((done) => {
			const timer = setTimeout(() => done(false), SIGN_IN_CODE_WAIT_MS);
			timer.unref?.();
			s.waiters.push({ kind, done: (ok) => { clearTimeout(timer); done(ok); } });
		});
	}

	/** #1619: wait for the mailbox link, then open it in the run's own page. The URL is never returned or traced. */
	private async openSignInLink(run: Run): Promise<boolean> {
		if (!(await this.awaitSignIn(run, "link"))) return false;
		const link = run.signIn?.link;
		const page = run.browser?.handoffPage?.();
		if (!link || !page || page.isClosed()) return false;
		run.signIn!.link = undefined;
		run.signIn!.linkDelivered = true;
		run.signIn!.requested.delete("link");
		try {
			await page.goto(link, { waitUntil: "domcontentloaded", timeout: 30_000 });
		} catch {
			return false;
		}
		this.emit(run, { type: "policy.decision", domain: run.signIn?.origin || undefined, detail: { tool: "agent_sign_in", class: "session", source: "platform", decision: "link_opened" } });
		return true;
	}

	/** The sign-in ended either way: the secrets are wiped and the run is an ordinary running run again. */
	private signInDone(run: Run): void {
		for (const w of run.signIn?.waiters.splice(0) ?? []) w.done(false);
		run.signIn = undefined;
		run.browser?.secrets?.clearSecrets();
	}

	/** The owner acted: add their answers to what values may be grounded in, admit any site they allowed, release. */
	resume(raw: unknown): LocalApplyStatusResponse {
		const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
		const run = this.get(String(o.runId ?? ""));
		if (run.state === "ended") throw new RunnerInputError("The run has ended", 409);
		if (run.finalAnswerLease && !run.pause?.answerWait) throw new RunnerInputError("The final-answer wait has no current paused answer epoch; no answers were applied.", 409);
		const websitePause = run.envelope.policy.browserWebsiteAccess?.mode === "ask_once" && run.pause?.reason === "external_redirect" && run.pause.domain && run.pause.handoffRequestId ? { hostname: run.pause.domain, pauseKey: run.pause.handoffRequestId } : undefined;
		const websitePolicy = websiteResumePolicy(run.envelope.policy.browserWebsiteAccess, o.browserWebsiteAccess, websitePause, o.expectedWebsitePauseKey, o.websiteDecision);
		const domains = resumeDomainGrants(o.allowDomains, run.state, run.pause);
		if (run.pause?.reason === "supervisor_checkpoint") throw new RunnerInputError("This run is waiting for a persisted supervisor directive, not an owner resume", 409);
		if (run.pause?.reason === "owner_requested" && (o.expectedOwnerPauseKey !== run.pause.handoffRequestId || run.handoff?.state === "ready" || this.handoffs.isBusy(run))) throw new RunnerInputError("Close and drain the exact owner handoff before resuming AI dispatch", 409);
		const answers = resumeAnswerSources(o.answers, run.pause, o.expectedAnswerPauseKey, this.now());
		if (run.pause?.answerWait && !finalAnswerPageAvailable(run.finalAnswerLease, readFinalAnswerPage(() => run.browser?.handoffPage?.()))) throw new RunnerInputError("The exact final-answer browser page is no longer available; this pause cannot resume.", 409);
		if (run.pause?.answerWait && this.now() >= run.pause.answerWait.expiresAt) throw new RunnerInputError("The final-answer deadline passed before resume; no answers were applied.", 409);
		if (websitePolicy) run.envelope.policy.browserWebsiteAccess = websitePolicy;
		run.grounding.push(...answers);
		for (const domain of domains) run.allow.add(domain);
		// The owner took the sign-in over: whatever was provisioned for the CLI is wiped (#1412).
		if (run.signIn) this.signInDone(run);
		if (run.pause?.reason === "owner_requested") { run.ownerPauseReady = false; run.browser?.tools.resumeDispatch?.(); }
		this.release(run, "resumed");
		return this.status({ runId: run.envelope.runId, afterSeq: run.seq });
	}

	/**
	 * Store then apply an immutable cloud directive. The caller persists it before this runner
	 * endpoint is reached; this in-process record makes delivery idempotent and closes the race
	 * where a directive arrives just before the bridge begins waiting.
	 */
	directive(raw: unknown): LocalApplyStatusResponse {
		const o = (raw && typeof raw === "object" ? raw : {}) as Partial<LocalApplyDirectiveRequest>;
		const run = this.get(typeof o.runId === "string" ? o.runId : "");
		const checkpointId = typeof o.checkpointId === "string" && SAFE_ID.test(o.checkpointId) ? o.checkpointId : null;
		const directive: LocalApplySupervisorDirective | null = o.directive === "continue" || o.directive === "request_review" || o.directive === "stop" ? o.directive : null;
		if (o.schemaVersion !== 1 || !checkpointId || !directive) throw new RunnerInputError("directive needs schemaVersion: 1, a safe checkpointId, and directive continue, request_review or stop");
		const lease = run.reviewApprovalLease;
		if (o.submitAuthorization && lease?.checkpointId !== checkpointId) throw new RunnerInputError("Submission approval is only valid at this run's exact live review checkpoint.", 409);
		if (lease?.checkpointId === checkpointId) {
			if (lease.authorization) {
				if (directive !== "continue" || !sameReviewAuthorization(lease.authorization, o.submitAuthorization)) throw new RunnerInputError("A different authorization is already recorded for this review.", 409);
				return this.status({ runId: run.envelope.runId, afterSeq: run.seq });
			}
			if (directive === "request_review") throw new RunnerInputError("This checkpoint is already waiting for explicit owner approval.", 409);
			if (directive === "continue") {
				if (run.handoff?.state === "ready" || this.handoffs.isBusy(run)) throw new RunnerInputError("Close and drain owner browser control before approving this review.", 409);
				const failure = reviewApprovalFailure(lease, run.browser?.handoffPage?.(), this.now());
				if (failure) { this.end(run, { outcome: "blocked", blockReason: "incomplete", summary: failure }); throw new RunnerInputError(failure, 409); }
				if (run.state !== "paused" || run.pause?.checkpoint?.checkpointId !== checkpointId || !run.bridge || run.cancelled) throw new RunnerInputError("The exact live review is no longer waiting.", 409);
				const auth = validateReviewAuthorization(o.submitAuthorization, run.envelope, (kind) => run.bridge!.verifyArtifact(kind));
				lease.authorization = auth; run.envelope.policy.mode = "auto_submit"; run.envelope.policy.submitGate = { gateId: auth.gateId }; run.bridge.authorizeSubmission(auth.gateId);
			}
		}
		let checkpoint = run.checkpoints.get(checkpointId);
		if (checkpoint?.directive) {
			if (checkpoint.directive !== directive) throw new RunnerInputError("A different directive is already recorded for this checkpoint", 409);
			return this.status({ runId: run.envelope.runId, afterSeq: run.seq });
		}
		if (run.state === "ended") throw new RunnerInputError("The run has ended", 409);
		checkpoint ??= {};
		checkpoint.directive = directive;
		run.checkpoints.set(checkpointId, checkpoint);
		this.emit(run, { type: "supervisor.directive", detail: { checkpointId, directive } });

		const waitingForThis = run.state === "paused" && run.pause?.reason === "supervisor_checkpoint" && run.pause.checkpoint?.checkpointId === checkpointId;
		if (waitingForThis && directive === "continue") this.release(run, "resumed");
		else if (waitingForThis && directive !== "continue") this.finishSupervisorDirective(run, directive, checkpointId, checkpoint.checkpoint);
		return this.status({ runId: run.envelope.runId, afterSeq: run.seq });
	}

	cancel(raw: unknown): { runId: string; state: string } {
		const runId = String((raw as { runId?: unknown } | null)?.runId ?? "");
		const run = this.get(runId);
		if (run.state !== "ended") {
			run.cancelled = true;
			this.release(run, "stopped");
			if (run.child && run.child.exitCode === null) this.kill(run);
			else this.end(run, { outcome: "failed", error: "Cancelled by the owner" });
		}
		return { runId, state: run.state };
	}

	/** `POST /local-apply/shots {runId, afterSeq}` — the run's replay frames after `afterSeq` (#1063). */
	shots(raw: unknown): ReplayShotsPage {
		const o = (raw && typeof raw === "object" ? raw : {}) as { runId?: unknown; afterSeq?: unknown };
		const run = this.get(String(o.runId ?? ""));
		return run.shots.page(run.envelope.runId, typeof o.afterSeq === "number" && o.afterSeq > 0 ? o.afterSeq : 0);
	}

	/** This run's recorded browser calls after `afterSeq` (#1409), for the shared `/browser-calls` pull route. */
	browserCalls(runId: string, afterSeq: number, caller?: string, limit?: number): BrowserCallsPage {
		const run = this.get(runId);
		if (caller && run.envelope.instanceId !== caller) throw new RunnerInputError("This browser run belongs to another agent instance", 403);
		return run.browser?.tools.pullCalls?.({ kind: "local_apply_run", id: run.envelope.runId }, afterSeq, limit) ?? { calls: [], lastSeq: 0, dropped: 0 };
	}
	browserState(runId: string, caller?: string): BrowserStateObservation {
		const run = this.get(runId);
		if (caller && run.envelope.instanceId !== caller) throw new RunnerInputError("This browser run belongs to another agent instance", 403);
		const subject = { kind: "local_apply_run", id: run.envelope.runId };
		return run.browser?.tools.browserState?.(subject, run.state !== "ended") ?? { subject, epoch: "unavailable", capturedAt: new Date().toISOString(), current: false, availability: "unavailable" };
	}

	status(raw: unknown): LocalApplyStatusResponse {
		const o = (raw && typeof raw === "object" ? raw : {}) as { runId?: unknown; afterSeq?: unknown };
		const run = this.get(String(o.runId ?? ""));
		const failure = run.state !== "ended" && reviewApprovalFailure(run.reviewApprovalLease, run.browser?.handoffPage?.(), this.now()); if (failure) this.end(run, { outcome: "blocked", blockReason: "incomplete", summary: `${failure} External effects remain unverified; no replay is authorized.` });
		const after = typeof o.afterSeq === "number" && o.afterSeq > 0 ? o.afterSeq : 0;
		// A page of at most 500 events; `lastSeq` is the cursor for the next page, so nothing is skipped.
		const pending = run.events.filter((e) => e.seq > after);
		const page = pending.length > 500 ? pending.slice(0, 500) : pending;
		return {
			runId: run.envelope.runId,
			state: run.state,
			...(run.pause ? { pause: run.pause } : {}),
			...(run.signIn && run.state === "running" ? { signIn: { state: "signing_in" as const, origin: run.signIn.origin, secrets: [...run.signIn.names], codeRequested: run.signIn.requested.has("code"), newPasswordRequested: run.signIn.requested.has("newPassword"), linkRequested: run.signIn.requested.has("link") } } : {}),
			events: page,
			lastSeq: page.length < pending.length ? page[page.length - 1].seq : run.seq,
			...(run.result ? { result: run.result } : {}),
		};
	}

	/** A takeover only views the exact live page; it never authorizes the paused bridge. */
	async ownerPause(raw: unknown): Promise<LocalApplyStatusResponse> { const o = raw as { runId?: string }; const run = this.get(o?.runId ?? ""); if (run.finalAnswerLease) throw new RunnerInputError("The final-review answer wait is already active; answer its current question or use Stop before taking owner control.", 409); return requestOwnerPause(run, raw, () => { void this.pause(run, { reason: "owner_requested" }); }, () => this.status({ runId: run.envelope.runId })); }
	async handoff(raw: unknown): Promise<LocalApplyHandoffStatus> { return this.handoffs.handoff(raw); }
	async handoffStatus(raw: unknown): Promise<LocalApplyHandoffStatus> { return this.handoffs.status(raw); }
	async handoffFrame(raw: unknown): Promise<{ frame: string; width: number; height: number }> { return this.handoffs.frame(raw); }
	async handoffInput(raw: unknown): Promise<void> { return this.handoffs.input(raw); }
	async endHandoff(raw: unknown): Promise<LocalApplyHandoffStatus> { return this.handoffs.end(raw); }

	/** Does this token belong to this run? The bridge forwarder's only credential. */
	authorizeBridge(runId: string, token: string): boolean {
		const run = this.runs.get(runId);
		return !!run && run.state !== "ended" && token.length > 0 && token === run.token;
	}

	async bridge(raw: unknown): Promise<unknown> {
		const o = (raw && typeof raw === "object" ? raw : {}) as { runId?: unknown; op?: unknown; name?: unknown; args?: unknown };
		const run = this.get(String(o.runId ?? ""));
		if (!run.bridge || run.state === "ended" || run.cancelled || run.timedOut) throw new RunnerInputError("The run is not active", 409);
		if (o.op === "list") return { tools: await run.bridge.listTools() };
		if (o.op === "call" && run.pause?.reason === "owner_requested") { await this.pause(run, run.pause); return { content: [{ type: "text", text: "Owner control ended. This queued action was not executed. Inspect the current page before choosing a new action." }], isError: true }; }
		// A call that arrives while the run waits on the owner (the CLI gave up waiting on its own
		// call) does not go ahead of them: nothing reaches the page until the owner resumes.
		if (o.op === "call" && run.state === "paused") return { content: [{ type: "text", text: `The run is paused for the owner (${run.pause?.reason.replace(/_/g, " ") ?? "waiting"}). Nothing can be done until they resume it. Stop now.` }], isError: true };
		if (o.op === "call" && typeof o.name === "string") return run.bridge.callTool(o.name, (o.args && typeof o.args === "object" ? o.args : {}) as Record<string, unknown>);
		throw new RunnerInputError("op must be list or call");
	}

	private get(runId: string): Run {
		const run = this.runs.get(runId); if (!run) throw new RunnerInputError(`No application run ${runId} on this runner (it may have restarted)`, 404);
		return run;
	}
	private kill(run: Run): void { killApplyEngine(run.child); }
	private end(run: Run, r: Partial<LocalApplyResultEnvelope> & { outcome: LocalApplyResultEnvelope["outcome"] }, preflightFailure?: LocalApplyPreflightFailure): void {
		if (run.state === "ended") return;
		run.documentPreparation?.abort(); delete run.documentPreparation;
		// A terminal application outcome never means that a handoff succeeded.  Tear down only the
		// live view and retain the explicit closed state for a caller that polls before restart.
		if (run.handoff?.state === "ready") void this.handoffs.close(run, "run_ended");
		if (run.state === "paused") this.release(run, "stopped");
		if (run.signIn) this.signInDone(run);
		if (run.timer) clearInterval(run.timer);
		run.state = "ended";
		run.endedAt = this.now();
		const b = run.bridge;
		run.result = {
			runId: run.envelope.runId,
			outcome: r.outcome,
			mode: run.envelope.policy.mode,
			traceId: run.envelope.runId,
			engineAuth: r.engineAuth ?? run.engineAuth,
			filled: b?.filled ?? 0,
			uploaded: [...(b?.uploaded ?? [])],
			submitAttempted: b?.submitAttempted ?? false,
			...(run.envelope.policy.toolAccess === "full" && !b?.submitted && !preflightFailure ? { submissionVerification: "unverified" as const } : {}),
			...(preflightFailure ? { preflightFailure } : {}),
			executionEvidence: executionEvidence({ tools: run.browser?.tools, bridge: b, runId: run.envelope.runId, full: run.envelope.policy.toolAccess === "full", timedOut: run.timedOut, engineExit: run.child?.exitCode }),
			summary: redactText((r.summary ?? "").slice(0, LOCAL_APPLY_CAPS.summary), run.secrets),
			...(r.outcome === "submitted" && r.submitted ? { submitted: r.submitted } : {}),
			...(r.outcome === "blocked" ? { blockReason: r.blockReason ?? "incomplete", questions: (r.questions ?? []).map((q) => redactText(q, run.secrets)), ...(r.blockReason === "job_unavailable" && r.unavailable ? { unavailable: r.unavailable } : {}) } : {}),
			...(r.outcome === "failed" ? { error: redactText((r.error ?? "The run failed without a reason.").slice(0, 1000), run.secrets) } : {}),
			// #975 — carried through as the closed vocabulary it is. Nothing here is redacted because
			// nothing here is text: counts, an exit code, and signal ids this platform defines.
			...(r.diagnostic ? { diagnostic: r.diagnostic } : {}),
		};
		// This must happen before stopping the browser or exposing `ended`: a process restart in the
		// narrow handoff window must not turn an observed result into `runner_lost` in the cloud.
		clearCloudDocuments(run.envelope, run.dir);
		run.grounding = [];
		delete run.envelope.instancePreferences;
		delete run.envelope.ownerFacts;
		run.output = [];
		this.persistTerminal(run);
		if (run.child && run.child.exitCode === null) this.kill(run);
		void run.browser?.stop().catch(() => undefined);
	}

	/** Drop ended runs past retention, with their folders (scratch, MCP config, isolated profile). */
	sweep(): void {
		const cutoff = this.now() - this.retentionMs;
		for (const [id, run] of this.runs) {
			if (run.state === "ended" && (run.endedAt ?? 0) < cutoff) {
				rememberApplyStart(this.startClaimsRoot, run.dir, run.envelope);
				rmSync(run.dir, { recursive: true, force: true });
				this.runs.delete(id);
			}
		}
		if (!existsSync(this.root)) return;
		for (const instance of readdirSync(this.root)) {
			const instDir = join(this.root, instance);
			for (const runId of readdirSync(instDir)) {
				if (this.runs.has(runId)) continue;
				const dir = join(instDir, runId);
				if (statSync(dir).mtimeMs < cutoff) {
					rememberApplyStart(this.startClaimsRoot, dir);
					rmSync(dir, { recursive: true, force: true });
				}
			}
		}
	}

	closeAll(): void {
		for (const run of this.runs.values()) {
			if (run.state !== "ended") {
				run.cancelled = true;
				this.release(run, "stopped");
				this.end(run, { outcome: "failed", error: "The runner shut down during the run" });
			}
		}
	}
}
