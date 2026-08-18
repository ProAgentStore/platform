/**
 * The parts of `agents.config` that are COPIED into an instance at subscribe, and therefore do not
 * reach an instance that already exists (#496, #394).
 *
 * ── The decision this file states
 *
 * **An instance is a snapshot, not a view.** Subscribe copies the template's identity and pipelines
 * into the subscriber's own copy, and nothing re-reads the template afterwards. That is deliberate
 * and it is the marketplace invariant: a creator must not be able to change the personality — or
 * the pipeline — of a running instance without its owner knowing. Read-time resolution of identity
 * is a product boundary that lands on epic #58, not a bug fix (#496's own comment thread records
 * why it cannot ship before "edited by the subscriber" is a tracked fact rather than an inference).
 *
 * The consequence, and it is the whole failure mode: **a seed migration patching one of these keys
 * fixes the catalog and reaches nobody who is already running the agent.** The migration applies,
 * CI is green, the `agents` row is right, and every live instance is unchanged. It is invisible.
 * #483 shipped that way (`0118`, identity) and so did #394's 1MiB fix (`0111`, pipelines).
 *
 * So the rule, enforced by `seed-identity-propagation.test.ts`:
 *
 *   A migration that patches an instance-copied key must ALSO reach the existing copies, or record
 *   that it deliberately does not.
 *
 * and how it does that is decided by ONE property — which store the copy lives in:
 *
 *   * `store: "d1"` (`$.pipelines`) — the copy is a column a migration can write. The migration
 *     MUST write `agent_instances` too, gated so it cannot clobber a subscriber's own edit.
 *   * `store: "durable-object"` (`$.identity`) — the copy is DO state. D1 cannot reach it at all,
 *     so the second route has to be code that resolves live (the way `connectorToolsPrompt` does),
 *     or an owner-initiated `PUT /v1/instances/:id/state`. A migration claiming to reach it would
 *     be claiming something impossible.
 *
 * ── The CONTRAST, which is what makes this list a list rather than "any json_set on agents"
 *
 * `$.capabilities` and `$.settingsSchema` are NOT copied — `capabilitiesForInstance` JOINs the
 * agents row on every read, so patching them DOES reach live instances. `0117` (a tool grant) and
 * `0118` (a personality rule) shipped twenty minutes apart to the same agent; only `0117` arrived.
 * Same file shape, opposite outcome, and the difference is exactly this list.
 */

/** Where the subscriber's copy physically lives — the only thing that decides how to reach it. */
export type InstanceCopyStore = "d1" | "durable-object";

export interface InstanceCopiedConfigKey {
	/** The `agents.config` JSON path a seed migration patches. */
	readonly path: string;
	/** Where subscribe puts the copy. */
	readonly copy: string;
	/** Which store that copy is in. `"d1"` means a migration can reach it; `"durable-object"` means it cannot. */
	readonly store: InstanceCopyStore;
	/** The subscribe-time code that makes the copy, so the claim above is checkable rather than remembered. */
	readonly copiedBy: string;
	/** What reads the copy afterwards — i.e. why the stale value is the one that runs. */
	readonly readBy: string;
}

/**
 * Enumerated from the subscribe path (`routes/instances.ts` — `defaultPipelinesFor` and the DO
 * `/init` payload). Two keys today. Anything a future subscribe copies belongs here on the same
 * commit, because the guard derives its detector from this list and will otherwise watch a field
 * that no longer exists while missing the one that does.
 */
export const INSTANCE_COPIED_CONFIG_KEYS: readonly InstanceCopiedConfigKey[] = [
	{
		path: "$.identity",
		copy: "the instance's Durable Object state (personality, goal, guardrails, welcomeMessage)",
		store: "durable-object",
		copiedBy: "routes/instances.ts — POST https://agent/init on subscribe",
		readBy: "agent-do-prompt.ts — the personality/goal block of every prompt",
	},
	{
		path: "$.pipelines",
		copy: "agent_instances.config.pipelines",
		store: "d1",
		copiedBy: "routes/instances.ts — defaultPipelinesFor(agent.config) on subscribe",
		readBy: "lib/pipeline.ts loadPipeline — SELECT config FROM agent_instances, no fallback to the agents row",
	},
] as const;

/**
 * A migration's DDL, comments stripped — the same split `check-migrations.mjs` makes.
 *
 * The detector has to read the DDL and not the prose: these migrations explain themselves at
 * length, and every one of them discusses `$.identity` or `$.pipelines` in its header. A detector
 * over the raw text would flag a migration for describing the hazard it was written to avoid.
 */
export function migrationDdl(sql: string): string {
	return sql
		.split("\n")
		.filter((l) => !l.trimStart().startsWith("--"))
		.join("\n");
}

/**
 * The instance-copied paths a migration PATCHES on an `agents` row that may already have instances.
 *
 * Three properties, and each one is load-bearing:
 *
 *   * a `json_set`/`json_patch` — the shape of the edit, not its content. An INSERT-shaped seed is
 *     deliberately NOT one of these: a brand-new agent has no instances to miss, and every future
 *     subscriber gets the value by the copy that already works.
 *   * the path as a QUOTED SQL path literal (`'$.pipelines`), which is what keeps the same word
 *     appearing as a key inside a JSON blob being inserted from counting.
 *   * in a statement that writes the `agents` table. The remedy for one of these migrations is a
 *     write to `agent_instances` naming the very same path, and a detector that could not tell the
 *     two apart would flag the fix as another instance of the defect.
 */
export function instanceCopiedPatchPaths(sql: string): string[] {
	const onAgents = migrationDdl(sql)
		// Mask the embedded JSON blobs before splitting on `;`: a seeded pipeline definition holds
		// prose, prose holds semicolons, and a statement split through the middle of one would put
		// `UPDATE agents` and the path literal in different fragments. SQL doubles a quote to escape
		// it, so the literal's own end is unambiguous.
		.replace(/json\('(?:[^']|'')*'\)/g, "json('…')")
		.split(";")
		.filter((s) => /\b(update\s+agents|into\s+agents)\b/i.test(s) && /json_(set|patch)\s*\(/i.test(s));
	return INSTANCE_COPIED_CONFIG_KEYS.filter((k) => onAgents.some((s) => s.includes(`'${k.path}`))).map((k) => k.path);
}

/** The declared record for one key, or undefined if the path is not instance-copied. */
export function instanceCopiedKey(path: string): InstanceCopiedConfigKey | undefined {
	return INSTANCE_COPIED_CONFIG_KEYS.find((k) => k.path === path);
}
