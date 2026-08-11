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
