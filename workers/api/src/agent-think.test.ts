import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toolBlurbFor, withPartialToolLog } from "./agent-think.js";
import { findCalls, stripCommentsAndLiterals } from "./lib/source-guard.js";
import type { AgentCapabilities } from "./lib/agent-capabilities.js";

/** agent-think.ts as written, and with comments/strings blanked (line numbers preserved). */
const THINKER = readFileSync(new URL("./agent-think.ts", import.meta.url).pathname, "utf-8");
const THINKER_CODE = stripCommentsAndLiterals(THINKER);

describe("withPartialToolLog (#24 — surface committed side effects on a late failure)", () => {
	it("attaches the completed tool log to an Error and returns the same error", () => {
		const err = new Error("provider exploded mid-turn");
		const out = withPartialToolLog(err, ["✅ **create_task** done"]);
		expect(out).toBe(err);
		expect((err as { partialToolLog?: string[] }).partialToolLog).toEqual(["✅ **create_task** done"]);
	});

	it("no-ops when nothing succeeded (empty tool log)", () => {
		const err = new Error("failed on round 0");
		withPartialToolLog(err, []);
		expect((err as { partialToolLog?: string[] }).partialToolLog).toBeUndefined();
	});

	it("preserves the error's own type/status (creds/provider errors still propagate)", () => {
		const err = Object.assign(new Error("bad creds"), { status: 401 });
		const out = withPartialToolLog(err, ["✅ **insert_record** ok"]) as {
			status?: number;
			partialToolLog?: string[];
		};
		expect(out.status).toBe(401);
		expect(out.partialToolLog).toEqual(["✅ **insert_record** ok"]);
	});

	it("tolerates a non-object error without throwing", () => {
		expect(() => withPartialToolLog("string error", ["✅ x"])).not.toThrow();
		expect(withPartialToolLog("string error", ["✅ x"])).toBe("string error");
	});
});

describe("toolBlurbFor (declared tools must not be described as tools the agent lacks)", () => {
	const caps = (over: Partial<AgentCapabilities>): AgentCapabilities =>
		({ surfaces: [], runtime: null, workflow: null, ...over }) as AgentCapabilities;

	// The regression: Local Repo Chat declares tools and NO surface. It fell through to the
	// generic blurb, was told it could "search your knowledge", and concluded its repo tools
	// needed an index first — so it refused to read a repo it could already read.
	it("a declared-tools agent with no surface is never told it can search knowledge", () => {
		const blurb = toolBlurbFor(caps({ tools: ["repo_tree", "repo_read_file"] }));
		expect(blurb).not.toContain("search your knowledge");
		expect(blurb).not.toContain("collections");
		expect(blurb).toContain("exactly what you have");
	});

	it("tells a declared-tools agent not to invent a prerequisite setup step", () => {
		const blurb = toolBlurbFor(caps({ tools: ["repo_tree"] }));
		expect(blurb).toMatch(/indexing|ingestion/);
	});

	// A declared allowlist wins over the surface, since the allowlist is what actually gates.
	it("prefers the declared list over a surface that would describe different tools", () => {
		expect(toolBlurbFor(caps({ surfaces: ["repo"], tools: ["repo_tree"] }))).toContain("exactly what you have");
	});

	it("keeps the surface-derived blurbs for legacy agents that declare no tools", () => {
		expect(toolBlurbFor(caps({ surfaces: ["repo"] }))).toContain("indexed repositories");
		expect(toolBlurbFor(caps({ surfaces: ["coding"] }))).toContain("live terminal");
		expect(toolBlurbFor(caps({}))).toContain("search your knowledge");
		// An empty declared list is "declared nothing", not "declared" — must not win.
		expect(toolBlurbFor(caps({ tools: [] }))).toContain("search your knowledge");
	});
});

// ── #397: every chat completion names its own output cap ────────────────────────────
//
// The defect was not that 1024 is small — it is that chat was the ONE caller of
// `runUserWorkersAi` that never chose, so it inherited a number picked for nothing and every
// reply a human reads end to end was cut at ~4,000 characters. There is nothing about a
// four-argument call with no `maxTokens` that looks wrong in review, and this path has four
// completions in it (tool-less, per round, the #395 correction, the final answer). So the rule
// is asserted over the SOURCE: one wrapper, and the cap and the stop-reason read live in it.
describe("chat completions are capped and their stop reason is read (#397)", () => {
	it("agent-think.ts calls the provider through exactly ONE wrapper", () => {
		const calls = findCalls(THINKER_CODE, "runUserWorkersAi").map((h) => `agent-think.ts:${h.line} ${h.excerpt}`);
		expect(
			calls,
			"Route the completion through `chatComplete`, the single wrapper that sets maxTokens and\n" +
				"reads stopReason (#397). A second direct call site inherits the 1024 default and its reply\n" +
				`is truncated with nothing saying so.\nOffenders:\n${calls.join("\n")}`,
		).toHaveLength(1);
	});

	it("that wrapper sets an explicit cap and reads the provider's stop reason", () => {
		expect(THINKER_CODE).toContain("maxTokens: CHAT_MAX_TOKENS");
		expect(findCalls(THINKER_CODE, "hitOutputCap").length).toBeGreaterThan(0);
	});

	it("both delivery exits carry the truncation notice, not just the tool-using one", () => {
		// A tool-less agent's reply is the longest kind on this platform (no tool log to break it
		// up) and it returns from a different line. Shipping the notice on one exit only is the
		// obvious half-fix: it passes a happy-path test and hides the cut on the surface most
		// likely to hit it.
		expect(findCalls(THINKER_CODE, "withTruncation")).toHaveLength(2); // the tool-less exit + `deliver`
	});

	it("the cap is a named constant, not a literal spelled at the call site", () => {
		// A literal is how the four call sites drifted apart in the first place.
		expect(THINKER_CODE).not.toMatch(/maxTokens:\s*\d/);
	});
});

