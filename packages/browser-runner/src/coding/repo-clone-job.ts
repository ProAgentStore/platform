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
 */
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { promisify } from "node:util";
import { checkWorkdir, probeGitSshIdentity } from "./repo.js";

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
	/** Clone `url` into `dir`, rejecting with git's reason. */
	clone: (dir: string, url: string) => Promise<void>;
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
export async function runCloneJob(job: CloneJob, protocol: CloneProtocol, deps: CloneJobDeps): Promise<CloneJob> {
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
			await deps.clone(job.path, cloneUrlFor(job.slug, via));
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
export async function cloneIntoOwnFolder(dir: string, url: string): Promise<void> {
	const at = checkWorkdir(dir);
	if (at.exists && at.isDirectory && at.entryCount > 0) throw new Error(`"${dir}" is not empty — never cloned into`);
	if (at.exists && !at.isDirectory) throw new Error(`"${dir}" is a file, not a folder`);
	if (at.exists && at.insideWorkTree) throw new Error(`"${dir}" is an empty folder inside another git checkout — not cloning a second repository into it`);
	if (at.exists) rmSync(dir, { recursive: true, force: true });
	try {
		await run("git", ["clone", url, dir], {
			timeout: 60 * 60_000,
			// No prompt, ever: a refusal must fail with git's reason, not wait on input nobody will give.
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" },
		});
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

/**
 * The runner's clone jobs, one per folder. `start` joins a clone in flight rather than starting a
 * second; a finished or failed job is replaced by a new start, which is how a failed clone is retried.
 */
export class CloneJobs {
	private jobs = new Map<string, CloneJob>();

	constructor(private readonly deps: CloneJobDeps = liveCloneDeps) {}

	start(path: string, slug: string, protocol: CloneProtocol = "auto"): CloneJob {
		const current = this.jobs.get(path);
		if (current?.state === "cloning") return current;
		const job: CloneJob = { path, slug, state: "cloning", attempts: [], startedAt: this.deps.now() };
		this.jobs.set(path, job);
		void runCloneJob(job, protocol, this.deps);
		return job;
	}

	status(path: string): CloneJob | { path: string; state: "none" } {
		return this.jobs.get(path) ?? { path, state: "none" };
	}
}
