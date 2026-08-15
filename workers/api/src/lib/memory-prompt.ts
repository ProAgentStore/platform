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
	// …and, when the two differ, how long it has been BELIEVED as well as when it was last
	// restated. An entry carried for two weeks and re-extracted yesterday reads one day old on
	// `updatedAt` alone, which is the shape the incident entry had.
	const firstMs = Date.parse(m.firstSeenAt ?? "");
	const first =
		Number.isFinite(firstMs) && Math.abs(firstMs - ms) >= DAY ? `, first noted ${localStamp(m.firstSeenAt, timeZone)}` : "";
	return ` (auto-noted from an earlier conversation${when ? ` on ${when}` : ""}${first} — may be out of date)`;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * How long a summary-derived entry keeps being injected after its last restatement.
 *
 * Measured, not chosen by habit (#495's decision brief, over live memory dumps from four instances):
 * a durable subject on an active instance is re-extracted within ~2 days, at the tail 5.9; the junk
 * this bounds is write-once and never comes back — "tmux sessions exist five", false within the
 * hour, never restated. Seven days is the smallest round number above that measured tail.
 *
 * Keyed on the LAST RESTATEMENT (`updatedAt`), not on `firstSeenAt`. The brief recommended
 * `firstSeenAt` because `updatedAt` is defeated by an agent that keeps repeating its own stale
 * belief — which is true, and is why `firstSeenAt` is recorded and rendered. But keying the cutoff
 * on it retires a fact that is being re-confirmed every other day, permanently and silently: the
 * same summariser produced `fact:commit-strategy … Always push to main`, a real standing preference
 * of the owner's, and no amount of restating it would bring it back. The issue's own words are
 * "drop them from injection after N days UNLESS RE-CONFIRMED", and that is what `updatedAt` means.
 * The self-restatement loop is closed at the reader instead — STALE_MEMORY_RULE and the first-noted
 * stamp are what stop the agent repeating it in the first place.
 */
export const SUMMARY_MEMORY_TTL_DAYS = 7;

/**
 * How many summary-derived entries may be injected at once, newest restatement first.
 *
 * The TTL alone does not bound the days that actually cost anything: the growth is BURST-shaped —
 * 61 of one instance's 75 inferred facts were written on a single day, because `SUMMARY_THRESHOLD`
 * is 20 messages and `maybeSummarize` runs after every assistant reply, each summary writing up to
 * 20 facts. Measured on that instance, a TTL of 7 dropped everything today and would have dropped
 * NOTHING on the day the block was at its worst; a cap of 30 takes it from ~4,981 tokens per turn
 * to ~2,242 every day.
 *
 * User- and agent-written entries are never counted and never dropped — this bounds inference, not
 * memory.
 */
export const SUMMARY_MEMORY_CAP = 30;

/** Last restatement, as a number; `-Infinity` for an unparseable date so it sorts oldest. */
function restatedAt(m: MemoryEntry): number {
	const ms = Date.parse(m.updatedAt ?? "");
	return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * Which entries reach the prompt, and how many were withheld.
 *
 * UN-INJECTED, NEVER DELETED — the owner's stated preference and the right one. The same generator
 * that produced "tmux sessions exist five" produced a real standing preference; deletion is the
 * lossy answer to a provenance problem, and the console Memory tab already offers a one-click
 * promotion (editing an entry re-tags it `source:"user"`, which makes it undated, protected and
 * permanently injected). `read_memory` still returns everything, so nothing here is unreachable —
 * it is unrepeated.
 */
export function selectMemoryForPrompt(
	memory: readonly MemoryEntry[],
	now: number,
): { shown: MemoryEntry[]; withheld: number } {
	const cutoff = now - SUMMARY_MEMORY_TTL_DAYS * DAY;
	// An UNDATED legacy entry is not expired — it is unmeasured, and dropping it would be a decision
	// made by a parse failure rather than by evidence. It still sorts last under the cap, and it
	// still carries the "auto-noted" label, which is the part that must never be lost.
	const fresh = memory.filter((m) => m.source !== "summary" || restatedAt(m) === Number.NEGATIVE_INFINITY || restatedAt(m) >= cutoff);
	const inferred = fresh.filter((m) => m.source === "summary").sort((a, b) => restatedAt(b) - restatedAt(a));
	const keep = new Set(inferred.slice(0, SUMMARY_MEMORY_CAP));
	// Original order preserved for everything kept: the block is read by a model, and re-sorting it
	// by recency would imply a ranking the platform is not making.
	const shown = memory.filter((m) => m.source !== "summary" || keep.has(m));
	return { shown, withheld: memory.length - shown.length };
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
	const { shown, withheld } = selectMemoryForPrompt(memory, opts.now);
	if (shown.length === 0 && withheld === 0) return "";
	const lines = shown.map((m) => `- [${m.type}] ${m.key}${provenance(m, opts.now, opts.timeZone)}: ${m.content}`);
	const hasSummary = shown.some((m) => m.source === "summary");
	// Said out loud, because a list the model believes is complete is a list it will answer from.
	// It also names the one tool that still reaches them, so "not repeated to you" cannot be read as
	// "gone" — read_memory returns every entry, un-injected or not.
	const cut = withheld
		? `\n(${withheld} older auto-noted ${withheld === 1 ? "entry is" : "entries are"} not repeated here — they are still in your memory and read_memory returns them.)\n`
		: "";
	return (
		"\n\n## Your Memory\n" +
		"To change a fact below, write_memory to its EXACT key; never add a new key for a fact that already has one. " +
		"Entries marked (user-set) were set directly by the user — never overwrite or delete them unless the user explicitly asks.\n" +
		`${lines.join("\n")}\n` +
		cut +
		(hasSummary ? STALE_MEMORY_RULE : "")
	);
}