// ── #399: the connector list carries the RESOLVED consent, not the rule ─────────────
//
// The block used to render `[write — needs the connector's consent]` unconditionally, so a tmux
// agent whose four write tools were all `writeConsent:"granted"` refused the work and sent its
// owner to enable a setting that was already on. The prompt is built from data now
// (lib/connector-tool-prompt.ts, tested there); what this asserts is that agent-think still
// FETCHES the fact — the regression that turns the whole thing back into a rule is dropping the
// consent read and passing an empty list, which type-checks and labels every write tool blocked.
describe("connector tools are described with the instance's real consent (#399)", () => {
	it("builds the block from the shared renderer instead of inline string concatenation", () => {
		expect(findCalls(THINKER_CODE, "connectorToolsPrompt")).toHaveLength(1);
	});

	it("reads the instance's consent rows at prompt-build time", () => {
		expect(findCalls(THINKER_CODE, "listConsents")).toHaveLength(1);
	});

	it("never states the gate as an unconditional rule again", () => {
		// Over the RAW file, comments included: the sentence is the defect, and a copy of it left in
		// a comment next to a call site is one revert away from being live again.
		expect(THINKER).not.toContain("[write — needs the connector's consent]");
	});
});

describe("cross-round dedup — a read repeats only when something CHANGED", () => {
	// The rule is stated in agent-think.ts and worth pinning as data, because getting it wrong is
	// invisible in both directions:
	//   too strict → `read_terminal` after `send_to_cli` is refused, so the model describes the
	//                PRE-send pane as the outcome (and `get_tasks` says "no tasks" right after
	//                create_task);
	//   too loose  → the model re-runs the same pure read every round until the cap, which also
	//                removes the loop's stopping condition. Seen live on the Coder Lead:
	//                `list_subordinates` ran 1×, then 2×, then 3× in one turn for the same rows.
	function replay(calls: Array<{ name: string; read: boolean }>): string[] {
		const READ = new Set(calls.filter((c) => c.read).map((c) => c.name));
		const executed = new Map<string, number>();
		let mutations = 0;
		const outcome: string[] = [];
		for (const c of calls) {
			const sig = `${c.name}:{}`;
			const isRead = READ.has(c.name);
			const ranAt = executed.get(sig);
			if (ranAt !== undefined && !(isRead && mutations > ranAt)) {
				outcome.push("refused");
				continue;
			}
			executed.set(sig, mutations);
			if (!isRead) mutations++;
			outcome.push("ran");
		}
		return outcome;
	}

	it("refuses a pure read repeated with NOTHING in between", () => {
		expect(replay([
			{ name: "list_subordinates", read: true },
			{ name: "list_subordinates", read: true },
			{ name: "list_subordinates", read: true },
		])).toEqual(["ran", "refused", "refused"]);
	});

	it("ALLOWS the same read once a mutating tool has run", () => {
		expect(replay([
			{ name: "read_terminal", read: true },
			{ name: "send_to_cli", read: false },
			{ name: "read_terminal", read: true },
		])).toEqual(["ran", "ran", "ran"]);
	});

	it("refuses a second read after the mutation, until the next REAL mutation", () => {
		// The 5th call is a duplicate create_task, correctly refused — and because it never ran,
		// nothing changed, so the read after it is refused too. A refused mutation must not count
		// as a change, or the pair would ping-pong: read, blocked-write, read, blocked-write…
		expect(replay([
			{ name: "get_tasks", read: true },
			{ name: "create_task", read: false },
			{ name: "get_tasks", read: true },
			{ name: "get_tasks", read: true },
			{ name: "create_task", read: false },
			{ name: "get_tasks", read: true },
		])).toEqual(["ran", "ran", "ran", "refused", "refused", "refused"]);
	});

	it("a DIFFERENT mutation re-opens the read", () => {
		expect(replay([
			{ name: "get_tasks", read: true },
			{ name: "create_task", read: false },
			{ name: "get_tasks", read: true },
			{ name: "update_task", read: false },
			{ name: "get_tasks", read: true },
		])).toEqual(["ran", "ran", "ran", "ran", "ran"]);
	});

	it("never lets a MUTATION repeat, whatever happened in between", () => {
		// The original guard's whole purpose: three identical job tasks from one turn.
		expect(replay([
			{ name: "create_task", read: false },
			{ name: "read_terminal", read: true },
			{ name: "create_task", read: false },
		])).toEqual(["ran", "ran", "refused"]);
	});
});
