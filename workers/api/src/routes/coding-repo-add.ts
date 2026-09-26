/**
 * The strict coding-repo add (#849) and the duplicate-binding answer every add shares (#829).
 * Split out of `coding-repos.ts`, which registers the route that calls into it.
 */
import type { Context } from "hono";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS, type RunnerConn } from "../lib/runner-client.js";
import { RunnerUnreachableError } from "../lib/runner-unreachable.js";
import { createRepo, findExistingRepoBinding, updateRepoClone } from "../lib/coding-store.js";
import { checkWorkdirVia } from "../lib/coding-workdir.js";
import { parseRepoRef } from "../lib/git-providers.js";
import { sqlTime } from "../lib/sql-time.js";

/** The 409 for an add that would bind a GitHub repo this instance already has (#829). */
export function duplicateBinding(c: Context, githubRepo: string, existing: { id: string; name: string }) {
	return c.json(
		{
			error: `${githubRepo} is already bound to this instance${existing.name ? ` as "${existing.name}"` : ""} — use that binding, or remove it first`,
			githubRepo,
			existingId: existing.id,
			existingName: existing.name,
		},
		409,
	);
}

/** D1 surfaces a unique-index violation only as message text. */
export function isUniqueViolation(e: unknown): boolean {
	return /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e));
}

/**
 * Add a coding repo with BOTH halves at once (#849): the local checkout the engine runs in AND
 * the GitHub identity every `github_*` tool and the routing hint key off.
 *
 * Before this, one `path` meant EITHER a folder OR an owner/repo, so a binding made over MCP was
 * always half a binding — GitHub-aware but never checked out (`cloning` forever), or checked out
 * but anonymous. Here nothing is stored until both halves are proven on the machine: the folder
 * is a real checkout, and its `origin` resolves to GitHub (matching `githubRepoIn` when given).
 * A missing half is refused by name — never defaulted, never dropped.
 */
export async function addPairedRepo(
	c: Context,
	instanceId: string,
	uid: string,
	name: string,
	localPath: string,
	githubRepoIn: string | undefined,
	clone = false,
	protocol: CloneProtocol = "auto",
) {
	const refuse = (error: string) => c.json({ error }, 400);
	if (!localPath) {
		return refuse(
			`Missing the local workdir: a coding repo needs the folder of its checkout as well as ${githubRepoIn ? `\`${githubRepoIn}\`` : "its GitHub owner/repo"}. Pass the checkout's path (~/dev/...).`,
		);
	}
	const conn = await getBoundRunnerConn(c.env, instanceId, uid).catch(() => null);
	if (!conn) {
		return refuse(
			`No machine is connected, so \`${localPath}\` cannot be verified as a checkout nor its GitHub origin read. Run \`pags up\` on the machine that has it, then add the repo again.`,
		);
	}
	// A clone of this folder already in flight (#858) — a call REPEATED while a long clone runs joins it
	// rather than reading a half-written checkout as finished. Checked before the folder is judged.
	if (clone) {
		const inFlight = await readCloneJob(conn, localPath);
		if (inFlight?.state === "cloning") {
			const outcome = await awaitClone(conn, localPath, inFlight);
			if (outcome.kind === "pending") return stillCloning(c, outcome.job);
			if (outcome.kind === "failed") return refuse(outcome.error);
		}
	}
	let verdict = await checkWorkdirVia(conn, localPath);
	// Cold start (#857): nothing there yet, and the caller opted in — clone it, then carry on through
	// EVERY check below exactly as for a checkout that was already there. Only an absent or empty folder
	// is ever cloned into; without `clone` the same folder is refused as it always was.
	if (clone && (verdict.state === "missing" || verdict.state === "empty")) {
		if (!githubRepoIn) return refuse(`Cloning needs github_repo — which repository to clone into \`${localPath}\`.`);
		// Refused BEFORE the clone, so a repo already bound here is not cloned a second time for nothing.
		const bound = await findExistingRepoBinding(c.env, instanceId, githubRepoIn);
		if (bound) return duplicateBinding(c, githubRepoIn, bound);
		const outcome = await cloneOnMachine(conn, localPath, githubRepoIn, protocol);
		if (outcome.kind === "pending") return stillCloning(c, outcome.job);
		if (outcome.kind === "failed") return refuse(outcome.error);
		verdict = await checkWorkdirVia(conn, localPath);
	}
	if (verdict.state !== "ok") return refuse(`Invalid local workdir: ${verdict.detail}`);
	const remote = await callRunner<{ remote?: string | null }>(conn, "/coding/git-remote", { workDir: localPath }, { timeoutMs: READ_TIMEOUT_MS })
		.then((r) => r.remote ?? null)
		.catch(() => null);
	const ref = parseRepoRef(remote);
	if (ref?.provider !== "github" || !ref.slug) {
		return refuse(
			`Missing the GitHub origin: \`${localPath}\` has ${remote ? `origin \`${remote}\`, which is not a GitHub repository` : "no readable `origin` remote"}. A coding repo must be a checkout of a GitHub repo.`,
		);
	}
	if (githubRepoIn && githubRepoIn.toLowerCase() !== ref.slug.toLowerCase()) {
		return refuse(`\`${localPath}\` is a checkout of ${ref.slug}, not ${githubRepoIn} — pass the folder that holds ${githubRepoIn}, or omit github_repo.`);
	}
	const existing = await findExistingRepoBinding(c.env, instanceId, ref.slug);
	if (existing) return duplicateBinding(c, ref.slug, existing);
	const created = await createRepo(c.env, instanceId, uid, {
		name: name || ref.slug,
		workdir: localPath,
		githubRepo: ref.slug,
		provider: "github",
		repoSlug: ref.slug,
		webUrl: ref.webUrl || undefined,
		cloneUrl: ref.cloneUrl,
	}).catch((e: unknown) => {
		if (isUniqueViolation(e)) return null;
		throw e;
	});
	if (!created) {
		const dup = await findExistingRepoBinding(c.env, instanceId, ref.slug);
		return duplicateBinding(c, ref.slug, dup ?? { id: "", name: "" });
	}
	// The folder was looked at a moment ago — record that look, as every other verified path does.
	await updateRepoClone(c.env, created.id, { cloneStatus: "ready", cloneError: null, checkedNow: true });
	return c.json({ repo: { ...created, cloneStatus: "ready", cloneCheckedAt: sqlTime() } }, 201);
}

