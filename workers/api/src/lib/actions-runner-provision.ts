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
import { migrateLegacyRunner, type MigrationView } from "./actions-runner-migrate.js";
import { callRunner, getBoundRunnerConn, type RunnerConn } from "./runner-client.js";
import { assertPrivateRepo, type HostReadinessReport, nodeRunnerLabel, PAGS_RUNNER_LABEL, RUNNER_UNAVAILABLE_LABEL, runnerAvailability, type RunnerAvailability, routingLabels } from "./runner-routing.js";
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

/** What a machine reports it can run (`/coding/actions-runner/capabilities`, #1260). */
export interface RunnerCapabilities {
	labels: string[];
	missing: Array<{ tool: string; hint: string }>;
	warnings: string[];
	os: { platform: string; version: string | null };
	/** A Windows machine's host readiness (#1272). Absent elsewhere and from older runners. */
	windows?: HostReadinessReport | null;
}

/**
 * The preflight an owner reads BEFORE the runner takes jobs: tools CI uses that this machine lacks, and what to do. Informational for
 * macOS/Linux tools (#1260). For a Windows machine that is not ready (#1272) it also GATES routing: `availability.available` is false,
 * the runner is registered without its routing labels, and `message` carries the reasons and fixes.
 */
export interface RunnerPreflight {
	missing: Array<{ tool: string; hint: string }>;
	warnings: string[];
	/** One paragraph for a person. */
	message: string;
	availability?: RunnerAvailability;
}

export interface ProvisionDeps extends MintDeps {
	conn: (instanceId: string, userId: string) => Promise<RunnerConn | null>;
	call: <T>(conn: RunnerConn, path: string, body: unknown) => Promise<T>;
	/** The GitHub repos this agent works on (`owner/name`). */
	agentRepos: (instanceId: string, userId: string) => Promise<string[]>;
	/** The platform-owned smoke job for a migrated runner (#1272): run a minimal safe job on exactly that runner and report. Absent = none is configured. */
	smoke?: (scope: RunnerScope, runnerName: string) => Promise<{ ok: boolean; detail?: string }>;
	sleep?: (ms: number) => Promise<void>;
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
 * The machine's capability labels, or null when it cannot say (a runner older than #1260 answers 404, or the call failed): the
 * runner is then registered with the base labels only, exactly as before — never refused for a probe that could not run.
 */
async function machineCapabilities(deps: ProvisionDeps, conn: RunnerConn): Promise<RunnerCapabilities | null> {
	try {
		const r = await deps.call<Partial<RunnerCapabilities>>(conn, "/coding/actions-runner/capabilities", {});
		const labels = Array.isArray(r.labels) ? r.labels.filter((l): l is string => typeof l === "string" && /^[A-Za-z0-9._+-]{1,100}$/.test(l)) : [];
		const missing = Array.isArray(r.missing) ? r.missing.filter((m): m is { tool: string; hint: string } => !!m && typeof m.tool === "string" && typeof m.hint === "string") : [];
		const warnings = Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === "string") : [];
		const w = (r as { windows?: HostReadinessReport }).windows;
		const windows: HostReadinessReport | null = w && typeof w === "object" ? { applicable: w.applicable === true, ready: w.ready === true, summary: typeof w.summary === "string" ? w.summary : undefined, reasons: Array.isArray(w.reasons) ? w.reasons.filter((x) => !!x && typeof x === "object") : [] } : null;
		return { labels, missing, warnings, os: { platform: String(r.os?.platform ?? ""), version: r.os?.version ?? null }, windows };
	} catch {
		return null;
	}
}

/** The preflight text: which CI tools are missing and how to get each; `null` capabilities say the machine could not be asked. */
export function preflightFor(caps: RunnerCapabilities | null, node: string): RunnerPreflight {
	if (!caps) return { missing: [], warnings: [], message: `${node} could not report its tools (an older runner, or the check failed), so the runner is labelled \`pags\` and \`pags-<node>\` only and a job that needs jq, brew or Flutter may still land there. Update it with runner_update, then run actions_runner_setup again to add capability labels.` };
	const availability = runnerAvailability(caps.windows);
	const parts: string[] = [];
	if (!availability.available) parts.push(`${node} is UNAVAILABLE for routing until fixed — its service can be installed, but no job is routed to it. ${availability.reasons.length ? availability.reasons.join(" ") : availability.summary}`);
	if (caps.missing.length) parts.push(`${node} lacks ${caps.missing.map((m) => `\`${m.tool}\``).join(", ")}: ${caps.missing.map((m) => `${m.tool} — ${m.hint}`).join("; ")}. Jobs that need them should require the matching \`has-<tool>\` label; it is added once the tool is installed and actions_runner_setup is run again.`);
	for (const w of caps.warnings) parts.push(w);
	if (!parts.length) parts.push(`${node} has the CI tools checked (${["brew", "jq", "flutter", "dart"].join(", ")}).`);
	return { missing: caps.missing, warnings: caps.warnings, message: parts.join(" "), availability };
}

