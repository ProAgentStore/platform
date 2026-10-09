/**
 * Local artifact generation on the runner (#956) — the Application Tailor's hands.
 *
 * One run = one Codex or Claude Code process, signed in on this machine, that turns ONE approved
 * job lead plus the owner's own source files into a tailored résumé and cover letter. No browser,
 * no repository, no provider API key. The runtime, not the CLI, does every read and every write:
 *
 *  - reads: only the configured source files, each resolved on the real disk inside the workspace
 *    (`..`, absolute paths and symlinks out are refused), and never under `applications/`, where
 *    generated material — this instance's or another's — lives;
 *  - writes: only new files in a fresh `<workspace>/applications/<leadId>/<runId>/`, created
 *    exclusively (`wx`), so a master source is never rewritten and two runs never share a folder;
 *  - the trace carries handles (role, owner-visible path, sha256, byte count), never content.
 *
 * A missing source, an unusable workspace, a CLI that is not signed in, an API key in the env, a
 * malformed lead or a draft whose claims do not check out ends the run `needs_human` — a pause
 * the owner resolves — never a plausible guess written to disk.
 *
 * Runs live in memory, like local browser runs: a restart loses them and `status` answers 404,
 * which PAGS reads as "the runner lost this run". Generated folders carry a manifest with their
 * retention date; a later run on the same workspace removes those past it.
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { RunnerInputError } from "../errors.js";
import { redactText, secretEnvValues } from "../local-browser/contract.js";
import { resolveWorkspacePath } from "../local-browser/runtime.js";
import {
	LOCAL_ARTIFACT_AUTH_MODES,
	LOCAL_ARTIFACT_CAPS,
	LOCAL_ARTIFACT_ENGINES,
	LOCAL_ARTIFACT_SOURCE_ROLES,
	LOCAL_ARTIFACT_TASK_TYPE,
	type LocalArtifactBlockReason,
	type LocalArtifactEngineAuth,
	type LocalArtifactEvent,
	type LocalArtifactFile,
	type LocalArtifactLead,
	type LocalArtifactResultEnvelope,
	type LocalArtifactRunnerEvent,
	type LocalArtifactSource,
	type LocalArtifactSourceHash,
	type LocalArtifactStatusResponse,
	type LocalArtifactTaskEnvelope,
	type LocalArtifactValidationDiagnostic,
	PATH_SEGMENT,
	REQUIRED_SOURCE_ROLES,
	isHomeRelative,
	isWorkspaceRelative,
	parseLocalArtifactLead,
} from "./contract.js";
import { type SourceText, buildArtifactEngineSpec, checkDraft, finalText, missingLogin, observedArtifactAuth, parseDraft, tailorPrompt } from "./engine.js";

export interface LocalArtifactRuntimeDeps {
	/** The runner's data dir; per-run scratch folders live under `<dataDir>/local-artifact/`. */
	dataDir: string;
	spawn?: typeof nodeSpawn;
	now?: () => number;
	homeDir?: string;
	/** How long an ended run's in-memory record and scratch folder are kept. Default 24h. */
	retentionMs?: number;
}

/** The manifest in every generated folder — what retention reads, and proof the folder is ours. */
export const ARTIFACT_MANIFEST = ".pags-artifact.json";
const MAX_EVENTS = 200;
const OUTPUT_LINES = 400;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,300}$/;
const DAY_MS = 86_400_000;

/** A structurally valid envelope whose lead did not validate: the run still starts, and pauses. */
type ParsedEnvelope = Omit<LocalArtifactTaskEnvelope, "lead"> & { lead: LocalArtifactLead | null; leadError?: string };

interface Run {
	envelope: ParsedEnvelope;
	scratch: string;
	state: "running" | "ended";
	events: LocalArtifactRunnerEvent[];
	seq: number;
	result?: LocalArtifactResultEnvelope;
	child?: ChildProcess;
	output: string[];
	secrets: string[];
	engineAuth: LocalArtifactEngineAuth;
	cancelled: boolean;
	timedOut: boolean;
	endedAt?: number;
	timer?: ReturnType<typeof setTimeout>;
}

