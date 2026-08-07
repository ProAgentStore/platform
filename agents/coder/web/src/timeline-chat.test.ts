import { describe, expect, it } from "vitest";
import { chatMessagesFrom, lastTerminalSnapshot, timelineExcerpt } from "./timeline-chat";
import type { TimelineEntry } from "./types";

const e = (type: string, over: Partial<TimelineEntry> = {}): TimelineEntry => ({ type, content: type, ...over });

/** One of everything `coding_timeline` can hold, in the order a real session writes it. */
const FULL: TimelineEntry[] = [
	e("chat_user", { content: "fix the flaky test", createdAt: "2026-08-07T01:00:00Z", audioKey: "a1" }),
	e("brain", { content: "decided: run the suite" }),
	e("command", { content: "pnpm test" }),
	e("terminal", { content: "  3 failed  " }),
	e("chat_assistant", { content: "three failures, all in repo-status" }),
	e("outcome", { content: "exit 1" }),
	e("system", { content: "Loop stopped by user." }),
	e("terminal", { content: "  all green  " }),
	e("chat_system", { content: "Loop complete." }),
];

describe("which rows are the conversation", () => {
	it("keeps exactly the five human-facing types, in order", () => {
		expect(chatMessagesFrom({ chat: FULL }).map((m) => `${m.role}:${m.content}`)).toEqual([
			"user:fix the flaky test",
			"user:pnpm test",
			"assistant:three failures, all in repo-status",
			"system:Loop stopped by user.",
			"system:Loop complete.",
		]);
	});

	it("drops the machinery — brain decisions, outcomes, terminal snapshots", () => {
		const kept = chatMessagesFrom({ chat: FULL }).map((m) => m.content);
		for (const noise of ["decided: run the suite", "exit 1", "  3 failed  "]) {
			expect(kept).not.toContain(noise);
		}
	});

	it("reads a driven command as something the USER said", () => {
		// The row type is named for the mechanism; the person typing it is still the speaker.
		expect(chatMessagesFrom({ chat: [e("command")] })[0].role).toBe("user");
	});

	it("drops a row with no type rather than rendering an unattributed bubble", () => {
		expect(chatMessagesFrom({ chat: [{ content: "orphan" }, e("chat_user")] })).toHaveLength(1);
	});

	it("carries the timestamp and the voice recording through", () => {
		const [first] = chatMessagesFrom({ chat: FULL });
		expect(first.time).toBe("2026-08-07T01:00:00Z");
		expect(first.audioKey).toBe("a1");
	});

	it("falls back to the older `text` column, and to empty rather than undefined", () => {
		expect(chatMessagesFrom({ chat: [{ type: "chat_user", text: "legacy" }] })[0].content).toBe("legacy");
		expect(chatMessagesFrom({ chat: [{ type: "chat_user" }] })[0].content).toBe("");
	});
});

describe("which half of the payload is read", () => {
	it("prefers `chat` when the route sent both", () => {
		expect(chatMessagesFrom({ chat: [e("chat_user", { content: "from chat" })], timeline: FULL })).toEqual([
			{ role: "user", content: "from chat", time: undefined, audioKey: undefined },
		]);
	});

	it("falls back to `timeline` — the shape an older API answered with", () => {
		expect(chatMessagesFrom({ timeline: FULL })).toHaveLength(5);
	});

	it("`?full=1` buys the terminal snapshot, NOT a richer transcript", () => {
		// Worth stating plainly, because the route's own comment says full=1 exists "so the whole
		// session can be copied as JSON": `chat` is non-empty whenever there is any conversation
		// at all, so the typed `timeline` half is unreachable through these readers except here.
		expect(lastTerminalSnapshot({ chat: FULL })).toBe("");
		expect(lastTerminalSnapshot({ timeline: FULL })).toBe("all green");
	});

	it("takes the LAST terminal row, trimmed", () => {
		expect(lastTerminalSnapshot({ timeline: FULL })).toBe("all green");
	});

	it("answers empty string — not null — when there is no snapshot", () => {
		// The caller only tests it for truthiness, and `if (saved)` on a null would still be
		// right; the type is what stops the next caller from rendering "null" into a <pre>.
		expect(lastTerminalSnapshot({})).toBe("");
		expect(lastTerminalSnapshot({ timeline: [e("terminal", { content: "   " })] })).toBe("");
	});
});

describe("what the copy button puts on the clipboard", () => {
	it("takes the tail, not the whole history", () => {
		const many = Array.from({ length: 25 }, (_, i) => e("chat_user", { content: `m${i}`, seq: i }));
		const out = timelineExcerpt({ chat: many });
		expect(out).toHaveLength(10);
		expect(out[0].content).toBe("m15");
		expect(out[9].content).toBe("m24");
	});

	it("keeps the machinery rows the conversation reader drops", () => {
		// This is a debugging artefact, not a transcript — the brain decisions and outcomes are
		// exactly what someone pasting into a bug report needs.
		expect(timelineExcerpt({ chat: FULL }).map((x) => x.type)).toContain("brain");
	});

	it("returns fewer than the limit rather than padding", () => {
		expect(timelineExcerpt({ chat: [e("chat_user")] })).toHaveLength(1);
		expect(timelineExcerpt({})).toEqual([]);
	});
});