/** Labels this platform OWNS on a runner, so a refresh replaces them and leaves any label an owner added by hand alone. */
const MANAGED_LABEL = /^(has-[a-z0-9]+|macos-\d+\+)$/;

interface GithubRunner {
	id: number;
	name: string;
	status?: string;
	busy?: boolean;
	labels: Array<{ name: string; type?: string }>;
}

const ghBase = (scope: RunnerScope) => ("org" in scope ? `https://api.github.com/orgs/${scope.org}` : `https://api.github.com/repos/${scope.repo}`);

/** One registered runner as GitHub reports it (its `status` is `online` or `offline`), or null when none has that name. Read-only. */
export async function findGithubRunner(scope: RunnerScope, runnerName: string, deps: MintDeps): Promise<{ id: number; status: string; busy: boolean } | null> {
	const owner = scopeOwner(scope);
	const app = await deps.installationToken(owner);
	if (!app) throw new HttpError(409, `The ProAgentStore GitHub App is not installed on ${owner}, so it cannot see whether a runner is online there.`);
	const headers = { Authorization: `Bearer ${app}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ProAgentStore" };
	for (let page = 1; page <= 5; page++) {
		const res = await deps.fetch(`${ghBase(scope)}/actions/runners?per_page=100&page=${page}`, { headers });
		if (!res.ok) throw new HttpError(res.status === 403 || res.status === 404 ? 403 : 502, `GitHub returned ${res.status} listing runners for ${"org" in scope ? scope.org : scope.repo}.`);
		const runners = ((await res.json().catch(() => null)) as { runners?: GithubRunner[] } | null)?.runners ?? [];
		const found = runners.find((r) => r.name === runnerName);
		if (found) return { id: found.id, status: found.status ?? "offline", busy: found.busy === true };
		if (runners.length < 100) break;
	}
	return null;
}

/**
 * Bring a registered runner's CUSTOM labels in line with what its machine reports now (#1260): drop its old capability labels
 * (`has-*`, `macos-NN+`), add the current ones, keep every other custom label. GitHub's own labels (`self-hosted`, the OS, the CPU)
 * are read-only and untouched. A no-op when nothing differs. Needs the same App permission as minting a registration token.
 */
export async function syncRunnerLabels(
	scope: RunnerScope,
	runnerName: string,
	desired: readonly string[],
	deps: MintDeps,
	/** Labels this platform also owns on THIS runner — the routing labels, so becoming (un)available swaps them (#1272). */
	alsoManaged: readonly string[] = [],
): Promise<{ runnerId: number; before: string[]; after: string[]; changed: boolean }> {
	const owner = scopeOwner(scope);
	const app = await deps.installationToken(owner);
	if (!app) throw new HttpError(409, `The ProAgentStore GitHub App is not installed on ${owner}, so it cannot update a runner's labels there.`);
	const headers = { Authorization: `Bearer ${app}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ProAgentStore" };
	const denied = (status: number) => new HttpError(403, `GitHub refused to ${status === 403 || status === 404 ? "list or relabel" : "read"} runners for ${"org" in scope ? scope.org : scope.repo} (${status}). The ProAgentStore App needs ${"org" in scope ? '"Self-hosted runners: Read and write" (organization)' : '"Administration: Read and write" (repository)'}, accepted on ${owner}'s installation — see #1207.`);
	let found: GithubRunner | null = null;
	for (let page = 1; page <= 5 && !found; page++) {
		const res = await deps.fetch(`${ghBase(scope)}/actions/runners?per_page=100&page=${page}`, { headers });
		if (res.status === 403 || res.status === 404) throw denied(res.status);
		if (!res.ok) throw new HttpError(502, `GitHub returned ${res.status} listing runners.`);
		const body = (await res.json().catch(() => null)) as { runners?: GithubRunner[] } | null;
		const runners = body?.runners ?? [];
		found = runners.find((r) => r.name === runnerName) ?? null;
		if (runners.length < 100) break;
	}
	if (!found) throw new HttpError(409, `No runner named ${runnerName} is registered with GitHub for ${"org" in scope ? scope.org : scope.repo}, so there are no labels to refresh. Remove and install it again.`);
	const before = found.labels.filter((l) => l.type === "custom").map((l) => l.name);
	const after = [...new Set([...before.filter((l) => !MANAGED_LABEL.test(l) && !alsoManaged.includes(l)), ...desired])];
	const same = before.length === after.length && after.every((l) => before.includes(l));
	if (same) return { runnerId: found.id, before, after, changed: false };
	const put = await deps.fetch(`${ghBase(scope)}/actions/runners/${found.id}/labels`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ labels: after }) });
	if (put.status === 403 || put.status === 404) throw denied(put.status);
	if (!put.ok) throw new HttpError(502, `GitHub returned ${put.status} updating the runner's labels.`);
	return { runnerId: found.id, before, after, changed: true };
}

