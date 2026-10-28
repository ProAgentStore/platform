/**
 * #1224 — an `ask_owner` never reaches the owner as a headline with its choices gone. Run 57d1fa2d
 * asked a three-way choice twice with `options: []` (every option was over the old 80-character
 * drop); TradePort run 78971d03 parked "Two decisions needed …:" with no options and no parts. The
 * dropped text was unrecoverable: the session had ended and `coding_terminal` held no snapshot.
 */
import { describe, expect, it } from "vitest";
import { getLoopRun, recordLiveness, type WaitingAsk } from "./agent-loop-store.js";
import { ASK_OPTION_MAX, ASK_QUESTION_MAX, askAnnouncement, askOptions, whyBeyond } from "./coding-ask.js";
import { runCodingLoop, toDecision, type CodingDeps, type CodingPaneSnapshot } from "./coding-loop.js";
import { realSchemaD1, seedTenant } from "./d1-sqlite.js";
import type { Env } from "../types.js";

const ask = (args: Record<string, unknown>) => toDecision({ name: "ask_owner", arguments: args }).needsInput;

// The shape of #1057's options: each a sentence explaining what it means, all well over 80 characters.
const LONG = [
	"Collapse the four native tools into one native_control tool with an action enum, which keeps us inside the #569 listing budget",
	"Keep the four tools but gate them behind the native surface so a connection without it never lists them at all",
	"Raise the #569 budget by the four tools' share and record why in the tool-count ceiling, accepting the larger listing",
];

describe("long options are kept, not dropped (#1224)", () => {
	it("three sentence-long options all reach the owner, whole, with nothing marked lost", () => {
		for (const o of LONG) expect(o.length).toBeGreaterThan(80);
		const d = ask({ question: "How should the native tools fit the listing budget?", options: LONG, why: "#569 caps the listing" });
		expect(d?.options).toEqual(LONG.map((o) => o.replace(/,/g, ";")));
		expect(d).not.toHaveProperty("fullQuestion");
	});

	it("an option past the bound is clipped with a marker, and the ask as written keeps it whole", () => {
		const huge = `Rewrite the listing ${"budget arithmetic ".repeat(25)}end.`;
		expect(huge.length).toBeGreaterThan(ASK_OPTION_MAX);
		const d = ask({ question: "Which way?", options: [huge, "Leave it"] });
		expect(d?.options).toHaveLength(2);
		expect(d?.options?.[0].length).toBeLessThanOrEqual(ASK_OPTION_MAX);
		expect(d?.options?.[0]).toMatch(/\[cut: showing the first \d+ of \d+ characters\]$/);
		expect(d?.fullQuestion).toBe(`Which way?\n- ${huge}\n- Leave it`);
		expect(askOptions([huge, huge, "x"])).toHaveLength(2); // a clipped duplicate is still one option
	});

	it("parts whose options are long survive — the TradePort shape — instead of collapsing to no options at all", () => {
		const d = ask({
			question: "Two decisions needed before implementing product video (issue #53 slice):",
			parts: [
				{ question: "Where does the video live?", options: ["In the product page hero, autoplaying muted with a poster frame so the page still loads fast", "Behind a play button below the gallery, loaded only when the visitor taps it"] },
				{ question: "What lands in this PR?", options: ["Only the player and the upload field; transcoding and captions are follow-up issues", "Player, upload and server-side transcoding together, with captions as a follow-up"] },
			],
		});
		expect(d?.parts).toHaveLength(2);
		expect(d?.parts?.[0].options[0]).toContain("autoplaying muted");
		expect(d).not.toHaveProperty("fullQuestion");
		expect(d).not.toHaveProperty("incomplete");
	});
});

describe("a multi-line question keeps every line (#1224)", () => {
	it("a short one travels whole as the question", () => {
		const q = "Two things before I go on:\n1. Keep the old endpoint?\n2. Bump the major version?";
		expect(ask({ question: q, options: ["Keep it and bump", "Drop it and bump"] })?.field).toBe(q);
	});

	it("a long one is cut to phone size, and the uncut ask has every line", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `${i + 1}. A consideration the owner needs before choosing, number ${i + 1}.`);
		const q = ["Before I choose, read these:", ...lines].join("\n");
		const d = ask({ question: q, options: ["Proceed", "Stop"] });
		expect(d?.field.length).toBeLessThanOrEqual(ASK_QUESTION_MAX);
		for (const l of lines) expect(d?.fullQuestion).toContain(l);
		expect(d?.fullQuestion).toBe(q); // the options are intact — their buttons say them, so they are not repeated
	});
});

