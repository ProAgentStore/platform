/**
 * Local CLI browser research on the runner (#944) — the run registry and its lifecycle.
 *
 * One run = one Codex or Claude Code process, signed in on this machine, in its own working folder
 * (a managed scratch folder by default; never a repository), whose only window on the web is the
 * policy bridge (bridge.ts). The runtime owns everything PAGS later pulls with `status`:
 *
 *  - idempotency: a start with a requestId this runner already holds returns that run;
 *  - the concurrency cap the API resolved (`limits.maxConcurrent`), per instance;
 *  - the time limit — ACTIVE time only, so a run waiting on the owner is not timed out by the wait;
 *  - pauses: a consent, captcha or sign-in pause holds the bridge call until `resume` (or cancel,
 *    or the time limit) releases it;
 *  - the trace: seq-numbered, redacted events, capped per run;
 *  - the result envelope, once the CLI exits;
 *  - retention: an ended run's folder and record are removed after `retentionMs`.
 *
 * Runs live in memory. A runner restart loses them, and `status` then answers 404 for the run —
 * which the API reads as "the runner lost this run" and ends it, rather than waiting forever.
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerInputError } from "../errors.js";
import { type BrowserTools, BrowserBridge, domainWithin } from "./bridge.js";
import { BRIDGE_ENV } from "./bridge-stdio.js";
import {
	LOCAL_BROWSER_AUTH_MODES,
	LOCAL_BROWSER_ENGINES,
	LOCAL_BROWSER_TASK_TYPE,
	type LocalBrowserEngineAuth,
	type LocalBrowserEvent,
	type LocalBrowserLimits,
	type LocalBrowserPauseReason,
	type LocalBrowserProfile,
	type LocalBrowserResultEnvelope,
	type LocalBrowserResumeRequest,
	type LocalBrowserRunnerEvent,
	type LocalBrowserStatusResponse,
	type LocalBrowserTaskEnvelope,
	redactDetail,
	redactText,
	secretEnvValues,
} from "./contract.js";
import { buildEngineSpec, finalText, missingLogin, observedEngineAuth, researchPrompt, signInHelp } from "./engine.js";

/** A browser for one run: the runner's shared signed-in browser, or a throwaway one. */
export interface RunBrowser {
	tools: BrowserTools;
	/** Close it — a no-op for the shared browser, which outlives every run. */
	stop(): Promise<void>;
}

export interface LocalBrowserRuntimeDeps {
	/** The runner's data dir; runs live under `<dataDir>/local-browser/`. */
	dataDir: string;
	/** The runner's own local URL, for the bridge forwarder to call back. Null until the server listens. */
	selfUrl(): string | null;
	browserFor(profile: LocalBrowserProfile, runDir: string): Promise<RunBrowser>;
	spawn?: typeof nodeSpawn;
	now?: () => number;
	homeDir?: string;
	/** How long an ended run's folder and record are kept. Default 24h. */
	retentionMs?: number;
	/** Path to the compiled bridge forwarder. Defaults to bridge-stdio.js beside this file. */
	bridgeScript?: string;
}

const MAX_EVENTS = 2000;
const OUTPUT_LINES = 400;

interface Run {
	envelope: LocalBrowserTaskEnvelope;
	dir: string;
	workDir: string;
	token: string;
	state: "running" | "paused" | "ended";
	pauseReason?: LocalBrowserPauseReason;
	events: LocalBrowserRunnerEvent[];
	seq: number;
	result?: LocalBrowserResultEnvelope;
	child?: ChildProcess;
	browser?: RunBrowser;
	bridge?: BrowserBridge;
	consented: Set<string>;
	deny: Set<string>;
	profileConsented: boolean;
	/** The owner's decision ids, by domain (`*` = the signed-in profile) — named on the trace (#947). */
	consentIds: Map<string, string>;
	/** Credential values in the engine's env: never stored, whatever the CLI prints (#947). */
	secrets: string[];
	activeSince: number;
	activeMs: number;
	waiters: Array<(outcome: "resumed" | "stopped") => void>;
	output: string[];
	engineAuth: LocalBrowserEngineAuth;
	cancelled: boolean;
	timedOut: boolean;
	endedAt?: number;
	timer?: ReturnType<typeof setInterval>;
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()) : []);
const posInt = (v: unknown, max: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max ? v : null);

