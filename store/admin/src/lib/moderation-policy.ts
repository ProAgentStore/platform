/**
 * What an operator is allowed to aim at, and what a destructive request is allowed to
 * contain (#280).
 *
 * The API enforces all of this too — self-suspension and self-demotion are refused, key
 * revoke demands an explicit provider, agent delete must echo the slug. These are the
 * client-side expressions of the same rules, extracted out of JSX (#282) so they can be
 * asserted. Two of them are more than cosmetic:
 *
 *  - `deleteAgentRequest` sends what the operator TYPED, not the correct slug read back
 *    from props. The UI gate and the server's echo check now validate the same string;
 *    before, a regressed gate would still have produced a perfectly valid delete.
 *  - `revokeKeyRequest` refuses a blank provider rather than omitting the field. An
 *    omitted provider must never be read as "all of them".
 */

/** The roles an operator may grant. `user` is implied by the API and never removable. */
export const GRANTABLE_ROLES = ["creator", "admin"];

export interface Guard {
	disabled: boolean;
	/** Shown in place of the control, so it says WHY rather than failing on click. */
	reason?: string;
}

/**
 * Suspension aimed at yourself. The API refuses it; saying so up front beats offering a
 * button whose only possible outcome is an error — and the outcome it is protecting
 * against is the operator locking themselves out of the portal they would need to undo it.
 */
export function suspendGuard(targetUserId: string, selfId: string | null): Guard {
	if (selfId && selfId === targetUserId) {
		return { disabled: true, reason: "you cannot suspend your own account" };
	}
	return { disabled: false };
}

/**
 * Dropping your own `admin` role is the same lockout by a quieter route, so that one
 * checkbox is locked. Granting yourself a role you do not have is fine; taking away the
 * one that got you here is not.
 */
export function roleCheckboxLocked(role: string, isSelf: boolean, currentRoles: string[]): boolean {
	return isSelf && role === "admin" && currentRoles.includes("admin");
}

/**
 * The roles PUT is a set, not a patch, so this builds the whole list.
 *
 * `user` is always present. Roles that have no checkbox (anything outside
 * GRANTABLE_ROLES) are PRESERVED rather than dropped: silently stripping a role the UI
 * cannot render would be a privilege change nobody asked for, arriving through a form
 * that never showed it.
 */
export function rolesPayload(selected: string[]): string[] {
	return ["user", ...new Set(selected.filter((r) => r && r !== "user"))];
}

/** Order-insensitive: `[user, admin]` and `[admin, user]` are the same grant. */
export function rolesChanged(next: string[], current: string[]): boolean {
	return JSON.stringify([...next].sort()) !== JSON.stringify([...current].sort());
}

/**
 * Revoke ONE provider's stored key. Blank is refused loudly instead of being sent as an
 * absent field, because the server's "which key?" default must never have to be guessed
 * from a request that forgot to say.
 */
export function revokeKeyRequest(provider: string): { provider: string } {
	const p = (provider || "").trim();
	if (!p) throw new Error("Refusing to revoke: no provider named. Revocation is per-provider, never 'all keys'.");
	return { provider: p };
}

/**
 * Delete an agent. `confirmed` is the operator's typed echo; it has to match the slug
 * exactly, and it is that value — not the slug from props — that goes in the body.
 */
export function deleteAgentRequest(slug: string, confirmed: string | undefined, force: boolean | undefined): { confirm: string; force: boolean } {
	if (!slug) throw new Error("Refusing to delete: the agent has no slug to confirm against.");
	if (confirmed !== slug) throw new Error(`Refusing to delete: type ${slug} exactly to confirm.`);
	return { confirm: confirmed, force: force === true };
}
