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
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerInputError } from "../errors.js";
import { isHomeRelative, isWorkspaceRelative } from "../local-artifact/contract.js";
import { resolveSource } from "../local-artifact/runtime.js";
import { type BrowserTools, domainWithin } from "../local-browser/bridge.js";
import { BRIDGE_ENV } from "../local-browser/bridge-stdio.js";
import { redactText, secretEnvValues } from "../local-browser/contract.js";
import { finalText, missingLogin, signInHelp } from "../local-browser/engine.js";
import { resolveWorkspacePath } from "../local-browser/runtime.js";
import { ApplyBridge } from "./bridge.js";
import { confirmationSignals } from "./confirmation.js";
import {
	type LocalApplySignal,
	type LocalApplyDiagnosticCause,
	type LocalApplyDiagnostic,
	LOCAL_APPLY_AUTH_MODES,
	LOCAL_APPLY_CAPS,
	LOCAL_APPLY_ENGINES,
	LOCAL_APPLY_MODES,
	LOCAL_APPLY_TASK_TYPE,
	type LocalApplyArtifact,
	type LocalApplyArtifactKind,
	type LocalApplyBlockReason,
	type LocalApplyDirectiveRequest,
	type LocalApplyEngineAuth,
	type LocalApplyEvent,
	type LocalApplyPause,
	type LocalApplyProfile,
	type LocalApplyResultEnvelope,
	type LocalApplyRunnerEvent,
	type LocalApplySource,
	type LocalApplyStatusResponse,
	type LocalApplySupervisorCheckpoint,
	type LocalApplySupervisorDirective,
	type LocalApplyTaskEnvelope,
	parseLocalApplyResult,
} from "./contract.js";
import { applyPrompt, buildApplyEngineSpec, observedApplyAuth, type SourceBlock } from "./engine.js";

export interface RunBrowser {
	tools: BrowserTools;
	stop(): Promise<void>;
}

export interface LocalApplyRuntimeDeps {
	dataDir: string;
	selfUrl(): string | null;
	browserFor(profile: LocalApplyProfile, runDir: string): Promise<RunBrowser>;
	spawn?: typeof nodeSpawn;
	now?: () => number;
	homeDir?: string;
	retentionMs?: number;
	bridgeScript?: string;
}

const MAX_EVENTS = 1000;
const OUTPUT_LINES = 400;
const SOURCE_BYTES = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,300}$/;
const HASH = /^[a-f0-9]{64}$/;
/** One application at a time per agent: two runs on one employer's form is how duplicates happen. */
const MAX_ACTIVE = 1;

