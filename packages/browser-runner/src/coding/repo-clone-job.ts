/**
 * Cold-start clones as BACKGROUND jobs, over https or SSH (#858).
 *
 * #857's clone was one synchronous `git clone` inside a relay command: a repository that took longer
 * than the relay's two-minute ceiling failed the call while git kept going, and `execFileSync` held the
 * runner's event loop — its relay socket included — for as long as git ran. Here the clone is a job:
 * started, answered at once, and run with an async `git` so the runner keeps serving everything else.
 * The cloud reads the job back until it is `done` or `failed`; one job per folder, so asking again
 * joins the clone in flight instead of starting a second one.
 *
 * Which URL: the machine's own credentials decide. https first (its credential helper — what
 * `gh auth login` configures). If that is refused and the machine holds an SSH identity for github.com,
 * `git@github.com:<owner>/<repo>.git` next — a machine that reaches GitHub only through a key used to
 * fail a private repository with "could not read Username". `protocol` pins one or the other.
 *
 * The folder guards are {@link ensureRepo}'s owner-folder rules: an absent or empty folder is cloned
 * into, a folder with anything in it never is, an empty folder inside another checkout is refused.
 *
 * `CloneJobs`'s in-memory map does not survive a runner crash or a forced restart (#1459) — see
 * `clone-receipt-store.ts` for the durable receipt that does, and `clone-evidence.ts` for how a
 * reconciled job's real outcome is judged from disk rather than assumed.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clearReceipt, type CloneReceipt, readReceipt, writeReceipt } from "./clone-receipt-store.js";
import { requireEmptyCloneTarget } from "./clone-target.js";
import { inspectCloneEvidence } from "./clone-evidence.js";
import { probeGitSshIdentity } from "./repo.js";

const run = promisify(execFile);

export type CloneProtocol = "auto" | "https" | "ssh";
export type CloneVia = "https" | "ssh";

export interface CloneJob {
	path: string;
	slug: string;
	state: "cloning" | "done" | "failed";
	/** The transport that succeeded, once one has. */
	via?: CloneVia;
	/** One line per refused attempt — git's own reason, in order. */
	attempts: string[];
	/** Why it failed, for `failed`: every attempt, and what would fix it. */
	error?: string;
	startedAt: number;
	finishedAt?: number;
}

export interface CloneJobDeps {
	/** Clone `url` into `dir`, rejecting with git's reason. Reports the child's pid as soon as it
	 *  is spawned, when the caller wants it (#1459's durable receipt). */
	clone: (dir: string, url: string, onPid?: (pid: number) => void) => Promise<void>;
	/** The account the machine's SSH key authenticates to github.com as, or null. */
	sshIdentity: () => string | null;
	now: () => number;
}

export const cloneUrlFor = (slug: string, via: CloneVia) => (via === "ssh" ? `git@github.com:${slug}.git` : `https://github.com/${slug}.git`);

/**
 * Run a job to its end. Never rejects: every outcome is written onto `job`.
 *
 * `auto` tries https, then SSH only when https was refused AND the machine has an SSH identity — the
 * probe runs only then, because it is a network round trip a clone that already worked does not need.
 */
