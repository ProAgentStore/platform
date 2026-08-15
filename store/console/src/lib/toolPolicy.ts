// What the Settings tab SAYS about an agent's tools — the console's half of #351.
//
// The server already resolves the two verdicts (`workers/api/src/lib/instance-tool-policy.ts`,
// exhaustively tested there): `allowed` answers "is this tool part of this agent", and the
// separate `writeConsent` answers "will the consent gate refuse it anyway". Both arrive on every
// row of `GET /v1/instances/:id/tools`.
//
// The console then made three READINGS of that list — the sentence above the switches, the chip
// beside each switch, and the set of write-access checkboxes underneath — and two of them
// disagreed, because each was written where it was rendered:
//
//   • the checkbox set counted a tool as write-capable when `scope === "write"` OR
//     `writeConsent === "per_call"`, which is what #351 fixed so `http_request` — honestly
//     scope:"read", because the CALLER picks the verb — has a switch for the grant its mutating
//     calls are refused for;
//   • the sentence counted only `scope === "write"`.
//
// So an agent whose one tool is `http_request` read: "This agent has no write tools — it can only
// read", directly above a checkbox offering to let it "act as you", with a chip on the very same
// row reading "writes need http access". Three statements, one list, no agreement.
//
// They are here, together, deriving from ONE predicate, so the next reading added is a call rather
// than a fourth opinion. Pure: no fetch, no JSX — the page renders what these return.
//
// ── The second time it went wrong, and what it cost (#584 / #577)
//
// One predicate was not enough, because the sentence above the switches makes claims on THREE
// independent axes and only one field was being read for all of them:
//
//   • does it change anything          → `mutates` (#563)
//   • how far can it reach             → `reach` (#584)
//   • does a connector grant gate it   → `scope` + `writeConsent` (#351)
//
// Measured on the deployed API over all 34 instances of the operator account (2026-08-15):
// TEN were told "…but has no tool that reaches outside the platform" while `fetch_url` was
// `allowed:true` on every one of them — it is in `BASE`, and it takes a caller-chosen `method`
// and `body`. The reach claim was derived from {@link writeConnectors}, i.e. from "does any listed
// tool NAME a connector", which was exactly true while the listing held connector tools and
// nothing else and was falsified by #525 when the connector-less built-ins joined it. In the same
// enumeration ZERO instances rendered the read-only sentence, and `writesOwnData` was asking the
// `mutates` question of the `scope` field (#577).
//
// So the two clauses are now derived from the two facts the server sends for them, and NEITHER is
// derived from `connector`. That word is wrong in both directions: `fetch_url` has no connector
// and reaches the internet, every `supervision` tool has one and never leaves the platform. See
// `workers/api/src/lib/tool-reach.ts` for what reach means and why `tier`, `scope` and `mutates`
// were each measured and rejected as a proxy for it.
//
// The rule this file keeps, one layer up from any of them: **a sentence may not assert a negative
// it cannot derive.** Where the server has not sent the fact, say what the agent HAS and stop.

/** Mirrors ToolWriteConsent in workers/api/src/lib/instance-tool-policy.ts. */
export type ToolWriteConsent = "n/a" | "granted" | "required" | "per_call";

/** Mirrors ToolReach in workers/api/src/lib/tool-reach.ts — where a call to the tool LANDS. */
export type ToolReach = "platform" | "machine" | "internet";

/** One row of `GET /v1/instances/:id/tools`, as the console reads it. */
export interface ToolPolicyEntry {
	name: string;
	connector?: string;
	scope: "read" | "write";
	/**
	 * Does a call change anything (#563)? Mirrored because this row mirrors the wire, and because
	 * an incomplete mirror is how the console ends up re-deriving a fact the server already sent.
	 *
	 * It IS what the summary's change claim is derived from, since #577 — the previous note here
	 * said the opposite, on the grounds that `mutates` is "anywhere" while the own-data sentence
	 * asks the narrower "this agent's data". That was the right objection to the wrong fix: the
	 * narrowing wanted is a REACH narrowing, so it comes from {@link ToolPolicyEntry.reach}, and
	 * `scope` was never able to supply it (`start_work`, `run_pipeline` and seven others are
	 * `scope:"read"` and change things).
	 *
	 * Optional so an older API's response still typechecks; absent, {@link changesAnything} falls
	 * back to the pre-#563 predicate rather than guessing.
	 */
	mutates?: boolean;
	description: string;
	allowed: boolean;
	disabled: boolean;
	reason: "ok" | "not_declared" | "disabled_by_owner";
	writeConsent?: ToolWriteConsent;
	/** Catalog group (#525): `base` is a universal facility, `connector` reaches another system. */
	tier?: "base" | "standard" | "runtime" | "connector";
	/**
	 * How far a call to this tool can get (#584): the platform's own storage, the owner's machine,
	 * or a third-party system. The fact the reach claim is made from, sent by the server because
	 * it is the server that knows it — `tier` cannot answer it (`fetch_url` and `write_memory` are
	 * both `base`) and neither can `connector`.
	 *
	 * Optional for the same reason `mutates` is: an older API does not send it. Absent, the
	 * summary makes NO reach claim rather than falling back to the proxy that produced #584.
	 */
	reach?: ToolReach;
	/** Surfaces that can reach it (#525). A built-in tool is `["chat"]` — the agent's own loop. */
	invocableBy?: readonly ("chat" | "call_instance_tool")[];
}