interface Run {
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
	allow: Set<string>;
	/** Source text, approved materials and the owner's answers — what a value may be grounded in. */
	grounding: string[];
	secrets: string[];
	activeSince: number;
	activeMs: number;
	waiters: Array<(outcome: "resumed" | "stopped") => void>;
	output: string[];
	engineAuth: LocalApplyEngineAuth;
	cancelled: boolean;
	timedOut: boolean;
	/** Directives are recorded before they can release a checkpoint, including a delivery-before-wait race. */
	checkpoints: Map<string, { checkpoint?: LocalApplySupervisorCheckpoint; directive?: LocalApplySupervisorDirective }>;
	endedAt?: number;
	timer?: ReturnType<typeof setInterval>;
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

class Blocked extends Error {
	constructor(
		readonly reason: LocalApplyBlockReason,
		readonly questions: string[],
	) {
		super(reason);
	}
}

const posInt = (v: unknown, max: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean) : []);
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** The envelope, validated at the runner's boundary. */
export function parseApplyEnvelope(raw: unknown): LocalApplyTaskEnvelope {
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const bad = (what: string) => new RunnerInputError(`Invalid application task: ${what}`);
	if (o.type !== LOCAL_APPLY_TASK_TYPE) throw bad(`type must be ${LOCAL_APPLY_TASK_TYPE}`);
	for (const k of ["runId", "requestId", "instanceId", "applicationId"]) if (typeof o[k] !== "string" || !SAFE_ID.test(o[k] as string)) throw bad(`${k} is required`);
	if (!/^[A-Za-z0-9_-]{1,100}$/.test(o.runId as string)) throw bad("runId must be a plain id");
	if (!LOCAL_APPLY_ENGINES.includes(o.engine as never)) throw bad("engine must be claude or codex");
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
	if (!LOCAL_APPLY_MODES.includes(p.mode as never)) throw bad("policy.mode must be fill_and_review or auto_submit");
	const gate = (p.submitGate && typeof p.submitGate === "object" ? p.submitGate : null) as Record<string, unknown> | null;
	const gateId = gate && typeof gate.gateId === "string" && SAFE_ID.test(gate.gateId) ? gate.gateId : null;
	// auto_submit without the gate PAGS evaluated is not a mode this runner will run.
	if (p.mode === "auto_submit" && !gateId) throw bad("auto_submit requires policy.submitGate");
	const allowDomains = strList(p.allowDomains);
	if (!allowDomains.length) throw bad("policy.allowDomains must name the application's site");
	const l = (o.limits && typeof o.limits === "object" ? o.limits : {}) as Record<string, unknown>;
	const limits = { maxMinutes: posInt(l.maxMinutes, 60) ?? 0, maxPages: posInt(l.maxPages, 200) ?? 0, maxActions: posInt(l.maxActions, 1000) ?? 0 };
	if (Object.values(limits).some((v) => !v)) throw bad("limits are out of range");
	const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : undefined);
	return {
		type: LOCAL_APPLY_TASK_TYPE,
		runId: o.runId as string,
		requestId: o.requestId as string,
		instanceId: o.instanceId as string,
		applicationId: o.applicationId as string,
		engine: o.engine as LocalApplyTaskEnvelope["engine"],
		authMode: o.authMode as LocalApplyTaskEnvelope["authMode"],
		browserProfile: o.browserProfile,
		applicationUrl: o.applicationUrl,
		job: { title: job.title.trim().slice(0, 300), company: opt(job.company), location: opt(job.location) },
		workspace: o.workspace,
		sources,
		artifacts,
		policy: { mode: p.mode as LocalApplyTaskEnvelope["policy"]["mode"], allowDomains, ...(p.mode === "auto_submit" && gateId ? { submitGate: { gateId } } : {}) },
		limits,
	};
}

/**
 * An approved artifact on the real disk: inside the workspace's `applications/`, and still the
 * file #956 hashed. Anything else is not uploaded.
 */