/** The envelope, validated at the runner's boundary — PAGS sends it, but the relay is a boundary. */
export function parseEnvelope(raw: unknown): LocalBrowserTaskEnvelope {
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const bad = (what: string) => new RunnerInputError(`Invalid local browser task: ${what}`);
	if (o.type !== LOCAL_BROWSER_TASK_TYPE) throw bad(`type must be ${LOCAL_BROWSER_TASK_TYPE}`);
	for (const k of ["runId", "requestId", "instanceId"]) if (typeof o[k] !== "string" || !SAFE_ID.test(o[k] as string)) throw bad(`${k} is required`);
	if (typeof o.objective !== "string" || !o.objective.trim() || o.objective.length > 4000) throw bad("objective is required");
	if (!LOCAL_BROWSER_ENGINES.includes(o.engine as never)) throw bad("engine must be claude or codex");
	if (!LOCAL_BROWSER_AUTH_MODES.includes(o.authMode as never)) throw bad("authMode is invalid");
	const ws = (o.workspace && typeof o.workspace === "object" ? o.workspace : {}) as Record<string, unknown>;
	if (ws.kind !== "scratch" && !(ws.kind === "path" && typeof ws.path === "string")) throw bad("workspace must be scratch or a path");
	if (o.browserProfile !== "isolated" && o.browserProfile !== "default") throw bad("browserProfile must be isolated or default");
	const p = (o.policy && typeof o.policy === "object" ? o.policy : {}) as Record<string, unknown>;
	if (p.mode !== "research_only") throw bad("only research_only runs are supported");
	const l = (o.limits && typeof o.limits === "object" ? o.limits : {}) as Record<string, unknown>;
	const limits: LocalBrowserLimits = {
		maxMinutes: posInt(l.maxMinutes, 60) ?? 0,
		maxPages: posInt(l.maxPages, 200) ?? 0,
		maxActions: posInt(l.maxActions, 1000) ?? 0,
		maxConcurrent: posInt(l.maxConcurrent, 3) ?? 0,
	};
	if (Object.values(limits).some((v) => !v)) throw bad("limits are out of range");
	const schema = (o.resultSchema && typeof o.resultSchema === "object" ? o.resultSchema : {}) as Record<string, unknown>;
	return {
		type: LOCAL_BROWSER_TASK_TYPE,
		runId: o.runId as string,
		requestId: o.requestId as string,
		instanceId: o.instanceId as string,
		objective: o.objective.trim(),
		engine: o.engine as LocalBrowserTaskEnvelope["engine"],
		authMode: o.authMode as LocalBrowserTaskEnvelope["authMode"],
		workspace: ws.kind === "path" ? { kind: "path", path: ws.path as string } : { kind: "scratch" },
		browserProfile: o.browserProfile,
		policy: {
			mode: "research_only",
			allowDomains: strList(p.allowDomains),
			denyDomains: strList(p.denyDomains),
			consentedDomains: strList(p.consentedDomains),
			profileConsented: p.profileConsented === true,
			consentIds: consentIdMap(p.consentIds),
		},
		limits,
		resultSchema: { id: typeof schema.id === "string" ? schema.id : "findings", version: typeof schema.version === "number" ? schema.version : 1 },
	};
}

/** Decision ids keyed by lowercase domain (or `*`), from an untrusted object. */
function consentIdMap(raw: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 200)) if (typeof v === "string" && SAFE_ID.test(v)) out[k.toLowerCase()] = v;
	}
	return out;
}

/**
 * A `~/…` workspace, resolved under the home directory — re-checked here against the real disk,
 * because the API could only check the string. A symlink out of home is refused like `..` is.
 */
export function resolveWorkspacePath(path: string, home: string): string {
	if (!/^~\/[^\0]+$/.test(path)) throw new RunnerInputError('The workspace folder must be written "~/…", under this machine\'s home folder.');
	const realHome = realpathSync(home);
	const target = resolve(realHome, path.slice(2));
	if (!target.startsWith(realHome + sep)) throw new RunnerInputError("The workspace folder must be inside this machine's home folder.");
	mkdirSync(target, { recursive: true });
	const real = realpathSync(target);
	if (!real.startsWith(realHome + sep)) throw new RunnerInputError("The workspace folder resolves outside this machine's home folder (a symlink).");
	return real;
}

export class LocalBrowserRuntime {
	private readonly runs = new Map<string, Run>();
	private readonly root: string;
	private readonly now: () => number;
	private readonly spawn: typeof nodeSpawn;
	private readonly retentionMs: number;

	constructor(private readonly deps: LocalBrowserRuntimeDeps) {
		this.root = join(deps.dataDir, "local-browser");
		this.now = deps.now ?? Date.now;
		this.spawn = deps.spawn ?? nodeSpawn;
		this.retentionMs = deps.retentionMs ?? 24 * 60 * 60 * 1000;
	}

