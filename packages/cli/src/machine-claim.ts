// "Is this machine also known as…?" — the first-run claim prompt (#460).
//
// ── The gap this closes
//
// #379 gave a machine a stable id and #393 taught the console to fold by it. Both work, and on the
// account they were built for they healed nothing, because the name history starts at UPGRADE
// time: a fresh `machine.json` holds `{ id, names: [<current hostname>] }`, so `claimMachineNames`
// stamps exactly one row. The rows minted under names the laptop wore BEFORE it had an id can
// never be claimed by anything — and six agents were pinned to one of them, answering every call
// with "run `pags up`" while `pags up` was running.
//
// The documented recovery was: upgrade the CLI, open `~/.config/proagentstore/machine.json` in an
// editor, type the other hostnames in by hand, restart. That editor step is the product gap, and
// it is the only step that matters.
//
// ── Why the machine asks instead of guessing
//
// The server cannot answer this and neither can the console: neither is ON the machine. The CLI is,
// which is what makes its answer evidence rather than a heuristic — but only if a human confirms
// it. Every automatic rule considered was rejected for the same reason: `RLs-MacBook-Air` and
// `RLs-MacBook-Air.local` LOOK like one machine, and a rule that says so also merges two laptops an
// admin named consistently. Same for MAC address, serial, and same-public-IP (a household NAT makes
// two laptops indistinguishable). A wrong merge moves another machine's sessions and pins, and
// nothing un-stamps a claimed row — so the guarantee #379 exists to provide is that we fail closed.
//
// Three narrowings do the safety work here, and none of them is a guess:
//   - a name already carrying a machineId is another machine's PROVEN identity — never offered;
//   - a name whose relay socket is UP right now is a machine that is running, which this one is not
//     yet — never offered;
//   - nothing is pre-selected, and Enter means no.
//
// None of those three is a completeness claim. A second machine that is merely asleep IS still
// offered, because nothing on this side can tell it from a name this laptop used last month — and
// that is the point: the list is a question, and the only thing that claims a name is a human
// typing its number.
//
// ── Why it can never block a runner
//
// `pags up` is the entry point for EVERY runtime agent, so a prompt that waits on a machine with no
// keyboard takes the whole runtime offline. The gate is therefore checked BEFORE any network call:
// `--headless`, a non-TTY stdin, `CI`, or `PAGS_NO_PROMPT` return without fetching anything at all.
// `claimPromptSkipReason` is pure and tested for exactly that, because "it did not hang" is not
// something a reader can see by looking at an async function.
import { writeLine } from "./output.js";
import {
	loadMachineIdentity,
	machineFilePath,
	type MachineIdentity,
	saveMachineIdentity,
	withClaimedNames,
	withDeclinedNames,
} from "./machine.js";

/** One machine as `GET /v1/terminals/nodes` reports it, reduced to the claim question. */
export interface NodeSummary {
	node: string;
	/** null = no machine has claimed this name. Non-null = it is already someone's identity. */
	machineId: string | null;
	lastSeenAt: string | null;
	connected: boolean;
	/** How many agents that name serves — the number that makes "16 agents" recognisable. */
	agentCount: number;
}

/** Why no prompt was shown, or how it was answered. */
export type ClaimSkipReason = "headless" | "no-tty" | "ci" | "suppressed";
export type ClaimOutcome =
	| { prompted: false; reason: ClaimSkipReason | "no-identity" | "unavailable" | "nothing-unclaimed" | "unanswered" }
	| { prompted: true; reason: "claimed" | "declined"; claimed: string[]; declined: string[] };

export interface PromptGate {
	headless?: boolean;
	/** `process.stdin.isTTY` — undefined/false when stdin is a pipe, a closed fd, or a service. */
	isTTY?: boolean | undefined;
	ci?: boolean;
	suppressed?: boolean;
}

/**
 * Whether a prompt may be shown at all — null when it may, otherwise the reason it may not.
 *
 * Pure, and checked before anything else happens, so an ungated path cannot acquire a network call
 * or a readline by accident.
 */
