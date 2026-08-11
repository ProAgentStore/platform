import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toolBlurbFor, withPartialToolLog } from "./agent-think.js";
import { findCalls, matchLines, stripCommentsAndLiterals } from "./lib/source-guard.js";
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

describe("the subscriber's configured repo reaches the agent (#494)", () => {
	// The whole ticket, as one measurement: `grep -c githubRepo agent-think.ts` returned 0. The
	// repo had exactly one reader (`instances-deploy.ts`, for the console), so an Operator asked
	// which repository it worked on answered from memory and got it wrong, and asked twice more for
	// a value its owner had already saved. This is #255's rule — console-only state is invisible to
	// the agent — and #488 added the third store to break it.
	it("builds the block from the shared module, not inline", () => {
		expect(findCalls(THINKER_CODE, "deploymentContext")).toHaveLength(1);
	});

	it("passes the instance config, which is where the console wrote the repo", () => {
		// The reader has to be on the INSTANCE config specifically: the value is per-subscriber
		// (`patchInstanceConfig(... "githubRepo" ...)`), so reading the agent template's config
		// would resolve to nothing for every real instance and look wired.
		expect(matchLines(THINKER_CODE, /deploymentContext\(env, userId, instanceCfg,/)).toHaveLength(1);
	});

	it("hands it the turn's clock and the owner's zone, so the build's age is stated not computed", () => {
		// A build line without an age is read as "now", which is how a 13-hour-old success became
		// the answer to "was it deployed?". #329's rule: format the absolute time here rather than
		// letting the model convert it.
		expect(matchLines(THINKER_CODE, /deploymentContext\([^)]*now: turnStartedAt, timeZone: ownerTimeZone/)).toHaveLength(1);
	});
});

describe("memory is rendered with its provenance and age (#495)", () => {
	// The instance carried "Write access to terminal connector is not enabled" — false 84 seconds
	// after it was written, still injected four days later — in the same prompt as
	// "[write — consent GRANTED, you may call this]". The old inline loop emitted
	// `- [type] key: content` with a `(user-set)` marker and NO date, so two contradictory claims
	// arrived on equal terms.
	it("builds the block from the shared renderer, not an inline loop", () => {
		expect(findCalls(THINKER_CODE, "memoryPrompt")).toHaveLength(1);
		// The pre-fix line, which is what a later edit would most naturally reintroduce. Over the
		// RAW file deliberately: `stripCommentsAndLiterals` blanks string BODIES, so
		// `m.source === "user" ? " (user-set)" : ""` strips to `m.source === "    " ? …` and the
		// assertion would pass against the stripped source even with the old loop still present.
		expect(THINKER).not.toMatch(/m\.source === "user" \? " \(user-set\)" : ""/);
	});

	it("passes the turn's clock and the owner's zone, so the age is stated not computed", () => {
		expect(matchLines(THINKER_CODE, /memoryPrompt\(memory, \{ now: turnStartedAt, timeZone: ownerTimeZone/)).toHaveLength(1);
	});

	it("still self-heals stray behaviour keys afterwards (#226)", () => {
		// behaviourStrayPrompt stayed at the call site rather than moving into the renderer: it is a
		// one-time migration for entries written before the Behaviour tab existed, not a statement
		// about provenance. Dropping it while moving the loop would be a silent regression.
		expect(findCalls(THINKER_CODE, "behaviourStrayPrompt")).toHaveLength(1);
	});
});

// ── #398: a tool result arrives as the PLATFORM's block, never as the model's prose ──
//
// The loop used to append `{role:"assistant", content:"I called tools:\n…"}` and never append the
// model's `tool_use` turn at all. Ground truth lived in the one role that means "the model's own
// words", which is the convention #395's fabrication imitated — the model reproduced the format it
// was shown every single turn. The shape of the fix is asserted over the source because the
// regression is a REVERT to something that reads perfectly well: two `aiMessages.push` calls of
// plain strings.
describe("tool results are the platform's blocks, not the assistant's words (#398)", () => {
	// These read the RAW file: `stripCommentsAndLiterals` blanks string bodies, so `role: "user"`
	// survives as `role: "    "` and a rule about which ROLE carries the blocks cannot be written
	// against the lexed form.
	it("appends the provider's own assistant turn, blocks intact", () => {
		expect(THINKER).toContain('aiMessages.push({ role: "assistant", content: rawResult.contentBlocks })');
	});

	it("answers it with a USER turn of tool_result blocks — never an assistant one", () => {
		// The role is the whole point. `invented-results.ts` proves a fabrication by construction
		// from the fact that the platform never writes result markup into an ASSISTANT message; put
		// these blocks on an assistant turn and that proof is gone along with the fix.
		expect(THINKER).toMatch(/aiMessages\.push\(\{\s*role:\s*"user",\s*content:\s*toolResultTurn\(/);
		expect(THINKER).not.toMatch(/role:\s*"assistant",\s*content:\s*toolResultTurn\(/);
	});

	it("takes the ids from the assistant turn, not from the normalized call list", () => {
		// `normalizeToolCalls` skips a call with malformed arguments; its `tool_use` block stays in
		// the turn, and an unanswered id makes the provider reject the whole request.
		expect(findCalls(THINKER_CODE, "toolUseIdsOf")).toHaveLength(1);
		expect(findCalls(THINKER_CODE, "toolResultTurn")).toHaveLength(1);
	});

	it("keeps the prose shape ONLY as the no-blocks fallback", () => {
		// Workers AI does not speak this protocol, and its limitation must not set the format for
		// `claude-sonnet-4-6`, which is what almost every chat actually runs on. One occurrence: any
		// second one is the unconditional path coming back.
		expect(THINKER.split("I called tools:").length - 1).toBe(1);
	});

	it("still DEFINES the tools on the two prose-only completions", () => {
		// The final answer and #395's correction round send no tools, which is how they discourage
		// another round. Once the transcript holds tool blocks the provider rejects that outright —
		// a 400 on the whole turn, not a worse reply. Both must go through `proseOnly()`.
		// matchLines, not findCalls: the call sites spread it (`...proseOnly()`), and findCalls's
		// lookbehind — which is what stops `stub.fetch(` matching `fetch(` — rejects the leading dot.
		expect(matchLines(THINKER_CODE, /proseOnly\(\)/g)).toHaveLength(2);
		expect(findCalls(THINKER_CODE, "hasToolBlocks")).toHaveLength(1);
	});

	it("records every call's outcome against its id, including refusals and de-duplicated repeats", () => {
		// An id with no entry is answered by a placeholder, so a miss degrades one result instead of
		// failing the request — but a refusal that never reaches the map is a result the model is
		// told the platform did not run, which is a different and false fact.
		expect(findCalls(THINKER_CODE, "record").length).toBeGreaterThanOrEqual(3);
	});
});

// ── #442: a failed tool round is resumable ──────────────────────────────────────────
//
// The decisions live in `lib/resumable-round.ts` and are unit-tested there. What CANNOT be
// unit-tested is the wiring: `runAgentThink` needs D1, a Durable Object and a provider, so these
// are source assertions for the same reason every other guard in this file is one. Each of them
// fails on a specific wrong fix, and each of those wrong fixes is invisible in review.
describe("a failed round is resumable, and resuming does not re-run the tool (#442)", () => {
	it("BOTH provider-failure exits offer a resumable round", () => {
		// There are exactly two: the per-round completion at the top of the loop, and the final
		// answer. The final one is the most valuable — every tool has run and only the generation
		// failed — and it is also the one a reader is most likely to miss, because it sits after
		// the loop rather than in it.
		expect(matchLines(THINKER_CODE, /withResumableRound\(/g)).toHaveLength(2);
		// Wrapped AROUND withPartialToolLog rather than replacing it: #427 praised the partial-log
		// behaviour and #442 requires resumption to be purely additive.
		expect(matchLines(THINKER_CODE, /withResumableRound\(withPartialToolLog\(/g)).toHaveLength(2);
	});

	it("a round is recorded only after the whole round settled, and only in the structured shape", () => {
		// Recording before the tools settle stores a `tool_result` for work that may not have
		// happened — resuming it would SKIP a write whose result was never recorded, which is the
		// duplicate-side-effect hazard facing the other way.
		//
		// One push site, on the `tool_use` branch. The prose fallback must NOT be resumable: it is
		// the `I called tools:` shape #398 removed from the live path, and replaying it would
		// re-teach the format #395's fabrication imitated.
		expect(findCalls(THINKER_CODE, "roundMessages.push")).toHaveLength(1);
	});

	it("a resumed turn continues the round budget instead of restarting it", () => {
		// `for (let round = 0; …)` on a resumed turn hands a retry eight fresh rounds on top of the
		// ones already paid for — the opposite of the ticket, which is about not paying twice.
		expect(THINKER_CODE).toMatch(/for \(let round = resume\?\.roundsUsed \?\? 0;/);
	});

	it("seeds the dedup map from the resumed round, so a WRITE cannot run twice", () => {
		// This is the criterion the ticket cares most about. The in-turn dedup is scoped to ONE
		// request and cannot see the previous one, so without seeding, a retry of a round whose
		// tools were writes re-commits the side effects. A `new Map()` here is the obvious wrong
		// fix and is silent — reads merely cost money again, writes duplicate.
		expect(THINKER_CODE).toMatch(/new Map<string, number>\(resume\?\.executed \?\? \[\]\)/);
		expect(THINKER_CODE).toMatch(/mutations = resume\?\.mutations \?\? 0/);
	});

	it("carries the failed attempt's executed tools into #395's ground truth", () => {
		// `honestReply` audits the model's text against what actually ran. A resumed turn whose
		// answer cites `github_read_issue` — correctly, from a real result — would be corrected as
		// a fabrication if the executed list started empty.
		expect(THINKER_CODE).toMatch(/executedTools: string\[\] = \[\.\.\.\(resume\?\.executedTools \?\? \[\]\)\]/);
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
