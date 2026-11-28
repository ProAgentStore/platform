/**
 * #1672 — the research run's "Scan activity" card must not scroll the page sideways on a phone.
 *
 * The defect: each row was `flex gap-2` with a fixed 160px label (`w-40 shrink-0`) next to a value with no `min-w-0`. `break-words`
 * (`overflow-wrap: break-word`) does NOT lower an item's min-content width, so one long unbroken token (a host, URL or id) plus the
 * 160px label was wider than a 320–430px viewport and the whole page panned. The fix (893a7e27) stacks label over value below `sm`,
 * keeps the 160px column from `sm` up, and gives the value `min-w-0` and `[overflow-wrap:anywhere]`, which DOES count toward
 * min-content.
 *
 * What this can and cannot see. This console has no component harness (no jsdom, and `ResearchRunView` loads its run through effects
 * and fetch), and a unit test has no layout engine — so it cannot MEASURE a 320px viewport. It pins the CLASS CONTRACT that makes the
 * browser wrap, read from the real markup in `ResearchRunView.tsx` (the pattern `scanSchedule.test.ts` uses for the same file), plus
 * the realistic trigger: the long unbroken value the real `telemetryRows` produces for a long source hostname. The checker is itself
 * proven against the ORIGINAL buggy markup below, so it cannot pass vacuously.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ScanTelemetry, telemetryRows } from "../../lib/scanSchedule";

const source = readFileSync(new URL("./ResearchRunView.tsx", import.meta.url), "utf8");

/** The card's JSX: from its test id to the end of its row list. */
function cardBlock(src: string): string {
	const start = src.indexOf('data-testid="scan-telemetry"');
	if (start < 0) throw new Error("the Scan activity card (data-testid=scan-telemetry) is gone from ResearchRunView.tsx");
	const end = src.indexOf("</dl>", start);
	if (end < 0) throw new Error("the Scan activity card has no </dl>");
	return src.slice(start, end);
}

/** The class tokens of one element in the block: `className="…"` or a template literal, with `${…}` expressions dropped. */
function tokens(block: string, tag: "div" | "dt" | "dd", opts: { keyed?: boolean } = {}): string[] {
	const open = opts.keyed ? new RegExp(`<${tag}\\s+key=\\{row\\.label\\}\\s+className=(?:"([^"]*)"|\\{\`([^\`]*)\`\\})`) : new RegExp(`<${tag}\\s+className=(?:"([^"]*)"|\\{\`([^\`]*)\`\\})`);
	const m = block.match(open);
	if (!m) throw new Error(`no <${tag}> with a className in the Scan activity card`);
	return (m[1] ?? m[2] ?? "").replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean);
}

/** Every way the old layout can come back, as readable sentences. Empty means the contract holds. */
export function layoutViolations(block: string): string[] {
	const row = tokens(block, "div", { keyed: true });
	const dt = tokens(block, "dt");
	const dd = tokens(block, "dd");
	const out: string[] = [];
	const need = (list: string[], what: string, token: string) => { if (!list.includes(token)) out.push(`${what} must have \`${token}\``); };
	const bare = (list: string[], what: string, token: string) => { if (list.includes(token)) out.push(`${what} must not have bare \`${token}\` (it applies on a phone; use \`sm:${token}\`)`); };
	// The row stacks label over value on a phone and goes side by side from `sm`.
	need(row, "the row", "flex");
	need(row, "the row", "flex-col");
	need(row, "the row", "sm:flex-row");
	for (const t of row) if (/^(gap-|items-)/.test(t)) out.push(`the row's \`${t}\` is unprefixed, so it also applies when stacked (use \`sm:${t}\`)`);
	// The 160px label column exists only from `sm` up.
	need(dt, "the label", "sm:w-40");
	need(dt, "the label", "sm:shrink-0");
	bare(dt, "the label", "w-40");
	bare(dt, "the label", "shrink-0");
	// The value can shrink below its longest token and wraps anywhere.
	need(dd, "the value", "min-w-0");
	need(dd, "the value", "[overflow-wrap:anywhere]");
	need(dd, "the value", "sm:flex-1");
	bare(dd, "the value", "flex-1");
	return out;
}

/** The markup #1672 was filed against, verbatim from before 893a7e27. */
const ORIGINAL_BUGGY_BLOCK = `data-testid="scan-telemetry">
	<dl className="flex flex-col gap-1">
		{rows.map((row) => (
			<div key={row.label} className="text-xs flex gap-2 items-baseline">
				<dt className="text-muted shrink-0 w-40">{row.label}</dt>
				<dd className={\`flex-1 break-words \${row.tone === "danger" ? "text-danger" : "text-ink"}\`}>{row.value}</dd>
			</div>
		))}
	`;

const LONG_HOST = `${"a-very-long-unbroken-subdomain-".repeat(6)}example.org`; // 197 characters, no space — one token to the browser
const withLongHost = (): ScanTelemetry => ({
	runId: "run-1", status: "completed", startedBy: "trigger", startedAt: "2026-10-08T07:00:00.000Z", endedAt: "2026-10-08T07:04:00.000Z", durationMs: 240_000,
	configured: { engine: "claude", authMode: "subscription", sources: [LONG_HOST], denied: [], collection: "job_leads", keyField: "url", maxPages: 30, maxMinutes: 15 },
	sources: { configured: 1, reached: 0, unreachable: 1, reach: [{ domain: LONG_HOST, pages: 0, blocked: 0, failed: "login_required" }] },
	seen: { pages: 0, snapshots: 0, findings: 0 },
	leads: { added: 0, duplicates: 0, skipped: 0, pending: 0, recordIds: [] },
	rejections: [], handoffs: { emitted: 0, note: "" }, warnings: [], errors: [{ code: "source:login_required", count: 1 }],
	terminal: { outcome: "completed", errorCode: null, reason: "No leads." },
});

