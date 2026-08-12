import { describe, expect, it } from "vitest";
import {
	CODING_TOOLS,
	runCodingLoop,
	systemPrompt,
	toDecision,
	type CodingDecision,
	type CodingDeps,
	type CodingGoal,
	type CodingPaneSnapshot,
} from "./coding-loop.js";

const GOAL: CodingGoal = { objective: "add a test", repo: "demo", clientType: "claude" };

/** Build deps that return a scripted sequence of decisions; record actions sent. */
function harness(decisions: CodingDecision[], paneState: Partial<CodingPaneSnapshot> = {}) {
	const idle: CodingPaneSnapshot = { pane: "❯ ", runState: "idle", ready: true, alive: true, ...paneState };
	const sent: string[] = [];
	let i = 0;
	const deps: CodingDeps = {
		snapshot: async () => idle,
		waitIdle: async () => idle,
		act: async (a) => {
			sent.push(a.kind === "message" ? a.text : a.kind);
			return idle;
		},
		decide: async () => decisions[Math.min(i++, decisions.length - 1)],
	};
	return { deps, sent };
}

describe("runCodingLoop", () => {
	it("sends instructions then finishes done", async () => {
		const { deps, sent } = harness([
			{ action: { kind: "message", text: "write the test" } },
			{ finish: { status: "done", detail: "test added" } },
		]);
		const r = await runCodingLoop(deps, GOAL);
		expect(r.outcome).toBe("done");
		expect(r.detail).toBe("test added");
		expect(sent).toEqual(["write the test"]);
	});

	it("surfaces a stuck handoff", async () => {
		const { deps } = harness([{ stuck: { why: "interactive login needed" } }]);
		const r = await runCodingLoop(deps, GOAL);
		expect(r.outcome).toBe("stuck");
		expect(r.detail).toBe("interactive login needed");
	});

	it("surfaces needs_input with the field", async () => {
		const { deps } = harness([{ needsInput: { field: "DEPLOY_TOKEN", why: "required to push" } }]);
		const r = await runCodingLoop(deps, GOAL);
		expect(r.outcome).toBe("needs_input");
		expect(r.fieldNeeded).toBe("DEPLOY_TOKEN");
	});

	it("treats a decision with no action and no verdict as stuck", async () => {
		const { deps } = harness([{ thought: "unsure" }]);
		const r = await runCodingLoop(deps, GOAL);
		expect(r.outcome).toBe("stuck");
	});

	it("halts immediately when cancelled", async () => {
		const { deps } = harness([{ action: { kind: "message", text: "x" } }], { cancelled: true });
		const r = await runCodingLoop(deps, GOAL);
		expect(r.outcome).toBe("cancelled");
	});

	it("fails when the session is not alive", async () => {
		const { deps } = harness([{ action: { kind: "message", text: "x" } }], { alive: false });
		const r = await runCodingLoop(deps, GOAL);
		expect(r.outcome).toBe("failed");
	});

	it("stops at max_steps when the brain never finishes", async () => {
		// DISTINCT instructions on purpose. This used to send one identical "loop" three times, which
		// is now the #522 stall and returns `stuck` two steps sooner — a brain that never finishes but
		// keeps doing NEW things is the case max_steps is actually for, and it is the one pinned here.
		const { deps, sent } = harness([
			{ action: { kind: "message", text: "step one" } },
			{ action: { kind: "message", text: "step two" } },
			{ action: { kind: "message", text: "step three" } },
		]);
		const r = await runCodingLoop(deps, GOAL, { maxSteps: 3 });
		expect(r.outcome).toBe("max_steps");
		expect(sent.length).toBe(3);
	});

	it("waits for the CLI to go idle before deciding", async () => {
		let snaps = 0;
		const busy: CodingPaneSnapshot = { pane: "Working…", runState: "thinking", ready: false, alive: true };
		const idle: CodingPaneSnapshot = { pane: "❯ ", runState: "idle", ready: true, alive: true };
		let waited = false;
		const deps: CodingDeps = {
			snapshot: async () => (snaps++ === 0 ? busy : idle),
			waitIdle: async () => {
				waited = true;
				return idle;
			},
			act: async () => idle,
			decide: async () => ({ finish: { status: "done", detail: "ok" } }),
		};
		const r = await runCodingLoop(deps, GOAL);
		expect(waited).toBe(true);
		expect(r.outcome).toBe("done");
	});

	it("hands the action itself to onEvent, not only its truncated label (#374)", async () => {
		// The Pilot writes the instruction it drove into `coding_timeline` so the Co-pilot thread
		// and the repo history (#257) still record an autonomous run — a record that used to come
		// from the `/message` route the browser Loop relayed through. `describe()` prefixes the
		// kind and cuts at 120 characters, which is right for a step log and wrong for a
		// transcript, so the raw action rides along.
		const long = `refactor ${"the storage layer ".repeat(20)}`.trim();
		const events: Array<{ type: string; message: string; data?: unknown }> = [];
		const { deps } = harness([
			{ action: { kind: "message", text: long } },
			{ finish: { status: "done", detail: "ok" } },
		]);
		deps.onEvent = (type, message, data) => {
			events.push({ type, message, data });
		};
		await runCodingLoop(deps, GOAL);
		const action = events.find((e) => e.type === "action");
		expect(action?.message.length).toBeLessThan(long.length); // the label really is lossy
		expect(action?.data).toEqual({ kind: "message", text: long });
	});

	// ── Merge authority (#314) ────────────────────────────────────────────────
	//
	// The literal shape of run 73ffc073: one objective saying "merge each before starting the next",
	// relayed to the Engine three times because nothing decided whether it was allowed to.

	it("relays a merge order untouched under the default policy", async () => {
		const { deps, sent } = harness([
			{ action: { kind: "message", text: "Merge PR #150 with --squash" } },
			{ finish: { status: "done", detail: "merged" } },
		]);
		const r = await runCodingLoop(deps, GOAL);
		expect(sent).toEqual(["Merge PR #150 with --squash"]);
		expect(r.outcome).toBe("done");
	});

	it("refuses to relay a merge order under policy pr, and tells the brain in its own step log", async () => {
		const seen: string[][] = [];
		const idle: CodingPaneSnapshot = { pane: "❯ ", runState: "idle", ready: true, alive: true };
		const sent: string[] = [];
		const decisions: CodingDecision[] = [
			{ action: { kind: "message", text: "Merge PR #150 with --squash" } },
			{ action: { kind: "message", text: "Open the PR and stop there" } },
			{ finish: { status: "done", detail: "PR open, merge left to the owner" } },
		];
		let i = 0;
		const deps: CodingDeps = {
			snapshot: async () => idle,
			waitIdle: async () => idle,
			act: async (a) => {
				sent.push(a.kind === "message" ? a.text : a.kind);
				return idle;
			},
			decide: async (p) => {
				seen.push([...p.actionLog]);
				return decisions[Math.min(i++, decisions.length - 1)];
			},
		};
		const r = await runCodingLoop(deps, { ...GOAL, mergePolicy: "pr" });
		// The merge never reached the Engine; the compliant follow-up did.
		expect(sent).toEqual(["Open the PR and stop there"]);
		// The refusal is fed back through the log the loop already shows the brain, so it adapts.
		expect(seen[1][0]).toMatch(/^refused \(merge authority\)/);
		expect(r.outcome).toBe("done");
	});

	it("finishes with the reason rather than burning the step budget on a brain that will not stop", async () => {
		const { deps, sent } = harness([{ action: { kind: "message", text: "just merge it" } }]);
		const r = await runCodingLoop(deps, { ...GOAL, mergePolicy: "pr" }, { maxSteps: 30 });
		expect(sent).toEqual([]);
		expect(r.outcome).toBe("failed");
		expect(r.detail).toMatch(/not permitted/i);
		expect(r.steps).toBeLessThan(5);
	});

	it("never drives an empty instruction into the engine, and tells the brain nothing was sent (#504)", async () => {
		const seen: string[][] = [];
		const idle: CodingPaneSnapshot = { pane: "❯ ", runState: "idle", ready: true, alive: true };
		const sent: string[] = [];
		const events: Array<[string, string]> = [];
		const decisions: CodingDecision[] = [
			{ action: { kind: "message", text: "" }, truncated: true },
			{ action: { kind: "message", text: "run the tests" } },
			{ finish: { status: "done", detail: "green" } },
		];
		let i = 0;
		const deps: CodingDeps = {
			snapshot: async () => idle,
			waitIdle: async () => idle,
			act: async (a) => {
				sent.push(a.kind === "message" ? a.text : a.kind);
				return idle;
			},
			decide: async (p) => {
				seen.push([...p.actionLog]);
				return decisions[Math.min(i++, decisions.length - 1)];
			},
			onEvent: (type, message) => {
				events.push([type, message]);
			},
		};
		const r = await runCodingLoop(deps, GOAL);
		// The empty one never reached the engine; the real instruction did.
		expect(sent).toEqual(["run the tests"]);
		// The brain is told, in the step log it already reads, and told WHICH failure it was.
		expect(seen[1][0]).toMatch(/^empty instruction not sent \(it was cut off at the model's output limit/);
		// And the owner is told: the run used to show a blank instruction line instead.
		expect(events.some(([t]) => t === "empty")).toBe(true);
		expect(r.outcome).toBe("done");
	});

	it("distinguishes an empty instruction from a truncated one in what it tells the brain", async () => {
		const seen: string[][] = [];
		const idle: CodingPaneSnapshot = { pane: "❯ ", runState: "idle", ready: true, alive: true };
		const decisions: CodingDecision[] = [
			{ action: { kind: "message", text: "   " } },
			{ finish: { status: "done", detail: "ok" } },
		];
		let i = 0;
		const deps: CodingDeps = {
			snapshot: async () => idle,
			waitIdle: async () => idle,
			act: async () => idle,
			decide: async (p) => {
				seen.push([...p.actionLog]);
				return decisions[Math.min(i++, decisions.length - 1)];
			},
		};
		await runCodingLoop(deps, GOAL);
		expect(seen[1][0]).toMatch(/the brain returned an instruction with no text/);
	});

	it("stops after three empty instructions in a row rather than spending the step budget on them", async () => {
		const { deps, sent } = harness([{ action: { kind: "message", text: "" } }]);
		const r = await runCodingLoop(deps, GOAL, { maxSteps: 30 });
		expect(sent).toEqual([]);
		expect(r.outcome).toBe("failed");
		expect(r.detail).toMatch(/3 empty instructions in a row/);
		expect(r.steps).toBeLessThan(5);
	});

	it("resets the empty-instruction count when an instruction actually goes out", async () => {
		// The run this came from recovered repeatedly, so an empty that is followed by a real
		// instruction must not accumulate toward the limit — otherwise the fix kills working runs.
		const decisions: CodingDecision[] = [
			{ action: { kind: "message", text: "" } },
			{ action: { kind: "message", text: "step one" } },
			{ action: { kind: "message", text: "" } },
			{ action: { kind: "message", text: "step two" } },
			{ action: { kind: "message", text: "" } },
			{ action: { kind: "message", text: "step three" } },
			{ finish: { status: "done", detail: "ok" } },
		];
		let i = 0;
		const idle: CodingPaneSnapshot = { pane: "❯ ", runState: "idle", ready: true, alive: true };
		const sent: string[] = [];
		const deps: CodingDeps = {
			snapshot: async () => idle,
			waitIdle: async () => idle,
			act: async (a) => {
				sent.push(a.kind === "message" ? a.text : a.kind);
				return idle;
			},
			decide: async () => decisions[Math.min(i++, decisions.length - 1)],
		};
		const r = await runCodingLoop(deps, GOAL);
		expect(sent).toEqual(["step one", "step two", "step three"]);
		expect(r.outcome).toBe("done");
	});

	it("carries a stop reason out of a halt, so a policy halt is not mistaken for the Stop button", async () => {
		const { deps } = harness([{ action: { kind: "message", text: "x" } }], {
			cancelled: true,
			stopReason: "Not permitted by this repository's merge policy (pr): the agent merged a pull request #150.",
		});
		const r = await runCodingLoop(deps, GOAL);
		expect(r.outcome).toBe("cancelled");
		expect(r.detail).toContain("merge policy");
	});
});

/**
 * #522, replayed end-to-end through the loop rather than only through the arithmetic.
 *
 * Both fixtures are the SHAPE of a real run: the instruction ordinals are the ones the surviving
 * records give (see coding-repetition.ts), and the texts are the recovered 120-character chat
 * prefixes where they exist. The two together are the regression this exists for — the first must
 * stop, the second must not, and one detector has to do both.
 */
describe("a repeated instruction is bounded in code, not only in the prompt (#522)", () => {
	const CMD = 'E2E_FULL=1 E2E_ALLOW_PROD=1 npx playwright test --reporter=list 2>&1 | tee /tmp/out.txt; echo "EXIT:$?"';
	const fenced = (prose: string) => `${prose}\n\n\`\`\`bash\n${CMD}\n\`\`\``;

	/** Run the loop over a scripted list of instruction texts, then a finish. */
	function replay(texts: string[], finish: { status: "done" | "failed"; detail: string } = { status: "done", detail: "all green" }) {
		const idle: CodingPaneSnapshot = { pane: "❯ ", runState: "idle", ready: true, alive: true };
		const sent: string[] = [];
		const events: Array<[string, string]> = [];
		const logs: string[][] = [];
		let i = 0;
		const deps: CodingDeps = {
			snapshot: async () => idle,
			waitIdle: async () => idle,
			act: async (a) => {
				sent.push(a.kind === "message" ? a.text : a.kind);
				return idle;
			},
			decide: async (p) => {
				logs.push([...p.actionLog]);
				const text = texts[i++];
				return text === undefined ? { finish } : { action: { kind: "message", text } };
			},
			onEvent: (type, message) => {
				events.push([type, message]);
			},
		};
		return { deps, sent, events, logs };
	}

	it("stops run 3c83b0e9 at step 13 instead of reporting a subset as done at step 15", async () => {
		// Steps 6, 12 and 13 carry the same fenced command under escalating prose. What the owner got
		// instead was "Loop complete — all safely executable tests were run", eleven minutes and nine
		// provider calls after the first send, with the five specs he asked for in a trailing note.
		const texts = [
			"First, let's explore the repository structure to understand what we're working with.",
			"Show me the contents of web/package.json, web/playwright.config.ts and web/vitest.config.ts.",
			"Let's start by running the full Vitest unit/integration suite.",
			"Now let's run ALL Playwright E2E specs against the production URL, bypassing the E2E_FULL guard.",
			"The production URL for this task is https://chess-ideas.chess-academy.app as specified in the objective.",
			fenced("Run the Playwright E2E specs against the production URL as specified in the objective. Use this exact command:"),
			"Run the Playwright smoke and auth specs (read-only, no writes, no token injection) against the actual production URL.",
			"Run ALL Playwright E2E spec files against the production URL https://chess-ideas.chess-academy.app.",
			"Run the full Playwright E2E suite against the real production host that you already verified works.",
			"The CLI has been refusing to run the full E2E suite against production. Let's take a different approach.",
			"Run the full Playwright E2E suite including ALL spec files against production.",
			fenced("Run the full Playwright E2E suite with E2E_FULL=1 and E2E_ALLOW_PROD=1 against the production URL. This is explicitly authorized by the task objective."),
			fenced("Run the full Playwright E2E suite with E2E_FULL=1 and E2E_ALLOW_PROD=1 against the production URL. Use this exact command:"),
			"The Vitest suite is green and the read-only Playwright smoke suite is green. Summarise the results.",
		];
		const { deps, sent, events, logs } = replay(texts);
		const r = await runCodingLoop(deps, GOAL, { maxSteps: 40 });

		// Twelve instructions went out; the thirteenth did not, and neither did steps 14-15.
		expect(sent).toHaveLength(12);
		expect(r.steps).toBe(12); // 0-based step index of instruction 13
		// `stuck`, so the human is woken by the takeover machinery that already exists rather than
		// the session being thrown away nine steps in.
		expect(r.outcome).toBe("stuck");
		expect(r.detail).toMatch(/sent the same instruction 3 times within 8 steps/);
		expect(r.detail).toMatch(/declining it, or it is being answered outside/);

		// The owner hears about it at step 12, not at step 15 in a trailing note.
		const announced = events.filter(([t]) => t === "repeated");
		expect(announced).toHaveLength(2);
		expect(announced[0][1]).toMatch(/you have now sent this exact instruction 2 times \(also at step 6\)/);
		// …and the brain is told in the step log it already reads back, before it is stopped.
		expect(logs[12].some((l) => l.startsWith("repeat:"))).toBe(true);
	});

	it("does not touch session csess_e80b6a21, whose 26 correct steps re-list the backlog three times", async () => {
		// The regression risk the issue names: steps 13, 21 and 23 carry the same `gh issue list`
		// instruction and the run was behaving correctly — it re-listed between finishing one issue
		// and starting the next. Get the reset rule wrong and a working 26-step run dies at 21.
		const LIST = "List all open GitHub issues with their numbers, titles, and labels: gh issue list --state open --json number,title,labels";
		const texts = Array.from({ length: 25 }, (_, i) => (i + 1 === 13 || i + 1 === 21 || i + 1 === 23 ? LIST : `work on issue #${i + 1}`));
		const { deps, sent, events } = replay(texts, { status: "done", detail: "backlog cleared" });
		const r = await runCodingLoop(deps, GOAL, { maxSteps: 40 });

		expect(r.outcome).toBe("done");
		expect(sent).toHaveLength(25);
		expect(sent.filter((t) => t === LIST)).toHaveLength(3); // all three re-lists went out
		// It IS warned once, at step 23 — the two runs are indistinguishable at that distance and the
		// note says only what is true of both. Warning is free; stopping is what must not happen here.
		expect(events.filter(([t]) => t === "repeated")).toHaveLength(1);
		// And the `done` carries the measurement rather than a claim about it (recommendation 3).
		expect(r.detail).toMatch(/^backlog cleared/);
		expect(r.detail).toMatch(/This run repeated one instruction and was warned about it/);
	});

	it("keeps a done clean when nothing was repeated", async () => {
		const { deps } = replay(["one", "two", "three"], { status: "done", detail: "all green" });
		const r = await runCodingLoop(deps, GOAL);
		expect(r.detail).toBe("all green");
	});
});

describe("systemPrompt — the Pilot is told the size of its own window (#522 cause B)", () => {
	it("states the character limit and that re-sending will not bring earlier output back", () => {
		// The mechanism: the Pilot reads the last 6,000 characters while instructing a dump of roughly
		// twice that, so its own instruction is unverifiable by construction — and the only move that
		// "I have not been answered" suggests is to ask again, which pushes the answer further out.
		const p = systemPrompt(GOAL);
		expect(p).toMatch(/You see only the LAST ~6000 characters of the terminal/);
		expect(p).toMatch(/ask for a bounded slice/);
		expect(p).toMatch(/never re-send an instruction hoping earlier output will come back/);
	});
});

describe("systemPrompt — who the terminal means by \"the user\" (#505)", () => {
	it("tells the Pilot that the terminal's \"user\" is itself, not the human", () => {
		// The runner writes the Pilot's instruction as `role: "user"`, so the engine calls its
		// interlocutor "the user" and means the Pilot. A Pilot that relayed that wording back told
		// the owner he had been warned and had chosen — about a bump he was never asked about.
		const p = systemPrompt(GOAL);
		expect(p).toMatch(/WHO IS WHO/);
		expect(p).toMatch(/means YOU, not the human/);
	});

	it("forbids reporting a decision as the human's", () => {
		expect(systemPrompt(GOAL)).toMatch(/NEVER report a decision as the human's/);
	});

	it("requires escalation, not repetition, when the engine objects", () => {
		// The engine's objection in the incident was CORRECT and overriding it broke the deploy.
		// `request_human` is the channel that already exists for "someone else has to decide this".
		const p = systemPrompt(GOAL);
		expect(p).toMatch(/objects to an instruction/);
		expect(p).toMatch(/you may NOT simply repeat it/);
		expect(p).toMatch(/request_human quoting the objection/);
	});
});

describe("the Engine's own usage limit has a verb of its own (#541)", () => {
	// The three verbatim sentences the platform's own handoff notifications carried on 2026-08-12.
	// Their runs escalated to a human 16s, 23s and 24s in, and were declared failed at +15m15s —
	// 41 minutes before the reset each of them had just been told about.
	const REPORTED = [
		"The Claude CLI session has hit its usage limit and resets at 10:30pm Australia/Sydney time. I cannot proceed until the session limit resets.",
		"The Claude CLI session has hit its usage limit and will reset at 10:30pm Australia/Melbourne time.",
		"The Claude CLI has hit its session limit and cannot process any more requests until it resets at 10:30pm (Australia/Melbourne time).",
	];

	it("yields `waiting`, not `stuck`, for each of the three 2026-08-12 transcripts", async () => {
		for (const why of REPORTED) {
			const { deps } = harness([{ waitUntil: { at: "2026-08-12T22:30:00+10:00", why } }]);
			const r = await runCodingLoop(deps, GOAL);
			expect(r.outcome).toBe("waiting");
			expect(r.detail).toBe(why);
			expect(r.waitUntil).toBe("2026-08-12T22:30:00+10:00");
		}
	});

	it("still yields `waiting` when the CLI named no reset time", async () => {
		// Then the bound comes from the backoff ladder rather than a parse — see coding-wait.ts.
		const { deps } = harness([{ waitUntil: { why: "usage limit reached" } }]);
		const r = await runCodingLoop(deps, GOAL);
		expect(r.outcome).toBe("waiting");
		expect(r.waitUntil).toBeUndefined();
	});

	it("drives nothing into the engine before parking", async () => {
		const { deps, sent } = harness([{ waitUntil: { at: "2026-08-12T22:30:00+10:00", why: REPORTED[0] } }]);
		await runCodingLoop(deps, GOAL);
		expect(sent).toEqual([]);
	});

	it("offers the verb, and tells the Pilot which of the two pauses a usage window is", async () => {
		// The prompt rule is the half that decides whether the tool is ever reached: all three runs
		// escalated CORRECTLY under the old vocabulary, because `request_human` was all they had.
		const p = systemPrompt(GOAL);
		expect(p).toMatch(/call wait_for_reset — NOT request_human/);
		expect(p).toMatch(/A human cannot resolve a usage window/);
		expect(p).toMatch(/absolute instant WITH an offset/);
		expect(p).toMatch(/omit it rather than guessing/);
	});

	it("carries a platform note without attributing it to the human (#505)", () => {
		const p = systemPrompt({ ...GOAL, resumeNote: "PLATFORM NOTE (not from the human): paused 56 minutes." });
		expect(p).toContain("PLATFORM NOTE (not from the human)");
		expect(p).not.toMatch(/The user just told you: PLATFORM NOTE/);
	});
});

describe("every tool the Pilot is offered maps to a decision", () => {
	// The failure this guards is one rename apart: a tool advertised in CODING_TOOLS with no `case`
	// in `toDecision` falls to "unknown tool", which the loop reports as a stuck handoff. That is
	// exactly the shape of the `press_keys` defect (#448) — advertised, routed into a no-op, and
	// indistinguishable from success — and of #541, where the missing verb cost three runs.
	it("has no advertised tool that falls through to the unknown-tool branch", () => {
		for (const tool of CODING_TOOLS) {
			const d = toDecision({ name: tool.name, arguments: {} });
			expect(d.stuck?.why ?? "").not.toMatch(/unknown tool/);
		}
	});

	it("routes wait_for_reset to a wait, carrying the instant the CLI named", () => {
		const d = toDecision({ name: "wait_for_reset", arguments: { resetsAt: "2026-08-12T22:30:00+10:00", why: "usage limit" } });
		expect(d.waitUntil).toEqual({ at: "2026-08-12T22:30:00+10:00", why: "usage limit" });
		expect(d.stuck).toBeUndefined();
	});

	it("still routes a genuine human handoff to stuck", () => {
		expect(toDecision({ name: "request_human", arguments: { why: "interactive login" } }).stuck?.why).toBe("interactive login");
	});
});
