// Whose permissions a tool call runs under (#185).
//
// The rule, in one line: **a delegation carries the owner's authority plus a goal. It lends
// nothing else.**
//
// Why this needs to be a module rather than a convention. Once supervision is configurable
// (#183), a delegated tool call has TWO instances in scope — the one that asked (the supervisor)
// and the one doing the work (the subordinate). If permission were ever resolved against the
// asker, supervision would become a consent bypass: wire a low-trust agent beneath a high-trust
// one and it inherits reach it was never granted, by configuration alone, with no code change and
// no review. The platform's real consent boundary (write-consent, migration 0051; the
// `capabilities.tools` allowlist) would be routed straight around.
//
// So the executing instance is the ONLY authority, and the asker is recorded for the audit trail
// and nothing else. Both directions matter and both are tested:
//   • down-lending  — a supervisor must not widen a subordinate's reach by delegating to it
//   • up-borrowing  — a supervisor must not gain a subordinate's reach by delegating through it

/** The identity a tool call executes as. */
export interface ExecutionAuthority {
	/** The instance whose consent, tool allowlist and guardrails apply. ALWAYS the executor. */
	instanceId: string;
	/** Owner of both ends of any delegation — the authority a delegation actually carries. */
	userId: string;
	/**
	 * Audit only: the instance that ASKED for this work, when it differs from the executor.
	 * Never consulted for permission. Present so the trace can answer "who asked for this?"
	 * separately from "whose authority ran it?".
	 */
	onBehalfOf?: string;
}

/**
 * Build the authority for delegated work.
 *
 * Note which id lands in `instanceId`: the **subordinate**. The supervisor only ever reaches
 * `onBehalfOf`. This function exists so that is a single reviewable line rather than a decision
 * re-made at each future call site.
 */
export function authorityForDelegation(opts: {
	subordinateInstanceId: string;
	supervisorInstanceId: string;
	userId: string;
}): ExecutionAuthority {
	return {
		instanceId: opts.subordinateInstanceId,
		userId: opts.userId,
		// Self-delegation would make this noise in the audit trail; only record a real asker.
		onBehalfOf: opts.supervisorInstanceId === opts.subordinateInstanceId ? undefined : opts.supervisorInstanceId,
	};
}

/** Authority for work an instance does for itself — no delegation involved. */
export function ownAuthority(instanceId: string, userId: string): ExecutionAuthority {
	return { instanceId, userId };
}

/**
 * The instance to check consent and mint connector tokens against.
 *
 * Deliberately a named function returning `instanceId` rather than callers reaching for the field
 * directly: it gives the invariant one place to be stated, one place to be tested, and one place
 * a reviewer can check. It must never consult `onBehalfOf`.
 */
export function consentInstanceOf(authority: ExecutionAuthority): string {
	return authority.instanceId;
}

/** Was this work delegated by someone else? Audit/UI only — never a permission input. */
export function isDelegated(authority: ExecutionAuthority): boolean {
	return !!authority.onBehalfOf && authority.onBehalfOf !== authority.instanceId;
}

/** One-line attribution for the trace: which authority ran, and who asked. */
export function describeAuthority(authority: ExecutionAuthority): string {
	return isDelegated(authority)
		? `ran as ${authority.instanceId} (asked by ${authority.onBehalfOf})`
		: `ran as ${authority.instanceId}`;
}
