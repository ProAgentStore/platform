/**
 * The per-tool-call record (#581 AC7) — parsed from the pane, de-duplicated across snapshots.
 *
 * #581 shipped its reader and stated the half it could not answer: *"show me every tool call this
 * iteration made, with its inputs and outputs"*. The fixtures below are VERBATIM production text,
 * read from `coding_timeline` on 2026-08-15, because the whole claim of this feature is that the
 * record already exists in that exact shape — a hand-written fixture would prove only that the
 * parser matches the parser's own idea of the format.
 *
 * The arms that matter are the ones that fail on the obvious wrong implementation:
 *
 *   · de-duplicating on the LAST call would swallow the in-flight one's result forever;
 *   · de-duplicating by VALUE would collapse a command the engine genuinely ran twice;
 *   · anchoring on the FIRST occurrence would replay the second;
 *   · not de-duplicating at all would re-deliver 41% of every poll.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { appendTimeline, FEED_TOOLCALL_BYTES, loadTimelineFeed } from "./coding-timeline.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { capToolCalls, type EngineToolCall, parseEngineToolCalls, RESULT_LINES_MIN_CLI, TOOL_OUTCOME_MIN_CLI, toolCallsForSnapshot } from "./engine-tool-calls.js";
import type { Env } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Verbatim from production `coding_timeline` seq 8966 — four `Bash` calls with their results.
 *
 * Kept exactly as stored, including the runner's `…` cut markers and the leading two-space indent
 * on the result lines, because those characters ARE the format this parser depends on.
 */
const PRODUCTION_PANE = [
	'⚙ Bash {"command":"git branch --show-current && git log --oneline -1 && git remote -v | head -2 && git status --short | wc -l","description":"Confirm branch, remote, a…',
	"  ↳ main e501c2f security(#117): guard-audit pass 1 — freeze-once and same-org prerequisite origin git@github-personal:proappstore-online/chess-academy.git (fetch) 13",
	'⚙ Bash {"command":"git add -A && git status --short && echo \\"=== staged count ===\\" && git diff --cached --stat | tail -3","description":"Stage all changes"}',
	"  ↳ M CLAUDE.md M README.md A docs/technical/registered-action-checklist.md M package.json M web/src/components/ProvisionStudentModal.test.tsx M web/src/components/…",
	'⚙ Bash {"command":"git push origin main 2>&1 | tail -10","description":"Push to main"}',
	"  ↳ To github-personal:proappstore-online/chess-academy.git ! [rejected] main -> main",
].join("\n");

