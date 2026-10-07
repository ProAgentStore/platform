import { describe, expect, it } from "vitest";
import { boundedJson, clipMarked } from "./clip-marked.js";

describe("clipMarked (#898)", () => {
	it("returns a value that fits unchanged", () => {
		expect(clipMarked("abc", 3)).toBe("abc");
	});

	it("keeps the head and names both lengths", () => {
		expect(clipMarked("abcdef", 3)).toBe("abc\n[cut: showing the first 3 of 6 characters]");
	});

	it("fits marker and all inside the limit with `within`", () => {
		const out = clipMarked("a".repeat(500), 100, { within: true });
		expect(out.length).toBeLessThanOrEqual(100);
		expect(out).toMatch(/\[cut: showing the first \d+ of 500 characters\]$/);
	});

	it("keeps the tail for logs and panes", () => {
		expect(clipMarked("abcdef", 3, { keep: "tail" })).toBe("[cut: showing the last 3 of 6 characters]\ndef");
	});
});

describe("boundedJson (#898)", () => {
	it("serialises a small value as is", () => {
		expect(boundedJson({ a: 1 }, 100)).toBe('{"a":1}');
	});

	it("stays valid JSON within the bound, however the value is shaped", () => {
		for (const value of [{ s: "x".repeat(10_000) }, { s: '"\\\\"'.repeat(3000) }, { nested: Array.from({ length: 500 }, (_, i) => ({ i, t: "漢字\n" })) }]) {
			const out = boundedJson(value, 4000);
			expect(out.length).toBeLessThanOrEqual(4000);
			const parsed = JSON.parse(out) as { truncated: boolean; chars: number };
			expect(parsed.truncated).toBe(true);
			expect(parsed.chars).toBe(JSON.stringify(value).length);
			expect(out).toMatch(/\[cut: showing the first \d+ of \d+ characters\]/);
		}
	});

	it("keeps the small fields a reader filters on, and marks the large one it cuts", () => {
		const out = JSON.parse(boundedJson({ instanceId: "inst-1", status: 500, body: "b".repeat(9000) }, 4000)) as Record<string, unknown>;
		expect(out).toMatchObject({ instanceId: "inst-1", status: 500, truncated: true });
		expect(String(out.body)).toMatch(/^b+\n\[cut: showing the first \d+ of 9000 characters\]$/);
	});

	it("bounds an array too", () => {
		const out = boundedJson(Array.from({ length: 2000 }, (_, i) => i), 500);
		expect(out.length).toBeLessThanOrEqual(500);
		expect(JSON.parse(out)).toMatchObject({ truncated: true });
	});
});