/**
 * The rows the tab lists: what this agent HAS, whether or not the owner has it switched on.
 *
 * `allowed || disabled` rather than `allowed`, because the two are the on and off positions of the
 * same switch — a tool the owner turned off is still one of this agent's tools, and it has to stay
 * on screen or there is nothing to turn back on. Everything else in the registry is `not_declared`
 * and belongs to some other agent.
 */
export function listedTools(policy: readonly ToolPolicyEntry[]): ToolPolicyEntry[] {
	return policy.filter((t) => t.allowed || t.disabled);
}

/**
 * Will the write-consent gate ever ask for this tool's connector to be granted?
 *
 * `scope` alone is not the question. A tool is scope:"read" when the tool itself does not choose
 * to write, which is exactly true of `http_request` (the caller names the method) and exactly
 * irrelevant to the person deciding whether to hand the agent a grant. `per_call` is the server
 * saying "this one is decided at call time" — i.e. it CAN write, subject to a gate. Both belong on
 * the same side of that decision.
 *
 * #577 asked whether this should move to `mutates` too, and the answer is NO — deliberately, not
 * by omission. This predicate feeds exactly one thing: which connectors get a write-access
 * checkbox. That is a question about the GATE, and `scope` + `writeConsent` are the gate's own
 * inputs (`writeConsentOf`, server side). `mutates` answers a different question and would put a
 * checkbox under a tool the gate never consults — a control that grants nothing, which is worse
 * than no control, and the mirror of the "switch that does nothing" #351 removed.
 *
 * The consistency #577 was reaching for is real and is now kept where it belongs: `fetch_url` and
 * `http_request` are the same shape (the caller names the verb) and the SENTENCE treats them
 * identically, because it reads `mutates` — which `mutatesBuiltin` derives from that same shape so
 * the two cannot drift. They differ here only in whether a connector exists to be granted, which
 * is the honest difference between them.
 */
export function mayWrite(t: ToolPolicyEntry): boolean {
	return t.scope === "write" || t.writeConsent === "per_call";
}

/**
 * Does a call to this tool change anything — anywhere?
 *
 * `mutates` when the server sends it (#563). When it does not — an older API — this falls back to
 * {@link mayWrite}, i.e. to exactly the pre-#563 behaviour, rather than to a guess.
 *
 * `|| mayWrite(t)` is not redundant on a modern response: it keeps this predicate from ever
 * contradicting the checkbox set. A row that somehow arrived `mutates:false` with a write gate on
 * it would otherwise let the read-only sentence render directly above a control offering to let
 * the agent act as you, which is the exact defect this module was created for.
 */
export function changesAnything(t: ToolPolicyEntry): boolean {
	return t.mutates === true || mayWrite(t);
}

/**
 * The connectors that get a write-access checkbox: every connector named by a write-capable tool
 * this agent has.
 *
 * Read off the server's own verdict rather than re-derived from tool names — the gate and the UI
 * must not be able to disagree about which grant a refusal is asking for. Stable under the tool
 * switches above it, because `listedTools` is: switching a tool off must not remove the grant
 * control for it, or turning it back on would silently re-arm an access the owner can no longer see.
 */
export function writeConnectors(policy: readonly ToolPolicyEntry[]): string[] {
	const out = new Set<string>();
	for (const t of listedTools(policy)) if (t.connector && mayWrite(t)) out.add(t.connector);
	return [...out];
}

/**
 * The tools this agent holds that leave the platform — reaching the owner's own machine, or a
 * third-party system.
 *
 * Reaching, not changing: a read that leaves is the question an owner is actually asking above the
 * tool switches, because it is the one that decides what goes in the knowledge base. `web_search`
 * changes nothing and takes whatever it is given to Google.
 *
 * Rows whose `reach` the server did not send are excluded: an unknown reach is not evidence of
 * one. {@link toolScopeSummary} handles that case separately rather than counting it either way.
 */
export function reachesOutside(policy: readonly ToolPolicyEntry[]): ToolPolicyEntry[] {
	return listedTools(policy).filter((t) => t.reach !== undefined && t.reach !== "platform");
}

