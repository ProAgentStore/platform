/**
 * "Your runner is too old" — said about a NAMED MACHINE (#524).
 *
 * ── What was wrong with the old sentence
 *
 * `repo_find`/`repo_grep` refused three times in 40 minutes with:
 *
 *   > This machine's runner is too old to search this repository — it needs CLI 0.4.49 or newer.
 *   > Run `npm i -g @proagentstore/cli` on that machine and restart `pags up`.
 *
 * The owner had TWO machines connected and had already upgraded one of them. The agent relayed
 * the sentence faithfully (that part worked — it is #517's fix), and it was still unactionable:
 * "that machine" is a phrase a reader resolves to the machine in front of them, which here was
 * the upgraded one that needed nothing. The version was named and the machine was not, and the
 * machine is the part he had to go and find.
 *
 * The pin is not the defect and is not relaxed. `runner-client.ts` refuses to fall through to
 * another node when a pin is set, deliberately — a Repo Coder's checkout lives on ONE machine and
 * searching a different machine's copy returns confidently wrong results, which is worse than a
 * refusal (#379/#380/#461/#500). What is added is that the refusal says which machine, what it is
 * running, that the pin is why, and whether a capable machine exists to repin to.
 *
 * ── Pure, and what "connected" is allowed to mean
 *
 * {@link runnerUpgradeMessage} is a pure function of facts, so the sentence can be asserted
 * without a runner. Reading the facts is {@link runnerUpgradeFacts}, and it is careful about one
 * word: a candidate machine is called CONNECTED only when the relay says it holds a live socket
 * for this instance right now. The `status` column is never cleared on disconnect (#238), so a
 * machine that has been off for months still reads `registered` — offering that as "connected and
 * ready" would be the same class of error this issue is about, one machine over.
 */

import { getRunnerConn } from "./runner-client.js";
import { runtimeConnectivity } from "./instance-connectivity.js";
import { normalizeRunnerNode } from "./runtime-nodes.js";
import type { Env } from "../types.js";

/** How many candidate machines we will probe the relay for. Each probe is a Durable Object fetch. */
const MAX_CANDIDATE_PROBES = 3;

/**
 * Is `version` at least `min`? Dotted numeric comparison; anything unparseable is `false`.
 *
 * Unknown is NOT capable. This decides whether the message will NAME a machine as an alternative,
 * and naming one that turns out to be older is how a dead end becomes a wild goose chase.
 */
export function cliAtLeast(version: string | null | undefined, min: string): boolean {
	const parse = (v: string) => v.trim().replace(/^v/, "").split(".").map((p) => Number.parseInt(p, 10));
	const a = parse(String(version ?? ""));
	const b = parse(min);
	if (!a.length || a.some((n) => !Number.isFinite(n))) return false;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		if (x !== y) return x > y;
	}
	return true;
}

/** A machine that could serve the call, and whether we know it is up RIGHT NOW. */
export interface CapableMachine {
	node: string;
	version: string | null;
	/** A live relay socket for this instance, checked — not a `status` column (#238). */
	connected: boolean;
}

export interface RunnerUpgradeFacts {
	/** What the call was trying to do, in the owner's words: "search this repository". */
	what: string;
	/** The release that first serves it — `REPO_SEARCH_MIN_CLI`, `SWITCH_BRANCH_MIN_CLI`, … */
	minCli: string;
	/** The machine the call actually went to. Null when we could not resolve one. */
	node?: string | null;
	/** What that machine last reported running. Null when it never said. */
	nodeVersion?: string | null;
	/** `config.runnerNode` points at {@link node}, so no other machine will be used. */
	pinned?: boolean;
	/** Another of the owner's machines that meets `minCli`. Null when there is none. */
	alternative?: CapableMachine | null;
}

/**
 * The refusal, with the machine in the FIRST clause.
 *
 * Position is deliberate. #517's finding was that a long remedy gets truncated before the owner
 * sees it, and this message is longer than the one it replaces — so the machine name goes before
 * the version numbers, and `runner-upgrade.test.ts` asserts that a hard cut at 80 characters still
 * carries it. Everything after the first two sentences is elaboration that can be lost.
 */
export function runnerUpgradeMessage(f: RunnerUpgradeFacts): string {
	const node = (f.node || "").trim();
	if (!node) {
		// No resolved machine: the old sentence, unchanged. Inventing a name would be worse than
		// the vagueness — this arm is reachable when the connection was resolved by a path that
		// does not record which node answered.
		return `This machine's runner is too old to ${f.what} — it needs CLI ${f.minCli} or newer. Run \`npm i -g @proagentstore/cli\` on that machine and restart \`pags up\`.`;
	}
	const has = f.nodeVersion ? ` (it has ${f.nodeVersion})` : "";
	const parts = [
		`\`${node}\` needs a newer runner to ${f.what}${has} — this needs CLI ${f.minCli} or newer.`,
		`Run \`npm i -g @proagentstore/cli\` on \`${node}\`, then restart \`pags up\` there.`,
	];
	if (f.pinned) {
		// Without this the owner has no way to DISCOVER the pin from the failure, and the pin is
		// the only reason the machine he already upgraded is not being used.
		parts.push(`This agent is pinned to that machine (Settings → Runs on), so it will not use another one.`);
	}
	const alt = f.alternative;
	if (alt && alt.node !== node) {
		const state = alt.connected
			? `is connected and already runs ${alt.version ?? `CLI ${f.minCli} or newer`}`
			: `last reported ${alt.version ?? `CLI ${f.minCli} or newer`}`;
		parts.push(
			f.pinned
				? `\`${alt.node}\` ${state} — repin this agent there (Settings → Runs on), or upgrade \`${node}\`.`
				: `\`${alt.node}\` ${state}, if you would rather use that machine.`,
		);
	}
	return parts.join(" ");
}

