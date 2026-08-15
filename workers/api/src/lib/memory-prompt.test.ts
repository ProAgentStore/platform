/**
 * #495 — a summary-derived belief can no longer reach the model undated or unranked.
 *
 * The fixtures below are the REAL entries read off instance cda75e28 (agent `tmux-operator`), all
 * six of them `source:"summary"`. The first was false 84 seconds after it was written and was
 * still being injected on every turn four days later, alongside `[write — consent GRANTED, you may
 * call this]` from the same prompt. #399 fixed the live label; nothing could reach the copy in
 * durable storage.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "../agent-types.js";
import { STALE_MEMORY_RULE, memoryPrompt } from "./memory-prompt.js";

const NOW = Date.parse("2026-08-11T00:00:00Z");

/** The entry that caused the refusal, exactly as stored. */
const WRITE_ACCESS: MemoryEntry = {
	key: "fact:Write access to terminal connector:is not enabled",
	type: "knowledge",
	content: "Write access to terminal connector is not enabled Write access to terminal connector",
	updatedAt: "2026-08-10T07:13:25Z",
	source: "summary",
};
const TMUX_SESSIONS: MemoryEntry = {
	key: "fact:tmux sessions:exist",
	type: "knowledge",
	content: "tmux sessions exist five",
	updatedAt: "2026-08-07T06:29:08Z",
	source: "summary",
};
const USER_SET: MemoryEntry = {
	key: "preference:tone",
	type: "preference",
	content: "Keep it short",
	updatedAt: "2026-08-01T00:00:00Z",
	source: "user",
};
const AGENT_SET: MemoryEntry = {
	key: "fact:commit-strategy",
	type: "knowledge",
	content: "Always push to main",
	updatedAt: "2026-08-10T10:30:54Z",
	source: "agent",
};

describe("#495 — a summary-derived entry cannot reach the model undated", () => {
	it("labels it as inferred, not told", () => {
		const block = memoryPrompt([WRITE_ACCESS], { now: NOW });
		expect(block).toContain("auto-noted from an earlier conversation");
		expect(block).toContain("may be out of date");
	});

	it("carries its age — the whole of what was missing", () => {
		// The old renderer emitted `- [knowledge] {key}: {content}` and nothing else. Four days of
		// staleness were invisible, so the entry competed with the live consent label on equal terms.
		const block = memoryPrompt([TMUX_SESSIONS], { now: NOW });
		expect(block).toContain("4d ago");
	});

	it("dates EVERY summary entry, not just the ones a test happens to name", () => {
		// The invariant, structurally: the platform cannot know which inferences are stale, so it
		// guarantees the narrower thing — none of them arrives without its provenance and its age.
		const many: MemoryEntry[] = [WRITE_ACCESS, TMUX_SESSIONS, { ...WRITE_ACCESS, key: "fact:x:y" }];
		const lines = memoryPrompt(many, { now: NOW }).split("\n").filter((l) => l.startsWith("- "));
		expect(lines).toHaveLength(3);
		for (const line of lines) expect(line).toContain("auto-noted from an earlier conversation");
	});

	it("states the absolute date in the owner's zone, not an ISO string", () => {
		const block = memoryPrompt([WRITE_ACCESS], { now: NOW, timeZone: "Australia/Sydney" });
		expect(block).not.toContain("2026-08-10T07:13:25Z");
		expect(block).toMatch(/auto-noted from an earlier conversation on .*2026/);
	});

	it("survives a missing or unparseable updatedAt without dropping the label", () => {
		// Legacy rows exist. Losing the age is acceptable; losing the "this was inferred" label
		// would put the entry back on equal footing with a live fact.
		const block = memoryPrompt([{ ...WRITE_ACCESS, updatedAt: "" }], { now: NOW });
		expect(block).toContain("auto-noted from an earlier conversation");
		expect(block).not.toContain("NaN");
	});
});

describe("#495 — live state outranks it, so a contradiction resolves", () => {
	it("says a live tool result and the status blocks win", () => {
		expect(STALE_MEMORY_RULE).toContain("outranks");
		expect(STALE_MEMORY_RULE).toContain("the live one is right");
	});

	it("names the exact move the agent made — refusing on the strength of a stale entry", () => {
		// It said "I just need write access to be enabled on the connector, which based on past
		// attempts has been blocked", and never attempted the call. The tool log for that turn
		// records one execution: terminal_list_targets.
		expect(STALE_MEMORY_RULE).toContain("Never refuse an action");
		expect(STALE_MEMORY_RULE).toMatch(/disabled, unavailable or already done/);
		expect(STALE_MEMORY_RULE).toContain("check it now instead");
	});

	it("is emitted whenever a summary entry is present", () => {
		expect(memoryPrompt([WRITE_ACCESS], { now: NOW })).toContain(STALE_MEMORY_RULE);
	});

	it("is NOT emitted when nothing could go stale", () => {
		// A rule about entries that are not there is noise the model has to invent a use for, and
		// most agents' memory is entirely user- or agent-written.
		const block = memoryPrompt([USER_SET, AGENT_SET], { now: NOW });
		expect(block).not.toContain(STALE_MEMORY_RULE);
		expect(block).toContain("## Your Memory");
	});
});

