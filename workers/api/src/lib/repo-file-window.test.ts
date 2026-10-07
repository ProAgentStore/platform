import { describe, expect, it } from "vitest";
import { capToolResult, TOOL_RESULT_MAX_CHARS } from "./tool-result-cap.js";
import { MAX_LINE_CHARS, READ_MAX_CHARS, READ_MAX_LINES, renderRepoFileWindow, runnerRange } from "./repo-file-window.js";
import { getRegistryTool, renderToolContent } from "./tool-registry.js";

/**
 * The window as `repo_read_file` actually delivers it (#752).
 *
 * `renderRepoFileWindow` now returns `head`/`content`/`tail` so the dispatcher can fence the file's
 * LINES and leave the platform's disclosure — which lines you got, and the literal call for the
 * next window — outside the block (ADR 0006 F2). Every assertion below is about what the model
 * reads, so it reads the composed result; in particular the `capToolResult` cases would otherwise
 * measure a string ~230 characters shorter than the one that is actually sent.
 */
const REPO_READ_FILE = getRegistryTool("repo_read_file")!;
function render(input: Parameters<typeof renderRepoFileWindow>[0]) {
	const r = renderRepoFileWindow(input);
	return { ...r, content: renderToolContent(REPO_READ_FILE, r) };
}

const file = (n: number, text = "const x = 1;"): string => Array.from({ length: n }, (_, i) => `${text} // ${i + 1}`).join("\n");