/**
 * The same fact as a CLAUSE, for a caller that embeds it in a sentence of its own.
 *
 * `classifyRunnerError` (repo-policy-act.ts) puts its `detail` inside a work card's sentence, so
 * it cannot take the full message — but it had written the same machine-less remedy, which is
 * what AC4 of #524 is about: "this machine's runner has no switch-branch endpoint". Same rule
 * (name the machine, name the version), different grammar, one module, both asserted.
 */
export function runnerUpgradeClause(f: { what: string; minCli: string; node?: string | null }): string {
	const node = (f.node || "").trim();
	return node
		? `\`${node}\` cannot ${f.what} — it needs CLI ${f.minCli} or newer; run \`npm i -g @proagentstore/cli\` on \`${node}\` and restart \`pags up\` there`
		: `this machine's runner cannot ${f.what} — CLI ${f.minCli} or newer, then restart \`pags up\``;
}

interface NodeRow {
	runner_node: string | null;
	runner_version: string | null;
	last_seen_at: string | null;
}

/**
 * Every machine this user has registered, freshest heartbeat per node.
 *
 * Both tables, for the reason `instance-connectivity.ts` gives: `instance_runtimes` is the legacy
 * single-machine row and `instance_runtime_nodes` is the per-machine one, and reading only one of
 * them under-reports whole accounts. Account-wide rather than per-instance because the machine
 * worth naming may be registered for the owner's OTHER agents — which is exactly the shape of the
 * account in #524, where the upgraded laptop held sockets for fifteen instances and not this one.
 */
async function userNodes(env: Env, userId: string): Promise<NodeRow[]> {
	const res = await env.DB.prepare(
		`SELECT runner_node, runner_version, last_seen_at FROM instance_runtimes WHERE user_id = ?1
		 UNION ALL
		 SELECT runner_node, runner_version, last_seen_at FROM instance_runtime_nodes WHERE user_id = ?1`,
	)
		.bind(userId)
		.all<NodeRow>()
		.catch(() => ({ results: [] as NodeRow[] }));
	const best = new Map<string, NodeRow>();
	const at = (s: string | null) => (s ? Date.parse(`${s.replace(" ", "T")}Z`) || 0 : 0);
	for (const r of res.results ?? []) {
		const node = normalizeRunnerNode(r.runner_node);
		if (!node) continue;
		const prev = best.get(node);
		if (!prev || at(r.last_seen_at) > at(prev.last_seen_at)) best.set(node, { ...r, runner_node: node });
	}
	return [...best.values()];
}

/**
 * Read what the message needs: which machine answered, what it runs, whether a pin holds it there,
 * and whether a capable machine exists.
 *
 * Never throws — a refusal must not become a 500 because a diagnosis query failed. On any failure
 * the caller still gets `{what, minCli}`, which produces the original sentence.
 */
export async function runnerUpgradeFacts(
	env: Env,
	instanceId: string,
	userId: string,
	opts: { what: string; minCli: string },
): Promise<RunnerUpgradeFacts> {
	const base: RunnerUpgradeFacts = { what: opts.what, minCli: opts.minCli };
	try {
		const facts = await runtimeConnectivity(env, instanceId, userId);
		const node = facts.node;
		const out: RunnerUpgradeFacts = {
			...base,
			node,
			nodeVersion: facts.runnerVersion,
			pinned: Boolean(facts.pinnedNode && (!node || facts.pinnedNode === node)),
		};
		const candidates = (await userNodes(env, userId))
			.filter((r) => r.runner_node !== node && cliAtLeast(r.runner_version, opts.minCli))
			// Freshest first: with several capable machines, name the one most likely to be on.
			.sort((a, b) => (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? ""))
			.slice(0, MAX_CANDIDATE_PROBES);
		if (!candidates.length) return out;
		// Liveness is the relay's answer, per (instance, node). A machine registered for this
		// instance can be reported as CONNECTED; one known only from the owner's other agents
		// cannot, and the message says "last reported" for it instead of claiming a socket.
		const live = await Promise.all(
			candidates.map((c) => getRunnerConn(env, instanceId, userId, c.runner_node).catch(() => null)),
		);
		const chosen = candidates.findIndex((_, i) => live[i]);
		const pick = chosen >= 0 ? candidates[chosen] : candidates[0];
		return {
			...out,
			alternative: { node: pick.runner_node ?? "", version: pick.runner_version, connected: chosen >= 0 },
		};
	} catch {
		return base;
	}
}

/**
 * The whole thing, for a call site that has just caught a 404 from a runner.
 *
 * One helper rather than a message per connector: `REPO_SEARCH_MIN_CLI` and
 * `SWITCH_BRANCH_MIN_CLI` had independently written the same unactionable sentence, and a third
 * was going to.
 */
export async function runnerUpgradeRefusal(
	env: Env,
	instanceId: string,
	userId: string,
	opts: { what: string; minCli: string },
): Promise<string> {
	return runnerUpgradeMessage(await runnerUpgradeFacts(env, instanceId, userId, opts));
}
