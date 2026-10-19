/**
 * Register (or remove) the GitHub Actions self-hosted runner on a Coder's pinned machine (#1208, #1209;
 * epic #1113).
 *
 * The registration token is minted HERE, server-side, through the GitHub App's installation token —
 * `POST /orgs/{org}/actions/runners/registration-token`, or the repo-level form for a repo-scoped
 * runner — at the moment the machine needs it, and handed straight to that machine's `pags up` over the
 * relay (`/coding/actions-runner/install`). It is never written to D1, KV, a log or a trace: it exists
 * in this function's memory and in the relay message, and GitHub expires it within the hour. What is
 * recorded is that a runner was asked for, where, and the job id.
 *
 * LIVE DEPENDENCY: minting needs the App's "Self-hosted runners: write" (org scope) or
 * "Administration: write" (repo scope) permission, accepted on that org's installation (#1207). Until
 * then GitHub answers 403 and this says which permission is missing; nothing is half-done.
 *
 * Both scopes are supported because the topology is not settled: runner GROUPS (one per machine, #1210)
 * need GitHub Team, and the orgs are on Free (checked 2026-10-19). A repo-scoped runner serves exactly
 * one repo, which isolates it by construction.
 */
import { HttpError } from "./auth.js";
import { installationTokenForOwner } from "./github-app.js";
import { logEvent } from "./events.js";
import { callRunner, getBoundRunnerConn, type RunnerConn } from "./runner-client.js";
import { assertPrivateRepo, nodeRunnerLabel, PAGS_RUNNER_LABEL } from "./runner-routing.js";
import { listRepos } from "./coding-store.js";
import { safeFetch } from "./ssrf.js";
import type { Env } from "../types.js";

/** The CLI release whose runner answers `/coding/actions-runner/*`. */
export const ACTIONS_RUNNER_MIN_CLI = "0.4.162";

export type RunnerScope = { org: string } | { repo: string };
export type RunnerTokenKind = "registration" | "remove";

const OWNER = /^[A-Za-z0-9-]{1,39}$/;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** Validate a scope from a request body. */
export function parseRunnerScope(raw: unknown): RunnerScope {
	const o = (raw ?? {}) as { org?: unknown; repo?: unknown };
	if (typeof o.org === "string" && OWNER.test(o.org) && o.repo === undefined) return { org: o.org };
	if (typeof o.repo === "string" && REPO.test(o.repo) && o.org === undefined) return { repo: o.repo };
	throw new HttpError(400, 'scope must be { "org": "<org>" } or { "repo": "<owner>/<name>" }');
}

export const scopeOwner = (s: RunnerScope) => ("org" in s ? s.org : s.repo.split("/")[0]);
export const scopeUrl = (s: RunnerScope) => `https://github.com/${"org" in s ? s.org : s.repo}`;