export function claimPromptSkipReason(gate: PromptGate): ClaimSkipReason | null {
	if (gate.headless) return "headless";
	if (gate.suppressed) return "suppressed";
	if (gate.ci) return "ci";
	if (!gate.isTTY) return "no-tty";
	return null;
}

/** D1 writes `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker; `Date.parse` would read it local. */
export function stampMs(value: string | null | undefined): number {
	if (!value) return 0;
	const t = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
	return Number.isFinite(t) ? t : 0;
}

/** Read the node list out of an unknown API body. Anything malformed is simply no candidates. */
export function parseNodesResponse(data: unknown): NodeSummary[] {
	const nodes = (data as { nodes?: unknown } | null)?.nodes;
	if (!Array.isArray(nodes)) return [];
	const out: NodeSummary[] = [];
	for (const raw of nodes) {
		const n = raw as Record<string, unknown>;
		const node = typeof n?.node === "string" ? n.node.trim() : "";
		if (!node) continue;
		out.push({
			node,
			machineId: typeof n.machineId === "string" && n.machineId.trim() ? n.machineId.trim() : null,
			lastSeenAt: typeof n.lastSeenAt === "string" ? n.lastSeenAt : null,
			connected: n.connected === true,
			agentCount: Array.isArray(n.instances) ? n.instances.length : 0,
		});
	}
	return out;
}

/**
 * The names it is safe to OFFER, freshest first.
 *
 * Every filter here is a refusal, never an inference — the list only ever gets shorter than what
 * the server returned, and a name that survives is still not claimed until a human types its
 * number.
 */
export function claimCandidates(nodes: readonly NodeSummary[], identity: MachineIdentity): NodeSummary[] {
	const mine = new Set(identity.names);
	const declined = new Set(identity.declined ?? []);
	const seen = new Set<string>();
	const out: NodeSummary[] = [];
	for (const n of nodes) {
		const name = n.node.trim();
		if (!name || seen.has(name)) continue;
		// Already someone's proven identity. Claiming it would be a merge of two identified
		// machines, which is the one thing the whole mechanism exists to make impossible.
		if (n.machineId) continue;
		// Already ours — it is claimed by the next register with no question asked.
		if (mine.has(name)) continue;
		// Asked once, answered no.
		if (declined.has(name)) continue;
		// A live socket right now is a machine that is up. This one is not: `pags up` has not
		// registered yet when the question is asked. So a connected name is evidence of a DIFFERENT
		// machine, and it is the most expensive wrong answer available.
		if (n.connected) continue;
		seen.add(name);
		out.push(n);
	}
	return out.sort((a, b) => stampMs(b.lastSeenAt) - stampMs(a.lastSeenAt));
}

/**
 * Resolve names the user named EXPLICITLY (`pags machines claim <name…>`) against the account.
 *
 * The same three refusals as the prompt, minus the decline filter: naming a machine on the command
 * line IS a later answer than an earlier "no", and `withClaimedNames` clears the decline. A refusal
 * is reported rather than dropped — a claim that silently did nothing is how this defect class
 * started.
 */
export function resolveClaimByName(
	requested: readonly string[],
	nodes: readonly NodeSummary[],
	identity: MachineIdentity,
): { claim: string[]; problems: string[] } {
	const byName = new Map(nodes.map((n) => [n.node, n]));
	const claim: string[] = [];
	const problems: string[] = [];
	for (const raw of requested) {
		const name = raw.trim();
		if (!name || claim.includes(name)) continue;
		if (identity.names.includes(name)) {
			problems.push(`${name}: this machine already claims that name.`);
			continue;
		}
		const node = byName.get(name);
		if (!node) {
			problems.push(`${name}: no machine on this account is registered under that name.`);
			continue;
		}
		if (node.machineId) {
			problems.push(`${name}: already claimed by another machine (${node.machineId}).`);
			continue;
		}
		if (node.connected) {
			problems.push(`${name}: a runner is connected there right now, so it is a different machine. Stop it first if it is not.`);
			continue;
		}
		claim.push(name);
	}
	return { claim, problems };
}