describe("parseEngineToolCalls", () => {
	it("reads the argument AND the result off a real production pane", () => {
		const calls = parseEngineToolCalls(PRODUCTION_PANE);
		expect(calls).toHaveLength(3);
		expect(calls[0].tool).toBe("Bash");
		expect(calls[0].input).toContain('"command":"git branch --show-current');
		expect(calls[0].output).toContain("main e501c2f security(#117)");
		// The last one is the interesting one: a push that was REJECTED. The record has to carry the
		// result text whatever it says — this is the pair #581 asked for and could not get.
		expect(calls[2].input).toContain("git push origin main");
		expect(calls[2].output).toContain("! [rejected] main -> main");
	});

	it("reports the runner's own truncation instead of passing a cut argument off as whole", () => {
		const calls = parseEngineToolCalls(PRODUCTION_PANE);
		// `shortInput` cuts at 160 chars and appends `…` (headless.ts:899); `toolResult` at 240 (:910).
		expect(calls[0].inputCut).toBe(true);
		expect(calls[1].outputCut).toBe(true);
		expect(calls[2].inputCut).toBeUndefined();
		expect(calls[2].outputCut).toBeUndefined();
	});

	it("a call whose result has not come back reports output null, not an empty string", () => {
		// The live state: the snapshot was taken while the tool was still running. `null` and `""`
		// are different claims and a watcher acts on the difference.
		const calls = parseEngineToolCalls('⚙ Read {"file_path":"/tmp/a.ts"}');
		expect(calls).toEqual([{ tool: "Read", input: '{"file_path":"/tmp/a.ts"}', output: null, ok: null }]);
	});

	it("ignores the fragment a raw character cut leaves at the top of a snapshot", () => {
		// A stored row is `pane.slice(-8000)` (terminal-snapshot.ts:61), so the first line is usually
		// half of something. It carries no `⚙`, so it parses to nothing — never to a half-argument
		// reported as a whole one.
		const cut = `nd/repo && npm test","description":"run"}\n  ↳ 12 passing\n⚙ Bash {"command":"ls"}\n  ↳ a.ts b.ts`;
		const calls = parseEngineToolCalls(cut);
		expect(calls).toEqual([{ tool: "Bash", input: '{"command":"ls"}', output: "a.ts b.ts", ok: null }]);
	});

	it("a raw-spawn engine yields nothing, because it writes no such framing", () => {
		// Codex/Grok are raw spawns with captured stdout — "not observed", never "nothing happened".
		expect(parseEngineToolCalls("$ npm test\n> 12 passing\n$ git status\nnothing to commit")).toEqual([]);
	});

	it("reads the engine's own verdict off the arrow — succeeded, failed, and not observed (#597)", () => {
		// The three states, and they are three different claims. The marker is welded to the arrow
		// with no space, which is what makes the third one safe (see the arm below).
		const pane = [
			'⚙ Bash {"command":"npm test"}',
			"  ↳✓ 12 passing",
			'⚙ Read {"file_path":"missing.ts"}',
			"  ↳✗ File does not exist.",
			'⚙ Bash {"command":"sleep 30"}',
		].join("\n");
		const calls = parseEngineToolCalls(pane);
		expect(calls.map((c) => c.ok)).toEqual([true, false, null]);
		// The marker is stripped from the text it prefixes — a reader gets the result, not the frame.
		expect(calls[0].output).toBe("12 passing");
		expect(calls[1].output).toBe("File does not exist.");
		// Never observed vs observed-and-failed: the pending call has no result AND no verdict.
		expect(calls[2].output).toBeNull();
	});

	it("a row written by an OLDER runner reads unknown, even when its output starts with a tick", () => {
		// AC2, and the reason the marker sits against the arrow rather than after the space. Every
		// runner up to 0.4.51 wrote `↳ <result>`, and `toolResult()` collapses the result to one
		// line — so a vitest run's `✓ src/a.test.ts` lands exactly where a space-separated marker
		// would be read. That row must report NOT OBSERVED, never a pass.
		const calls = parseEngineToolCalls('⚙ Bash {"command":"npm test"}\n  ↳ ✓ src/a.test.ts (3 tests) ✗ 0 failed');
		expect(calls[0].ok).toBeNull();
		// …and the text is delivered whole: nothing was mistaken for a frame and eaten.
		expect(calls[0].output).toBe("✓ src/a.test.ts (3 tests) ✗ 0 failed");
	});

	it("names the CLI release that writes the marker, so 'all my calls are null' has an answer", () => {
		// The pattern TURN_REPORT_MIN_CLI states: a version without a number is one somebody has to
		// go and find. It must also be a version that HAS been published — a placeholder here sends
		// a user to npm for a release that does not exist.
		expect(TOOL_OUTCOME_MIN_CLI).toMatch(/^\d+\.\d+\.\d+$/);
		const cliPkg = join(__dirname, "../../../../packages/cli/package.json");
		const cliVersion = (JSON.parse(readFileSync(cliPkg, "utf8")) as { version: string }).version;
		const cmp = (a: string, b: string) => {
			const [pa, pb] = [a.split(".").map(Number), b.split(".").map(Number)];
			for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
			return 0;
		};
		// Not equality — the CLI keeps moving and this constant must not. What it may never be is a
		// version AHEAD of the one being published, which would send a user to a release that does
		// not exist yet.
		expect(cmp(TOOL_OUTCOME_MIN_CLI, cliVersion), `${TOOL_OUTCOME_MIN_CLI} vs published CLI ${cliVersion}`).toBeLessThanOrEqual(0);
	});

	it("every production fixture predating the marker reads unknown, not success", () => {
		// The corpus this feature already serves. `ok` was added at read time, so the ~914 terminal
		// rows in D1 on the day it shipped carry no marker at all — reporting them as passes would
		// be the exact inversion #594 named, at the scale of the whole archive.
		expect(parseEngineToolCalls(PRODUCTION_PANE).map((c) => c.ok)).toEqual([null, null, null]);
	});

	it("a result marker inside a result's own text cannot rewrite the call above it", () => {
		const calls = parseEngineToolCalls('⚙ Bash {"command":"cat notes"}\n  ↳ first\n  ↳ second');
		expect(calls).toHaveLength(1);
		expect(calls[0].output).toBe("first");
	});
});