export type CloneProtocol = "auto" | "https" | "ssh";

/** A background clone as the runner reports it (#858) — `packages/browser-runner/src/coding/repo-clone-job.ts`. */
interface CloneJobView {
	path: string;
	slug?: string;
	state: "cloning" | "done" | "failed" | "none";
	via?: "https" | "ssh";
	attempts?: string[];
	error?: string;
	startedAt?: number;
}

type CloneOutcome = { kind: "done" } | { kind: "pending"; job: CloneJobView } | { kind: "failed"; error: string };

/**
 * How long one call waits on a background clone before answering "still cloning" (#858). Under the
 * relay's two-minute command ceiling and a typical MCP client's own timeout; a small repository is
 * cloned and bound inside it exactly as #857's synchronous clone was.
 */
const CLONE_WAIT_MS = 45_000;
const CLONE_POLL_MS = 2_000;
/** A pre-#858 runner's synchronous clone is one relay command, capped by the relay at two minutes. */
const LEGACY_CLONE_TIMEOUT_MS = 120_000;

/** The runner's answer for why it could not be asked — or null when the error is git's own. */
function runnerTrouble(e: unknown): string | null {
	const message = e instanceof Error ? e.message : String(e);
	if (e instanceof RunnerUnreachableError) return `The machine stopped answering before the clone could run (${message}). Check \`pags up\` there, then add the repo again.`;
	return null;
}

const errorText = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).replace(/^Runner \/coding\/[a-z-]+ → \d+: /, "").replace(/^\{"error":"(.*)"\}$/s, "$1");

/** The clone job for this folder, or null when there is none or the runner predates jobs. */
async function readCloneJob(conn: RunnerConn, localPath: string): Promise<CloneJobView | null> {
	return callRunner<CloneJobView>(conn, "/coding/clone-status", { workDir: localPath }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null);
}