describe("renderRepoFileWindow — the window and what it says about itself (#534)", () => {
	it("returns a small file whole, numbered, and says it is whole", () => {
		const r = render({ path: "src/a.ts", content: "a\nb\nc\n", size: 6 });
		expect(r.success).toBe(true);
		expect(r.content).toContain("--- src/a.ts — lines 1-3 of 3 (the whole file) ---");
		expect(r.content).toContain("1: a");
		expect(r.content).toContain("3: c");
		// Nothing was withheld, so there is nothing to disclose and no next call to suggest.
		expect(r.content).not.toContain("WINDOW");
		expect(r.content).not.toContain("startLine=");
	});

	// The acceptance test from #534, in the shape it was reported: firestore.rules is 511+ lines and
	// the rule the owner needed is at 511-513, well past the old 8KB cut. One call, no repo_grep.
	it("reaches a line past the old 8KB cut in ONE call", () => {
		const lines = Array.from({ length: 560 }, (_, i) => `// filler line ${i + 1} ${"x".repeat(40)}`);
		lines[510] = "    match /eventCalls/{callId} {";
		lines[511] = "      allow read: if isSignedIn();";
		const content = lines.join("\n");
		expect(content.length).toBeGreaterThan(8 * 1024);

		const r = render({ path: "firestore.rules", content, size: content.length, startLine: 505, endLine: 515 });
		expect(r.success).toBe(true);
		expect(r.content).toContain("511:     match /eventCalls/{callId} {");
		expect(r.content).toContain("512:       allow read: if isSignedIn();");
		expect(r.content).toContain("--- firestore.rules — lines 505-515 of 560 ---");
	});

	it("stops at the character budget and states the lines it did not return plus the next call", () => {
		const content = file(4_000);
		const r = render({ path: "big.ts", content, size: content.length });
		expect(r.content).toContain("--- big.ts — lines 1-");
		expect(r.content).toContain("of 4,000");
		expect(r.content).toContain("were NOT returned");
		expect(r.content).toMatch(/startLine=\d/);
		// Sized on the RENDERED text, prefixes included, so the result cannot overshoot the budget.
		expect(r.content.length).toBeLessThanOrEqual(READ_MAX_CHARS + 2_000);
	});

	// The invariant that makes the header-first layout matter: the result must fit under the seam
	// that would otherwise re-cut it and replace this file's precise disclosure with a generic one.
	it("a window of a large file stays under TOOL_RESULT_MAX_CHARS", () => {
		const content = file(20_000);
		const r = render({ path: "huge.ts", content, size: content.length });
		expect(r.content.length).toBeLessThan(TOOL_RESULT_MAX_CHARS);
		expect(capToolResult(r.content)).toBe(r.content);
	});

	// And the reason it is a HEADER rather than a tail note: if the budget is ever raised past the
	// tool-result ceiling, the disclosure still survives the cut. A tail note would not.
	it("the disclosure survives capToolResult even when the window is over the ceiling", () => {
		const content = file(20_000);
		const r = render({ path: "huge.ts", content, size: content.length, maxChars: 60_000 });
		expect(r.content.length).toBeGreaterThan(TOOL_RESULT_MAX_CHARS);
		const capped = capToolResult(r.content);
		expect(capped).toContain("--- huge.ts — lines 1-");
		expect(capped).toContain("of 20,000");
		expect(capped).toContain("startLine=");
	});

	it("honours the line budget when the lines are short enough that characters never bind", () => {
		const content = Array.from({ length: READ_MAX_LINES + 500 }, () => "x").join("\n");
		const r = render({ path: "short.txt", content, size: content.length });
		const shown = r.content.split("\n").filter((l) => /^\d+: x$/.test(l));
		expect(shown.length).toBe(READ_MAX_LINES);
		expect(r.content).toContain(`lines 1-${READ_MAX_LINES.toLocaleString("en-US")} of`);
	});

	it("caps a single enormous line instead of letting it spend the whole window", () => {
		const content = `first\n${"a".repeat(200_000)}\nlast`;
		const r = render({ path: "bundle.js", content, size: content.length });
		expect(r.content).toContain("[line truncated: it is 200,000 characters long]");
		expect(r.content).toContain("3: last");
		expect(r.content.length).toBeLessThan(TOOL_RESULT_MAX_CHARS);
	});

	it("distinguishes the end of a WINDOW from the end of the FILE when the fetch itself was cut", () => {
		const content = file(3_000);
		const r = render({ path: "enormous.ts", content, fetchTruncated: true, size: 431_936 });
		expect(r.content).toContain("of at least ");
		// An older runner (no `firstLine`) still cannot reach past its byte cap — and is told how to fix that (#954).
		expect(r.content).toContain("cannot be reached until its `pags` CLI is updated (runner_update)");
		expect(r.content).toContain("Do NOT state or imply that the file ends here");
	});

	it("drops the partial last line of a byte-cut fetch rather than showing a fragment as a line", () => {
		const r = render({ path: "cut.ts", content: "one\ntwo\nthr", fetchTruncated: true, size: 90_000 });
		expect(r.content).toContain("2: two");
		expect(r.content).not.toMatch(/^3: /m);
		expect(r.content).toContain("of at least 2");
	});

	it("refuses a startLine past the end, naming the file's real line count", () => {
		const r = render({ path: "src/a.ts", content: "a\nb\nc\n", size: 6, startLine: 100 });
		expect(r.success).toBe(false);
		expect(r.content).toContain("src/a.ts has 3 lines");
	});

	it("refuses a backwards range with the correction", () => {
		const r = render({ path: "src/a.ts", content: file(50), startLine: 40, endLine: 10 });
		expect(r.success).toBe(false);
		expect(r.content).toContain("is before `startLine`");
	});

	it("refuses a non-numeric range rather than silently reading from the top", () => {
		const r = render({ path: "src/a.ts", content: file(50), startLine: "the eventCalls rule" });
		expect(r.success).toBe(false);
		expect(r.content).toContain("must be whole numbers");
	});

	it("clamps a zero/negative startLine and SAYS it did", () => {
		const r = render({ path: "src/a.ts", content: "a\nb\n", startLine: 0 });
		expect(r.success).toBe(true);
		expect(r.content).toContain("the first line of a file is 1");
		expect(r.content).toContain("1: a");
	});

	it("accepts a numeric string, which is what a model often sends", () => {
		const r = render({ path: "src/a.ts", content: file(50), startLine: "10", endLine: "12" });
		expect(r.success).toBe(true);
		expect(r.content).toContain("lines 10-12 of 50");
	});

	it("says a file is empty rather than returning a blank result that reads like a failure", () => {
		const r = render({ path: "src/empty.ts", content: "", size: 0 });
		expect(r.success).toBe(true);
		expect(r.content).toContain("this file is empty");
	});

	it("clamps an endLine past the end to the end, without pretending there is more", () => {
		const r = render({ path: "src/a.ts", content: "a\nb\nc\n", startLine: 2, endLine: 900 });
		expect(r.content).toContain("lines 2-3 of 3");
		expect(r.content).not.toContain("WINDOW");
	});

	it("keeps the per-line cap and the character budget independent", () => {
		// One long-ish line under the per-line cap: it is kept whole and simply eats budget.
		const content = `${"z".repeat(MAX_LINE_CHARS - 1)}\nsecond`;
		const r = render({ path: "x.ts", content });
		expect(r.content).not.toContain("[line truncated");
		expect(r.content).toContain("2: second");
	});
});