const intIn = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);

/** The envelope, validated at the runner's boundary. A bad LEAD is not thrown: it pauses the run. */
export function parseArtifactEnvelope(raw: unknown): ParsedEnvelope {
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const bad = (what: string) => new RunnerInputError(`Invalid local artifact task: ${what}`);
	if (o.type !== LOCAL_ARTIFACT_TASK_TYPE) throw bad(`type must be ${LOCAL_ARTIFACT_TASK_TYPE}`);
	if (typeof o.runId !== "string" || !PATH_SEGMENT.test(o.runId)) throw bad("runId is required");
	for (const k of ["requestId", "instanceId"]) if (typeof o[k] !== "string" || !SAFE_ID.test(o[k] as string)) throw bad(`${k} is required`);
	if (!LOCAL_ARTIFACT_ENGINES.includes(o.engine as never)) throw bad("engine must be claude or codex");
	if (!LOCAL_ARTIFACT_AUTH_MODES.includes(o.authMode as never)) throw bad("authMode must be machine or subscription — a provider API key is never used");
	if (typeof o.workspace !== "string" || !isHomeRelative(o.workspace)) throw bad('workspace must be a folder written "~/…"');
	if (!Array.isArray(o.sources) || o.sources.length > LOCAL_ARTIFACT_CAPS.sources) throw bad("sources must be a list");
	const sources: LocalArtifactSource[] = [];
	for (const s of o.sources) {
		const r = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
		if (!LOCAL_ARTIFACT_SOURCE_ROLES.includes(r.role as never) || typeof r.path !== "string" || !isWorkspaceRelative(r.path)) throw bad("each source needs a role and a path inside the workspace");
		if (r.path.split("/")[0] === "applications") throw bad("a source may not be inside applications/, where generated material lives");
		if (sources.some((x) => x.role === r.role)) throw bad(`source ${String(r.role)} is listed twice`);
		sources.push({ role: r.role as LocalArtifactSource["role"], path: r.path });
	}
	const p = (o.policy && typeof o.policy === "object" ? o.policy : {}) as Record<string, unknown>;
	const retainDays = intIn(p.retainDays, 0, 3650);
	const maxMinutes = intIn(p.maxMinutes, 1, 60);
	const maxConcurrent = intIn(p.maxConcurrent, 1, 3);
	if (retainDays === null || maxMinutes === null || maxConcurrent === null) throw bad("policy limits are out of range");
	const lead = parseLocalArtifactLead(o.lead);
	return {
		type: LOCAL_ARTIFACT_TASK_TYPE,
		runId: o.runId,
		requestId: o.requestId as string,
		instanceId: o.instanceId as string,
		engine: o.engine as LocalArtifactTaskEnvelope["engine"],
		authMode: o.authMode as LocalArtifactTaskEnvelope["authMode"],
		workspace: o.workspace,
		sources,
		policy: { retainDays, maxMinutes, maxConcurrent },
		...("lead" in lead ? { lead: lead.lead } : { lead: null, leadError: lead.error }),
	};
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** A source file resolved on the real disk, strictly inside the workspace. */
export function resolveSource(workspace: string, rel: string): string {
	const real = realpathSync(resolve(workspace, rel));
	if (!real.startsWith(workspace + sep)) throw new Error("outside the workspace");
	if (real.slice(workspace.length + 1).split(sep)[0] === "applications") throw new Error("inside applications/");
	if (!statSync(real).isFile()) throw new Error("not a file");
	return real;
}

class Pause extends Error {
	constructor(
		readonly reason: LocalArtifactBlockReason,
		readonly questions: string[],
	) {
		super(reason);
	}
}

export class LocalArtifactRuntime {
	private readonly runs = new Map<string, Run>();

	/** Tailoring runs that a restart would lose (#896) — their state is in this process. */
	liveWork(): string[] {
		return [...this.runs.values()].filter((r) => r.state !== "ended").map((r) => `a tailoring run (${r.envelope.runId.slice(0, 8)})`);
	}
	private readonly root: string;
	private readonly now: () => number;
	private readonly spawn: typeof nodeSpawn;
	private readonly retentionMs: number;

	constructor(private readonly deps: LocalArtifactRuntimeDeps) {
		this.root = join(deps.dataDir, "local-artifact");
		this.now = deps.now ?? Date.now;
		this.spawn = deps.spawn ?? nodeSpawn;
		this.retentionMs = deps.retentionMs ?? DAY_MS;
	}

	/** Start a run. A requestId already held for the instance returns that run instead. */
	start(raw: unknown): { runId: string; taskId: string; status: "running" | "ended"; existing: boolean } {
		const envelope = parseArtifactEnvelope(raw);
		this.sweep();
		const same = [...this.runs.values()].find((r) => r.envelope.instanceId === envelope.instanceId && r.envelope.requestId === envelope.requestId);
		if (same) return { runId: same.envelope.runId, taskId: same.envelope.runId, status: same.state, existing: true };
		if (this.runs.has(envelope.runId)) throw new RunnerInputError(`Run ${envelope.runId} already exists with another requestId`, 409);
		const active = [...this.runs.values()].filter((r) => r.envelope.instanceId === envelope.instanceId && r.state !== "ended").length;
		if (active >= envelope.policy.maxConcurrent) throw new RunnerInputError(`This machine is already tailoring ${active} application(s) for this agent (limit ${envelope.policy.maxConcurrent}).`, 409);

		const scratch = join(this.root, envelope.instanceId.replace(/[^A-Za-z0-9_-]/g, "_"), envelope.runId);
		mkdirSync(scratch, { recursive: true });
		const run: Run = { envelope, scratch, state: "running", events: [], seq: 0, output: [], secrets: secretEnvValues(process.env), engineAuth: "unknown", cancelled: false, timedOut: false };
		this.runs.set(envelope.runId, run);
		void this.launch(run).catch((err) => {
			if (err instanceof Pause) this.pauseEnd(run, err.reason, err.questions);
			else this.end(run, { outcome: "failed", error: err instanceof Error ? err.message : String(err) });
		});
		return { runId: envelope.runId, taskId: envelope.runId, status: run.state, existing: false };
	}

	private async launch(run: Run): Promise<void> {
		const e = run.envelope;
		if (!e.lead) throw new Pause("malformed_lead", [`The approved lead could not be read (${e.leadError ?? "malformed"}). Re-approve it from the Scout.`]);
		const lead = e.lead;

		let workspace: string;
		try {
			workspace = resolveWorkspacePath(e.workspace, this.deps.homeDir ?? homedir());
		} catch (err) {
			throw new Pause("workspace_unavailable", [`The workspace ${e.workspace} cannot be used: ${err instanceof Error ? err.message : String(err)}`]);
		}
		this.sweepArtifacts(run, workspace);

		// Sources: read by the runtime, hashed, handed to the CLI in its prompt. Content never leaves this function except into the prompt.
		const texts: SourceText[] = [];
		const hashes: LocalArtifactSourceHash[] = [];
		const missing: string[] = [];
		for (const s of e.sources) {
			const shown = `${e.workspace}/${s.path}`;
			try {
				const file = resolveSource(workspace, s.path);
				const buf = readFileSync(file);
				if (buf.length > LOCAL_ARTIFACT_CAPS.sourceBytes) throw new Error(`larger than ${LOCAL_ARTIFACT_CAPS.sourceBytes / 1024} KB`);
				if (!buf.length) throw new Error("empty");
				texts.push({ role: s.role, text: buf.toString("utf8") });
				const hash = { role: s.role, path: shown, sha256: sha256(buf), bytes: buf.length };
				hashes.push(hash);
				this.emit(run, { type: "source.read", detail: hash });
			} catch (err) {
				this.emit(run, { type: "source.missing", detail: { role: s.role, path: shown } });
				missing.push(`Your ${s.role} at ${shown} could not be read (${err instanceof Error && !/ENOENT/.test(err.message) ? err.message : "not found"}). Add it, or choose another file in the Application Tailor settings.`);
			}
		}
		for (const role of REQUIRED_SOURCE_ROLES) {
			if (!e.sources.some((s) => s.role === role)) missing.push(`No ${role} source is configured. Choose one in the Application Tailor settings.`);
		}
		if (missing.length) throw new Pause("missing_source", missing);

		const outRel = `applications/${lead.leadId}/${e.runId}`;
		const outDir = join(workspace, "applications", lead.leadId, e.runId);
		try {
			mkdirSync(join(workspace, "applications", lead.leadId), { recursive: true });
			mkdirSync(outDir); // exclusive: a run never writes into a folder it did not create
			if (!realpathSync(outDir).startsWith(workspace + sep)) throw new Error("the output folder resolves outside the workspace");
		} catch (err) {
			throw new Pause("workspace_unavailable", [`Cannot create ${e.workspace}/${outRel}: ${err instanceof Error ? err.message : String(err)}`]);
		}

		const spec = buildArtifactEngineSpec({ engine: e.engine, authMode: e.authMode, prompt: tailorPrompt(lead, texts) });
		run.secrets = secretEnvValues({ ...process.env, ...spec.env });
		run.engineAuth = observedArtifactAuth(e.engine, spec.env);
		this.emit(run, { type: "engine.auth_checked", detail: { engine: e.engine, authMode: e.authMode, engineAuth: run.engineAuth } });
		if (run.engineAuth === "api-key") {
			rmdirSync(outDir);
			throw new Pause("api_key_refused", ["A provider API key would reach the CLI. The Application Tailor runs on your machine's sign-in only — remove the key from the runner's environment."]);
		}

		const child = this.spawn(spec.command, spec.args, { cwd: run.scratch, env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
		run.child = child;
		this.emit(run, { type: "engine.started", detail: { engine: e.engine } });
		let buf = "";
		const keep = (chunk: Buffer | string) => {
			buf += chunk.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) run.output.push(line.slice(0, 200_000));
			if (run.output.length > OUTPUT_LINES) run.output.splice(0, run.output.length - OUTPUT_LINES);
		};
		child.stdout?.on("data", keep);
		child.stderr?.on("data", keep);
		child.on("error", (err: NodeJS.ErrnoException) => {
			this.removeIfEmpty(outDir);
			this.end(run, { outcome: "failed", error: err.code === "ENOENT" ? `The ${e.engine === "claude" ? "Claude Code" : "Codex"} CLI is not installed on this machine (\`${spec.command}\` was not found).` : err.message });
		});
		child.on("close", (code) => {
			if (buf.trim()) run.output.push(buf);
			this.emit(run, { type: "engine.ended", detail: { exitCode: code ?? -1 } });
			try {
				this.finish(run, code ?? -1, { workspace, outDir, outRel, lead, hashes, texts });
			} catch (err) {
				this.removeIfEmpty(outDir);
				this.end(run, { outcome: "failed", error: err instanceof Error ? err.message : String(err) });
			}
		});
		run.timer = setTimeout(() => {
			run.timedOut = true;
			this.kill(run);
		}, e.policy.maxMinutes * 60_000);
		run.timer.unref?.();
	}

	/** The CLI exited: check its draft against the sources, and only then write the artifacts. */
	private finish(run: Run, code: number, ctx: { workspace: string; outDir: string; outRel: string; lead: LocalArtifactLead; hashes: LocalArtifactSourceHash[]; texts: SourceText[] }): void {
		if (run.state === "ended") return;
		const e = run.envelope;
		const output = run.output.join("\n");
		if (run.cancelled || run.timedOut) {
			this.removeIfEmpty(ctx.outDir);
			this.end(run, { outcome: "failed", error: run.cancelled ? "Cancelled by the owner" : `Stopped at the ${e.policy.maxMinutes}-minute limit.` });
			return;
		}
		const text = finalText(e.engine, run.output);
		if (!text && missingLogin(e.engine, output)) {
			this.removeIfEmpty(ctx.outDir);
			run.engineAuth = "missing_login";
			this.pauseEnd(run, "engine_not_signed_in", [e.engine === "claude" ? "Sign in to Claude Code on this machine (run `claude`, then /login), then retry." : "Sign in to Codex on this machine (`codex login`), then retry."]);
			return;
		}
		if (code !== 0 && !text) {
			this.removeIfEmpty(ctx.outDir);
			this.end(run, { outcome: "failed", error: `The ${e.engine} CLI exited with code ${code}: ${run.output.slice(-5).join("\n").slice(-800)}` });
			return;
		}
		const check = checkDraft(parseDraft(text), ctx.texts);
		const retry = /:retry:(\d+)$/.exec(e.requestId);
		const attemptNumber = retry ? Number(retry[1]) : 1;
		const diagnostic: LocalArtifactValidationDiagnostic | undefined = check.ok ? undefined : {
			validationError: check.validationError,
			parseAttempts: check.parseAttempts,
			rawOutputChars: text.length,
			runId: e.runId,
			attemptNumber,
		};
		this.emit(run, { type: "claims.checked", detail: { total: check.claims, unmatched: check.ok ? 0 : check.unmatched, ...(diagnostic ? { validationError: diagnostic.validationError, parseAttempts: diagnostic.parseAttempts.join(","), rawOutputChars: diagnostic.rawOutputChars, runId: diagnostic.runId, attemptNumber } : {}) } });
		if (!check.ok) {
			this.removeIfEmpty(ctx.outDir);
			this.pauseEnd(run, check.reason, check.questions, diagnostic);
			return;
		}

		const at = new Date(this.now()).toISOString();
		const artifacts: LocalArtifactFile[] = [];
		for (const [kind, name, body] of [
			["resume", "resume.md", check.resume],
			["cover_letter", "cover-letter.md", check.coverLetter],
		] as const) {
			const content = `${body}\n`;
			writeFileSync(join(ctx.outDir, name), content, { flag: "wx", mode: 0o600 });
			const file: LocalArtifactFile = { kind, path: `${e.workspace}/${ctx.outRel}/${name}`, sha256: sha256(content), bytes: Buffer.byteLength(content) };
			artifacts.push(file);
			this.emit(run, { type: "artifact.written", detail: { ...file } });
		}
		const profileVersion = sha256(ctx.hashes.map((h) => `${h.role}:${h.sha256}`).sort().join("\n")).slice(0, 16);
		const retainUntil = e.policy.retainDays > 0 ? this.now() + e.policy.retainDays * DAY_MS : null;
		writeFileSync(
			join(ctx.outDir, ARTIFACT_MANIFEST),
			JSON.stringify({ runId: e.runId, instanceId: e.instanceId, leadId: ctx.lead.leadId, eventId: ctx.lead.eventId, generatedAt: at, retainUntil, profileVersion, artifacts, sources: ctx.hashes }, null, 2),
			{ flag: "wx", mode: 0o600 },
		);
		this.end(run, { outcome: "completed", artifacts, sourceHashes: ctx.hashes, profileVersion, generatedAt: at });
	}

	/** Retention: remove generated folders whose manifest says they are past their date. Only ours — a folder without a manifest is the owner's. */
	private sweepArtifacts(run: Run, workspace: string): void {
		const apps = join(workspace, "applications");
		if (!existsSync(apps)) return;
		let removed = 0;
		for (const lead of readdirSync(apps)) {
			const leadDir = join(apps, lead);
			if (!statSync(leadDir).isDirectory()) continue;
			for (const runId of readdirSync(leadDir)) {
				const manifest = join(leadDir, runId, ARTIFACT_MANIFEST);
				if (!existsSync(manifest)) continue;
				try {
					const m = JSON.parse(readFileSync(manifest, "utf8")) as { retainUntil?: unknown };
					if (typeof m.retainUntil === "number" && m.retainUntil < this.now()) {
						rmSync(join(leadDir, runId), { recursive: true, force: true });
						removed++;
					}
				} catch {
					// An unreadable manifest is left alone: deleting on a guess is the one thing retention must not do.
				}
			}
			this.removeIfEmpty(leadDir);
		}
		if (removed) this.emit(run, { type: "retention.swept", detail: { removed } });
	}

	private removeIfEmpty(dir: string): void {
		try {
			if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
		} catch {
			// best-effort
		}
	}

	private emit(run: Run, ev: Omit<LocalArtifactEvent, "at">): void {
		if (run.events.length >= MAX_EVENTS) return;
		run.events.push({ ...ev, at: new Date(this.now()).toISOString(), seq: ++run.seq });
	}

	private pauseEnd(run: Run, reason: LocalArtifactBlockReason, questions: string[], diagnostic?: LocalArtifactValidationDiagnostic): void {
		this.emit(run, { type: "run.needs_human", detail: { reason, count: questions.length, ...(diagnostic ? { validationError: diagnostic.validationError, parseAttempts: diagnostic.parseAttempts.join(","), rawOutputChars: diagnostic.rawOutputChars, runId: diagnostic.runId, attemptNumber: diagnostic.attemptNumber } : {}) } });
		this.end(run, { outcome: "needs_human", blockReason: reason, questions, diagnostic });
	}

	private end(run: Run, r: Partial<LocalArtifactResultEnvelope> & { outcome: LocalArtifactResultEnvelope["outcome"] }): void {
		if (run.state === "ended") return;
		if (run.timer) clearTimeout(run.timer);
		run.state = "ended";
		run.endedAt = this.now();
		run.result = {
			runId: run.envelope.runId,
			outcome: r.outcome,
			artifacts: r.artifacts ?? [],
			sourceHashes: r.sourceHashes ?? [],
			profileVersion: r.profileVersion ?? null,
			engineAuth: run.engineAuth,
			traceId: run.envelope.runId,
			...(r.generatedAt ? { generatedAt: r.generatedAt } : {}),
			...(r.outcome === "needs_human" ? { blockReason: r.blockReason, questions: (r.questions ?? []).map((q) => redactText(q, run.secrets)), ...(r.diagnostic ? { diagnostic: r.diagnostic } : {}) } : {}),
			// CLI output becomes this text, and a CLI prints whatever it was given: redacted before it is kept.
			...(r.outcome === "failed" ? { error: redactText((r.error ?? "The run failed without a reason.").slice(0, 1000), run.secrets) } : {}),
		};
		if (run.child && run.child.exitCode === null) this.kill(run);
	}

	private kill(run: Run): void {
		const child = run.child;
		if (!child || child.exitCode !== null) return;
		child.kill("SIGTERM");
		setTimeout(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		}, 5_000).unref?.();
	}

	private get(runId: string): Run {
		const run = this.runs.get(runId);
		if (!run) throw new RunnerInputError(`No local artifact run ${runId} on this runner (it may have restarted)`, 404);
		return run;
	}

	status(raw: unknown): LocalArtifactStatusResponse {
		const o = (raw && typeof raw === "object" ? raw : {}) as { runId?: unknown; afterSeq?: unknown };
		const run = this.get(String(o.runId ?? ""));
		const after = typeof o.afterSeq === "number" && o.afterSeq > 0 ? o.afterSeq : 0;
		return { runId: run.envelope.runId, state: run.state, events: run.events.filter((e) => e.seq > after), lastSeq: run.seq, ...(run.result ? { result: run.result } : {}) };
	}

	cancel(raw: unknown): { runId: string; state: string } {
		const runId = String((raw as { runId?: unknown } | null)?.runId ?? "");
		const run = this.get(runId);
		if (run.state !== "ended") {
			run.cancelled = true;
			if (run.child && run.child.exitCode === null) this.kill(run);
			else this.end(run, { outcome: "failed", error: "Cancelled by the owner" });
		}
		return { runId, state: run.state };
	}

	/** Drop ended runs past retention with their scratch folders. Generated artifacts are swept by their own manifest, not here. */
	sweep(): void {
		const cutoff = this.now() - this.retentionMs;
		for (const [id, run] of this.runs) {
			if (run.state === "ended" && (run.endedAt ?? 0) < cutoff) {
				rmSync(run.scratch, { recursive: true, force: true });
				this.runs.delete(id);
			}
		}
	}

	closeAll(): void {
		for (const run of this.runs.values()) {
			if (run.state !== "ended") {
				run.cancelled = true;
				this.end(run, { outcome: "failed", error: "The runner shut down during the run" });
			}
		}
	}
}