/**
 * Does this agent hold a change that stays INSIDE the platform — its memory, tasks, board, files,
 * records?
 *
 * A separate question from {@link reachesOutside}, and #577's: it used to read `scope === "write"
 * && !connector`, which asked the `mutates` question of the write-consent field. `scope` is
 * `"read"` on nine tools that change things (`start_work`, `stop_work`, `end_coding_session`,
 * `set_behaviour`, `set_stats_card`, `run_pipeline`, `record_feedback`, `create_ticket`,
 * `dedupe_upsert`) because they have no connector to consent to — so an agent holding only those
 * was described as unable to change anything. It never rendered, because `BASE` always supplies
 * `write_memory`; "correct by an invariant nobody declared" is not correct.
 *
 * The `!connector` half is replaced by `reach`, not dropped: "has no connector" was standing in
 * for "stays on the platform", and every `supervision` tool has a connector and stays.
 */
export function writesOwnData(policy: readonly ToolPolicyEntry[]): boolean {
	return listedTools(policy).some((t) => changesAnything(t) && t.reach === "platform");
}

/** How to say a set of reaches out loud. Plural-safe, and it never names a reach nothing has. */
function reachWords(tools: readonly ToolPolicyEntry[]): string {
	const machine = tools.some((t) => t.reach === "machine");
	const internet = tools.some((t) => t.reach === "internet");
	if (machine && internet) return "your own computer, and other systems";
	return machine ? "your own computer" : "other systems";
}

/**
 * The sentence above the switches. Leading space: it is appended to the paragraph before it.
 *
 * Two independent axes, answered in the order an owner cares about them: **how far does it go**,
 * then **what can it change**. Reach leads, because the sentence is read while deciding what to
 * put in an agent's knowledge base, and a tool that only READS is still a tool that can carry that
 * knowledge to Google.
 *
 * The negative claims are what this function keeps getting wrong, so each is made only where the
 * fact that answers it arrived:
 *
 *   • "no tool that reaches outside the platform" (#584) needs every listed row to have SAID
 *     `reach:"platform"`. It used to be inferred from "no listed tool names a connector", and ten
 *     of this account's 34 instances rendered it over a switched-on `fetch_url`. The wording is
 *     unchanged on purpose: the sentence was always the right thing to tell an owner, and what
 *     was missing was any field that could support it.
 *   • "no tools that can change anything" (#525/#577) needs every listed row to be a read. It is
 *     also guarded by {@link changesAnything}, which folds in {@link mayWrite}, so it can never
 *     render above a write-access checkbox.
 *
 * The last branch is the one with no reach claim at all: an older API sends no `reach`, so the
 * honest sentence there states what the agent has and stops.
 */
export function toolScopeSummary(policy: readonly ToolPolicyEntry[]): string {
	const listed = listedTools(policy);
	const changing = listed.filter(changesAnything);
	// The grant clause belongs to whichever sentence renders — it is about the CONTROLS below, not
	// about reach, and #351's checkbox set (writeConnectors) stays its only source. A `supervision`
	// tool is why the two must stay separate: it needs granting and never leaves the platform.
	const grants = writeConnectors(policy).length > 0 ? " Each one behind a connector also needs it granted below." : "";
	const outward = reachesOutside(policy);
	if (outward.length > 0) {
		const where = reachWords(outward);
		if (outward.some(changesAnything)) {
			return ` This agent has tools that reach outside the platform — ${where} — and can change things there.${grants}`;
		}
		// It leaves the platform but only reads out there. The own-data half still has to be said:
		// an agent that writes its own memory and reads your machine is not "read-only", and a
		// sentence ending "can only read there" is read as if it were.
		return changing.length > 0
			? ` This agent can change its own data — its memory, tasks and stored documents — and can read from outside the platform — ${where} — but changes nothing there.${grants}`
			: ` This agent has tools that reach outside the platform — ${where} — but can only read there.${grants}`;
	}
	// EVERY listed row, not just the changing ones: with `outward` empty, an unstated reach is the
	// only thing left that could make the negative false, and it is exactly the row that would.
	const allPlatform = listed.every((t) => t.reach === "platform");
	if (changing.length === 0) {
		return allPlatform
			? " This agent has no tools that can change anything and none that reach outside the platform — it can only read."
			: " This agent has no tools that can change anything — it can only read.";
	}
	if (allPlatform) {
		return " This agent can change its own data — its memory, tasks and stored documents — but has no tool that reaches outside the platform.";
	}
	return ` This agent has tools that can change things.${grants}`;
}

/**
 * The consent state as a short chip, or null when nothing is in the way.
 *
 * Amber, not red, wherever this renders: an ungranted write tool is a switch the owner has not
 * flipped yet, not a fault. Null for a tool that is already refused for a reason the row states —
 * two explanations for one disabled switch is worse than one.
 */
export function consentChip(t: ToolPolicyEntry): string | null {
	if (!t.allowed) return null;
	if (t.writeConsent === "required") return `needs ${t.connector ?? "connector"} write access`;
	if (t.writeConsent === "per_call") {
		// MCP names its remote system at call time, so the connector row is only the outer gate and
		// the real reach is per (server, tool). Saying "needs mcp access" would point at a checkbox
		// that is already ticked.
		return t.connector === "mcp" ? "granted per server + tool" : `writes need ${t.connector ?? "connector"} access`;
	}
	return null;
}