/**
 * Start installing (or removing) the runner on the agent's pinned machine. Answers with the machine's
 * job, which {@link actionsRunnerStatus} reads back; the token is in neither the answer nor any record.
 */
export async function startActionsRunner(
	env: Env,
	input: { userId: string; instanceId: string; action: "install" | "remove"; scope: RunnerScope; runnerGroup?: string },
	deps: ProvisionDeps = liveProvisionDeps(env, input.userId),
): Promise<{ job: RunnerJobView; node: string; labels: string[]; capabilities?: RunnerCapabilities | null; preflight?: RunnerPreflight; refreshed?: { changed: boolean; before: string[]; after: string[] }; migration?: MigrationView }> {
	const conn = await boundConn(deps, input.instanceId, input.userId);
	if (input.action === "install") await checkScope(input.scope, input.instanceId, input.userId, deps);
	const node = conn.runnerNode;
	const label = nodeRunnerLabel(node);
	// What the machine can run, asked BEFORE registering (#1260): its labels join the base ones, so a job that needs `jq` can require
	// `has-jq`, and the owner reads what is missing while there is still time to install it. Removal does not need it.
	const caps = input.action === "install" ? await machineCapabilities(deps, conn) : null;
	const preflight = input.action === "install" ? preflightFor(caps, node) : undefined;
	// A machine that is not ready for CI (#1272) is registered WITHOUT the routing labels, so nothing routes to it; once fixed, running
	// this again refreshes the labels below. Removal never needs them.
	const labels = routingLabels(node, caps?.labels ?? [], preflight?.availability ?? runnerAvailability(null));

	// Already registered for this scope? Then installing again would do nothing, and the labels may be stale (a tool installed or an
	// OS upgraded since): refresh them at GitHub instead (#1260). The CLI holds no GitHub credential; the platform does.
	if (input.action === "install") {
		const status = await deps.call<{ installed?: Array<{ dir?: string; name: string | null; url: string | null; legacy?: boolean }> }>(conn, "/coding/actions-runner/status", {}).catch(() => null);
		const url = scopeUrl(input.scope);
		const sameScope = (r: { url: string | null }) => r.url?.replace(/\/$/, "").toLowerCase() === url.toLowerCase();
		// A profile-scoped Windows install (#1272) is MIGRATED to the machine root — never relabelled in place, never repaired by
		// granting the service access to the profile. The migrated runner registers under a staged name (`<label>-m`).
		const legacy = status?.installed?.find((r) => r.legacy && r.name === label && sameScope(r));
		if (legacy) return migrateLegacyRunner(env, { ...input, node, label, url, folder: (legacy.dir ?? "").split(/[\\/]/).pop() ?? "", availability: preflight?.availability, caps, preflight }, conn, { call: deps.call, sleep: deps.sleep, smoke: deps.smoke ? (name) => (deps.smoke as NonNullable<ProvisionDeps["smoke"]>)(input.scope, name) : undefined }, {
			mintToken: async () => (await mintRunnerToken(input.scope, "registration", deps)).token,
			scopeUrl: url,
			findRunner: (name) => findGithubRunner(input.scope, name, deps),
			relabel: (name, to, extra) => syncRunnerLabels(input.scope, name, to, deps, extra),
		});
		const present = status?.installed?.find((r) => (r.name === label || r.name === `${label}-m`) && sameScope(r));
		if (present?.name) {
			const synced = await syncRunnerLabels(input.scope, present.name, labels, deps, [PAGS_RUNNER_LABEL, label, RUNNER_UNAVAILABLE_LABEL]);
			await logEvent(env, {
				source: "runner",
				event: "actions_runner.labels_refreshed",
				userId: input.userId,
				instanceId: input.instanceId,
				message: `Refreshed the capability labels of ${node}'s GitHub Actions runner for ${url}`,
				context: { node, url, labels, changed: synced.changed },
			}).catch(() => undefined);
			const job: RunnerJobView = {
				id: `labels-${node}`,
				action: "install",
				url,
				name: label,
				state: "done",
				steps: [synced.changed ? `relabelled at GitHub: ${synced.before.join(",") || "(none)"} → ${synced.after.join(",")}` : "labels already match what the machine reports — nothing changed"],
				prerequisites: [],
				runsAs: "",
				service: "installed",
			};
			return { job, node, labels, capabilities: caps, preflight, refreshed: { changed: synced.changed, before: synced.before, after: synced.after } };
		}
	}

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
		context: { node, url: scopeUrl(input.scope), labels, jobId: job.id, ...(preflight?.missing.length ? { missingTools: preflight.missing.map((m) => m.tool) } : {}), ...(preflight?.availability && !preflight.availability.available ? { unavailable: preflight.availability.reasons } : {}) },
	}).catch(() => undefined);
	return { job, node, labels, ...(input.action === "install" ? { capabilities: caps, preflight } : {}) };
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