/** "2 days ago" — coarse on purpose; the point is recognition, not precision. */
export function relativeAge(lastSeenAt: string | null | undefined, nowMs: number): string {
	const at = stampMs(lastSeenAt);
	if (!at) return "last seen unknown";
	const mins = Math.max(0, Math.round((nowMs - at) / 60_000));
	if (mins < 60) return `last seen ${mins} min ago`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `last seen ${hours} hour${hours === 1 ? "" : "s"} ago`;
	const days = Math.round(hours / 24);
	if (days < 45) return `last seen ${days} days ago`;
	return `last seen ${Math.round(days / 30)} months ago`;
}

/** The one-line description of a candidate, after its number. */
export function describeCandidate(candidate: NodeSummary, nowMs: number): string {
	const agents = `${candidate.agentCount} agent${candidate.agentCount === 1 ? "" : "s"}`;
	return `${relativeAge(candidate.lastSeenAt, nowMs)} · ${agents}`;
}

export type Selection =
	| { kind: "skip" }
	| { kind: "pick"; indices: number[] }
	| { kind: "invalid"; message: string };

/**
 * What the user typed, as a decision.
 *
 * Empty (a bare Enter) is SKIP, which is why the prompt can be dismissed without reading it.
 * Anything unrecognised is `invalid` rather than skip: silently treating "1;2" as "no" would
 * record a decline the user did not make, and a decline is remembered.
 */
export function parseSelection(input: string, count: number): Selection {
	const raw = input.trim().toLowerCase();
	if (!raw || raw === "n" || raw === "no" || raw === "s" || raw === "skip" || raw === "none") return { kind: "skip" };
	if (raw === "a" || raw === "all") return { kind: "pick", indices: Array.from({ length: count }, (_, i) => i) };
	const parts = raw.split(/[\s,]+/).filter(Boolean);
	const indices: number[] = [];
	for (const part of parts) {
		if (!/^\d+$/.test(part)) return { kind: "invalid", message: `"${part}" is not a number.` };
		const n = Number.parseInt(part, 10);
		if (n < 1 || n > count) return { kind: "invalid", message: `${n} is not on the list (1–${count}).` };
		if (!indices.includes(n - 1)) indices.push(n - 1);
	}
	return indices.length ? { kind: "pick", indices } : { kind: "skip" };
}

/** The block of text the prompt prints. Pure so the wording is testable without a terminal. */
export function renderCandidates(candidates: readonly NodeSummary[], nowMs: number): string[] {
	const width = candidates.reduce((w, c) => Math.max(w, c.node.length), 0);
	const lines = [
		`PAGS knows ${candidates.length} machine name${candidates.length === 1 ? "" : "s"} on this account that no machine has claimed.`,
		"Is this machine also known as:",
		"",
	];
	candidates.forEach((c, i) => {
		lines.push(`  ${i + 1}) ${c.node.padEnd(width)}   ${describeCandidate(c, nowMs)}`);
	});
	lines.push("");
	lines.push("Selecting a name merges its agents, pins and sessions onto this machine.");
	lines.push("Pick only names THIS machine has used — use `pags machines unclaim <name>` to undo a wrong claim.");
	return lines;
}

/** Fetch the account's machines. Time-bounded and never throws: this is a nicety on a startup
 *  path, so an API that is slow or down costs the offer, never the runner. */
