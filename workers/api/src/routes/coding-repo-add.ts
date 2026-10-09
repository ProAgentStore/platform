/**
 * The strict coding-repo add (#849) and the duplicate-binding answer every add shares (#829).
 * Split out of `coding-repos.ts`, which registers the route that calls into it.
 */
import type { Context } from "hono";
import { CONFIRMATION_WINDOW_MS } from "../lib/confirmation-window.js";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS, type RunnerConn } from "../lib/runner-client.js";
import { NO_SOCKET_MARKER, RunnerUnreachableError } from "../lib/runner-unreachable.js";
import { attachGithubIdentity, attachWorkdir, findRepoByWorkdir } from "../lib/coding-repo-folder.js";
import { createRepo, findExistingRepoBinding, updateRepoClone } from "../lib/coding-store.js";
import { checkWorkdirVia } from "../lib/coding-workdir.js";
import { parseRepoRef } from "../lib/git-providers.js";
import { RUNNER_CONTROL_MIN_CLI } from "../lib/runner-features.js";
import { sqlTime } from "../lib/sql-time.js";
import type { Env } from "../types.js";

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
	const deadline = Date.now() + CONFIRMATION_WINDOW_MS;
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
			const outcome = await awaitClone(conn, localPath, inFlight, deadline);
			if (outcome.kind === "pending") return stillCloning(c, outcome.job);
		if (outcome.kind === "unconfirmed") return unconfirmedClone(c, localPath, githubRepoIn);
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
		// A binding with no folder is not a clone: it is what this one completes, below (#884).
		const bound = await findExistingRepoBinding(c.env, instanceId, githubRepoIn);
		if (bound?.workdir) return duplicateBinding(c, githubRepoIn, bound);
		const outcome = await cloneOnMachine(conn, localPath, githubRepoIn, protocol, deadline);
		if (outcome.kind === "pending") return stillCloning(c, outcome.job);
		if (outcome.kind === "unconfirmed") return unconfirmedClone(c, localPath, githubRepoIn);
		if (outcome.kind === "too-old") return tooOldToClone(c, conn, outcome.ssh);
		if (outcome.kind === "failed") return refuse(outcome.error);
		verdict = await checkWorkdirVia(conn, localPath);
	}
	// A CLI with no checkout check cannot pair anything; its remedy is an update, not a second try (#853 finding 11).
	if (verdict.outdatedRunner) {
		return refuse(
			`This machine's \`pags\` CLI is too old to check a checkout, so \`${localPath}\` cannot be verified. Call runner_update for this machine to update and restart it remotely, then add the repo again.`,
		);
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
	if (existing?.workdir) return duplicateBinding(c, ref.slug, existing);
	// The folder may already be bound (#853 finding 10) — #849's repair flow is exactly a local-only
	// binding getting its GitHub half. That row is completed IN PLACE, keeping its id, sessions and
	// timeline; a second binding on one checkout left two repos for session and engine resolution to
	// choose between. A folder bound to some OTHER repo is refused by name, never rebound.
	const sameFolder = await findRepoByWorkdir(c.env, instanceId, [localPath, verdict.path]);
	if (sameFolder?.githubRepo) {
		return c.json(
			{
				error: `\`${localPath}\` is already bound as "${sameFolder.name}" to ${sameFolder.githubRepo}, but its origin is ${ref.slug} — remove that binding first (coding_repo_remove), or fix the checkout's origin.`,
				existingId: sameFolder.id,
				existingName: sameFolder.name,
			},
			409,
		);
	}
	// The mirror case (#884): the repo is bound with NO folder — the needs_path binding the repo read
	// tools refuse. It gets this folder in place, keeping its id, instructions, sessions and timeline;
	// before this, MCP's only route was to remove it and add again, losing all three.
	if (existing) {
		// Two half-bindings — one with the folder, one with the repo — cannot both be kept as one row.
		if (sameFolder) {
			return c.json(
				{
					error: `\`${localPath}\` is already bound as "${sameFolder.name}" with no GitHub repo, and ${ref.slug} is bound separately as "${existing.name}" with no folder — remove the one you do not need (coding_repo_remove), then add again.`,
					existingId: existing.id,
					existingName: existing.name,
					folderBindingId: sameFolder.id,
				},
				409,
			);
		}
		const attached = await attachWorkdir(c.env, instanceId, existing.id, localPath);
		// A concurrent add gave it a folder between the lookup and here — the same 409 as a binding that had one.
		if (!attached) return duplicateBinding(c, ref.slug, existing);
		await updateRepoClone(c.env, attached.id, { cloneStatus: "ready", cloneError: null, checkedNow: true });
		return c.json(
			{
				repo: { ...attached, cloneStatus: "ready", cloneError: undefined, cloneCheckedAt: sqlTime() },
				detail: `${ref.slug} was already bound as "${existing.name}" with no folder; \`${localPath}\` is attached to that binding in place — its id, instructions and session history are kept, and no second binding was made.`,
			},
			200,
		);
	}
	if (sameFolder) {
		const raced = await attachGithubIdentity(c.env, instanceId, sameFolder.id, { githubRepo: ref.slug, webUrl: ref.webUrl || undefined, cloneUrl: ref.cloneUrl }).then(
			() => false,
			(e: unknown) => {
				if (isUniqueViolation(e)) return true;
				throw e;
			},
		);
		// A concurrent add bound this repo between the check above and here — the same 409 as the check.
		if (raced) return duplicateBinding(c, ref.slug, (await findExistingRepoBinding(c.env, instanceId, ref.slug)) ?? { id: "", name: "" });
		await updateRepoClone(c.env, sameFolder.id, { cloneStatus: "ready", cloneError: null, checkedNow: true });
		return c.json(
			{
				repo: { ...sameFolder, githubRepo: ref.slug, provider: "github", repoSlug: ref.slug, webUrl: ref.webUrl || undefined, cloneUrl: ref.cloneUrl, cloneStatus: "ready", cloneCheckedAt: sqlTime() },
				detail: `\`${localPath}\` was already bound as "${sameFolder.name}" with no GitHub repo; ${ref.slug} is attached to that binding in place — no second binding was made.`,
			},
			200,
		);
	}
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

type CloneOutcome = { kind: "unconfirmed" } | { kind: "done" } | { kind: "pending"; job: CloneJobView } | { kind: "failed"; error: string } | { kind: "too-old"; ssh: boolean };

/**
 * How long one request confirms a background clone before answering "still cloning" (#887).
 * The window includes initial runner reads; each poll uses only the remaining time, so a slow
 * status read cannot swallow the known accepted-job response before the MCP deadline.
 */
const CLONE_WAIT_MS = CONFIRMATION_WINDOW_MS;
const CLONE_POLL_MS = 2_000;
/** A pre-#858 runner's synchronous clone is one relay command, capped by the relay at two minutes. */
const LEGACY_CLONE_TIMEOUT_MS = 120_000;

type ClonePollDelay = (ms: number) => Promise<void>;
const realClonePollDelay: ClonePollDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let clonePollDelay: ClonePollDelay = realClonePollDelay;

/** Test seam for advancing the confirmation clock only after the clone poll is actually awaited. */
export function setClonePollDelayForTest(delay?: ClonePollDelay): () => void {
	const previous = clonePollDelay;
	clonePollDelay = delay ?? realClonePollDelay;
	return () => {
		clonePollDelay = previous;
	};
}

/** The runner's answer for why it could not be asked — or null when the error is git's own. */
function runnerTrouble(e: unknown): string | null {
	const message = e instanceof Error ? e.message : String(e);
	if (e instanceof RunnerUnreachableError) return `The machine stopped answering before the clone could run (${message}). Check \`pags up\` there, then add the repo again.`;
	return null;
}

/** An explicit runner rejection is definitive; a lost dispatch reply is not. */
function dispatchUnconfirmed(message: string): boolean {
	if (message.includes(NO_SOCKET_MARKER)) return false;
	const status = /→ (\d{3}):/.exec(message)?.[1];
	if (status && status !== "502" && status !== "504") return false;
	return /timed out|disconnected|WebSocket error|fetch failed|network/i.test(message);
}

const errorText = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).replace(/^Runner \/coding\/[a-z-]+ → \d+: /, "").replace(/^\{"error":"(.*)"\}$/s, "$1");