describe("a question that introduces choices and has none (#1224)", () => {
	it("when the choices were in the call but did not survive, the question becomes the ask as written", () => {
		const d = ask({ question: "Two decisions needed:", parts: [{ question: "Where?", options: ["Hero", 3] }, { question: "When?", options: [null] }] });
		expect(d?.options).toEqual([]);
		expect(d?.fullQuestion).toBe("Two decisions needed:\n1. Where?\n   - Hero\n2. When?");
		expect(d?.field).toBe(d?.fullQuestion);
		expect(d).not.toHaveProperty("incomplete");
	});

	it("when it never had any, it is marked incomplete — and a question that does not introduce choices is not", () => {
		expect(ask({ question: "Two decisions needed before I implement this:" })).toMatchObject({ options: [], incomplete: true });
		expect(ask({ question: "What should the release be called?" })).not.toHaveProperty("incomplete");
	});

	it("the loop sends an incomplete ask back once, then parks the second free-form", async () => {
		const idle: CodingPaneSnapshot = { pane: "❯ ", runState: "idle", ready: true, alive: true };
		const seen: string[][] = [];
		const deps: CodingDeps = {
			snapshot: async () => idle,
			waitIdle: async () => idle,
			act: async () => idle,
			decide: async (input) => {
				seen.push([...input.actionLog]);
				return toDecision({ name: "ask_owner", arguments: { question: "Two decisions needed:" } });
			},
		};
		const r = await runCodingLoop(deps, { objective: "x", repo: "demo", clientType: "claude" });
		expect(seen).toHaveLength(2);
		expect(seen[1].at(-1)).toMatch(/^ask_owner not sent: "Two decisions needed:" introduces choices but gave no options/);
		expect(r).toMatchObject({ outcome: "needs_input", fieldNeeded: "Two decisions needed:" });
	});
});

describe("the uncut ask reaches every reader (#1224)", () => {
	it("the issue comment / coder question announces the ask as written", () => {
		expect(askAnnouncement({ question: "Which?", fullQuestion: "Which?\n- the long first option\n- the second" })).toBe("Which?\n- the long first option\n- the second");
	});

	it("whyBeyond: the issue comment prints a why only when the announced question does not already say it (#1261)", () => {
		const report = "What it did: edited a.ts\n\nBlocker: build fails\n\nPlan: add the dependency";
		// An iteration-cap ask carries its report as the uncut question AND as the why; the comment shows it once.
		expect(whyBeyond(`This run reached its cap.\n\n${report}`, report)).toBeNull();
		// An ordinary ask's why is a separate thought and still gets its line.
		expect(whyBeyond("Which table layout?", "denser list")).toBe("denser list");
		expect(whyBeyond("Which table layout?", "  denser list  ")).toBe("denser list");
		expect(whyBeyond("Which table layout?", "")).toBeNull();
		expect(whyBeyond("Which table layout?", null)).toBeNull();
		expect(whyBeyond("Which table layout?", undefined)).toBeNull();
	});

	it("coding_loop_status's run view keeps the uncut question and the parts the park stored — it dropped them on read", async () => {
		const db = realSchemaD1();
		seedTenant(db, { userId: "u1", instanceIds: ["i1"] });
		db.exec("INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, iteration, max_iterations, started_at) VALUES ('r1','u1','i1','x','running',1,10,1)");
		const env = { DB: db.DB } as unknown as Env;
		const stored: WaitingAsk = {
			question: "Two decisions needed:",
			options: [],
			why: "",
			field: "Two decisions needed:",
			taskId: "csess-csess_s1",
			fullQuestion: "Two decisions needed:\n1. Where?\n   - Hero\n2. When?",
			parts: [{ question: "Where?", options: ["Hero", "Gallery"] }, { question: "When?", options: ["Now", "Later"] }],
		};
		await recordLiveness(env, "r1", 2_000, { reason: "decision", ask: stored });
		expect((await getLoopRun(env, "u1", "r1"))?.waitingAsk).toEqual(stored);
	});
});
