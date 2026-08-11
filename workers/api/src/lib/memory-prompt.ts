/**
 * The `## Your Memory` block — every entry rendered with WHERE it came from and, when it was
 * inferred rather than told, HOW OLD it is (#495).
 *
 * ── What happened
 *
 * An instance carried this, live, four days after it stopped being true:
 *
 *     fact:Write access to terminal connector:is not enabled
 *     "Write access to terminal connector is not enabled Write access to terminal connector"
 *     source: "summary"   updatedAt: 2026-08-10T07:13:25Z
 *
 * It was false 84 seconds after it was written — the same instance's trace shows the write tool
 * `terminal_new_target` succeeding at 06:30:32, having been recorded as blocked at 06:29:08. Three
 * of its five siblings were the same kind of thing: "tmux sessions exist five" (false within the
 * hour), "tmux session creation failed due to write access issue", "User initiated tmux session".
 *
 * The agent read it back (`read_memory`, 07:15:19Z) and eight minutes later told its owner "I just
 * need write access to be enabled on the connector, which based on past attempts has been blocked
 * — you can check that in the Settings tab", without attempting the call. Write consent was
 * granted, and it had already written successfully twice.
 *
 * ── Why the prompt could not resolve it
 *
 * #399 fixed the LIVE half: `connectorToolsPrompt` now renders the resolved verdict, so the same
 * prompt says `[write — consent GRANTED, you may call this]`. What it could not reach was the copy
 * already in durable storage. Both sentences were in the system prompt on every turn, and the
 * memory one carried no date, no provenance beyond the ABSENCE of a `(user-set)` marker, and no
 * statement of which one wins. Two undated contradictory claims is a coin flip.
 *
 * ── The invariant this file exists to make true
 *
 * A summary-derived entry can no longer reach the model undated or unranked. It is not a heuristic
 * about which facts are stale — the platform cannot know that — it is the narrower thing it CAN
 * guarantee: an inference from a past conversation is labelled as one, carries the day it was
 * made, and is explicitly outranked by live tool results and by the status blocks above it. A
 * four-day-old reading then loses to a live one instead of competing with it.
 *
 * ── Why provenance, not a blocklist
 *
 * Deciding by topic — "drop anything about permissions" — needs a vocabulary of state words, and
 * that list rots: it is right about the four entries in this incident and silently wrong about the
 * fifth kind nobody has seen yet. Provenance is already recorded on every row, and `source`
 * answers the question that actually matters: was this TOLD to the agent, or INFERRED by a
 * summariser that had no way to know whether it was reading a durable fact or a momentary one.
 *
 * The complementary half is upstream, in `agent-storage/summaries.ts`: the extraction instruction
 * now excludes the platform's own resolved state as a CLASS. That reduces how many of these get
 * made; this file bounds what any of them can do once made.
 */
import { localStamp } from "./agent-clock.js";
import type { MemoryEntry } from "../agent-types.js";

/** The provenance suffix for one entry. */
function provenance(m: MemoryEntry, now: number, timeZone?: string): string {
	// Told directly by the user: authoritative, protected from agent overwrite, and NOT dated —
	// ageing a standing instruction would invite the agent to treat it as expired.
	if (m.source === "user") return " (user-set)";
	if (m.source !== "summary") return "";
	const stamp = localStamp(m.updatedAt, timeZone);
	const ms = Date.parse(m.updatedAt ?? "");
	const age = Number.isFinite(ms) ? ago(now - ms) : "";
	const when = [stamp, age].filter(Boolean).join(", ");
	return ` (auto-noted from an earlier conversation${when ? ` on ${when}` : ""} — may be out of date)`;
}

/** Round to a human interval. Exact ms in a prompt invites the model to quote it back as precision. */
function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

/**
 * The rule that resolves a contradiction, emitted only when there is a summary-derived entry that
 * could cause one.
 *
 * Unconditional text would be noise on the majority of agents, whose memory is entirely user-set
 * or agent-written; and a rule about entries that are not present is a rule the model has to
 * imagine a use for. Stated in terms of what OUTRANKS what, because the failure was not that the
 * agent distrusted its memory — it was that nothing told it a live tool result should win.
 */
export const STALE_MEMORY_RULE =
	"\nEntries marked auto-noted were INFERRED by a summariser from a past conversation, not told to" +
	" you. They record what seemed true at that moment and nothing since. A live tool result, and any" +
	" status block above (your connected tools and their consent, runner and session state, settings," +
	" deployment), is CURRENT and always outranks them — where they disagree, the live one is right" +
	" and the memory is out of date. Never refuse an action, or tell the user something is disabled," +
	" unavailable or already done, on the strength of an auto-noted entry: check it now instead.";

/**
 * The whole block, or `""` for an agent with no memory.
 *
 * Pure so the wording is testable without a DO. `behaviourStrayPrompt` is appended by the caller
 * rather than here: it is #226's one-time self-heal for entries written before the Behaviour tab
 * existed, which is a migration concern rather than a statement about provenance.
 */
export function memoryPrompt(
	memory: readonly MemoryEntry[],
	opts: { now: number; timeZone?: string } = { now: Date.now() },
): string {
	if (memory.length === 0) return "";
	const lines = memory.map((m) => `- [${m.type}] ${m.key}${provenance(m, opts.now, opts.timeZone)}: ${m.content}`);
	const hasSummary = memory.some((m) => m.source === "summary");
	return (
		"\n\n## Your Memory\n" +
		"To change a fact below, write_memory to its EXACT key; never add a new key for a fact that already has one. " +
		"Entries marked (user-set) were set directly by the user — never overwrite or delete them unless the user explicitly asks.\n" +
		`${lines.join("\n")}\n` +
		(hasSummary ? STALE_MEMORY_RULE : "")
	);
}