export async function runCloneJob(job: CloneJob, protocol: CloneProtocol, deps: CloneJobDeps, onPid?: (pid: number) => void): Promise<CloneJob> {
	const order: CloneVia[] = protocol === "ssh" ? ["ssh"] : protocol === "https" ? ["https"] : ["https", "ssh"];
	for (const via of order) {
		if (via === "ssh" && protocol === "auto") {
			const identity = deps.sshIdentity();
			if (!identity) {
				job.attempts.push("ssh: not tried — this machine has no SSH key that github.com accepts");
				break;
			}
		}
		try {
			// Spread, not a trailing `undefined`: a caller that never asked for the pid (every
			// existing test and call site before #1459) must see the exact same two-argument call.
			await deps.clone(job.path, cloneUrlFor(job.slug, via), ...(onPid ? [onPid] : []));
			return Object.assign(job, { state: "done" as const, via, finishedAt: deps.now() });
		} catch (e) {
			job.attempts.push(`${via}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return Object.assign(job, {
		state: "failed" as const,
		finishedAt: deps.now(),
		error: `${job.attempts.join(" | ")} — the machine clones with its OWN git credentials: sign in over https there (\`gh auth login\`), or add an SSH key that github.com accepts.`,
	});
}

/**
 * Clone `url` into the owner's folder `dir` — async, never prompting, with the owner-folder guards.
 * Rejects with git's reason (scrubbed of nothing: these URLs carry no token).
 */
export async function cloneIntoOwnFolder(dir: string, url: string, onPid?: (pid: number) => void): Promise<void> {
	requireEmptyCloneTarget(dir);
	// git accepts an empty directory. Never recursively delete it: a concurrent writer could
	// have populated it since preflight, in which case git itself must refuse the clone.
	const pending = run("git", ["clone", url, dir], {
		timeout: 60 * 60_000,
		// No prompt, ever: a refusal must fail with git's reason, not wait on input nobody will give.
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" },
	});
	// `util.promisify(execFile)` attaches the real `ChildProcess` to the returned promise — read
	// its pid now, before awaiting, so a crash mid-clone still leaves a receipt naming it (#1459).
	const pid = (pending as unknown as { child?: { pid?: number } }).child?.pid;
	if (pid) onPid?.(pid);
	try {
		await pending;
	} catch (e) {
		const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim() || (e instanceof Error ? e.message : "git clone failed");
		throw new Error(stderr.slice(0, 300));
	}
}

/** The production deps: real git, the real SSH probe. */
export const liveCloneDeps: CloneJobDeps = {
	clone: cloneIntoOwnFolder,
	sshIdentity: () => probeGitSshIdentity("github.com").identity,
	now: () => Date.now(),
};

/** `process.kill(pid, 0)` existence-checks without sending a signal, on every platform Node runs. */
function defaultIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export interface CloneJobsOptions {
	/** Where durable receipts live. Omit to run exactly as before #1459 — in-memory only. */
	receiptsPath?: string | null;
	/** Fresh every runner boot by default; a receipt written under a DIFFERENT one is, by
	 *  construction, from a process that no longer holds this job in memory. */
	runnerInstanceId?: string;
	isAlive?: (pid: number) => boolean;
	inspectEvidence?: (path: string, slug: string) => "completed" | "incomplete";
	/** How often an adopted orphan's liveness is re-checked. */
	pollIntervalMs?: number;
	/** How long an adopted orphan may be polled before its outcome is judged from evidence
	 *  regardless of what `isAlive` still says — bounded, so a reused pid cannot wait forever. */
	maxOrphanWaitMs?: number;
}

/**
 * The runner's clone jobs, one per folder. `start` joins a clone in flight rather than starting a
 * second; a finished or failed job is replaced by a new start, which is how a failed clone is retried.
 *
 * Durable across a crash or forced restart when `receiptsPath` is set (#1459): `start`/`status`
 * reconcile an unseen path against its receipt before answering, so "cloning" from a process that no
 * longer exists becomes either an adopted orphan still being watched, or a judged, terminal outcome —
 * never a silent `none` for work that was genuinely in flight.
 */
export class CloneJobs {
	private jobs = new Map<string, CloneJob>();
	private readonly runnerInstanceId: string;
	private readonly isAlive: (pid: number) => boolean;
	private readonly inspectEvidence: (path: string, slug: string) => "completed" | "incomplete";
	private readonly receiptsPath: string | null;
	private readonly pollIntervalMs: number;
	private readonly maxOrphanWaitMs: number;

	constructor(
		private readonly deps: CloneJobDeps = liveCloneDeps,
		opts: CloneJobsOptions = {},
	) {
		this.runnerInstanceId = opts.runnerInstanceId ?? randomUUID();
		this.isAlive = opts.isAlive ?? defaultIsAlive;
		this.inspectEvidence = opts.inspectEvidence ?? inspectCloneEvidence;
		this.receiptsPath = opts.receiptsPath ?? null;
		this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
		this.maxOrphanWaitMs = opts.maxOrphanWaitMs ?? 65 * 60_000;
	}

	start(path: string, slug: string, protocol: CloneProtocol = "auto"): CloneJob {
		if (!this.jobs.has(path)) this.reconcile(path);
		const current = this.jobs.get(path);
		if (current?.state === "cloning") return current;
		const job: CloneJob = { path, slug, state: "cloning", attempts: [], startedAt: this.deps.now() };
		this.jobs.set(path, job);
		const jobId = randomUUID();
		this.persist(path, slug, protocol, jobId, null);
		void this.run(job, protocol, jobId);
		return job;
	}

	status(path: string): CloneJob | { path: string; state: "none" } {
		if (!this.jobs.has(path)) this.reconcile(path);
		return this.jobs.get(path) ?? { path, state: "none" };
	}

	/** Background clones outlive their start request and must block safe restarts (#1458). No owner paths leave here. */
	liveWork(): string[] {
		return [...this.jobs.values()].filter((job) => job.state === "cloning").map((_job, i) => `repository-clone-${i + 1}`);
	}

	private persist(path: string, slug: string, protocol: CloneProtocol, jobId: string, pid: number | null): void {
		if (!this.receiptsPath) return;
		writeReceipt(this.receiptsPath, { path, slug, protocol, jobId, runnerInstanceId: this.runnerInstanceId, pid, startedAt: this.deps.now() });
	}

	private async run(job: CloneJob, protocol: CloneProtocol, jobId: string): Promise<void> {
		const onPid = (pid: number) => this.persist(job.path, job.slug, protocol, jobId, pid);
		await runCloneJob(job, protocol, this.deps, onPid);
		if (this.receiptsPath) clearReceipt(this.receiptsPath, job.path);
	}

	/**
	 * A path with no in-memory job gets ONE chance to recover its receipt before answering `none`
	 * (#1459). No-op without `receiptsPath`, or when nothing was ever recorded for this path.
	 */
	private reconcile(path: string): void {
		if (!this.receiptsPath) return;
		const receipt = readReceipt(this.receiptsPath, path);
		if (!receipt) return;
		if (receipt.runnerInstanceId === this.runnerInstanceId) {
			// Our OWN receipt, from earlier in this same process. Missing from the in-memory map
			// means it already finished and was cleared — nothing left to adopt.
			clearReceipt(this.receiptsPath, path);
			return;
		}
		if (receipt.pid && this.isAlive(receipt.pid)) {
			const job: CloneJob = { path, slug: receipt.slug, state: "cloning", attempts: [], startedAt: receipt.startedAt };
			this.jobs.set(path, job);
			this.watchOrphan(job, receipt);
			return;
		}
		this.jobs.set(path, this.judge(path, receipt));
		clearReceipt(this.receiptsPath, path);
	}

	/** Judge a receipt whose owning process (and, so far as can be told, its clone child) is gone —
	 *  from disk evidence alone, never from the receipt's mere existence, and never by deleting
	 *  anything: a partial checkout is left exactly as it is for `requireEmptyCloneTarget` to refuse
	 *  a blind retry into. */
	private judge(path: string, receipt: CloneReceipt): CloneJob {
		const base = { path, slug: receipt.slug, attempts: [], startedAt: receipt.startedAt, finishedAt: this.deps.now() };
		if (this.inspectEvidence(path, receipt.slug) === "completed") return { ...base, state: "done" };
		return {
			...base,
			state: "failed",
			error:
				"The runner restarted while this clone was in progress and its outcome could not be confirmed complete. The destination is not empty, so a retry is refused until it is resolved by hand.",
		};
	}

	/** Watch an orphaned clone child adopted from a previous runner instance until it exits, then
	 *  judge it exactly as `judge` would — bounded by `maxOrphanWaitMs` so a reused pid cannot keep
	 *  this waiting forever. */
	private watchOrphan(job: CloneJob, receipt: CloneReceipt): void {
		const deadline = this.deps.now() + this.maxOrphanWaitMs;
		const poll = () => {
			if (receipt.pid && this.isAlive(receipt.pid) && this.deps.now() < deadline) {
				setTimeout(poll, this.pollIntervalMs);
				return;
			}
			Object.assign(job, this.judge(job.path, receipt));
			if (this.receiptsPath) clearReceipt(this.receiptsPath, job.path);
		};
		poll();
	}
}
