import type { Env } from "../types.js";

/**
 * Per-machine checkouts of a coding repo binding (#1142).
 *
 * A binding (`coding_repos`) is one GitHub repo for one instance. A checkout is that repo on ONE machine: where it lives
 * there and whether it is usable. Repinning or load-balancing an instance across machines needs the second fact per
 * machine, which the binding's single `workdir` / `clone_status` columns cannot hold.
 *
 * Every read is owner-scoped through the binding (`coding_repos.instance_id` / `user_id`), so a checkout is never
 * addressable without proving the binding is the caller's. The binding's own columns remain the default for a machine
 * with no row of its own.
 */

export interface CheckoutRow {
	id: string;
	repoId: string;
	machineId: string;
	/** The path on that machine; null = use the binding's own workdir. */
	workdir: string | null;
	cloneStatus: string;
	cloneError: string | null;
	lastVerifiedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

interface Raw {
	id: string;
	repo_id: string;
	machine_id: string;
	workdir: string | null;
	clone_status: string;
	clone_error: string | null;
	last_verified_at: string | null;
	created_at: string;
	updated_at: string;
}

const toCheckout = (r: Raw): CheckoutRow => ({
	id: r.id,
	repoId: r.repo_id,
	machineId: r.machine_id,
	workdir: r.workdir,
	cloneStatus: r.clone_status,
	cloneError: r.clone_error,
	lastVerifiedAt: r.last_verified_at,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

const COLS = "c.id, c.repo_id, c.machine_id, c.workdir, c.clone_status, c.clone_error, c.last_verified_at, c.created_at, c.updated_at";

export async function listCheckoutsForRepo(env: Env, instanceId: string, userId: string, repoId: string): Promise<CheckoutRow[]> {
	const { results } = await env.DB.prepare(
		`SELECT ${COLS} FROM coding_repo_checkouts c JOIN coding_repos r ON r.id = c.repo_id
		  WHERE c.repo_id = ?1 AND r.instance_id = ?2 AND r.user_id = ?3 ORDER BY c.machine_id`,
	)
		.bind(repoId, instanceId, userId)
		.all<Raw>();
	return (results ?? []).map(toCheckout);
}

/** Every checkout of every binding on one instance, grouped by repo id (one query for the list view). */
export async function listCheckoutsForInstance(env: Env, instanceId: string, userId: string): Promise<Map<string, CheckoutRow[]>> {
	const { results } = await env.DB.prepare(
		`SELECT ${COLS} FROM coding_repo_checkouts c JOIN coding_repos r ON r.id = c.repo_id
		  WHERE r.instance_id = ?1 AND r.user_id = ?2 ORDER BY c.machine_id`,
	)
		.bind(instanceId, userId)
		.all<Raw>();
	const byRepo = new Map<string, CheckoutRow[]>();
	for (const row of (results ?? []).map(toCheckout)) byRepo.set(row.repoId, [...(byRepo.get(row.repoId) ?? []), row]);
	return byRepo;
}

/** Every checkout one user has on one machine, with the binding's repo name (for "what lives on this machine"). */
export async function listCheckoutsForMachine(env: Env, userId: string, machineId: string): Promise<Array<CheckoutRow & { instanceId: string; githubRepo: string | null }>> {
	const { results } = await env.DB.prepare(
		`SELECT ${COLS}, r.instance_id AS instance_id, r.github_repo AS github_repo FROM coding_repo_checkouts c JOIN coding_repos r ON r.id = c.repo_id
		  WHERE c.machine_id = ?1 AND r.user_id = ?2 ORDER BY r.updated_at DESC`,
	)
		.bind(machineId, userId)
		.all<Raw & { instance_id: string; github_repo: string | null }>();
	return (results ?? []).map((r) => ({ ...toCheckout(r), instanceId: r.instance_id, githubRepo: r.github_repo }));
}

export async function getCheckout(env: Env, instanceId: string, userId: string, repoId: string, machineId: string): Promise<CheckoutRow | null> {
	const row = await env.DB.prepare(
		`SELECT ${COLS} FROM coding_repo_checkouts c JOIN coding_repos r ON r.id = c.repo_id
		  WHERE c.repo_id = ?1 AND c.machine_id = ?2 AND r.instance_id = ?3 AND r.user_id = ?4`,
	)
		.bind(repoId, machineId, instanceId, userId)
		.first<Raw>();
	return row ? toCheckout(row) : null;
}

export interface CheckoutPatch {
	/** Omit to keep the stored path; pass null to fall back to the binding's. */
	workdir?: string | null;
	cloneStatus: string;
	cloneError?: string | null;
	/** Stamp `last_verified_at` now: only for a DEFINITE verdict from the machine, never for "cloning" or "unreachable". */
	verified?: boolean;
}

/**
 * Create the (repo, machine) checkout or update it. Owner-scoped: nothing is written unless the binding belongs to
 * `instanceId` / `userId`. Returns false when it does not.
 */
export async function upsertCheckout(env: Env, instanceId: string, userId: string, repoId: string, machineId: string, patch: CheckoutPatch): Promise<boolean> {
	if (!machineId) return false;
	const setWorkdir = patch.workdir !== undefined ? 1 : 0;
	const res = await env.DB.prepare(
		`INSERT INTO coding_repo_checkouts (id, repo_id, machine_id, workdir, clone_status, clone_error, last_verified_at)
		 SELECT lower(hex(randomblob(16))), r.id, ?4, ?5, ?6, ?7, CASE WHEN ?8 = 1 THEN datetime('now') END
		   FROM coding_repos r WHERE r.id = ?1 AND r.instance_id = ?2 AND r.user_id = ?3
		 ON CONFLICT (repo_id, machine_id) DO UPDATE SET
		   workdir = CASE WHEN ?9 = 1 THEN excluded.workdir ELSE coding_repo_checkouts.workdir END,
		   clone_status = excluded.clone_status,
		   clone_error = excluded.clone_error,
		   last_verified_at = CASE WHEN ?8 = 1 THEN datetime('now') ELSE coding_repo_checkouts.last_verified_at END,
		   updated_at = datetime('now')`,
	)
		.bind(repoId, instanceId, userId, machineId, patch.workdir ?? null, patch.cloneStatus, patch.cloneError ?? null, patch.verified ? 1 : 0, setWorkdir)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

export async function deleteCheckout(env: Env, instanceId: string, userId: string, repoId: string, machineId: string): Promise<boolean> {
	const res = await env.DB.prepare(
		`DELETE FROM coding_repo_checkouts WHERE repo_id = ?1 AND machine_id = ?2
		   AND repo_id IN (SELECT id FROM coding_repos WHERE id = ?1 AND instance_id = ?3 AND user_id = ?4)`,
	)
		.bind(repoId, machineId, instanceId, userId)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

/**
 * The stable machine id behind a runner node name for this instance: the registry row for that name first, the
 * instance's own pin (`runnerMachineId`) when the name is the pinned one. Null when neither knows the node.
 */
export async function machineIdForNode(env: Env, instanceId: string, userId: string, node: string): Promise<string | null> {
	if (!node) return null;
	const reg = await env.DB.prepare(
		"SELECT machine_id FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 AND runner_node = ?3 AND machine_id IS NOT NULL AND machine_id <> '' LIMIT 1",
	)
		.bind(instanceId, userId, node)
		.first<{ machine_id: string }>();
	if (reg?.machine_id) return reg.machine_id;
	const pin = await env.DB.prepare(
		`SELECT CASE WHEN json_valid(config) THEN json_extract(config, '$.runnerMachineId') END AS machine_id,
		        CASE WHEN json_valid(config) THEN json_extract(config, '$.runnerNode') END AS node
		   FROM agent_instances WHERE id = ?1 AND user_id = ?2`,
	)
		.bind(instanceId, userId)
		.first<{ machine_id: string | null; node: string | null }>();
	return pin?.machine_id && pin.node === node ? pin.machine_id : null;
}

/** The path to use on a machine: its own checkout's, else the binding's. */
export const effectiveWorkdir = (checkout: Pick<CheckoutRow, "workdir"> | null | undefined, bindingWorkdir: string | undefined): string | undefined =>
	checkout?.workdir?.trim() || bindingWorkdir;
