import { describe, expect, it } from "vitest";
import { chatExportPayload, stripContextPreamble } from "./chatExport";
import type { Message } from "./types";

describe("stripContextPreamble", () => {
	it("removes a preamble the server prepended, and the blank line after it", () => {
		expect(stripContextPreamble("[Context: 3 documents]\n\nwhat does this repo do?")).toBe("what does this repo do?");
	});

	it("removes a MULTI-LINE preamble — the one shape that actually ships", () => {
		const content = "[Context:\n## Attached Repositories\n- pags/platform\n]\nsummarise it";
		expect(stripContextPreamble(content)).toBe("summarise it");
	});

	// Non-greedy: it must stop at the FIRST `]`, not the last one in the message.
	it("keeps everything after the preamble, brackets included", () => {
		expect(stripContextPreamble("[Context: kb]\nlook at run [42] and [43]")).toBe("look at run [42] and [43]");
	});

	// Anchored, and not multiline-anchored: asking the agent about its own prompt is ordinary.
	it("leaves a message that merely quotes a context block alone", () => {
		const asking = "why does every turn start with [Context: 3 documents]?";
		expect(stripContextPreamble(asking)).toBe(asking);
		const later = "first line\n[Context: kb]\nsecond line";
		expect(stripContextPreamble(later)).toBe(later);
	});

	it("survives an empty or missing body", () => {
		expect(stripContextPreamble("")).toBe("");
		expect(stripContextPreamble(undefined as unknown as string)).toBe("");
	});
});

describe("chatExportPayload", () => {
	const msgs: Message[] = [
		{ role: "user", content: "[Context: kb]\nhello", createdAt: "2026-08-07T01:00:00.000Z" },
		{ role: "assistant", content: "hi" },
	];

	it("carries the instance, the count and the turns in order", () => {
		expect(chatExportPayload("inst_1", msgs)).toEqual({
			instanceId: "inst_1",
			count: 2,
			messages: [
				{ role: "user", content: "hello", timestamp: "2026-08-07T01:00:00.000Z" },
				{ role: "assistant", content: "hi", timestamp: undefined },
			],
		});
	});

	it("exports an empty thread rather than throwing on one", () => {
		expect(chatExportPayload("inst_1", [])).toEqual({ instanceId: "inst_1", count: 0, messages: [] });
	});
});