/**
 * A result is many lines from {@link RESULT_LINES_MIN_CLI} on (#700), and reading only its first
 * one would report the first line of a 34-line file read as the whole result.
 *
 * The fixtures are the runner's exact output shape — `transcript-lines.test.ts` pins the writer
 * against the same strings, which is how two declarations of one format stay honest without the
 * Worker importing the runner's Node package.
 */
describe("parseEngineToolCalls — a result that spans lines (#700)", () => {
	const multi = [
		'⚙ Read {"file_path":"web/e2e/helpers.ts"}',
		'  ↳✓ import { test } from "@playwright/test";',
		"  │ ",
		"  │ export async function login(page) {",
		'  │ \tawait page.goto("/");…[cut: 1,500 of 18,432 chars]',
		'⚙ Bash {"command":"ls"}',
		"  ↳✓ a.ts",
	].join("\n");

	it("reads every line of the result, not just the arrow line", () => {
		const calls = parseEngineToolCalls(multi);
		expect(calls).toHaveLength(2);
		expect(calls[0].output).toBe('import { test } from "@playwright/test";\n\nexport async function login(page) {\n\tawait page.goto("/");…[cut: 1,500 of 18,432 chars]');
		expect(calls[0].ok).toBe(true);
		// The continuation lines belong to the FIRST call and must not leak into the next one.
		expect(calls[1].output).toBe("a.ts");
	});

	it("reads the cut off the LAST line, and takes the figures with it", () => {
		// The old detection was `text.endsWith('…')` on the arrow line, which is now the FIRST line
		// of a long result — so a cut result would have read as a complete one, the #503 shape.
		const calls = parseEngineToolCalls(multi);
		expect(calls[0].outputCut).toBe(true);
		expect(calls[0].output).toContain("of 18,432 chars");
		expect(calls[1].outputCut).toBeUndefined();
	});

	it("still reads a bare ellipsis from a runner that states no figures", () => {
		// Every machine below RESULT_LINES_MIN_CLI, which is most of them on the day this ships.
		const calls = parseEngineToolCalls('⚙ Read {"file_path":"a.ts"}\n  ↳ export const…');
		expect(calls[0].outputCut).toBe(true);
	});

	it("drops a continuation whose own arrow line was cut away by the 8,000-char window", () => {
		// A stored row is `pane.slice(-8000)`, so a long result can begin above the window. Its
		// orphaned tail must not be appended to whatever call happens to survive above it —
		// that would attribute one call's output to another, which is worse than losing it.
		const orphan = ['  │ \tawait page.goto("/");', '⚙ Bash {"command":"ls"}', "  ↳✓ a.ts"].join("\n");
		expect(parseEngineToolCalls(orphan)).toEqual([{ tool: "Bash", input: '{"command":"ls"}', output: "a.ts", ok: true }]);
	});

	it("does not attach a continuation that follows something other than its own result", () => {
		// `inResult`: the prefix alone is not enough, because narrative lines are free text. A `│`
		// line reached after an already-answered call, or after ordinary output, is ignored.
		const stray = ['⚙ Bash {"command":"ls"}', "  ↳✓ a.ts", "[12:00:00] I have listed the files.", "  │ not part of any result"].join("\n");
		expect(parseEngineToolCalls(stray)[0].output).toBe("a.ts");
	});

	it("a call-dense row of WIDENED results still fits the per-row budget, so none is dropped", () => {
		// The consequence #700 has on this module that is not about parsing at all. `capToolCalls`
		// drops calls PERMANENTLY — no cursor reaches them — and its 12,000-byte knee was measured
		// against results the runner had already cut to 240 characters. A production row's mean is
		// 12.05 calls; at the widened cap that row serialises to ~25,000 B, so the old budget would
		// have turned a wider pane into a feed that quietly reported a fraction of the record.
		const wide = Array.from({ length: 12 }, (_, i) => ({
			tool: "Read",
			input: `{"file_path":"src/file${i}.ts"}`,
			// The renderer's ceiling, newlines included, which is what actually crosses the wire.
			output: Array.from({ length: 34 }, (_, l) => `  const marker${l} = "${"x".repeat(20)}";`).join("\n"),
			ok: true,
			outputCut: true as const,
		}));
		const { omitted } = capToolCalls(wide, FEED_TOOLCALL_BYTES);
		expect(omitted).toBe(0);
	});

	it("names the CLI release that first writes continuations, and never one ahead of it", () => {
		// Same rule as TOOL_OUTCOME_MIN_CLI: a version here that has not been published sends a
		// user to a release that does not exist.
		expect(RESULT_LINES_MIN_CLI).toMatch(/^\d+\.\d+\.\d+$/);
		const cliPkg = join(__dirname, "../../../../packages/cli/package.json");
		const cliVersion = (JSON.parse(readFileSync(cliPkg, "utf8")) as { version: string }).version;
		const parts = (v: string) => v.split(".").map(Number);
		const [a, b] = [parts(RESULT_LINES_MIN_CLI), parts(cliVersion)];
		expect(a[0] * 1e6 + a[1] * 1e3 + a[2], `${RESULT_LINES_MIN_CLI} vs published CLI ${cliVersion}`).toBeLessThanOrEqual(b[0] * 1e6 + b[1] * 1e3 + b[2]);
	});
});