export async function fetchNodeSummaries(opts: {
	token: string;
	apiBase: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): Promise<NodeSummary[] | null> {
	const doFetch = opts.fetchImpl ?? fetch;
	try {
		const res = await doFetch(`${opts.apiBase.replace(/\/$/, "")}/v1/terminals/nodes`, {
			headers: { Authorization: `Bearer ${opts.token}` },
			signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
		});
		if (!res.ok) return null;
		return parseNodesResponse(await res.json());
	} catch {
		return null;
	}
}

export interface ClaimOptions {
	token: string;
	apiBase: string;
	headless?: boolean;
	/** Injected for tests; defaults to a readline question on stdin. */
	ask?: (question: string) => Promise<string>;
	fetchImpl?: typeof fetch;
	now?: number;
	isTTY?: boolean | undefined;
	env?: NodeJS.ProcessEnv;
}

/**
 * Offer the account's unclaimed machine names, once, and record the answer (#460).
 *
 * Called from `pags up` before the runner child is spawned, so a claim is already in
 * `machine.json` by the time the child registers and `claimMachineNames` stamps the rows.
 * It resolves — never rejects — for every failure mode there is.
 */
export async function maybeClaimMachineNames(opts: ClaimOptions): Promise<ClaimOutcome> {
	const env = opts.env ?? process.env;
	const skip = claimPromptSkipReason({
		headless: opts.headless,
		isTTY: opts.isTTY ?? process.stdin.isTTY,
		ci: !!env.CI,
		suppressed: !!env.PAGS_NO_PROMPT,
	});
	if (skip) return { prompted: false, reason: skip };

	const identity = loadMachineIdentity();
	// No id means no claim: `claimMachineNames` ignores an empty machineId, so anything recorded
	// here would be a promise the register call cannot keep.
	if (!identity.id) return { prompted: false, reason: "no-identity" };

	const nodes = await fetchNodeSummaries(opts);
	if (!nodes) return { prompted: false, reason: "unavailable" };
	const candidates = claimCandidates(nodes, identity);
	if (!candidates.length) return { prompted: false, reason: "nothing-unclaimed" };

	const nowMs = opts.now ?? Date.now();
	writeLine("");
	for (const line of renderCandidates(candidates, nowMs)) writeLine(`  ${line}`);
	writeLine("");

	const ask = opts.ask ?? defaultAsk;
	let selection: Selection = { kind: "skip" };
	// Two attempts, then treat it as a skip. A parse loop with no bound is a hang with extra steps.
	for (let attempt = 0; attempt < 2; attempt++) {
		let answer = "";
		try {
			answer = await ask("  Numbers to claim (e.g. 1,2 or all), or Enter to skip: ");
		} catch {
			// The terminal went away mid-question (Ctrl+C, a closed pipe). Nothing is recorded —
			// an interrupted question is not an answer, and a decline is remembered.
			return { prompted: false, reason: "no-tty" };
		}
		selection = parseSelection(answer, candidates.length);
		if (selection.kind !== "invalid") break;
		writeLine(`  ${selection.message} Enter to skip.`);
	}
	if (selection.kind === "invalid") {
		// Two unreadable answers is a fumbled syntax, not a decline. Recording one would burn the
		// offer permanently on a typo, and this offer IS the remedy — so nothing is written and the
		// question survives to the next launch. Bounded at two reads, so it is not a hang either.
		writeLine("  Nothing claimed — run `pags machines claim <name>` when you know which.");
		writeLine("");
		return { prompted: false, reason: "unanswered" };
	}

	const names = candidates.map((c) => c.node);
	if (selection.kind !== "pick") {
		saveMachineIdentity(withDeclinedNames(identity, names));
		writeLine(`  Skipped — these names will not be offered again (${machineFilePath()}).`);
		writeLine("");
		return { prompted: true, reason: "declined", claimed: [], declined: names };
	}

	const claimed = selection.indices.map((i) => names[i]);
	const rest = names.filter((n) => !claimed.includes(n));
	// The names NOT picked are declined in the same write: the user has now answered about all of
	// them, and re-offering the ones they left would be the interrogation this is meant to end.
	saveMachineIdentity(withDeclinedNames(withClaimedNames(identity, claimed), rest));
	writeLine(`  Claiming ${claimed.join(", ")} — merged on the next register.`);
	writeLine("");
	return { prompted: true, reason: "claimed", claimed, declined: rest };
}

/** A one-shot readline question. Imported lazily so nothing is touched on a gated path. */
async function defaultAsk(question: string): Promise<string> {
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		// A stdin that ENDS must end the question, not leave it pending: `rl.question()` does not
		// settle when its stream closes, and an unsettled promise on this path is `pags up` never
		// starting — the outage the whole gate above exists to prevent, arriving one layer lower.
		const closed = new Promise<string>((resolve) => rl.once("close", () => resolve("")));
		return await Promise.race([rl.question(question), closed]);
	} finally {
		rl.close();
	}
}
