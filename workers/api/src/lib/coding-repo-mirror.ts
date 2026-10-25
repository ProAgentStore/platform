import { clipMarked } from "./clip-marked.js";
import { callRunner, getRunnerConn, READ_TIMEOUT_MS, type RunnerConn } from "./runner-client.js";
import { getCheckout, listCheckoutsForRepo, upsertCheckout } from "./coding-repo-checkouts.js";
import { getRepo, listRepos } from "./coding-store.js";
import { checkWorkdirVia } from "./coding-workdir.js";
import type { CodingRepo } from "./coding-types.js";
import type { Env } from "../types.js";

/**
 * Putting a repo on every machine an instance may run on (#1142).
 *
 * A binding has one checkout per machine (`coding_repo_checkouts`). Repinning an instance, or placing it on another
 * machine, is only safe when the target holds the repo, so this makes that true: for a machine with no usable checkout
 * it starts the SAME background clone `coding_repo_add` uses (`/coding/clone-start`, #858: the machine's own git
 * credentials, https then ssh) into the binding's home-relative path, and records the checkout as `cloning`. The clone
 * is never awaited, a multi-gigabyte repo would outlive any request; the next verification (a session start, or another
 * mirror) reads it back as `ready` or `needs_attention`.
 */

export type MirrorStatus = "ready" | "cloning" | "error" | "skipped";
export interface MirrorResult {
	machineId: string;
	runnerNode: string;
	status: MirrorStatus;
	/** Why, when it is not simply ready / cloning. */
	detail?: string;
}

export const MIRROR_CONCURRENCY = 5;

/** Run `fn` over `items`, at most `limit` at a time, results in input order. */
async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i]);
			}
		}),
	);
	return out;
}

interface Machine { machineId: string; runnerNode: string }

/** The instance's registered machines that hold a live relay, one per machine id. */
async function onlineMachines(env: Env, instanceId: string, userId: string): Promise<Array<Machine & { conn: RunnerConn }>> {
	const { results } = await env.DB.prepare(
		"SELECT runner_node, machine_id FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 AND machine_id IS NOT NULL AND machine_id <> '' ORDER BY last_seen_at DESC",
	)
		.bind(instanceId, userId)
		.all<{ runner_node: string; machine_id: string }>();
	const seen = new Set<string>();
	const machines = (results ?? []).filter((r) => {
		if (seen.has(r.machine_id)) return false;
		seen.add(r.machine_id);
		return true;
	});
	const live = await Promise.all(
		machines.map(async (m) => ({ machineId: m.machine_id, runnerNode: m.runner_node, conn: await getRunnerConn(env, instanceId, userId, m.runner_node).catch(() => null) })),
	);
	return live.filter((m): m is Machine & { conn: RunnerConn } => m.conn !== null);
}

/**
 * Make sure the repo is on one machine: verify what is there, clone what is missing.
 * Never throws; every outcome is a {@link MirrorResult} and a recorded checkout.
 */
export async function ensureCheckoutOnMachine(env: Env, instanceId: string, userId: string, repo: CodingRepo, machine: Machine, conn: RunnerConn): Promise<MirrorResult> {
	const base = { machineId: machine.machineId, runnerNode: machine.runnerNode };
	const existing = await getCheckout(env, instanceId, userId, repo.id, machine.machineId).catch(() => null);
	const workdir = existing?.workdir?.trim() || repo.workdir;
	const record = (cloneStatus: string, cloneError: string | null, verified: boolean) =>
		upsertCheckout(env, instanceId, userId, repo.id, machine.machineId, { cloneStatus, cloneError, verified }).catch(() => false);
	if (!workdir) return { ...base, status: "skipped", detail: "the binding has no folder to put a checkout in" };
	if (!repo.githubRepo || repo.provider !== "github") return { ...base, status: "skipped", detail: "only GitHub repos can be cloned for a machine" };

	const verdict = await checkWorkdirVia(conn, workdir);
	if (verdict.state === "ok") {
		await record("ready", null, true);
		return { ...base, status: "ready" };
	}
	if (verdict.state === "unverified") return { ...base, status: "error", detail: verdict.detail || "the machine could not be asked about the folder" };
	// An absent or empty folder is cloned into; anything else (a file, a non-git folder with content) is the owner's to resolve.
	if (verdict.state !== "missing" && verdict.state !== "empty") {
		await record("needs_attention", verdict.detail || null, true);
		return { ...base, status: "error", detail: verdict.detail || `the folder is ${verdict.state}` };
	}
	try {
		const job = await callRunner<{ state?: string; error?: string }>(conn, "/coding/clone-start", { workDir: workdir, slug: repo.githubRepo, protocol: "auto" }, { timeoutMs: READ_TIMEOUT_MS });
		if (job?.state === "failed") {
			await record("error", job.error ?? "git failed", false);
			return { ...base, status: "error", detail: job.error ?? "the clone failed" };
		}
		if (job?.state === "done") {
			await record("ready", null, true);
			return { ...base, status: "ready" };
		}
		await record("cloning", null, false);
		return { ...base, status: "cloning" };
	} catch (e) {
		const detail = clipMarked(e instanceof Error ? e.message : String(e), 300, { what: "the error" });
		await record("error", detail, false);
		return { ...base, status: "error", detail };
	}
}

/** Mirror one binding onto every connected machine of its instance. Concurrency {@link MIRROR_CONCURRENCY}. */
export async function mirrorRepoToAllMachines(env: Env, instanceId: string, userId: string, repoId: string): Promise<MirrorResult[] | null> {
	const repo = await getRepo(env, instanceId, userId, repoId);
	if (!repo) return null;
	const machines = await onlineMachines(env, instanceId, userId);
	return pooled(machines, MIRROR_CONCURRENCY, (m) => ensureCheckoutOnMachine(env, instanceId, userId, repo, m, m.conn));
}

/**
 * The repin hook: the machine an instance was just pinned to gets every GitHub binding it lacks (#1142). Best effort,
 * the repin has already happened and must not depend on it. Returns what was done, for the response.
 */
export async function ensureCheckoutsOnRepin(env: Env, instanceId: string, userId: string, node: string, machineId: string, opts?: { waitMs?: number; pollMs?: number }): Promise<MirrorResult[]> {
	if (!node || !machineId) return [];
	// The repin returns before the machine has necessarily attached, so give it a bounded moment to come up.
	const until = Date.now() + (opts?.waitMs ?? 0);
	let conn = await getRunnerConn(env, instanceId, userId, node).catch(() => null);
	while (!conn && Date.now() < until) {
		await new Promise((r) => setTimeout(r, opts?.pollMs ?? 3_000));
		conn = await getRunnerConn(env, instanceId, userId, node).catch(() => null);
	}
	if (!conn) return [];
	const repos = await listRepos(env, instanceId, userId).catch(() => []);
	const mine = await Promise.all(repos.map(async (r) => ({ r, have: (await listCheckoutsForRepo(env, instanceId, userId, r.id).catch(() => [])).find((c) => c.machineId === machineId) })));
	// A checkout already known good is left alone; everything else is verified, and cloned if absent.
	const todo = mine.filter(({ have }) => have?.cloneStatus !== "ready" && have?.cloneStatus !== "cloning").map(({ r }) => r);
	return pooled(todo, MIRROR_CONCURRENCY, (r) => ensureCheckoutOnMachine(env, instanceId, userId, r, { machineId, runnerNode: node }, conn));
}