	/** Start a run. A requestId already held for the instance returns that run instead. */
	start(raw: unknown): { runId: string; taskId: string; status: "running" | "paused" | "ended"; existing: boolean } {
		const envelope = parseEnvelope(raw);
		this.sweep();
		const same = [...this.runs.values()].find((r) => r.envelope.instanceId === envelope.instanceId && r.envelope.requestId === envelope.requestId);
		if (same) return { runId: same.envelope.runId, taskId: same.envelope.runId, status: same.state, existing: true };
		if (this.runs.has(envelope.runId)) throw new RunnerInputError(`Run ${envelope.runId} already exists with another requestId`, 409);
		const active = [...this.runs.values()].filter((r) => r.envelope.instanceId === envelope.instanceId && r.state !== "ended").length;
		if (active >= envelope.limits.maxConcurrent) throw new RunnerInputError(`This machine is already running ${active} research run(s) for this agent (limit ${envelope.limits.maxConcurrent}).`, 409);
		const selfUrl = this.deps.selfUrl();
		if (!selfUrl) throw new RunnerInputError("The runner is still starting; try again in a moment.", 409);

		const dir = join(this.root, envelope.instanceId, envelope.runId);
		mkdirSync(dir, { recursive: true });
		const workDir = envelope.workspace.kind === "path" ? resolveWorkspacePath(envelope.workspace.path, this.deps.homeDir ?? homedir()) : join(dir, "scratch");
		mkdirSync(workDir, { recursive: true });

		const run: Run = {
			envelope,
			dir,
			workDir,
			token: randomBytes(24).toString("hex"),
			state: "running",
			events: [],
			seq: 0,
			consented: new Set(envelope.policy.consentedDomains),
			deny: new Set(envelope.policy.denyDomains),
			profileConsented: envelope.policy.profileConsented,
			consentIds: new Map(Object.entries(envelope.policy.consentIds ?? {})),
			secrets: secretEnvValues(process.env),
			activeSince: this.now(),
			activeMs: 0,
			waiters: [],
			output: [],
			engineAuth: "unknown",
			cancelled: false,
			timedOut: false,
		};
		this.runs.set(envelope.runId, run);
		// Not awaited: a signed-in-profile consent pause can hold the launch for minutes, and the
		// relay command that started the run must answer now. Everything after this is in `status`.
		void this.launch(run, selfUrl).catch((err) => this.end(run, { outcome: "failed", error: err instanceof Error ? err.message : String(err) }));
		return { runId: envelope.runId, taskId: envelope.runId, status: run.state, existing: false };
	}

	private async launch(run: Run, selfUrl: string): Promise<void> {
		const e = run.envelope;
		// The signed-in profile is the owner's own browser — never without their say-so (#947).
		if (e.browserProfile === "default" && !run.profileConsented) {
			this.emit(run, { type: "consent.requested", detail: { scope: "signed_in_profile" } });
			const outcome = await this.pause(run, "consent_required", { scope: "signed_in_profile" });
			if (outcome !== "resumed" || !run.profileConsented) throw new Error("The owner did not allow research in their signed-in browser profile.");
		}
		if (e.browserProfile === "default") this.emit(run, { type: "policy.decision", ...this.consentRef(run, "*"), detail: { scope: "signed_in_profile", decision: "consented" } });
		run.browser = await this.deps.browserFor(e.browserProfile, run.dir);
		run.bridge = new BrowserBridge(run.browser.tools, {
			emit: (ev) => this.emit(run, ev),
			pause: (reason, detail) => this.pause(run, reason, detail),
			consentIdFor: (host) => this.consentRef(run, host).consentId,
			isDenied: (host) => [...run.deny].some((d) => domainWithin(host, d)),
			isPermitted: (host) => [...e.policy.allowDomains, ...run.consented].some((d) => domainWithin(host, d)),
			allowListOnly: () => e.policy.allowDomains.length > 0,
			overTime: () => this.activeMs(run) >= e.limits.maxMinutes * 60_000,
			limits: e.limits,
		});

		const bridgeScript = this.deps.bridgeScript ?? fileURLToPath(new URL("./bridge-stdio.js", import.meta.url));
		const spec = buildEngineSpec({
			engine: e.engine,
			authMode: e.authMode,
			prompt: researchPrompt(e),
			bridge: { command: process.execPath, args: [bridgeScript], env: { [BRIDGE_ENV.url]: selfUrl, [BRIDGE_ENV.runId]: e.runId, [BRIDGE_ENV.token]: run.token } },
			mcpConfigPath: join(run.dir, "mcp.json"),
			toolTimeoutMs: e.limits.maxMinutes * 60_000,
		});
		if (spec.mcpConfig) writeFileSync(spec.mcpConfig.path, spec.mcpConfig.json, { mode: 0o600 });
		// The env the engine actually gets — a key the owner chose to pass (api-key mode) included.
		run.secrets = secretEnvValues({ ...process.env, ...spec.env });
		run.engineAuth = observedEngineAuth(e.engine, spec.env);
		this.emit(run, { type: "engine.auth_checked", detail: { engine: e.engine, authMode: e.authMode, engineAuth: run.engineAuth } });

		const child = this.spawn(spec.command, spec.args, { cwd: run.workDir, env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
		run.child = child;
		this.emit(run, { type: "engine.started", detail: { engine: e.engine, workspace: e.workspace.kind } });
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
			const missing = err.code === "ENOENT";
			this.end(run, { outcome: "failed", error: missing ? `The ${e.engine === "claude" ? "Claude Code" : "Codex"} CLI is not installed on this machine (\`${spec.command}\` was not found).` : err.message });
		});
		child.on("close", (code) => {
			if (buf.trim()) run.output.push(buf);
			this.emit(run, { type: "engine.ended", detail: { exitCode: code ?? -1 } });
			this.finish(run, code ?? -1);
		});
		run.timer = setInterval(() => {
			if (run.state !== "ended" && this.activeMs(run) >= e.limits.maxMinutes * 60_000 + 60_000) {
				// The bridge already refuses past the limit; this is the backstop for a CLI that keeps
				// thinking without calling a tool.
				run.timedOut = true;
				this.kill(run);
			}
		}, 5_000);
		run.timer.unref?.();
	}