describe("toolCallsForSnapshot — the cursor, at call granularity", () => {
	/** Snapshot N, then N+1 which is the same transcript plus one more call. */
	const first = '⚙ Bash {"command":"ls"}\n  ↳ a.ts\n⚙ Read {"file_path":"a.ts"}\n  ↳ export const x = 1';
	const second = `${first}\n⚙ Edit {"file_path":"a.ts"}\n  ↳ applied`;

	it("does not re-deliver the calls the previous snapshot already carried", () => {
		const one = toolCallsForSnapshot(first, null);
		expect(one.calls.map((c) => c.tool)).toEqual(["Bash", "Read"]);
		const two = toolCallsForSnapshot(second, one.anchor);
		// Without de-duplication this would be ["Bash","Read","Edit"] — the 41% of every poll that
		// production overlap re-delivers.
		expect(two.calls.map((c) => c.tool)).toEqual(["Edit"]);
		expect(two.gap).toBeUndefined();
	});

	it("delivers the in-flight call's RESULT when it arrives, which anchoring on the last call would not", () => {
		// This is the arm the obvious implementation fails. Snapshot N ends with a call whose result
		// has not come back. Anchoring on that call's identity marks it delivered, so the answer —
		// the single thing a live watcher is waiting for — never reaches the reader.
		const pending = '⚙ Bash {"command":"ls"}\n  ↳ a.ts\n⚙ Bash {"command":"npm test"}';
		const settled = '⚙ Bash {"command":"ls"}\n  ↳ a.ts\n⚙ Bash {"command":"npm test"}\n  ↳ 12 passing';
		const one = toolCallsForSnapshot(pending, null);
		expect(one.calls.map((c) => c.output)).toEqual(["a.ts", null]);
		// The anchor is the last SETTLED call, so the pending one is still ahead of the cursor.
		expect(one.anchor).toEqual({ tool: "Bash", input: '{"command":"ls"}', output: "a.ts", ok: null });
		const two = toolCallsForSnapshot(settled, one.anchor);
		expect(two.calls).toEqual([{ tool: "Bash", input: '{"command":"npm test"}', output: "12 passing", ok: null }]);
	});

	it("a command the engine genuinely ran twice is delivered twice", () => {
		// Value de-duplication (a Set of tool+input) would collapse these into one and under-report
		// what the run did. The anchor is positional, so the repeat survives.
		const repeated = '⚙ Bash {"command":"git status"}\n  ↳ clean\n⚙ Bash {"command":"git status"}\n  ↳ clean';
		const out = toolCallsForSnapshot(repeated, null);
		expect(out.calls).toHaveLength(2);
		// …and resuming from it takes the LAST occurrence, not the first: anchoring on the first
		// would replay the second on every subsequent poll.
		const next = toolCallsForSnapshot(`${repeated}\n⚙ Bash {"command":"ls"}\n  ↳ a.ts`, out.anchor);
		expect(next.calls.map((c) => c.input)).toEqual(['{"command":"ls"}']);
	});

	it("says so when the anchor scrolled out of the window rather than pretending continuity", () => {
		// 35 of 86 rows on the sampled production session: the engine did more than 8,000 chars of
		// work between two snapshots, so the previous anchor is simply not in this one. Some calls
		// are missing from the record entirely, and a reader is told that instead of inferring it.
		const out = toolCallsForSnapshot(second, { tool: "Bash", input: '{"command":"long gone"}', output: "x", ok: null });
		expect(out.gap).toBe(true);
		expect(out.calls).toHaveLength(3);
	});

	it("a snapshot with no calls does not clear the anchor", () => {
		// A bare prompt line says nothing about continuity. Clearing on it would report a gap — and
		// re-deliver a whole window — on the next row that carries anything.
		const one = toolCallsForSnapshot(first, null);
		const blank = toolCallsForSnapshot("\n❯ [14:20:57] Please read GitHub issue #57", one.anchor);
		expect(blank.calls).toEqual([]);
		expect(blank.anchor).toEqual(one.anchor);
	});
});