describe("#495 — provenance, not a topic blocklist", () => {
	it("leaves a user-set entry authoritative and undated", () => {
		// Ageing a standing instruction would invite the agent to treat it as expired. #226/#230:
		// user-set entries are protected from overwrite, which is the opposite posture.
		const block = memoryPrompt([USER_SET], { now: NOW });
		expect(block).toContain("- [preference] preference:tone (user-set): Keep it short");
		expect(block).not.toContain("out of date");
	});

	it("leaves an agent-written entry exactly as it was", () => {
		// `write_memory` is a deliberate act by the agent about its subject matter. Only the
		// summariser infers, so only the summariser's output is discounted.
		const block = memoryPrompt([AGENT_SET], { now: NOW });
		expect(block).toContain("- [knowledge] fact:commit-strategy: Always push to main");
		expect(block).not.toContain("auto-noted");
	});

	it("does not judge an entry by what it is ABOUT", () => {
		// The durable fix is provenance, because a state-word vocabulary is right about this
		// incident's four entries and silently wrong about the fifth kind nobody has seen. A
		// user-set entry that mentions write access is still authoritative.
		const block = memoryPrompt([{ ...WRITE_ACCESS, source: "user" }], { now: NOW });
		expect(block).toContain("(user-set)");
		expect(block).not.toContain("auto-noted");
	});
});