	private activeMs(run: Run): number {
		return run.activeMs + (run.state === "running" ? this.now() - run.activeSince : 0);
	}

	private emit(run: Run, ev: Omit<LocalBrowserEvent, "at">): void {
		if (run.events.length >= MAX_EVENTS) return;
		const { detail: raw, ...rest } = ev;
		const detail = redactDetail(raw, 0, run.secrets);
		run.events.push({ ...rest, ...(detail && Object.keys(detail).length ? { detail } : {}), at: new Date(this.now()).toISOString(), seq: ++run.seq });
	}

	private pause(run: Run, reason: LocalBrowserPauseReason, detail: Record<string, unknown>): Promise<"resumed" | "stopped"> {
		if (run.state === "ended" || run.cancelled) return Promise.resolve("stopped");
		if (run.state === "running") {
			run.activeMs += this.now() - run.activeSince;
			run.state = "paused";
			run.pauseReason = reason;
			this.emit(run, { type: "run.paused", pauseReason: reason, detail });
		}
		return new Promise((resolveWait) => run.waiters.push(resolveWait));
	}

	private release(run: Run, outcome: "resumed" | "stopped"): void {
		if (run.state === "paused") {
			run.state = "running";
			run.pauseReason = undefined;
			run.activeSince = this.now();
			if (outcome === "resumed") this.emit(run, { type: "run.resumed" });
		}
		for (const w of run.waiters.splice(0)) w(outcome);
	}

	/** The owner acted: refresh consent and release whatever the run was waiting on. */
	resume(raw: unknown): LocalBrowserStatusResponse {
		const o = (raw && typeof raw === "object" ? raw : {}) as Partial<LocalBrowserResumeRequest>;
		const run = this.get(String(o.runId ?? ""));
		if (run.state === "ended") throw new RunnerInputError("The run has ended", 409);
		for (const [d, id] of Object.entries(consentIdMap(o.consentIds))) run.consentIds.set(d, id);
		for (const d of strList(o.consentedDomains)) run.consented.add(d);
		for (const d of strList(o.denyDomains)) run.deny.add(d);
		if (o.profileConsented === true) run.profileConsented = true;
		this.release(run, "resumed");
		return this.status({ runId: run.envelope.runId, afterSeq: run.seq });
	}

	cancel(raw: unknown): { runId: string; state: string } {
		const runId = String((raw as { runId?: unknown } | null)?.runId ?? "");
		const run = this.get(runId);
		if (run.state !== "ended") {
			run.cancelled = true;
			this.release(run, "stopped");
			if (run.child) this.kill(run);
			else this.end(run, { outcome: "failed", error: "Cancelled by the owner" });
		}
		return { runId, state: run.state };
	}