export interface MintDeps {
	installationToken: (owner: string) => Promise<string | null>;
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

const liveMintDeps = (env: Env, userId: string): MintDeps => ({ installationToken: (owner) => installationTokenForOwner(env, userId, owner), fetch: (url, init) => safeFetch(url, init) });

/**
 * Mint a runner registration or removal token. Returned to the caller, never stored. Refuses with the
 * permission to grant when GitHub answers 403 — the state until #1207 is accepted on that org.
 */
export async function mintRunnerToken(scope: RunnerScope, kind: RunnerTokenKind, deps: MintDeps): Promise<{ token: string; expiresAt: string | null }> {
	const owner = scopeOwner(scope);
	const app = await deps.installationToken(owner);
	if (!app) throw new HttpError(409, `The ProAgentStore GitHub App is not installed on ${owner}, so it cannot register a runner there.`);
	const base = "org" in scope ? `https://api.github.com/orgs/${scope.org}` : `https://api.github.com/repos/${scope.repo}`;
	const res = await deps.fetch(`${base}/actions/runners/${kind === "registration" ? "registration-token" : "remove-token"}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${app}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ProAgentStore" },
	});
	if (res.status === 403 || res.status === 404) {
		const permission = "org" in scope ? '"Self-hosted runners: Read and write" (organization)' : '"Administration: Read and write" (repository)';
		throw new HttpError(403, `GitHub refused to mint a runner ${kind} token for ${"org" in scope ? scope.org : scope.repo} (${res.status}). The ProAgentStore App needs ${permission}, accepted on ${owner}'s installation — see #1207.`);
	}
	if (!res.ok) throw new HttpError(502, `GitHub returned ${res.status} minting a runner ${kind} token.`);
	const body = (await res.json().catch(() => null)) as { token?: unknown; expires_at?: unknown } | null;
	if (typeof body?.token !== "string") throw new HttpError(502, "GitHub returned no runner token.");
	return { token: body.token, expiresAt: typeof body.expires_at === "string" ? body.expires_at : null };
}

export interface RunnerJobView {
	id: string;
	action: "install" | "remove";
	url: string;
	name: string;
	state: "running" | "done" | "failed";
	steps: string[];
	prerequisites: Array<{ name: string; found: boolean; note?: string }>;
	runsAs: string;
	service: "installed" | "removed" | "not_installed" | "needs_admin";
	serviceNote?: string;
	error?: string;
}

export interface ProvisionDeps extends MintDeps {
	conn: (instanceId: string, userId: string) => Promise<RunnerConn | null>;
	call: <T>(conn: RunnerConn, path: string, body: unknown) => Promise<T>;
	/** The GitHub repos this agent works on (`owner/name`). */
	agentRepos: (instanceId: string, userId: string) => Promise<string[]>;
}

const liveProvisionDeps = (env: Env, userId: string): ProvisionDeps => ({
	...liveMintDeps(env, userId),
	conn: (instanceId, uid) => getBoundRunnerConn(env, instanceId, uid),
	call: (conn, path, body) => callRunner(conn, path, body, { timeoutMs: 30_000 }),
	agentRepos: async (instanceId, uid) => (await listRepos(env, instanceId, uid)).flatMap((r) => (r.githubRepo ? [r.githubRepo] : [])),
});

/** A repo's visibility as GitHub reports it to the App, or null when it cannot be read. */
async function repoVisibility(repo: string, deps: MintDeps): Promise<string | null> {
	const app = await deps.installationToken(repo.split("/")[0]);
	if (!app) return null;
	const res = await deps.fetch(`https://api.github.com/repos/${repo}`, { headers: { Authorization: `Bearer ${app}`, Accept: "application/vnd.github+json", "User-Agent": "ProAgentStore" } });
	const body = res.ok ? ((await res.json().catch(() => null)) as { visibility?: unknown } | null) : null;
	return typeof body?.visibility === "string" ? body.visibility : null;
}

/**
 * A runner is set up only where THIS agent works: an org that owns one of its repos, or one of its
 * repos. A repo-scoped runner only for a PRIVATE repo — a public repo's fork PRs would run code on
 * the owner's machine (#1113 security).
 */
async function checkScope(scope: RunnerScope, instanceId: string, userId: string, deps: ProvisionDeps): Promise<void> {
	const repos = await deps.agentRepos(instanceId, userId);
	const ok = "org" in scope ? repos.some((r) => r.split("/")[0].toLowerCase() === scope.org.toLowerCase()) : repos.some((r) => r.toLowerCase() === scope.repo.toLowerCase());
	if (!ok) throw new HttpError(400, `${"org" in scope ? scope.org : scope.repo} is not ${"org" in scope ? "the owner of a repository" : "a repository"} this agent works on (${repos.join(", ") || "it has none"}).`);
	if ("repo" in scope) {
		const visibility = await repoVisibility(scope.repo, deps);
		try {
			assertPrivateRepo(visibility);
		} catch {
			throw new HttpError(400, `${scope.repo} is ${visibility ?? "of unknown visibility"}; a self-hosted runner serves private repositories only.`);
		}
	}
}

async function boundConn(deps: ProvisionDeps, instanceId: string, userId: string): Promise<RunnerConn & { runnerNode: string }> {
	const conn = await deps.conn(instanceId, userId);
	if (!conn) throw new HttpError(409, "This agent's machine is not connected. Start `pags up` on it (or pin the agent to a connected machine), then ask again.");
	if (!conn.runnerNode) throw new HttpError(409, "This agent's machine has no node name to label its runner with. Update the CLI and reconnect it.");
	return conn as RunnerConn & { runnerNode: string };
}

const oldRunner = (e: unknown) => e instanceof Error && /→ 404/.test(e.message);

/**
 * Start installing (or removing) the runner on the agent's pinned machine. Answers with the machine's
 * job, which {@link actionsRunnerStatus} reads back; the token is in neither the answer nor any record.
 */
export async function startActionsRunner(
	env: Env,
	input: { userId: string; instanceId: string; action: "install" | "remove"; scope: RunnerScope; runnerGroup?: string },
	deps: ProvisionDeps = liveProvisionDeps(env, input.userId),
): Promise<{ job: RunnerJobView; node: string; labels: string[] }> {
	const conn = await boundConn(deps, input.instanceId, input.userId);
	if (input.action === "install") await checkScope(input.scope, input.instanceId, input.userId, deps);
	const node = conn.runnerNode;
	const label = nodeRunnerLabel(node);
	const labels = [PAGS_RUNNER_LABEL, label];
	const { token } = await mintRunnerToken(input.scope, input.action === "install" ? "registration" : "remove", deps);
	let job: RunnerJobView;
	try {
		job = await deps.call<RunnerJobView>(conn, `/coding/actions-runner/${input.action}`, {
			url: scopeUrl(input.scope),
			token,
			name: label,
			labels,
			...(input.runnerGroup && "org" in input.scope ? { runnerGroup: input.runnerGroup } : {}),
		});
	} catch (e) {
		if (oldRunner(e)) throw new HttpError(409, `This machine's runner cannot install the Actions runner (CLI ${ACTIONS_RUNNER_MIN_CLI} or newer). Update it with runner_update, then ask again.`);
		throw e;
	}
	await logEvent(env, {
		source: "runner",
		event: `actions_runner.${input.action}_started`,
		userId: input.userId,
		instanceId: input.instanceId,
		message: `Asked ${node} to ${input.action} the GitHub Actions runner for ${scopeUrl(input.scope)}`,
		// Ids and names only — never the token.
		context: { node, url: scopeUrl(input.scope), labels, jobId: job.id },
	}).catch(() => undefined);
	return { job, node, labels };
}

/** One job (when `jobId` is given) and every runner configured on the agent's machine. */
export async function actionsRunnerStatus(
	env: Env,
	input: { userId: string; instanceId: string; jobId?: string },
	deps: ProvisionDeps = liveProvisionDeps(env, input.userId),
): Promise<{ node: string; job: RunnerJobView | null; installed: Array<{ dir: string; managed: boolean; name: string | null; url: string | null }> }> {
	const conn = await boundConn(deps, input.instanceId, input.userId);
	try {
		const r = await deps.call<{ job: RunnerJobView | null; installed: Array<{ dir: string; managed: boolean; name: string | null; url: string | null }> }>(conn, "/coding/actions-runner/status", input.jobId ? { jobId: input.jobId } : {});
		return { node: conn.runnerNode, job: r.job ?? null, installed: r.installed ?? [] };
	} catch (e) {
		if (oldRunner(e)) throw new HttpError(409, `This machine's runner cannot report Actions runners (CLI ${ACTIONS_RUNNER_MIN_CLI} or newer). Update it with runner_update.`);
		throw e;
	}
}