/** The clone job for this folder, or null when there is none or the runner predates jobs. */
async function readCloneJob(conn: RunnerConn, localPath: string): Promise<CloneJobView | null> {
	return callRunner<CloneJobView>(conn, "/coding/clone-status", { workDir: localPath }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null);
}

/** Wait on a running clone for up to {@link CLONE_WAIT_MS}, reading it back every couple of seconds. */
async function awaitClone(conn: RunnerConn, localPath: string, job: CloneJobView, deadline: number): Promise<CloneOutcome> {
	const until = Math.min(deadline, Date.now() + CLONE_WAIT_MS);
	let current = job;
	while (current.state === "cloning" && Date.now() < until) {
		await clonePollDelay(Math.min(CLONE_POLL_MS, Math.max(0, until - Date.now())));
		const left = until - Date.now();
		if (left <= 0) break;
		current = (await callRunner<CloneJobView>(conn, "/coding/clone-status", { workDir: localPath }, { timeoutMs: Math.min(READ_TIMEOUT_MS, left) }).catch(() => null)) ?? current;
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
async function cloneOnMachine(conn: RunnerConn, localPath: string, slug: string, protocol: CloneProtocol, deadline: number): Promise<CloneOutcome> {
	let job: CloneJobView;
	try {
		job = await callRunner<CloneJobView>(conn, "/coding/clone-start", { workDir: localPath, slug, protocol }, { timeoutMs: READ_TIMEOUT_MS });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (dispatchUnconfirmed(message)) return { kind: "unconfirmed" };
		const trouble = runnerTrouble(e);
		if (trouble) return { kind: "failed", error: trouble };
		if (/→ 404/.test(e instanceof Error ? e.message : String(e))) return legacyClone(conn, localPath, slug, protocol);
		return { kind: "failed", error: `Could not start a clone of ${slug} into \`${localPath}\`: ${errorText(e).slice(0, 300)}` };
	}
	return awaitClone(conn, localPath, job, deadline);
}

/** #857's synchronous clone, for a runner that has no clone jobs yet — https only, one relay command. */
async function legacyClone(conn: RunnerConn, localPath: string, slug: string, protocol: CloneProtocol): Promise<CloneOutcome> {
	if (protocol === "ssh") return { kind: "too-old", ssh: true };
	try {
		await callRunner(conn, "/coding/clone", { workDir: localPath, cloneUrl: `https://github.com/${slug}.git` }, { timeoutMs: LEGACY_CLONE_TIMEOUT_MS });
		return { kind: "done" };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (dispatchUnconfirmed(message)) return { kind: "unconfirmed" };
		const trouble = runnerTrouble(e);
		if (trouble) return { kind: "failed", error: trouble };
		if (/→ 404/.test(message)) return { kind: "too-old", ssh: false };
		return {
			kind: "failed",
			error: `Could not clone ${slug} into \`${localPath}\`: ${errorText(e).slice(0, 400)} — the machine clones with its OWN git credentials, so for a private repository sign in there (\`gh auth login\` sets up https access), then add the repo again.`,
		};
	}
}

/**
 * 400 for a runner with no clone endpoint that serves the call (#861): the sentence, plus a stable code
 * and both versions so a caller can act without parsing it. `found` is what the machine last registered.
 */
async function tooOldToClone(c: Context<{ Bindings: Env }>, conn: RunnerConn, ssh: boolean) {
	const found = conn.runnerNode
		? await c.env.DB.prepare("SELECT runner_version FROM instance_runtime_nodes WHERE instance_id = ?1 AND runner_node = ?2 LIMIT 1")
				.bind(conn.instanceId, conn.runnerNode)
				.first<{ runner_version: string | null }>()
				.then((r) => r?.runner_version ?? null)
				.catch(() => null)
		: null;
	const cli = `This machine's \`pags\` CLI${found ? ` (${found})` : ""}`;
	const error = ssh
		? `${cli} is too old to clone over SSH — that needs ${RUNNER_CONTROL_MIN_CLI} or newer. Call runner_update for this machine, then add the repo again.`
		: `${cli} is too old to clone — that needs ${RUNNER_CONTROL_MIN_CLI} or newer. Call runner_update for this machine to update and restart it remotely, then add the repo again — or clone the repository there yourself and add it without clone.`;
	return c.json({ error, code: "runner_too_old_to_clone", required: RUNNER_CONTROL_MIN_CLI, found }, 400);
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

/** Dispatch lost its reply: neither success nor failure is known, and no binding is stored. */
function unconfirmedClone(c: Context, localPath: string, slug: string | undefined) {
	return c.json({
		outcome: "unknown",
		possibleOutcomes: ["not-started", "cloning", "completed"],
		poll: { tool: "coding_repos_list", input: { instance_id: c.req.param("instanceId") } },
		cloning: null,
		unconfirmed: true,
		job: { path: localPath, slug, state: "unknown" },
		detail: `The clone request's outcome is not confirmed. It may have started or completed on the machine. Nothing is stored yet. Call coding_repo_add again with the same arguments to check the checkout or join the same background clone; do not choose a different path or repository while the outcome is unknown.`,
	}, 202);
}