	status(raw: unknown): LocalBrowserStatusResponse {
		const o = (raw && typeof raw === "object" ? raw : {}) as { runId?: unknown; afterSeq?: unknown };
		const run = this.get(String(o.runId ?? ""));
		const after = typeof o.afterSeq === "number" && o.afterSeq > 0 ? o.afterSeq : 0;
		return {
			runId: run.envelope.runId,
			state: run.state,
			...(run.pauseReason ? { pauseReason: run.pauseReason } : {}),
			events: run.events.filter((e) => e.seq > after).slice(0, 500),
			lastSeq: run.seq,
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
		if (o.op === "call" && typeof o.name === "string") return run.bridge.callTool(o.name, (o.args && typeof o.args === "object" ? o.args : {}) as Record<string, unknown>);
		throw new RunnerInputError("op must be list or call");
	}

	/** The decision that covers this host (or `*`), as an event field — empty when none does. */
	private consentRef(run: Run, host: string): { consentId?: string } {
		if (host === "*") return run.consentIds.has("*") ? { consentId: run.consentIds.get("*") } : {};
		let best: [string, string] | null = null;
		for (const [d, id] of run.consentIds) if (d !== "*" && domainWithin(host, d) && (!best || d.length > best[0].length)) best = [d, id];
		return best ? { consentId: best[1] } : {};
	}

	private get(runId: string): Run {
		const run = this.runs.get(runId);
		if (!run) throw new RunnerInputError(`No local browser run ${runId} on this runner (it may have restarted)`, 404);
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

	/** The CLI exited: assemble the result from what the bridge recorded and what the CLI said. */
	private finish(run: Run, code: number): void {
		if (run.state === "ended") return;
		this.end(run, this.outcomeOf(run, code));
	}

	private outcomeOf(run: Run, code: number): { outcome: "completed" | "failed"; summary?: string; error?: string; engineAuth?: LocalBrowserEngineAuth } {
		const e = run.envelope;
		const bridge = run.bridge;
		const summary = bridge?.summary ?? finalText(e.engine, run.output);
		const found = (bridge?.findings.length ?? 0) > 0;
		if (run.cancelled) return { outcome: "failed", error: "Cancelled by the owner" };
		if (missingLogin(e.engine, run.output.join("\n")) && !found) return { outcome: "failed", error: signInHelp(e.engine), engineAuth: "missing_login" };
		const limit = `Stopped at the ${e.limits.maxMinutes}-minute limit.`;
		if (run.timedOut) return { outcome: found ? "completed" : "failed", summary: summary || limit, error: limit };
		if (code !== 0 && !bridge?.summary) {
			const tail = run.output.slice(-5).join("\n").slice(-800);
			return { outcome: "failed", summary, error: `The ${e.engine} CLI exited with code ${code}${tail ? `: ${tail}` : ""}` };
		}
		return { outcome: "completed", summary };
	}

	private end(run: Run, r: { outcome: "completed" | "failed"; summary?: string; error?: string; engineAuth?: LocalBrowserEngineAuth }): void {
		if (run.state === "ended") return;
		if (run.state === "paused") this.release(run, "stopped");
		if (run.timer) clearInterval(run.timer);
		run.state = "ended";
		run.endedAt = this.now();
		run.result = {
			runId: run.envelope.runId,
			outcome: r.outcome,
			findings: run.bridge?.findings ?? [],
			sourceFailures: run.bridge?.sourceFailures ?? [],
			summary: redactText((r.summary ?? "").slice(0, 4000), run.secrets),
			traceId: run.envelope.runId,
			engineAuth: r.engineAuth ?? run.engineAuth,
			// CLI output becomes this text, and a CLI prints whatever it was given: redacted before it is kept.
			...(r.outcome === "failed" ? { error: redactText((r.error ?? "The run failed without a reason.").slice(0, 1000), run.secrets) } : {}),
		};
		if (run.child && run.child.exitCode === null) this.kill(run);
		void run.browser?.stop().catch(() => undefined);
	}

	/** Drop ended runs past retention, with their folders. Custom workspaces are the owner's and are never deleted. */
	sweep(): void {
		const cutoff = this.now() - this.retentionMs;
		for (const [id, run] of this.runs) {
			if (run.state === "ended" && (run.endedAt ?? 0) < cutoff) {
				rmSync(run.dir, { recursive: true, force: true });
				this.runs.delete(id);
			}
		}
		// Folders left by a previous runner process (its runs are gone from memory).
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

	/** Runner shutdown: stop every engine. Their runs end failed — the process that held them is going. */
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