export function verifyArtifact(workspace: string, home: string, a: LocalApplyArtifact): { path: string; text: string } | { error: string } {
	const label = a.kind.replace("_", " ");
	try {
		const real = realpathSync(resolve(realpathSync(home), a.path.slice(2)));
		if (!real.startsWith(join(workspace, "applications") + sep)) return { error: `The approved ${label} is not inside the workspace's applications/ folder.` };
		const buf = readFileSync(real);
		if (sha256(buf) !== a.sha256) return { error: `The approved ${label} at ${a.path} has changed since it was generated; it will not be uploaded.` };
		return { path: real, text: buf.toString("utf8") };
	} catch {
		return { error: `The approved ${label} at ${a.path} could not be read.` };
	}
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

	/** Application fills that a restart would lose (#896) — their state is in this process. */
	liveWork(): string[] {
		return [...this.runs.values()].filter((r) => r.state !== "ended").map((r) => `an application fill (${r.envelope.applicationId.slice(0, 8)})`);
	}
	private readonly root: string;
	private readonly now: () => number;
	private readonly spawn: typeof nodeSpawn;
	private readonly retentionMs: number;

	constructor(private readonly deps: LocalApplyRuntimeDeps) {
		this.root = join(deps.dataDir, "local-apply");
		this.now = deps.now ?? Date.now;
		this.spawn = deps.spawn ?? nodeSpawn;
		this.retentionMs = deps.retentionMs ?? 24 * 60 * 60 * 1000;
		this.hydrateTerminalJournals();
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
						envelope, dir, token: "", state: "ended", events: raw.events as LocalApplyRunnerEvent[], seq: raw.seq,
						result: checked, allow: new Set(envelope.policy.allowDomains), grounding: [], secrets: [], activeSince: raw.endedAt,
						activeMs: 0, waiters: [], output: [], engineAuth: checked.engineAuth, cancelled: false, timedOut: false,
						checkpoints: new Map(), endedAt: raw.endedAt,
					});
				} catch { /* a corrupt local cache is never an authority */ }
			}
		}
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
		mkdirSync(join(dir, "scratch"), { recursive: true });
		const run: Run = {
			envelope,
			dir,
			token: randomBytes(24).toString("hex"),
			state: "running",
			events: [],
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
		let workspace: string;
		try {
			workspace = resolveWorkspacePath(e.workspace, home);
		} catch (err) {
			throw new Blocked("source_unavailable", [`The workspace ${e.workspace} cannot be used: ${err instanceof Error ? err.message : String(err)}`]);
		}
		const blocks: SourceBlock[] = [];
		const missing: string[] = [];
		if (!e.sources.some((s) => s.role === "profile")) missing.push("No profile source is configured. Choose one in the Application Runner settings.");
		for (const s of e.sources) {
			const shown = `${e.workspace}/${s.path}`;
			try {
				const buf = readFileSync(resolveSource(workspace, s.path));
				if (!buf.length || buf.length > SOURCE_BYTES) throw new Error("empty or too large");
				blocks.push({ label: s.role, text: buf.toString("utf8") });
				this.emit(run, { type: "source.read", detail: { role: s.role, path: shown, sha256: sha256(buf), bytes: buf.length } });
			} catch {
				missing.push(`Your ${s.role} at ${shown} could not be read. Add it, or choose another file in the Application Runner settings.`);
			}
		}
		if (missing.length) throw new Blocked("source_unavailable", missing);
		for (const a of e.artifacts) {
			const v = verifyArtifact(workspace, home, a);
			if ("error" in v) throw new Blocked("artifact_changed", [`${v.error} Re-run tailoring for this application.`]);
			blocks.push({ label: a.kind, text: v.text });
		}
		run.grounding = blocks.map((b) => b.text);

		const bridgeScript = this.deps.bridgeScript ?? fileURLToPath(new URL("../local-browser/bridge-stdio.js", import.meta.url));
		const spec = buildApplyEngineSpec(e, applyPrompt(e, blocks), { command: process.execPath, args: [bridgeScript], env: { [BRIDGE_ENV.url]: selfUrl, [BRIDGE_ENV.runId]: e.runId, [BRIDGE_ENV.token]: run.token } }, join(run.dir, "mcp.json"));
		run.secrets = secretEnvValues({ ...process.env, ...spec.env });
		run.engineAuth = observedApplyAuth(e.engine, spec.env);
		this.emit(run, { type: "engine.auth_checked", detail: { engine: e.engine, authMode: e.authMode, engineAuth: run.engineAuth, mode: e.policy.mode } });
		if (run.engineAuth === "api-key") throw new Blocked("api_key_refused", ["A provider API key would reach the CLI. Applications run on this machine's sign-in only — remove the key from the runner's environment."]);

		run.browser = await this.deps.browserFor(e.browserProfile, run.dir);
		const artifactsByKind = new Map(e.artifacts.map((a) => [a.kind, a] as const));
		run.bridge = new ApplyBridge(run.browser.tools, {
			emit: (ev) => this.emit(run, ev),
			pause: (p) => this.pause(run, p),
			supervisorCheckpoint: (checkpointId) => this.supervisorCheckpoint(run, checkpointId),
			isAllowed: (host) => [...run.allow].some((d) => domainWithin(host, d)),
			grounding: () => run.grounding.join("\n"),
			artifactPath: (kind: LocalApplyArtifactKind) => {
				const a = artifactsByKind.get(kind);
				if (!a) return { error: `No approved ${kind.replace("_", " ")} for this application.` };
				const v = verifyArtifact(workspace, home, a);
				return "error" in v ? v : { path: v.path, sha256: a.sha256 };
			},
			overTime: () => this.activeMs(run) >= e.limits.maxMinutes * 60_000,
			now: this.now,
			limits: e.limits,
			mode: e.policy.mode,
			gateId: e.policy.submitGate?.gateId,
		});
		if (spec.mcpConfig) writeFileSync(spec.mcpConfig.path, spec.mcpConfig.json, { mode: 0o600 });

		const child = this.spawn(spec.command, spec.args, { cwd: join(run.dir, "scratch"), env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
		run.child = child;
		this.emit(run, { type: "engine.started", detail: { engine: e.engine, mode: e.policy.mode } });
		let buf = "";
		const keep = (chunk: Buffer | string) => {
			buf += chunk.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) run.output.push(line.slice(0, 20_000));
			if (run.output.length > OUTPUT_LINES) run.output.splice(0, run.output.length - OUTPUT_LINES);
		};
		child.stdout?.on("data", keep);
		child.stderr?.on("data", keep);
		child.on("error", (err: NodeJS.ErrnoException) => {
			this.end(run, { outcome: "failed", error: err.code === "ENOENT" ? `The ${e.engine === "claude" ? "Claude Code" : "Codex"} CLI is not installed on this machine (\`${spec.command}\` was not found).` : err.message });
		});
		child.on("close", (code) => {
			if (buf.trim()) run.output.push(buf);
			this.emit(run, { type: "engine.ended", detail: { exitCode: code ?? -1 } });
			this.end(run, this.outcomeOf(run, code ?? -1));
		});
		run.timer = setInterval(() => {
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
		if (b?.reviewReady) return { outcome: "awaiting_review", summary };
		if (!b?.filled && missingLogin(e.engine, run.output.join("\n"))) return { outcome: "blocked", summary, blockReason: "engine_not_signed_in", questions: [signInHelp(e.engine)], engineAuth: "missing_login" };
		if (b?.blocked) return { outcome: "blocked", summary, blockReason: b.blocked.reason, questions: b.blocked.questions };
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

	private activeMs(run: Run): number {
		return run.activeMs + (run.state === "running" ? this.now() - run.activeSince : 0);
	}

	private emit(run: Run, ev: Omit<LocalApplyEvent, "at">): void {
		if (run.events.length >= MAX_EVENTS) return;
		run.events.push({ ...ev, at: new Date(this.now()).toISOString(), seq: ++run.seq });
	}

	private pause(run: Run, p: LocalApplyPause): Promise<"resumed" | "stopped"> {
		if (run.state === "ended" || run.cancelled) return Promise.resolve("stopped");
		if (run.state === "running") {
			run.activeMs += this.now() - run.activeSince;
			run.state = "paused";
			run.pause = p;
			this.emit(run, { type: "run.paused", pauseReason: p.reason, ...(p.url ? { url: p.url } : {}), ...(p.domain ? { domain: p.domain } : {}) });
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
				detail: { checkpointId, phase: supervisor.facts.phase, actions: supervisor.facts.actions, filled: supervisor.facts.filled, uploaded: supervisor.facts.uploaded },
			});
		}
		if (checkpoint.directive) return Promise.resolve(checkpoint.directive);
		return this.pause(run, { reason: "supervisor_checkpoint", checkpoint: supervisor }).then(() => run.checkpoints.get(checkpointId)?.directive ?? "stop");
	}

	private release(run: Run, outcome: "resumed" | "stopped"): void {
		if (run.state === "paused") {
			run.state = "running";
			run.pause = undefined;
			run.activeSince = this.now();
			if (outcome === "resumed") this.emit(run, { type: "run.resumed" });
		}
		for (const w of run.waiters.splice(0)) w(outcome);
	}

	/** The owner acted: add their answers to what values may be grounded in, admit any site they allowed, release. */
	resume(raw: unknown): LocalApplyStatusResponse {
		const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
		const run = this.get(String(o.runId ?? ""));
		if (run.state === "ended") throw new RunnerInputError("The run has ended", 409);
		if (run.pause?.reason === "supervisor_checkpoint") throw new RunnerInputError("This run is waiting for a persisted supervisor directive, not an owner resume", 409);
		for (const a of (Array.isArray(o.answers) ? o.answers : []).slice(0, LOCAL_APPLY_CAPS.answers)) {
			const r = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
			if (typeof r.question === "string" && typeof r.answer === "string" && r.answer.trim()) run.grounding.push(`Q: ${r.question.slice(0, LOCAL_APPLY_CAPS.questionChars)}\nA: ${r.answer.trim().slice(0, LOCAL_APPLY_CAPS.answerChars)}`);
		}
		for (const d of strList(o.allowDomains)) run.allow.add(d);
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
		if (run.state === "ended") throw new RunnerInputError("The run has ended", 409);

		let checkpoint = run.checkpoints.get(checkpointId);
		if (checkpoint?.directive) {
			if (checkpoint.directive !== directive) throw new RunnerInputError("A different directive is already recorded for this checkpoint", 409);
			return this.status({ runId: run.envelope.runId, afterSeq: run.seq });
		}
		checkpoint ??= {};
		checkpoint.directive = directive;
		run.checkpoints.set(checkpointId, checkpoint);
		this.emit(run, { type: "supervisor.directive", detail: { checkpointId, directive } });

		const waitingForThis = run.state === "paused" && run.pause?.reason === "supervisor_checkpoint" && run.pause.checkpoint?.checkpointId === checkpointId;
		if (waitingForThis && directive === "continue") this.release(run, "resumed");
		else if (waitingForThis && directive === "request_review") {
			this.end(run, { outcome: "awaiting_review", summary: "The supervisor requested an owner review." });
		} else if (waitingForThis && directive === "stop") {
			this.end(run, { outcome: "blocked", blockReason: "incomplete", questions: ["The supervisor stopped this run before it could continue."] });
		}
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

	status(raw: unknown): LocalApplyStatusResponse {
		const o = (raw && typeof raw === "object" ? raw : {}) as { runId?: unknown; afterSeq?: unknown };
		const run = this.get(String(o.runId ?? ""));
		const after = typeof o.afterSeq === "number" && o.afterSeq > 0 ? o.afterSeq : 0;
		// A page of at most 500 events; `lastSeq` is the cursor for the next page, so nothing is skipped.
		const pending = run.events.filter((e) => e.seq > after);
		const page = pending.length > 500 ? pending.slice(0, 500) : pending;
		return {
			runId: run.envelope.runId,
			state: run.state,
			...(run.pause ? { pause: run.pause } : {}),
			events: page,
			lastSeq: page.length < pending.length ? page[page.length - 1].seq : run.seq,
			...(run.result ? { result: run.result } : {}),
		};
	}

	/** Does this token belong to this run? The bridge forwarder's only credential. */
	authorizeBridge(runId: string, token: string): boolean {
		const run = this.runs.get(runId);
		return !!run && run.state !== "ended" && token.length > 0 && token === run.token;
	}

	async bridge(raw: unknown): Promise<unknown> {
		const o = (raw && typeof raw === "object" ? raw : {}) as { runId?: unknown; op?: unknown; name?: unknown; args?: unknown };
		const run = this.get(String(o.runId ?? ""));
		if (!run.bridge || run.state === "ended") throw new RunnerInputError("The run is not active", 409);
		if (o.op === "list") return { tools: await run.bridge.listTools() };
		// A call that arrives while the run waits on the owner (the CLI gave up waiting on its own
		// call) does not go ahead of them: nothing reaches the page until the owner resumes.
		if (o.op === "call" && run.state === "paused") return { content: [{ type: "text", text: `The run is paused for the owner (${run.pause?.reason.replace(/_/g, " ") ?? "waiting"}). Nothing can be done until they resume it. Stop now.` }], isError: true };
		if (o.op === "call" && typeof o.name === "string") return run.bridge.callTool(o.name, (o.args && typeof o.args === "object" ? o.args : {}) as Record<string, unknown>);
		throw new RunnerInputError("op must be list or call");
	}

	private get(runId: string): Run {
		const run = this.runs.get(runId);
		if (!run) throw new RunnerInputError(`No application run ${runId} on this runner (it may have restarted)`, 404);
		return run;
	}

	private kill(run: Run): void {
		const child = run.child;
		if (!child || child.exitCode !== null) return;
		child.kill("SIGTERM");
		setTimeout(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		}, 5_000).unref?.();
	}

	private end(run: Run, r: Partial<LocalApplyResultEnvelope> & { outcome: LocalApplyResultEnvelope["outcome"] }): void {
		if (run.state === "ended") return;
		if (run.state === "paused") this.release(run, "stopped");
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
		this.persistTerminal(run);
		if (run.child && run.child.exitCode === null) this.kill(run);
		void run.browser?.stop().catch(() => undefined);
	}

	/** Drop ended runs past retention, with their folders (scratch, MCP config, isolated profile). */
	sweep(): void {
		const cutoff = this.now() - this.retentionMs;
		for (const [id, run] of this.runs) {
			if (run.state === "ended" && (run.endedAt ?? 0) < cutoff) {
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
				if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
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
