import { describe, expect, it } from "vitest";
import { entryText, groupRepoHistory, sessionLabel } from "./repo-history";
import type { TimelineEntry } from "./types";

const e = (over: Partial<TimelineEntry>): TimelineEntry => ({ seq: 1, type: "terminal", content: "x", sessionId: "s1", ...over });

describe("groupRepoHistory", () => {
	it("groups a repo's stream into per-session sections", () => {
		const sections = groupRepoHistory([
			e({ seq: 1, sessionId: "s1", content: "a" }),
			e({ seq: 2, sessionId: "s1", content: "b" }),
			e({ seq: 3, sessionId: "s2", content: "c" }),
		]);
		expect(sections).toHaveLength(2);
		expect(sections[0].entries.map((x) => x.content)).toEqual(["a", "b"]);
		expect(sections[1].sessionId).toBe("s2");
	});

	it("keeps seq order even when sessions interleave", () => {
		// Grouping by key would reorder these into an order that never happened — two machines, or
		// a session reclaimed onto another node, produce exactly this stream.
		const sections = groupRepoHistory([
			e({ seq: 1, sessionId: "s1", content: "a" }),
			e({ seq: 2, sessionId: "s2", content: "b" }),
			e({ seq: 3, sessionId: "s1", content: "c" }),
		]);
		expect(sections.map((s) => s.sessionId)).toEqual(["s1", "s2", "s1"]);
	});

	it("drops the co-pilot conversation — this is a terminal transcript, not a third chat copy", () => {
		const sections = groupRepoHistory([
			e({ seq: 1, type: "chat_user", content: "hi" }),
			e({ seq: 2, type: "chat_assistant", content: "hello" }),
			e({ seq: 3, type: "terminal", content: "$ ls" }),
		]);
		expect(sections).toHaveLength(1);
		expect(sections[0].entries).toHaveLength(1);
	});

	it("keeps commands, brain actions and outcomes — the record of what ran", () => {
		const sections = groupRepoHistory([
			e({ seq: 1, type: "command", content: "git pull" }),
			e({ seq: 2, type: "brain", content: "decided to pull" }),
			e({ seq: 3, type: "outcome", content: "ended — up to date" }),
			e({ seq: 4, type: "system", content: "runner reconnected" }),
		]);
		expect(sections[0].entries).toHaveLength(4);
	});

	it("an empty timeline yields no sections", () => {
		expect(groupRepoHistory([])).toEqual([]);
	});
});

describe("entryText", () => {
	it("marks a command as input so it does not read as output", () => {
		expect(entryText(e({ type: "command", content: "git pull" }))).toBe("$ git pull");
	});

	it("passes terminal output through unchanged", () => {
		expect(entryText(e({ type: "terminal", content: "Already up to date." }))).toBe("Already up to date.");
	});

	it("marks outcomes and brain actions distinctly", () => {
		expect(entryText(e({ type: "outcome", content: "ended" }))).toContain("ended");
		expect(entryText(e({ type: "brain", content: "thinking" }))).toContain("thinking");
	});
});

describe("sessionLabel", () => {
	it("shortens the session id and includes when it started", () => {
		const label = sessionLabel({ sessionId: "abcdef01-2345-6789", entries: [e({ createdAt: "2026-08-06 03:45:00" })] }, 0);
		expect(label).toContain("Session 1");
		expect(label).toContain("abcdef01");
		expect(label).not.toContain("2345-6789");
		expect(label).toContain("2026-08-06");
	});

	it("copes with an entry that has no timestamp", () => {
		expect(sessionLabel({ sessionId: "s1", entries: [e({ createdAt: undefined })] }, 1)).toBe("Session 2 · s1");
	});
});