/** Wait on a running clone for up to {@link CLONE_WAIT_MS}, reading it back every couple of seconds. */
async function awaitClone(conn: RunnerConn, localPath: string, job: CloneJobView): Promise<CloneOutcome> {
	const until = Date.now() + CLONE_WAIT_MS;
	let current = job;
	while (current.state === "cloning" && Date.now() < until) {
		await new Promise<void>((r) => setTimeout(r, CLONE_POLL_MS));
		current = (await readCloneJob(conn, localPath)) ?? current;
	}
	if (current.state === "cloning") return { kind: "pending", job: current };
	if (current.state === "failed") return { kind: "failed", error: `Could not clone ${current.slug ?? "the repository"} into \`${localPath}\`: ${current.error ?? "git failed"}` };
	return { kind: "done" };
}

/**
 * Clone `owner/repo` into `localPath` on the connected machine (#857), as a BACKGROUND job (#858).
 *
 * The runner starts the clone and answers at once; this reads it back for up to {@link CLONE_WAIT_MS}.
 * Finished → the caller binds it. Still running → `pending`, and the caller answers 202: nothing is
 * stored, and repeating the call joins the same clone. Transport is the MACHINE's own credentials —
 * https first, SSH next when https is refused and the machine has a key github.com accepts (`protocol`
 * pins one). A runner that predates jobs gets #857's synchronous https clone.
 */
async function cloneOnMachine(conn: RunnerConn, localPath: string, slug: string, protocol: CloneProtocol): Promise<CloneOutcome> {
	let job: CloneJobView;
	try {
		job = await callRunner<CloneJobView>(conn, "/coding/clone-start", { workDir: localPath, slug, protocol }, { timeoutMs: READ_TIMEOUT_MS });
	} catch (e) {
		const trouble = runnerTrouble(e);
		if (trouble) return { kind: "failed", error: trouble };
		if (/→ 404/.test(e instanceof Error ? e.message : String(e))) return legacyClone(conn, localPath, slug, protocol);
		return { kind: "failed", error: `Could not start a clone of ${slug} into \`${localPath}\`: ${errorText(e).slice(0, 300)}` };
	}
	return awaitClone(conn, localPath, job);
}

/** #857's synchronous clone, for a runner that has no clone jobs yet — https only, one relay command. */
async function legacyClone(conn: RunnerConn, localPath: string, slug: string, protocol: CloneProtocol): Promise<CloneOutcome> {
	if (protocol === "ssh") return { kind: "failed", error: "This machine's `pags` CLI is too old to clone over SSH. Update it and restart `pags up`." };
	try {
		await callRunner(conn, "/coding/clone", { workDir: localPath, cloneUrl: `https://github.com/${slug}.git` }, { timeoutMs: LEGACY_CLONE_TIMEOUT_MS });
		return { kind: "done" };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		const trouble = runnerTrouble(e);
		if (trouble) return { kind: "failed", error: trouble };
		if (/→ 404/.test(message)) return { kind: "failed", error: "This machine's `pags` CLI is too old to clone. Update it and restart `pags up`, or clone the repository there yourself and add it without clone." };
		if (/timed out/i.test(message)) {
			return { kind: "failed", error: `The clone of ${slug} did not finish within 2 minutes on this older CLI and may still be running. Update \`pags\` for background clones, or once \`${localPath}\` holds the checkout, call coding_repo_add again without clone.` };
		}
		return {
			kind: "failed",
			error: `Could not clone ${slug} into \`${localPath}\`: ${errorText(e).slice(0, 400)} — the machine clones with its OWN git credentials, so for a private repository sign in there (\`gh auth login\` sets up https access), then add the repo again.`,
		};
	}
}

/**
 * 202, nothing stored: the clone is still running on the machine (#858). Repeating the SAME call joins
 * it — never a second clone — and binds once it has finished and every check passes.
 */
function stillCloning(c: Context, job: CloneJobView) {
	const elapsed = job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : null;
	return c.json(
		{
			cloning: true,
			job: { path: job.path, slug: job.slug, state: job.state, startedAt: job.startedAt ?? null, attempts: job.attempts ?? [] },
			detail: `Still cloning ${job.slug ?? "the repository"} into \`${job.path}\` on the machine${elapsed !== null ? ` (${elapsed}s so far)` : ""}. Nothing is stored yet. Call coding_repo_add again with the same arguments: it joins this clone — never starts a second — and binds the repo once the clone has finished and every check passes.`,
		},
		202,
	);
}