describe("#495 — the upstream half: the summariser is told not to make these", () => {
	// Asserted over the source because the instruction is a string inside a template literal with no
	// export to import, and because the regression is a REVERT — the original sentence ("extract key
	// facts about the user … information shared") reads perfectly well and is one edit away.
	const SRC = readFileSync(new URL("../agent-storage/summaries.ts", import.meta.url).pathname, "utf-8");

	it("excludes permission and consent state, which is what caused the refusal", () => {
		expect(SRC).toMatch(/NEVER extract the platform's own state/);
		expect(SRC).toMatch(/enabled, granted, blocked or unavailable/);
	});

	it("excludes connection state and inventories — the other three bad entries", () => {
		// "tmux sessions exist five" was false within the hour; a session start and a failed session
		// creation were both readings of a moment.
		expect(SRC).toMatch(/connected, running, idle or offline/);
		expect(SRC).toMatch(/how many sessions, files, records or repositories exist/);
		expect(SRC).toMatch(/succeeded or failed/);
	});

	it("states the class by its DEFINITION rather than listing banned phrases", () => {
		// The definition does not rot: it is exactly the state the platform re-reads and re-states
		// authoritatively every turn. A phrase list would be right about this incident's four
		// entries and silently wrong about the fifth kind nobody has seen yet.
		expect(SRC).toMatch(/as a class/);
		expect(SRC).toMatch(/re-read live and re-stated to the agent authoritatively/);
	});

	it("tells the model the fact is permanent, which the original never did", () => {
		// The original asked for "key facts" with no hint that an answer here outlives the
		// conversation and is repeated on every future turn.
		expect(SRC).toMatch(/becomes PERMANENT/);
		expect(SRC).toMatch(/still be true next month/);
	});

	it("keeps the confidence gate and the user-provenance guard it already had", () => {
		expect(SRC).toMatch(/fact\.confidence >= 0\.8/);
		expect(SRC).toMatch(/existing\?\.source === "user"/);
	});
});

describe("#495 — the block is otherwise unchanged", () => {
	it("keeps the write_memory key rule and the user-set protection", () => {
		// Pre-existing behaviour lifted out of agent-think.ts verbatim; the ticket is about adding
		// provenance, not about renegotiating how memory is edited.
		const block = memoryPrompt([USER_SET], { now: NOW });
		expect(block).toContain("write_memory to its EXACT key");
		expect(block).toContain("never overwrite or delete them unless the user explicitly asks");
	});

	it("emits nothing for an agent with no memory", () => {
		expect(memoryPrompt([], { now: NOW })).toBe("");
	});

	it("renders type and key in the shape the rest of the prompt already uses", () => {
		expect(memoryPrompt([AGENT_SET], { now: NOW })).toMatch(/- \[knowledge] fact:commit-strategy: /);
	});
});

/**
 * #495 step 3 — what the block may NOT do is grow without bound.
 *
 * Steps 1 and 2 dated every inferred entry and subordinated it to live state, which roughly DOUBLED
 * the block (+76% on the largest instance measured, +2,150 tokens per turn). The honesty was worth
 * it and it made this half more urgent, not less: 75 of one instance's 77 entries are inferred, 61
 * of them written on a single day, injected on every turn for the life of the instance — including
 * `fact:GitHub App:not provisioned in production` (2 Aug) and `fact:GitHub App:already created and
 * installed` (3 Aug), both at once.
 */
describe("#495 step 3 — the inferred half of the block is bounded", () => {
	const summary = (n: number, daysAgo: number): MemoryEntry => ({
		key: `fact:subject ${n}:predicate`,
		type: "knowledge",
		content: `subject ${n} predicate object`,
		updatedAt: new Date(NOW - daysAgo * 86_400_000).toISOString(),
		source: "summary",
	});

	it("stops repeating an inferred entry nothing has restated for a week", () => {
		// Measured on the live dumps: a durable subject on an active instance is re-extracted within
		// ~2 days (5.9 at the tail); the junk this bounds is write-once — "tmux sessions exist five",
		// false within the hour, never restated.
		const block = memoryPrompt([summary(1, 2), summary(2, 30)], { now: NOW });
		expect(block).toContain("fact:subject 1:predicate");
		expect(block).not.toContain("fact:subject 2:predicate");
		// …and it SAYS so, because a list the model believes is complete is one it will answer from.
		expect(block).toMatch(/1 older auto-noted entry is not repeated here/);
		expect(block).toContain("read_memory returns them");
	});

	it("keeps a user-set and an agent-written entry forever, however old", () => {
		// This bounds INFERENCE, not memory. Ageing out a standing instruction the user typed would
		// invite the agent to treat it as expired — the reverse of the bug.
		const old = { ...USER_SET, updatedAt: "2025-01-01T00:00:00Z" };
		const agent = { ...AGENT_SET, updatedAt: "2025-01-01T00:00:00Z" };
		const block = memoryPrompt([old, agent], { now: NOW });
		expect(block).toContain("preference:tone");
		expect(block).toContain("fact:commit-strategy");
		expect(block).not.toMatch(/not repeated here/);
	});

	it("caps the inferred entries at 30, newest restatement first, and counts what it withheld", () => {
		// The TTL alone does not bound the days that cost anything: growth is BURST-shaped, so a cap
		// is the half that bites every day. 40 fresh entries in, 30 out.
		const many = Array.from({ length: 40 }, (_, i) => summary(i, i / 24)); // all within the day
		const block = memoryPrompt(many, { now: NOW });
		const shown = many.filter((m) => block.includes(`${m.key} (auto-noted`));
		expect(shown).toHaveLength(30);
		expect(shown.map((m) => m.key)).toContain("fact:subject 0:predicate"); // the newest survives
		expect(shown.map((m) => m.key)).not.toContain("fact:subject 39:predicate"); // the oldest does not
		expect(block).toMatch(/10 older auto-noted entries are not repeated here/);
	});

	it("says how long a fact has been BELIEVED, not only when it was last restated", () => {
		// `updatedAt` is rewritten on every re-extraction, and the transcript includes the agent's own
		// turns — so a stale belief the agent keeps repeating has its age reset to zero. The incident
		// entry existed on 7 Aug and read `updatedAt: 2026-08-10`. Two weeks of belief looked like one
		// day, which is exactly the reading that made it competitive with a live fact.
		const block = memoryPrompt([{ ...WRITE_ACCESS, firstSeenAt: "2026-08-07T06:29:08Z" }], { now: NOW, timeZone: "UTC" });
		expect(block).toMatch(/first noted/);
		// A first sighting on the same day as the restatement is not a second date worth printing.
		expect(memoryPrompt([{ ...WRITE_ACCESS, firstSeenAt: "2026-08-10T07:00:00Z" }], { now: NOW })).not.toMatch(/first noted/);
	});

	it("un-injects, never deletes — the caller's array is not mutated", () => {
		// The owner's stated preference and the right one: the same generator produced a real standing
		// preference of his, deletion is the lossy answer to a provenance problem, and editing an
		// entry in the console Memory tab re-tags it `source:"user"`, which is a one-click promotion
		// back to permanent. Nothing here removes a row from storage.
		const entries = [summary(1, 30), summary(2, 30)];
		const before = JSON.stringify(entries);
		memoryPrompt(entries, { now: NOW });
		expect(JSON.stringify(entries)).toBe(before);
		expect(entries).toHaveLength(2);
	});
});