describe("the research run's Scan activity card on a phone (#1672)", () => {
	const block = cardBlock(source);

	it("the markup satisfies the whole contract (no violations)", () => {
		expect(layoutViolations(block)).toEqual([]);
	});

	it("stacks the label over the value below `sm` and goes side by side from `sm`", () => {
		const row = tokens(block, "div", { keyed: true });
		expect(row).toEqual(expect.arrayContaining(["flex", "flex-col", "sm:flex-row"]));
		// Every spacing/alignment utility on the row is `sm:`-prefixed, so none of it widens the stacked layout.
		expect(row.filter((t) => /^(gap-|items-)/.test(t))).toEqual([]);
	});

	it("keeps the fixed 160px label column from `sm` up only", () => {
		const dt = tokens(block, "dt");
		expect(dt).toEqual(expect.arrayContaining(["sm:w-40", "sm:shrink-0"]));
		expect(dt).not.toContain("w-40");
		expect(dt).not.toContain("shrink-0");
	});

	it("lets the value shrink below its longest token and wrap anywhere — `break-words` alone does not", () => {
		const dd = tokens(block, "dd");
		expect(dd).toEqual(expect.arrayContaining(["min-w-0", "[overflow-wrap:anywhere]", "sm:flex-1"]));
		expect(dd).not.toContain("flex-1");
	});

	it("still renders every telemetry row through the one list, keyed by its label", () => {
		expect(block).toMatch(/telemetryRows\(run\.telemetry\)\.map\(\(row\) =>/);
		expect(block).toContain("{row.label}");
		expect(block).toContain("{row.value}");
		expect(block).toContain('<h3 className="text-base font-bold mb-2">Scan activity</h3>');
	});

	it("keeps the tone colours the value had", () => {
		expect(block).toContain("text-danger");
		expect(block).toContain("text-warning");
		expect(block).toContain("text-ink");
	});

	it("the realistic trigger: a long source hostname arrives as ONE unbroken token in a row value", () => {
		const reach = telemetryRows(withLongHost()).find((r) => r.label === "Source reachability");
		expect(reach?.value).toContain(LONG_HOST);
		expect(LONG_HOST.length).toBeGreaterThanOrEqual(190);
		expect(/\s/.test(LONG_HOST)).toBe(false);
		// 160px label + this token is wider than any phone viewport, which is why the value must be able to wrap in place.
		expect(160 + LONG_HOST.length * 6).toBeGreaterThan(430);
	});
});

describe("the checker itself (so the contract cannot pass vacuously)", () => {
	it("flags the ORIGINAL markup #1672 was filed against, naming each defect", () => {
		const found = layoutViolations(ORIGINAL_BUGGY_BLOCK);
		expect(found.length).toBeGreaterThanOrEqual(7);
		expect(found.join("\n")).toMatch(/row must have `flex-col`/);
		expect(found.join("\n")).toMatch(/row must have `sm:flex-row`/);
		expect(found.join("\n")).toMatch(/label must not have bare `w-40`/);
		expect(found.join("\n")).toMatch(/label must not have bare `shrink-0`/);
		expect(found.join("\n")).toMatch(/value must have `min-w-0`/);
		expect(found.join("\n")).toMatch(/value must have `\[overflow-wrap:anywhere\]`/);
		expect(found.join("\n")).toMatch(/`gap-2` is unprefixed/);
	});

	it("flags each regression separately, so a partial revert is still caught", () => {
		const fixed = cardBlock(source);
		expect(layoutViolations(fixed)).toEqual([]);
		// Each case undoes ONE class on ONE element, exactly as written in the markup, and must be caught on its own.
		const cases: Array<[string, string, RegExp]> = [
			["flex flex-col sm:flex-row", "flex sm:flex-row", /row must have `flex-col`/],
			["flex flex-col sm:flex-row", "flex flex-col", /row must have `sm:flex-row`/],
			["text-xs flex flex-col sm:flex-row sm:gap-2 sm:items-baseline", "text-xs flex flex-col sm:flex-row gap-2 items-baseline", /`gap-2` is unprefixed/],
			["text-muted sm:shrink-0 sm:w-40", "text-muted shrink-0 w-40", /bare `w-40`/],
			["min-w-0 sm:flex-1", "sm:flex-1", /value must have `min-w-0`/],
			["[overflow-wrap:anywhere]", "break-words", /value must have `\[overflow-wrap:anywhere\]`/],
			["min-w-0 sm:flex-1", "flex-1", /bare `flex-1`/],
		];
		for (const [from, to, expected] of cases) {
			expect(fixed, `the fixture string "${from}" must exist in the markup`).toContain(from);
			const mutated = fixed.replace(from, to);
			expect(mutated).not.toBe(fixed);
			expect(layoutViolations(mutated).join("\n"), `${from} -> ${to}`).toMatch(expected);
		}
	});

	it("reports a missing card as a clear failure instead of passing", () => {
		expect(() => cardBlock("export default function X() { return null; }")).toThrow(/scan-telemetry/);
	});
});
