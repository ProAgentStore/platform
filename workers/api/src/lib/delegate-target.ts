// The address of something a GOAL can be delegated to (#156).
//
// Why this exists: delegation used to be typed as `drive_claude(repoId, …)` — the target was a
// REPO. That single type is what kept Coder's hierarchy locked inside Coder: you cannot express
// "delegate to another agent" when the parameter is a repo id. Naming the target as its own
// addressable thing is the change that lets supervision become platform data (#183) instead of
// one agent's private structure.
//
// `instance` was deliberately parsed-but-refused until the supervision graph (#183), the spend
// budget (#184) and authority containment (#185) existed — without those, agent-to-agent
// delegation is an unbounded loop and a consent bypass. All three landed, so it is executable now
// (lib/delegate-instance.ts), and that module enforces each of them on the delegation path rather
// than trusting that they hold.

/** An addressable entity a goal can be delegated to. */
export type DelegationTarget =
	/** A repo's Pilot (the durable CodingSessionWorkflow). Live today. */
	| { kind: "repo"; repoId: string }
	/** Another instance's brain — a durable loop started on the subordinate (#159). */
	| { kind: "instance"; instanceId: string };

export type DelegationTargetKind = DelegationTarget["kind"];

/** Kinds that can actually be delegated to right now. Anything else parses but is refused at
 *  dispatch with an explicit reason — a silent no-op would look like success on the board.
 *  `instance` became executable once the supervision graph (#183), the spend budget (#184) and
 *  authority containment (#185) landed; see lib/delegate-instance.ts, which enforces all three
 *  rather than assuming them. */
const EXECUTABLE: ReadonlySet<DelegationTargetKind> = new Set<DelegationTargetKind>(["repo", "instance"]);

export function isExecutableTarget(target: DelegationTarget): boolean {
	return EXECUTABLE.has(target.kind);
}

/** Why a parsed-but-not-runnable target was refused. Phrased for the human reading the board. */
export function unsupportedTargetReason(target: DelegationTarget): string {
	return `Cannot delegate to a "${target.kind}" target.`;
}

const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * Normalize a target from tool arguments or stored config.
 *
 * Accepts the legacy `{ repoId }` shape the `drive_claude` tool still emits, so an in-flight model
 * call keeps working, as well as the explicit `{ kind, id }` form. Returns null for anything it
 * cannot name — callers must treat that as "no delegation", never as a default target.
 */
export function parseDelegationTarget(raw: unknown): DelegationTarget | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;

	// Explicit form: { kind, id }.
	if (isNonEmpty(o.kind)) {
		const kind = o.kind.trim();
		const id = isNonEmpty(o.id) ? o.id.trim() : "";
		if (!id) return null;
		if (kind === "repo") return { kind: "repo", repoId: id };
		if (kind === "instance") return { kind: "instance", instanceId: id };
		return null;
	}

	// Legacy/tool form: { repoId } or { instanceId }.
	if (isNonEmpty(o.repoId)) return { kind: "repo", repoId: o.repoId.trim() };
	if (isNonEmpty(o.instanceId)) return { kind: "instance", instanceId: o.instanceId.trim() };
	return null;
}

/** The target's id, independent of kind — for logging, board records and trace correlation. */
export function targetId(target: DelegationTarget): string {
	return target.kind === "repo" ? target.repoId : target.instanceId;
}

/** Stable `kind:id` string. Used where a target needs to be a map key or an idempotency
 *  component; distinct kinds with the same raw id must never collide. */
export function targetKey(target: DelegationTarget): string {
	return `${target.kind}:${targetId(target)}`;
}