describe("capToolCalls", () => {
	const many: EngineToolCall[] = Array.from({ length: 12 }, (_, i) => ({
		tool: "Bash",
		input: `{"command":"${"x".repeat(150)}${i}"}`,
		output: "y".repeat(240),
		ok: true,
	}));

	it("keeps the NEWEST calls and says how many it dropped", () => {
		// An explicit small budget, not FEED_TOOLCALL_BYTES: this arm is about the function, and a
		// constant sized so the cap almost never fires would make it assert nothing.
		const { calls, omitted } = capToolCalls(many, 1_600);
		expect(calls.length + omitted).toBe(12);
		expect(omitted).toBeGreaterThan(0);
		// The tail, for the same reason a terminal row keeps its tail: the live end is the question.
		expect(calls[calls.length - 1]).toEqual(many[11]);
	});

	it("a full production row fits the configured budget without dropping anything", () => {
		// 12.05 calls per row is the production mean, and FEED_TOOLCALL_BYTES is sized for it so that
		// omission — the one loss no cursor can undo — is reserved for an abnormal row.
		expect(capToolCalls(many, FEED_TOOLCALL_BYTES).omitted).toBe(0);
	});

	it("is measured on the serialised bytes, not on a character count", () => {
		// #569's lesson at row level: the assertion has to sit where the escaping happens.
		const { calls } = capToolCalls(many, 1_600);
		const bytes = new TextEncoder().encode(JSON.stringify(calls)).length;
		expect(bytes).toBeLessThanOrEqual(1_600 + 64);
	});

	it("always emits one call, so a single huge call cannot stall the record", () => {
		const huge: EngineToolCall = { tool: "Bash", input: "z".repeat(50_000), output: null, ok: null };
		expect(capToolCalls([huge], 10).calls).toHaveLength(1);
	});
});

