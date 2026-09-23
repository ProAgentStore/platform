/**
 * The 409 for a second binding of one repository on one instance (#829), shared by every route
 * in `coding-repos.ts` that can create or re-address a binding.
 */
import type { Context } from "hono";
import { createRepo } from "../lib/coding-store.js";
import { findDuplicateBinding, isUniqueViolation, type RepoIdentity } from "../lib/coding-repo-identity.js";
import type { CodingRepo } from "../lib/coding-types.js";
import type { Env } from "../types.js";

/**
 * One instance, one binding per repository (#829). The refusal names the binding that already
 * exists, so the caller can use it — or remove it first — rather than being told only "no".
 */
export function duplicateBinding(c: Context<{ Bindings: Env }>, existing: CodingRepo): Response {
	return c.json(
		{
			error: `This repository is already bound to this instance as "${existing.name}" (${existing.id}). Use that binding, or remove it before adding the repository again.`,
			existingRepo: { id: existing.id, name: existing.name, cloneStatus: existing.cloneStatus },
		},
		409,
	);
}

export async function refuseDuplicate(
	c: Context<{ Bindings: Env }>,
	instanceId: string,
	uid: string,
	identity: RepoIdentity,
	excludeRepoId?: string,
): Promise<Response | null> {
	const existing = await findDuplicateBinding(c.env, instanceId, uid, identity, excludeRepoId);
	return existing ? duplicateBinding(c, existing) : null;
}

/**
 * `createRepo`, with the race the pre-check cannot close: two adds of the same repo that both
 * passed it. Migration 0156's unique indexes refuse the second INSERT; that is answered with the
 * same 409 as the pre-check, not a 500.
 */
export async function createGuarded(
	c: Context<{ Bindings: Env }>,
	instanceId: string,
	uid: string,
	identity: RepoIdentity,
	input: Parameters<typeof createRepo>[3],
): Promise<CodingRepo | Response> {
	try {
		return await createRepo(c.env, instanceId, uid, input);
	} catch (err) {
		if (!isUniqueViolation(err)) throw err;
		const existing = await findDuplicateBinding(c.env, instanceId, uid, identity);
		if (!existing) throw err;
		return duplicateBinding(c, existing);
	}
}