// #954: a runner that honours `startLine`/`startColumn` sends the bytes from THAT line, with the
// file's line count, so no line is out of reach — the old 128 KiB ceiling was "the first 128 KiB".
describe("renderRepoFileWindow over a RANGED runner — any line, any column (#954)", () => {
	/** Lines `from`..`to` of a `total`-line file, as a ranged runner returns them. */
	const slice = (from: number, to: number) => `${Array.from({ length: to - from + 1 }, (_, i) => `const x = 1; // ${from + i}`).join("\n")}\n`;

	it("numbers the window from the runner's firstLine and states the file's real length", () => {
		const r = render({ path: "big.ts", content: slice(5_000, 5_200), fetchTruncated: true, size: 900_000, startLine: 5_000, firstLine: 5_000, totalLines: 40_000 });
		expect(r.success).toBe(true);
		expect(r.content).toMatch(/--- big\.ts — lines 5,000-5,\d{3} of 40,000 ---/);
		expect(r.content).toContain("5000: const x = 1; // 5000");
		// The continuation is a real call, because the next window is fetched from that line too.
		expect(r.content).toMatch(/To continue, call repo_read_file path="big\.ts" startLine=5,\d{3}/);
		expect(r.content).not.toContain("cannot be reached");
	});

	it("says a startLine past the file's end is past it, with the real line count", () => {
		const r = render({ path: "big.ts", content: "", startLine: 50_001, firstLine: 50_001, totalLines: 40_000, size: 900_000 });
		expect(r.success).toBe(false);
		expect(r.content).toContain("big.ts has 40,000 lines");
	});

	it("still says an empty file is empty", () => {
		const r = render({ path: "e.ts", content: "", firstLine: 1, totalLines: 0, size: 0 });
		expect(r.content).toContain("this file is empty");
	});

	it("a line too long to show names the startColumn that reads the rest of it", () => {
		const long = "m".repeat(50_000);
		const r = render({ path: "min.js", content: `${long}\nnext\n`, firstLine: 1, totalLines: 2, size: 50_006 });
		expect(r.content).toContain(`[line truncated: it is 50,000 characters long — read on with repo_read_file path="min.js" startLine=1 startColumn=${MAX_LINE_CHARS + 1}]`);
	});

	it("startColumn reads the rest of that line with the window's budget, not the per-line cap", () => {
		// What the runner returns for startLine=1 startColumn=2001: the line from that column on.
		const rest = "m".repeat(48_000);
		const r = render({ path: "min.js", content: `${rest}\nnext\n`, startLine: 1, startColumn: 2_001, firstLine: 1, totalLines: 2, size: 50_006 });
		expect(r.success).toBe(true);
		expect(r.content).toContain("1: [from column 2,001] mmm");
		const shown = /1: \[from column 2,001\] (m+)/.exec(r.content)?.[1].length ?? 0;
		expect(shown).toBeGreaterThan(MAX_LINE_CHARS * 5);
		// …and its own marker carries the column after what it showed.
		expect(r.content).toContain(`startLine=1 startColumn=${2_001 + shown}]`);
		expect(r.content).toContain("it is 50,000 characters long");
	});

	it("a line the fetch itself cut says it is AT LEAST that long", () => {
		const r = render({ path: "huge.js", content: "q".repeat(131_000), fetchTruncated: true, firstLine: 1, totalLines: 1, size: 9_000_000 });
		expect(r.content).toContain("it is at least 131,000 characters long");
	});

	it("an OLDER runner (no firstLine) refuses startColumn and names runner_update", () => {
		const r = render({ path: "min.js", content: "m".repeat(5_000), startColumn: 2_001 });
		expect(r.success).toBe(false);
		expect(r.content).toContain("runner_update");
	});

	it("an older runner's long line keeps the plain marker — there is no column to send it to", () => {
		const r = render({ path: "min.js", content: "m".repeat(5_000) });
		expect(r.content).toContain("[line truncated: it is 5,000 characters long]");
	});

	it("runnerRange sends only a real range — line 1 / column 1 are the runner's own default", () => {
		expect(runnerRange({})).toEqual({});
		expect(runnerRange({ startLine: 1, startColumn: 1 })).toEqual({});
		expect(runnerRange({ startLine: "480", startColumn: 2001 })).toEqual({ startLine: 480, startColumn: 2001 });
		expect(runnerRange({ startLine: "abc", startColumn: -3 })).toEqual({});
	});
});