describe("the feed delivers each tool call exactly once, over the real schema", () => {
	let db: RealSchemaD1;
	let env: Env;
	const SESSION = "csess_toolcalls";

	beforeEach(() => {
		db = realSchemaD1();
		seedTenant(db, { userId: "u1", instanceIds: ["i1"] });
		db.exec("INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES ('repo-1', 'i1', 'u1', 'demo')");
		db.exec(
			`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, tmux_session)
			 VALUES ('${SESSION}', 'i1', 'repo-1', 'u1', 'active', 'claude:${SESSION}')`,
		);
		env = { DB: db.DB } as unknown as Env;
	});

	const snap = (content: string) => appendTimeline(env, { sessionId: SESSION, instanceId: "i1", userId: "u1", type: "terminal", content });

	it("two overlapping snapshots across two polls yield each call once", async () => {
		// The production shape: snapshot 2 CONTAINS snapshot 1, plus one new call. Poll 1 reads the
		// first row; poll 2 resumes from its cursor and must find only the new call — including
		// across the page boundary, which is what `anchorAt` exists for.
		const one = '⚙ Bash {"command":"ls"}\n  ↳ a.ts\n⚙ Read {"file_path":"a.ts"}\n  ↳ export const x = 1';
		await snap(one);
		const page1 = await loadTimelineFeed(env, { sessionId: SESSION });
		expect(page1.events[0].toolCalls?.map((c) => c.tool)).toEqual(["Bash", "Read"]);

		await snap(`${one}\n⚙ Edit {"file_path":"a.ts"}\n  ↳ applied`);
		const page2 = await loadTimelineFeed(env, { sessionId: SESSION, sinceSeq: page1.nextSeq });
		// Before this change the second page carried a 400-char tail and nothing structured; without
		// the cross-page anchor it would carry all three calls again.
		expect(page2.events).toHaveLength(1);
		expect(page2.events[0].toolCalls?.map((c) => c.tool)).toEqual(["Edit"]);
		expect(page2.events[0].toolCalls?.[0].output).toBe("applied");
	});

	it("carries the call's outcome to the reader, and reports null for an old-runner row (#597)", async () => {
		// End to end over the real schema, because the field is only worth anything if it survives
		// the feed: parse → cap → JSON. A new-runner snapshot and an old-runner one in the same
		// session, which is exactly what a machine mid-upgrade produces.
		await snap('⚙ Bash {"command":"npm test"}\n  ↳✓ 12 passing\n⚙ Read {"file_path":"x.ts"}\n  ↳✗ File does not exist.');
		const page = await loadTimelineFeed(env, { sessionId: SESSION });
		expect(page.events[0].toolCalls?.map((c) => c.ok)).toEqual([true, false]);
		// `null` is SERIALISED, not dropped: a model told to check `ok` reads an absent key as fine,
		// which is the inversion this field exists to prevent.
		await snap('⚙ Bash {"command":"git push"}\n  ↳ ! [rejected] main -> main');
		const page2 = await loadTimelineFeed(env, { sessionId: SESSION, sinceSeq: page.nextSeq });
		expect(JSON.stringify(page2.events[0].toolCalls)).toContain('"ok":null');
	});

	it("a raw-engine snapshot carries no toolCalls key at all", async () => {
		await snap("$ npm test\n> 12 passing");
		const page = await loadTimelineFeed(env, { sessionId: SESSION });
		expect(page.events[0].toolCalls).toBeUndefined();
		// The narrative is untouched — the tail is still there, which is what #580's engine error
		// arrives as.
		expect(page.events[0].content).toContain("12 passing");
	});

	it("a page of call-bearing snapshots fits the wire limit, measured on the serialised page", async () => {
		// The denominator, per ADR 0002, and the WORST case rather than a comfortable one. Every row
		// carries twelve calls that share nothing with the row before it, so de-duplication removes
		// nothing — the opposite of production, where 41% is removed.
		//
		// The first version of this arm reused one call block for all 40 rows and measured 25,185 B
		// across a full 40-row page. It was measuring the de-duplicator, not the payload: rows 2-40
		// emitted zero calls because their calls were byte-identical to row 1's. That is #569's
		// mistake in a new place — an assertion that passes because it is pointed at the wrong thing —
		// and it is written down here because it nearly shipped again.
		for (let r = 0; r < 40; r++) {
			const calls = Array.from(
				{ length: 12 },
				(_, i) => `⚙ Bash {"command":"r${r}c${i}${"x".repeat(140)}"}\n  ↳ ${"y".repeat(230)}`,
			).join("\n");
			await snap(`run ${r}\n${calls}`);
		}
		const page = await loadTimelineFeed(env, { sessionId: SESSION });
		const bytes = new TextEncoder().encode(JSON.stringify(page)).length;
		// Measured: 7 events, 39,973 B against the 65,536 B limit the host in #569 applied.
		expect(bytes, `page of ${page.events.length} of 40 worst-case snapshots`).toBeLessThan(64 * 1024);
		// The PAGE bound is what cut it, and it said so — which is the whole point of sizing
		// FEED_TOOLCALL_BYTES generously: a dropped row costs a poll, a dropped call is gone.
		expect(page.hasMore).toBe(true);
		expect(page.events.length).toBeGreaterThan(0);
		for (const ev of page.events) {
			expect(ev.toolCalls).toHaveLength(12);
			expect(ev.toolCallsOmitted).toBeUndefined();
		}
	});
});
