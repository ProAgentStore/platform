/**
 * Owner constraints bind what the Pilot SENDS, and completion claims are held to what the run DID (#1019).
 *
 * Every test drives the real `runCodingSessionWorkflow` — real `pilotDecide` (with its per-decision
 * reload of rules and directives), real `runCodingLoop`, real D1 schema — with only its two edges
 * faked, exactly as `workflow-run.test.ts` does: the machine (`runner-client`) and the BYOK brain
 * (`decideCodingAction`). "Reaches the engine" is asserted at the transport: the bodies the simulated
 * runner received on `/coding/act`. Every fixture is synthetic.
 *
 * Deliberately imports nothing #1019 added, so this file runs unchanged against the code before it —
 * which is how its fail-before evidence was taken (see the commit message).
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { callRunner, decideCodingAction } = vi.hoisted(() => ({ callRunner: vi.fn(), decideCodingAction: vi.fn() }));
vi.mock("../../lib/runner-client.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/runner-client.js")>("../../lib/runner-client.js");
	const conn = { kind: "relay", instanceId: "i1", runnerNode: "n1", relayName: "i1:node:n1" };
	return {
		...actual,
		callRunner: (...a: unknown[]) => callRunner(...a),
		getRunnerConnIgnoringLiveness: async () => conn,
		getBoundRunnerConn: async () => conn,
		relayConnected: async () => true,
	};
});
vi.mock("../../lib/coding-loop.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/coding-loop.js")>("../../lib/coding-loop.js");
	return { ...actual, decideCodingAction: (...a: unknown[]) => decideCodingAction(...a) };
});

import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { runCodingSessionWorkflow } from "./workflow-run.js";
import type { CodingSessionParams } from "../coding-session-params.js";
import type { CodingDecision, CodingGoal } from "../../lib/coding-loop.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../../lib/d1-sqlite.js";
import type { Env } from "../../types.js";

interface Journal {
	done: Map<string, unknown>;
	onSleep?: (name: string) => void;
}
const newJournal = (): Journal => ({ done: new Map() });

function fakeStep(journal: Journal): WorkflowStep {
	return {
		async do(name: string, a: unknown, b?: unknown) {
			const cb = (typeof a === "function" ? a : b) as () => Promise<unknown>;
			if (journal.done.has(name)) return journal.done.get(name);
			const value = await cb();
			journal.done.set(name, value);
			return value;
		},
		async sleep(name: string) {
			journal.onSleep?.(name);
		},
	} as unknown as WorkflowStep;
}

type RunnerRoute = (body: Record<string, unknown>) => unknown;
let runner: Record<string, RunnerRoute>;
let acted: string[];
const IN_SYNC = { checked: true, branch: "main", upstream: "origin/main", localHead: "aaaaaaaa1", remoteHead: "aaaaaaaa1", ahead: 0, behind: 0, fetched: true };

let decisions: CodingDecision[];
let decided: { goal: CodingGoal; actionLog: string[] }[];
/** Runs WHILE the provider generates decision N (1-based) — the owner acting mid-generation. */
let duringGeneration: Record<number, () => void>;
let d1: RealSchemaD1;
let env: Env;
/** The engine's transcript so far — what every capture returns, growing as the engine works. */
let transcript: string;
const pane = () => ({ pane: transcript, runState: "idle", ready: true, alive: true });
/**
 * The runner's content digest (browser-runner coding/input-ledger.ts `actDigest`), re-derived HERE from the
 * contract rather than imported, so a drift between what the cloud and the runner hash fails a test (#1019).
 */
const digestOf = (a: { text?: unknown; author?: unknown; objective?: { runId?: unknown; text?: unknown; origin?: { kind?: unknown; by?: unknown }; constraints?: unknown[] } }) => {
	const str = (v: unknown) => (typeof v === "string" ? v : null);
	const o = a.objective;
	const objective = o ? [str(o.runId), str(o.text), str(o.origin?.kind), str(o.origin?.by), (o.constraints ?? []).filter((c) => typeof c === "string")] : null;
	return createHash("sha256").update(JSON.stringify([str(a.text), str(a.author), objective])).digest("hex");
};

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', 'i1', 'u1', 'acme/widget', '/w/widget', 'ready')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('s1', 'i1', 'r1', 'u1', 'active', 'claude')`);
	env = { DB: d1.DB } as unknown as Env;
	transcript = "$ ";
	acted = [];
	runner = {
		"/coding/start": () => ({ ok: true, sessionId: "s1" }),
		"/coding/capture": () => pane(),
		"/coding/act": (body) => {
			acted.push(String((body.action as { text?: string })?.text ?? ""));
			return pane();
		},
		"/coding/git": () => ({ output: "## main...origin/main\n" }),
		"/coding/sync": () => IN_SYNC,
	};
	callRunner.mockReset();
	callRunner.mockImplementation(async (_conn: unknown, path: string, body: Record<string, unknown> = {}) => runner[path]?.(body) ?? {});
	decided = [];
	duringGeneration = {};
	decideCodingAction.mockReset();
	decideCodingAction.mockImplementation(async (_env: unknown, _uid: unknown, p: { goal: CodingGoal; actionLog: string[] }) => {
		decided.push({ goal: structuredClone(p.goal), actionLog: [...p.actionLog] });
		duringGeneration[decided.length]?.();
		return decisions.length > 1 ? decisions.shift() : decisions[0];
	});
});
afterEach(() => d1.close());

function params(goal: Partial<CodingGoal> = {}, over: Partial<CodingSessionParams> = {}): CodingSessionParams {
	return {
		instanceId: "i1",
		userId: "u1",
		sessionId: "s1",
		repoId: "r1",
		runnerNode: "n1",
		goal: { objective: "implement the export feature and push it", repo: "acme/widget", clientType: "claude", ...goal },
		...over,
	} as CodingSessionParams;
}

async function run(p: CodingSessionParams = params(), journal: Journal = newJournal()) {
	return runCodingSessionWorkflow(env, { payload: p } as WorkflowEvent<CodingSessionParams>, fakeStep(journal));
}

const SEND = (text: string): CodingDecision => ({ action: { kind: "message", text } });
const FINISH = (detail: string): CodingDecision => ({ finish: { status: "done", detail } });
let dirSeq = 0;
/** The owner steers mid-run — recorded exactly as `POST …/message` records a steer. Returns the directive id. */
function directive(content: string, at = Date.now() + ++dirSeq, delivery = "queued"): string {
	const id = `dir-${dirSeq}-${at}`;
	d1.exec(`INSERT INTO coding_session_directives (id, session_id, instance_id, user_id, repo_id, run_id, kind, delivery, content, created_at)
	  VALUES ('${id}', 's1', 'i1', 'u1', 'r1', NULL, 'steer', '${delivery}', '${content.replace(/'/g, "''")}', ${at})`);
	return id;
}
/** Run `fn` on the first engine act only — the moment the owner steers. */
function onFirstAct(fn: () => void) {
	let n = 0;
	const act = runner["/coding/act"];
	runner["/coding/act"] = (body) => {
		if (++n === 1) fn();
		return act(body);
	};
}
const lastLog = () => decided[decided.length - 1]?.actionLog.join("\n") ?? "";

// ── 1. Constraints bind the generated action, before transport ─────────────────────────────────

describe("a later owner constraint binds the actions the Pilot generates", () => {
	it("refuses a mutation the stale objective asks for once the owner said read-only, and still sends in-scope work", async () => {
		decisions = [
			SEND("implement the export feature"),
			SEND("fix the failing export test and push"),
			SEND("Read src/export.ts and explain the failure — do not edit anything"),
			FINISH("explained the failure; no changes made"),
		];
		onFirstAct(() => directive("Read-only from now on. Investigate only."));
		const result = await run();
		// The refused instruction never reached the simulated engine; the valid one did.
		expect(acted).toEqual(["implement the export feature", "Read src/export.ts and explain the failure — do not edit anything"]);
		expect(acted.join("\n")).not.toContain("fix the failing export test");
		expect(decided[2].actionLog.join("\n")).toMatch(/refused \(owner constraint\): read-only.*owner directive 1/);
		expect(result.outcome).toBe("done");
	});

	it("never names the owner's private directive text in the refusal it logs and announces", async () => {
		decisions = [SEND("start"), SEND("git commit -am wip && git push"), FINISH("stopped")];
		onFirstAct(() => directive("SECRET-PHRASE-7781: stay read-only"));
		await run();
		const refusal = lastLog().split("\n").find((l) => l.startsWith("refused (owner constraint)")) ?? "";
		expect(refusal).toMatch(/read-only/);
		expect(refusal).not.toContain("SECRET-PHRASE-7781");
	});

	it("keeps a constraint in force past the newest-directive window", async () => {
		decisions = [SEND("start"), SEND("rm -rf build && git commit -am rebuild"), FINISH("done")];
		onFirstAct(() => {
			directive("Read-only from now on.");
			for (let i = 0; i < 14; i++) directive(`status update ${i}: keep investigating`);
		});
		await run();
		expect(acted).toEqual(["start"]);
		expect(decided[1].goal.ownerDirectives).toHaveLength(15);
		expect(decided[2].actionLog.join("\n")).toMatch(/refused \(owner constraint\): read-only/);
	});

	it("lets a later explicit lift supersede an earlier restriction — and a later restriction re-impose it", async () => {
		decisions = [SEND("start"), SEND("fix the export bug"), SEND("git push"), FINISH("fixed")];
		onFirstAct(() => {
			directive("Read-only for now.");
			directive("OK, you may now edit and fix it.");
			directive("Do not push.");
		});
		await run();
		expect(acted).toEqual(["start", "fix the export bug"]);
		expect(lastLog()).toMatch(/refused \(owner constraint\): no push/);
	});

	it("refuses a full-suite command after a focused-test limit and an unscoped kill under the platform rule", async () => {
		decisions = [SEND("start"), SEND("run `pnpm test` to check everything"), SEND("pkill -f node to free memory"), SEND("run `pnpm vitest run src/export.test.ts --maxWorkers=1`"), FINISH("focused test passes")];
		onFirstAct(() => directive("Only run the focused tests, at most 1 worker. The machine is low on memory."));
		await run();
		expect(acted).toEqual(["start", "run `pnpm vitest run src/export.test.ts --maxWorkers=1`"]);
		const log = lastLog();
		expect(log).toMatch(/refused \(owner constraint\): focused tests only/);
		// Capacity advice ("low on memory") is not termination authority.
		expect(log).toMatch(/refused \(owner constraint\): no unscoped process termination — set by platform rule/);
	});

	it("refuses collecting process arguments, environment or private logs once excluded", async () => {
		decisions = [SEND("start"), SEND("run `ps aux | grep node` and `printenv`"), SEND("list the repo's package.json scripts"), FINISH("listed")];
		onFirstAct(() => directive("Do not collect process arguments or environment variables."));
		await run();
		expect(acted).toEqual(["start", "list the repo's package.json scripts"]);
	});

	it("enforces the same constraints on a replay, when the journalled decisions come back without re-reading them", async () => {
		decisions = [SEND("start"), SEND("fix the bug and push"), FINISH("investigated")];
		onFirstAct(() => directive("Read-only from now on."));
		const journal = newJournal();
		const first = await run(params(), journal);
		expect(acted).toEqual(["start"]);
		// Replay the whole run from its journal after the directive row is gone from the read path:
		// the decisions are journalled, the per-decision reload does not run again, and the screen
		// must still use the constraints each decision was made under.
		d1.exec("DELETE FROM coding_session_directives");
		acted = [];
		const replayed = await run(params(), journal);
		expect(acted).toEqual([]);
		expect(replayed.outcome).toBe(first.outcome);
	});
});

// ── 1b. The corrections of #1019's second pass, through the same real workflow ──────────────────

describe("termination authority, inert data and test selection", () => {
	it("permission to finish after the push does not lift the termination prohibition", async () => {
		decisions = [SEND("start"), SEND("pkill -f vitest to free memory"), SEND("run `pnpm vitest run src/export.test.ts --maxWorkers=1`"), FINISH("done")];
		onFirstAct(() => directive("You may stop after the push."));
		await run();
		expect(acted).toEqual(["start", "run `pnpm vitest run src/export.test.ts --maxWorkers=1`"]);
		expect(lastLog()).toMatch(/refused \(owner constraint\): no unscoped process termination — set by platform rule/);
	});

	it("an explicit grant naming the processes still lifts it", async () => {
		decisions = [SEND("start"), SEND("pkill -f vitest"), FINISH("done")];
		onFirstAct(() => directive("You may kill the stray vitest processes."));
		await run();
		expect(acted).toEqual(["start", "pkill -f vitest"]);
	});

	it("passes a quoted fixture string presented as data, and still refuses the same command asked for or left unquoted", async () => {
		const fixture = "Add a test case to src/scope.test.ts asserting the screen refuses 'pkill -f node'";
		decisions = [SEND("start"), SEND(fixture), SEND("run `pkill -f node` — it is only test data"), SEND("Add a fixture string 'ok' and pkill -f node"), SEND("'killall node'"), FINISH("done")];
		const result = await run();
		expect(acted).toEqual(["start", fixture]);
		// Three refusals in a row is the loop's bound: the third (a bare quoted kill) ends the run, naming the rule.
		const refusals = lastLog().split("\n").filter((l) => l.startsWith("refused (owner constraint): no unscoped process termination"));
		expect(refusals).toHaveLength(2);
		expect(result.outcome).toBe("failed");
		expect(result.detail).toMatch(/outside the owner's constraints\. Last: no unscoped process termination/);
	});

	it("does not read a worker-limit value as a focused selector, and keeps a genuine focused invocation", async () => {
		decisions = [SEND("start"), SEND("run `pnpm vitest run --maxWorkers 4`"), SEND("run `pnpm test -- --max-workers 4`"), SEND('run `pnpm vitest run -t "export flow" --maxWorkers 4`'), FINISH("done")];
		onFirstAct(() => directive("Only run the focused tests, at most 4 workers."));
		await run();
		expect(acted).toEqual(["start", 'run `pnpm vitest run -t "export flow" --maxWorkers 4`']);
		expect(lastLog().match(/refused \(owner constraint\): focused tests only/g)).toHaveLength(2);
	});
});

describe("a termination grant is scoped to what it names (#1019)", () => {
	it("a vitest-only grant allows vitest kills and refuses node, by pattern, by killall and in prose", async () => {
		decisions = [SEND("start"), SEND("pkill -f node"), SEND("kill $(pgrep -f vitest)"), SEND("killall node"), SEND("pkill -f vitest"), FINISH("done")];
		onFirstAct(() => directive("You may kill the stray vitest processes."));
		await run();
		expect(acted).toEqual(["start", "kill $(pgrep -f vitest)", "pkill -f vitest"]);
		const scoped = /refused \(owner constraint\): no unscoped process termination — set by platform rule \(scoped by owner directive 1 \(\d\d:\d\d UTC\) to: vitest\); it terminates node, and the owner allowed terminating only vitest processes/g;
		expect(lastLog().match(scoped)).toHaveLength(2);
	});

	it("the same grant does not cover a prose request to stop every node process", async () => {
		decisions = [SEND("start"), SEND("stop all node processes"), FINISH("done")];
		onFirstAct(() => directive("You may kill the stray vitest processes."));
		await run();
		expect(acted).toEqual(["start"]);
		expect(lastLog()).toMatch(/it terminates node, and the owner allowed terminating only vitest processes/);
	});

	it("an explicit blanket grant still covers any process — the owner said so", async () => {
		decisions = [SEND("start"), SEND("pkill -f node"), FINISH("done")];
		onFirstAct(() => directive("You may kill any processes."));
		await run();
		expect(acted).toEqual(["start", "pkill -f node"]);
	});
});

describe("a constraint the owner sends while the provider is generating", () => {
	it("binds the action that generation produced — it never reaches transport", async () => {
		decisions = [SEND("start"), SEND("fix the export bug and push"), SEND("Read src/export.ts and report — do not edit anything"), FINISH("reported")];
		// Directive 2 is being generated when the owner says read-only; the prompt that produced it never saw it.
		duringGeneration[2] = () => directive("Read-only from now on.");
		await run();
		expect(decided[1].goal.ownerDirectives ?? []).toHaveLength(0);
		expect(acted).toEqual(["start", "Read src/export.ts and report — do not edit anything"]);
		expect(decided[2].actionLog.join("\n")).toMatch(/refused \(owner constraint\): read-only/);
	});
});

// ── 2. Completion claims are held to the run's own tool calls ──────────────────────────────────

/** Append an engine tool call to the transcript, as the runner writes it. A string input is written as given. */
function call(tool: string, input: Record<string, unknown> | string, result: string, ok: boolean | null = true) {
	const mark = ok === null ? " " : ok ? "✓" : "✗";
	const [first, ...rest] = result.split("\n");
	transcript += `\n⚙ ${tool} ${typeof input === "string" ? input : JSON.stringify(input)}\n↳${mark} ${first}${rest.map((l) => `\n  │ ${l}`).join("")}`;
}
/** Each instruction the engine receives does the work scripted for it. */
function engineDoes(...work: Array<() => void>) {
	let i = 0;
	const act = runner["/coding/act"];
	runner["/coding/act"] = (body) => {
		work[i++]?.();
		return act(body);
	};
}
const GREEN = "Test Files  40 passed (40)\n     Tests  812 passed (812)";
const edit = (path = "src/export.ts") => call("Edit", { file_path: path, old_string: "a", new_string: "b" }, "The file has been updated.");
const test = (command: string, out = GREEN, ok: boolean | null = true) => call("Bash", { command }, out, ok);
const commit = () => call("Bash", { command: "git commit -am 'feat: export'" }, "[main 1a2b3c4] feat: export\n 1 file changed");
const push = (out = "To github.com:acme/widget.git\n   0a1b2c3..1a2b3c4  main -> main") => call("Bash", { command: "git push origin main" }, out);

describe("a completion claim is checked against the final revision", () => {
	it("sends a claim back once when files changed after the last green run, then reports it contradicted", async () => {
		decisions = [SEND("implement and test"), FINISH("All tests pass."), FINISH("All tests pass.")];
		engineDoes(() => {
			test("pnpm test");
			edit();
		});
		const result = await run();
		expect(decided[2].actionLog.join("\n")).toMatch(/finish not accepted yet — files changed after the last green run \(src\/export\.ts\)/);
		expect(result.outcome).toBe("done");
		expect(result.detail).toMatch(/tests pass: CONTRADICTED — files changed after the last green run/);
	});

	it("accepts a genuinely valid final result first time and says what it verified", async () => {
		decisions = [SEND("implement, run the full suite, commit and push"), FINISH("Full suite: 812 tests passed. Pushed to main.")];
		engineDoes(() => {
			edit();
			test("pnpm test");
			commit();
			push();
		});
		const result = await run();
		expect(decided).toHaveLength(2);
		expect(result.detail).toMatch(/tests pass: verified/);
		expect(result.detail).toMatch(/full suite: verified/);
		expect(result.detail).toMatch(/test count: verified — the last run printed 812 passed/);
		expect(result.detail).toMatch(/pushed: verified/);
		expect(result.detail).not.toMatch(/CONTRADICTED|UNVERIFIED/);
	});

	it("does not count an invocation the test runner rejected as a pass", async () => {
		decisions = [SEND("test"), FINISH("tests pass"), FINISH("tests pass")];
		engineDoes(() => test("pnpm vitest run --runInBnad src/export.test.ts", "CACError: Unknown option `--runInBnad`", true));
		const result = await run();
		expect(result.detail).toMatch(/tests pass: CONTRADICTED — .*rejected an option/);
	});

	it("separates a focused subset from the full suite", async () => {
		decisions = [SEND("test"), FINISH("The full suite passes."), FINISH("The full suite passes.")];
		engineDoes(() => test("pnpm vitest run src/export.test.ts", "Test Files  1 passed (1)\n     Tests  9 passed (9)"));
		const result = await run();
		expect(result.detail).toMatch(/full suite: CONTRADICTED — the last run was a focused subset/);
		expect(result.detail).toMatch(/tests pass: verified/);
	});

	it("does not trust options written after a bare `--` that a package script may not forward", async () => {
		decisions = [SEND("test"), FINISH("tests pass")];
		engineDoes(() => test("pnpm test -- --maxWorkers=1 src/export.test.ts"));
		const result = await run();
		expect(result.detail).toMatch(/tests pass: UNVERIFIED — options after a bare `--`/);
	});

	it("reports missing results and mismatched counts as unknown or contradicted, never as passing", async () => {
		decisions = [SEND("test"), FINISH("All 900 tests pass")];
		engineDoes(() => test("pnpm test", "running…", null));
		const result = await run();
		expect(result.detail).toMatch(/tests pass: UNVERIFIED — the last test run's outcome was not recorded/);
		expect(result.detail).toMatch(/test count: UNVERIFIED/);

		transcript = "$ ";
		decisions = [SEND("test"), FINISH("All 900 tests pass")];
		decided = [];
		engineDoes(() => test("pnpm test"));
		const counted = await run();
		expect(counted.detail).toMatch(/test count: CONTRADICTED — claims 900; the last run printed 812 passed/);
	});

	it("does not take a push that moved nothing, or external CI it never saw, as done", async () => {
		decisions = [SEND("push"), FINISH("Pushed to main and CI is green."), FINISH("Pushed to main and CI is green.")];
		engineDoes(() => push("Everything up-to-date"));
		const result = await run();
		expect(result.detail).toMatch(/pushed: CONTRADICTED — .*Everything up-to-date/);
		expect(result.detail).toMatch(/CI\/deploy: UNVERIFIED — external CI\/deploy was not observed by this run/);
	});

	it("says the record is not observable on an engine whose tool calls are unstructured", async () => {
		d1.exec("UPDATE coding_sessions SET client_type = 'codex' WHERE id = 's1'");
		transcript = "codex> tests passed i think";
		decisions = [SEND("test"), FINISH("all tests pass")];
		const result = await run(params({ clientType: "codex" }));
		expect(result.detail).toMatch(/tests pass: UNVERIFIED — this engine's tool calls are not observable/);
	});
});

describe("completion claims keep their provenance (#1019 second pass)", () => {
	it("a test then an edit in ONE tool call does not verify the edited content", async () => {
		decisions = [SEND("test then tweak"), FINISH("All tests pass."), FINISH("All tests pass.")];
		engineDoes(() => call("Bash", { command: "pnpm test && sed -i 's/a/b/' src/export.ts" }, GREEN));
		const result = await run();
		expect(result.detail).toMatch(/tests pass: CONTRADICTED — files changed after the last green run/);
	});

	it("an edit then a test in one call does verify it", async () => {
		decisions = [SEND("tweak then test"), FINISH("All tests pass.")];
		engineDoes(() => call("Bash", { command: "sed -i 's/a/b/' src/export.ts && pnpm test" }, GREEN));
		const result = await run();
		expect(result.detail).toMatch(/tests pass: verified/);
	});

	it("a claim naming a different test command than the one that ran stays unverified", async () => {
		decisions = [SEND("test"), FINISH("pnpm test:unit passes")];
		engineDoes(() => test("pnpm vitest run src/export.test.ts", "Test Files  1 passed (1)\n     Tests  9 passed (9)"));
		const result = await run();
		expect(result.detail).toMatch(/tests pass: UNVERIFIED — the claim names `pnpm test:unit`, but the last test run was `pnpm vitest run src\/export\.test\.ts`/);
	});

	it("reads a worker-limited whole-suite run as the full suite, not as a focused subset", async () => {
		decisions = [SEND("test"), FINISH("The full suite passes.")];
		engineDoes(() => test("pnpm vitest run --maxWorkers 4"));
		const result = await run();
		expect(result.detail).toMatch(/full suite: verified/);
	});

	it("does not take a rendered-browser claim from a run that only read the source", async () => {
		decisions = [SEND("check the button"), FINISH("The button now renders correctly.")];
		engineDoes(() => {
			edit("src/Button.tsx");
			call("Read", { file_path: "src/Button.tsx" }, "export function Button() {}");
		});
		const result = await run();
		expect(result.detail).toMatch(/rendered in a browser: UNVERIFIED — no browser observed a page/);

		transcript = "$ ";
		decided = [];
		decisions = [SEND("check the button"), FINISH("The button now renders correctly.")];
		engineDoes(() => {
			edit("src/Button.tsx");
			call("mcp__playwright__browser_snapshot", { url: "http://localhost:5173" }, "button 'Save'");
		});
		const seen = await run();
		expect(seen.detail).toMatch(/rendered in a browser: verified/);
	});
});

describe("a test's redirected output is its artifact, not an edit — and not a selector (#1019)", () => {
	// INERT fixtures: transcript strings the simulated engine "ran". Nothing here executes a command.
	const NINE = "Test Files  1 passed (1)\n     Tests  9 passed (9)";

	for (const command of ["pnpm test > /tmp/owned-test-output.log", "pnpm test 2>&1 | tee /tmp/owned-test-output.log", "pnpm test &> /tmp/owned-test-output.log"]) {
		it(`verifies a green full-suite run whose output was captured: ${command}`, async () => {
			decisions = [SEND("run the suite"), FINISH("All tests pass. The full suite: 9 tests passed.")];
			engineDoes(() => test(command, NINE));
			const result = await run();
			expect(decided).toHaveLength(2); // accepted first time — nothing sent back
			expect(result.detail).toMatch(/tests pass: verified/);
			expect(result.detail).toMatch(/full suite: verified/);
			expect(result.detail).not.toMatch(/CONTRADICTED/);
		});
	}

	for (const [label, command] of [
		["a source edit chained after the captured run", "pnpm test > /tmp/out.log && sed -i 's/a/b/' src/export.ts"],
		["a redirect that is not the test's own output", "pnpm test > /tmp/out.log; echo patched > src/export.ts"],
		["the test's output written over a source file", "pnpm test > src/export.ts"],
		["the test's output tee'd into a config file", "pnpm test | tee config.json"],
	] as const) {
		it(`still invalidates the green run: ${label}`, async () => {
			decisions = [SEND("run the suite"), FINISH("All tests pass."), FINISH("All tests pass.")];
			engineDoes(() => test(command, NINE));
			const result = await run();
			expect(result.detail).toMatch(/tests pass: CONTRADICTED — files changed after the last green run/);
		});
	}

	it("a focused run stays focused when its output is captured", async () => {
		decisions = [SEND("test"), FINISH("The full suite passes."), FINISH("The full suite passes.")];
		engineDoes(() => test("pnpm vitest run src/export.test.ts > /tmp/out.log", NINE));
		const result = await run();
		expect(result.detail).toMatch(/full suite: CONTRADICTED — the last run was a focused subset/);
	});
});

describe("a rendered claim needs a browser that SAW the claimed page (#1019)", () => {
	const nav = (url: string) => call("mcp__playwright__browser_navigate", { url }, `navigated to ${url}`);
	const look = () => call("mcp__playwright__browser_snapshot", {}, "page snapshot");

	for (const [label, act] of [
		["closing the browser", () => call("mcp__playwright__browser_close", {}, "closed")],
		["listing the Playwright tests", () => test("npx playwright test --list", "Listing tests:\n  [chromium] › settings.spec.ts:3:1 › renders\nTotal: 1 test in 1 file")],
	] as const) {
		it(`${label} after the edit is not seeing the page`, async () => {
			decisions = [SEND("check it"), FINISH("The settings page now renders correctly.")];
			engineDoes(() => {
				edit("src/Settings.tsx");
				act();
			});
			const result = await run();
			expect(result.detail).toMatch(/rendered in a browser: UNVERIFIED — no browser observed a page/);
		});
	}

	it("a different page than the one claimed does not verify it; the claimed page does", async () => {
		decisions = [SEND("check it"), FINISH("The settings page now renders correctly.")];
		engineDoes(() => {
			edit("src/Settings.tsx");
			nav("http://localhost:5173/login");
			look();
		});
		const elsewhere = await run();
		expect(elsewhere.detail).toMatch(/rendered in a browser: UNVERIFIED — the claim is about settings, but the browser last observed http:\/\/localhost:5173\/login/);

		transcript = "$ ";
		decided = [];
		decisions = [SEND("check it"), FINISH("The settings page now renders correctly.")];
		engineDoes(() => {
			edit("src/Settings.tsx");
			nav("http://localhost:5173/settings");
			look();
			call("mcp__playwright__browser_close", {}, "closed"); // closing afterwards does not undo what was seen
		});
		const there = await run();
		expect(there.detail).toMatch(/rendered in a browser: verified/);
	});
});

describe("a compound command's success or count is never borrowed from another invocation (#1019)", () => {
	const PASS = (n: number) => `Test Files  1 passed (1)\n     Tests  ${n} passed (${n})`;

	it("two test runs joined by && both passed — but no single printed count is the claim's", async () => {
		decisions = [SEND("test"), FINISH("All 9 tests pass.")];
		engineDoes(() => test("pnpm vitest run src/a.test.ts && pnpm vitest run src/b.test.ts", `${PASS(9)}\n${PASS(3)}`));
		const result = await run();
		expect(result.detail).toMatch(/tests pass: verified — every test invocation/);
		expect(result.detail).toMatch(/test count: UNVERIFIED — claims 9; the last command ran several test invocations/);
	});

	it("a later run's summary does not vouch for an earlier one that crashed without printing one", async () => {
		decisions = [SEND("test"), FINISH("Tests pass."), FINISH("Tests pass.")];
		engineDoes(() => test("pnpm vitest run src/a.test.ts; pnpm vitest run src/b.test.ts", `Error: Cannot find module './missing'\n${PASS(3)}`));
		const result = await run();
		expect(result.detail).toMatch(/tests pass: UNVERIFIED — the exit status of .* belongs to another command/);
	});

	it("a run skipped by || does not take the earlier run's success as its own", async () => {
		decisions = [SEND("test"), FINISH("All tests pass with pnpm vitest run src/b.test.ts")];
		engineDoes(() => test("pnpm test:unit || pnpm vitest run src/b.test.ts", PASS(9)));
		const result = await run();
		expect(result.detail).toMatch(/tests pass: UNVERIFIED/);
	});

	it("a test whose status a pipe hands to `tail` is judged by its single summary — failing when it failed", async () => {
		decisions = [SEND("test"), FINISH("Tests pass."), FINISH("Tests pass.")];
		engineDoes(() => test("pnpm vitest run src/a.test.ts | tail -5", "Test Files  1 failed (1)\n     Tests  2 failed | 7 passed (9)"));
		const failing = await run();
		expect(failing.detail).toMatch(/tests pass: CONTRADICTED/);

		transcript = "$ ";
		decided = [];
		decisions = [SEND("test"), FINISH("Tests pass.")];
		engineDoes(() => test("pnpm vitest run src/a.test.ts | tail -5", PASS(9)));
		const passing = await run();
		expect(passing.detail).toMatch(/tests pass: verified — .*printed one summary — 9 passed, none failed/);
	});

	it("a test skipped behind a failing && is not reported as a failed test — it did not run", async () => {
		decisions = [SEND("test"), FINISH("Tests pass.")];
		engineDoes(() => test("false && pnpm vitest run src/a.test.ts", "", false));
		const result = await run();
		expect(result.detail).toMatch(/tests pass: UNVERIFIED/);
		expect(result.detail).not.toMatch(/tests pass: CONTRADICTED/);
	});
});

describe("a command the runner cut is still evidence by its output — never by its words (#1019)", () => {
	/** The runner's long-input form: the JSON cut after `kept` characters of the command, marked `…`. */
	const cut = (command: string, kept: string, out: string) => call("Bash", `${JSON.stringify({ command }).slice(0, JSON.stringify({ command: kept }).length - 2)}…`, out);
	const LONG = "cd /w/widget/packages/export-service/src/features/export && ";
	const SUMMARY = "Test Files  25 passed (25)\n     Tests  376 passed (376)";
	const REF_UPDATE = "To github.com:acme/widget.git\n   0a1b2c3..1a2b3c4  main -> main";

	it("a test run cut before the runner's name is in the record by its summary: the count is read, the command is not claimed", async () => {
		decisions = [SEND("test"), FINISH("376 tests passed.")];
		engineDoes(() => cut(`${LONG}pnpm vitest run --reporter=verbose`, LONG, SUMMARY));
		const result = await run();
		expect(result.detail).toMatch(/tests pass: UNVERIFIED — output of a test run was observed, but its command was cut before `test runner`/);
		expect(result.detail).toMatch(/test count: verified — the last run printed 376 passed/);
		expect(result.detail).not.toMatch(/no test run appears/);
	});

	it("a push cut before `git push` is in the record by its ref update, and its attribution stays unverified", async () => {
		decisions = [SEND("push"), FINISH("Pushed to main.")];
		engineDoes(() => cut(`${LONG}git add -A && git commit -m 'feat: export' && git push origin main`, LONG, REF_UPDATE));
		const result = await run();
		expect(result.detail).toMatch(/pushed: UNVERIFIED — output of a push that updated a remote ref was observed, but its command was cut before `git push`/);
		expect(result.detail).not.toMatch(/no push appears/);
	});

	it("a cut that kept the test runner's name takes the ordinary path, once — only its scope is unknown", async () => {
		decisions = [SEND("test"), FINISH("Full suite: 9 tests passed.")];
		engineDoes(() => cut("pnpm vitest run src/export.test.ts --reporter=verbose --coverage", "pnpm vitest run src/exp", "Test Files  1 passed (1)\n     Tests  9 passed (9)"));
		const result = await run();
		expect(result.detail).toMatch(/tests pass: verified — `pnpm vitest run src\/exp…` passed 9/);
		expect(result.detail).toMatch(/full suite: UNVERIFIED — the last test command was cut before its arguments/);
		expect(result.detail).toMatch(/test count: verified — the last run printed 9 passed/);
		expect(result.detail).not.toMatch(/was cut before `test runner`/);
	});

	it("a cut command whose output shows no test summary is no test run", async () => {
		decisions = [SEND("test"), FINISH("Tests pass.")];
		engineDoes(() => cut(`${LONG}pnpm vitest run`, LONG, "Done in 3.2s"));
		const result = await run();
		expect(result.detail).toMatch(/tests pass: UNVERIFIED — no test run appears in this run's record/);
	});

	for (const [label, out] of [
		["nothing to push", "On branch main\nnothing to commit, working tree clean"],
		["a fetch's ref update", "From github.com:acme/widget\n   0a1b2c3..1a2b3c4  main       -> origin/main"],
	] as const) {
		it(`a cut command whose output is ${label} is no push`, async () => {
			decisions = [SEND("push"), FINISH("Pushed to main.")];
			engineDoes(() => cut(`${LONG}git fetch && git status`, LONG, out));
			const result = await run();
			expect(result.detail).toMatch(/pushed: UNVERIFIED — no push appears in this run's record/);
		});
	}
});

describe("a claimed test count is a count of tests, never of files (#1019)", () => {
	const SUMMARY = "Test Files  25 passed (25)\n     Tests  376 passed (376)";

	for (const [claim, verdict] of [
		["376 tests, 25 test files, all passed.", /test count: verified — the last run printed 376 passed/],
		["Tests 376 passed (376).", /test count: verified — the last run printed 376 passed/],
		["The run passed 376 tests.", /test count: verified — the last run printed 376 passed/],
		["25 tests passed.", /test count: CONTRADICTED — claims 25; the last run printed 376 passed/],
		["25 test files passed.", null],
		["Test Files 25 passed (25).", null],
	] as const) {
		it(`reads "${claim}" as ${verdict ? "its test count" : "no test count"}`, async () => {
			decisions = [SEND("test"), FINISH(claim), FINISH(claim)];
			engineDoes(() => test("pnpm test", SUMMARY));
			const result = await run();
			if (verdict) expect(result.detail).toMatch(verdict);
			else expect(result.detail).not.toMatch(/test count:/);
		});
	}

	it("a run that printed only its file count printed no test count", async () => {
		decisions = [SEND("test"), FINISH("25 tests passed.")];
		engineDoes(() => test("pnpm test", "Test Files  25 passed (25)"));
		const result = await run();
		expect(result.detail).toMatch(/tests pass: UNVERIFIED — the last run exited cleanly but its output shows no pass count/);
		expect(result.detail).toMatch(/test count: UNVERIFIED — claims 25; no count was printed in the record/);
	});

	it("reads the test count whichever order the two summary lines come in", async () => {
		decisions = [SEND("test"), FINISH("376 tests passed.")];
		engineDoes(() => test("pnpm test", "     Tests  376 passed (376)\n Test Files  25 passed (25)"));
		const result = await run();
		expect(result.detail).toMatch(/test count: verified — the last run printed 376 passed/);
	});

	it("two test summaries from one command are still ambiguous — neither count is the claim's", async () => {
		decisions = [SEND("test"), FINISH("All 9 tests pass.")];
		engineDoes(() => test("pnpm test", `${SUMMARY}\nTest Files  1 passed (1)\n     Tests  9 passed (9)`));
		const result = await run();
		expect(result.detail).toMatch(/test count: UNVERIFIED — claims 9; the last command ran several test invocations/);
	});
});

// ── 3. Pending versus processed, as the Pilot is told it ───────────────────────────────────────

describe("directive state reaches the Pilot as it is, not as acknowledged", () => {
	it("reports a queued directive the engine has not read as queued, and only a processed one as processed", async () => {
		decisions = [SEND("start"), FINISH("ok")];
		onFirstAct(() => {
			directive("stay on the export module", Date.now() - 1, "delivered");
			d1.exec("UPDATE coding_session_directives SET processed_at = created_at + 5000");
			directive("also skip the docs", Date.now() + 1, "queued");
		});
		await run();
		const [processed, queued] = decided[1].goal.ownerDirectives ?? [];
		expect(processed).toMatchObject({ processed: true });
		expect(queued).toMatchObject({ delivery: "queued", processed: false });
	});

	it("marks a directive processed only when the runner reports a completed turn consumed it — not because a turn ended after it", async () => {
		let consumed: string[] = [];
		let ids: { read: string; queued: string } | null = null;
		const capture = runner["/coding/capture"];
		runner["/coding/capture"] = (body) => ({ ...(capture(body) as object), lastTurn: { verdict: "ok", exitCode: null, signal: null, at: Date.now() + 60_000 }, consumedInputs: consumed });
		decisions = [SEND("start"), SEND("next"), FINISH("ok")];
		onFirstAct(() => {
			ids = { read: directive("stay on the export module"), queued: directive("also skip the docs") };
			// The turn that ended consumed only the first; the second was queued behind it.
			consumed = [ids.read];
		});
		await run();
		const processed = (id: string) => (d1.sqlite.prepare("SELECT processed_at FROM coding_session_directives WHERE id = ?").get(id) as { processed_at: number | null }).processed_at;
		expect(ids).not.toBeNull();
		const { read, queued } = ids as unknown as { read: string; queued: string };
		expect(processed(read)).not.toBeNull();
		expect(processed(queued)).toBeNull();
	});
});

// ── 4. A working run is not reported as having lost its heartbeat ──────────────────────────────

describe("a long engine turn keeps the run's claim fresh", () => {
	it("heartbeats the driver claim while waiting on the engine, with no action in between", async () => {
		const stale = Date.now() - 20 * 60_000;
		d1.exec(`UPDATE coding_sessions SET driver_id = 'drv-1', driver_at = ${stale} WHERE id = 's1'`);
		let captures = 0;
		runner["/coding/capture"] = () => (++captures < 4 ? { pane: "$ working", runState: "responding", ready: false, alive: true } : pane());
		let seenDuringWait: number | null = null;
		const journal = newJournal();
		journal.onSleep = () => {
			seenDuringWait ??= (d1.sqlite.prepare("SELECT driver_at FROM coding_sessions WHERE id = 's1'").get() as { driver_at: number }).driver_at;
		};
		decisions = [FINISH("nothing to do")];
		await run(params({}, { driverId: "drv-1" } as Partial<CodingSessionParams>), journal);
		expect(seenDuringWait).not.toBeNull();
		expect(seenDuringWait).toBeGreaterThan(stale);
	});
});

// ── The run's objective reaches the engine verbatim, with the run's first turn (#1019) ───────────

describe("the run's objective reaches the engine verbatim, with the run's first turn (#1019)", () => {
	const OBJ = "Implement #1019 only.\nDo NOT run the full suite — focused tests only.";
	let bodies: Array<{ text?: string; objective?: { runId: string; text: string }; inputId?: string; replay?: string }>;
	let consumed: string[];
	const objectiveEvents = () =>
		(d1.sqlite.prepare("SELECT message, context FROM agent_events WHERE event = 'coding.run.objective' ORDER BY rowid").all() as Array<{ message: string; context: string | null }>).map((r) => ({
			message: r.message,
			state: (JSON.parse(r.context ?? "{}") as { state?: string }).state,
		}));
	/** A runner that advertises the capabilities, accepts each input id once, and an engine that reads every turn it is sent. */
	function capableRunner(opts: { reads?: boolean; stale?: string[]; caps?: string[] } = {}) {
		const accepted: string[] = [];
		const ledger: Array<[string, string, number]> = [];
		// One ledger, one engine process: the stale ids belong to an earlier run of the same session.
		const engine = () => ({ ledger: "L-cap", epoch: 0, accepted: ledger.slice(-16), consumed: [...(opts.stale ?? []), ...consumed].map((id) => [id, 0] as [string, number]) });
		runner["/capabilities"] = () => ({ capabilities: opts.caps ?? ["coding.sessions", "coding.run-objective", "coding.run-objective.v2", "coding.run-objective.v3", "coding.input-idempotent", "coding.engine-identity"] });
		runner["/coding/act"] = (body) => {
			const a = body.action as (typeof bodies)[number];
			if (a.inputId && accepted.includes(a.inputId)) return { ...pane(), acceptedInputs: [...accepted], engine: engine(), duplicateInput: a.inputId };
			bodies.push(a);
			acted.push(String(a.text ?? ""));
			if (a.inputId) {
				accepted.push(a.inputId);
				ledger.push([a.inputId, digestOf(a), 0]);
			}
			if (opts.reads !== false && a.inputId) consumed.push(a.inputId);
			return { ...pane(), acceptedInputs: [...accepted], engine: engine() };
		};
		runner["/coding/capture"] = () => ({ ...pane(), acceptedInputs: [...accepted], consumedInputs: [...(opts.stale ?? []), ...consumed], engine: engine() });
	}
	beforeEach(() => {
		bodies = [];
		consumed = [];
	});

	it("fresh run: the first turn carries the objective verbatim beside the Pilot's own text, and is confirmed read", async () => {
		capableRunner();
		decisions = [SEND("open the issue first"), SEND("now write the test"), FINISH("done")];
		await run(params({ objective: OBJ }, { loopRunId: "run-A" } as Partial<CodingSessionParams>));
		expect(bodies[0]).toMatchObject({ text: "open the issue first", objective: { runId: "run-A", text: OBJ, origin: { kind: "unverified" } }, inputId: expect.stringMatching(/^act:run-A:s\d+-act$/) });
		// The second instruction is bare: delivered once, not repeated.
		expect(bodies[1].objective).toBeUndefined();
		expect(bodies[1].text).toBe("now write the test");
		expect(objectiveEvents()).toEqual([{ message: expect.stringContaining("was delivered verbatim to the engine"), state: "delivered" }]);
		// The record names the length, never the objective's text.
		expect(objectiveEvents()[0].message).not.toContain("Implement #1019");
	});

	it("a Claude session that keeps its own conversation still gets it — it does not ride the per-turn replay", async () => {
		capableRunner();
		decisions = [SEND("go"), FINISH("done")];
		await run(params({ objective: OBJ, clientType: "claude" }));
		expect(bodies[0].replay).toBeUndefined();
		expect(bodies[0].objective?.text).toBe(OBJ);
	});

	it("a long objective is delivered whole, at the accepted length", async () => {
		capableRunner();
		const long = `${"a".repeat(7_997)}END`;
		decisions = [SEND("go"), FINISH("done")];
		await run(params({ objective: long }));
		expect(bodies[0].objective?.text).toBe(long);
		expect(bodies[0].objective?.text.length).toBe(8_000);
	});

	it("a later owner directive still outranks it: the out-of-scope instruction never reaches the engine", async () => {
		capableRunner();
		decisions = [SEND("start"), SEND("git commit -am wip && git push"), FINISH("stopped")];
		onFirstAct(() => directive("Read-only from now on."));
		await run(params({ objective: "implement the export feature and push it" }));
		expect(bodies.map((b) => b.text)).toEqual(["start"]);
		expect(bodies[0].objective?.text).toBe("implement the export feature and push it");
		expect(lastLog()).toMatch(/refused \(owner constraint\): read-only/);
	});

	it("an engine that never confirms reading it gets it on a bounded number of turns, and the run says unconfirmed — never delivered", async () => {
		capableRunner({ reads: false });
		decisions = [SEND("one"), SEND("two"), SEND("three"), SEND("four"), SEND("five"), FINISH("done")];
		await run(params({ objective: OBJ }, { loopRunId: "run-U" } as Partial<CodingSessionParams>));
		expect(bodies.map((b) => !!b.objective)).toEqual([true, true, true, false, false]);
		expect(new Set(bodies.map((b) => b.inputId)).size).toBe(5); // every act its own id
		expect(objectiveEvents().map((e) => e.state)).toEqual(["unconfirmed"]);
	});

	it("a workflow replay re-sends nothing and re-reports nothing", async () => {
		capableRunner();
		decisions = [SEND("go"), FINISH("done")];
		const journal = newJournal();
		await run(params({ objective: OBJ }), journal);
		const sent = bodies.length;
		await run(params({ objective: OBJ }), journal);
		expect(bodies).toHaveLength(sent);
		expect(objectiveEvents().map((e) => e.state)).toEqual(["delivered"]);
	});

	it("a failed transport is retried with the SAME objective and input id — the platform's step retry, not a new delivery", async () => {
		capableRunner();
		const attempted: Array<(typeof bodies)[number]> = [];
		const act = runner["/coding/act"];
		runner["/coding/act"] = (body) => {
			attempted.push(body.action as (typeof bodies)[number]);
			if (attempted.length === 1) throw new Error("relay dropped the act");
			return act(body);
		};
		// Cloudflare re-runs a failed step's callback (`retries.limit`); the fake journal does the same, once.
		const journal = newJournal();
		const step = fakeStep(journal);
		const retrying = {
			...step,
			do: async (name: string, a: unknown, b?: unknown) => step.do(name, a as never, b as never).catch(() => step.do(name, a as never, b as never)),
		} as unknown as WorkflowStep;
		decisions = [SEND("go"), FINISH("done")];
		await runCodingSessionWorkflow(env, { payload: params({ objective: OBJ }, { loopRunId: "run-T" } as Partial<CodingSessionParams>) } as WorkflowEvent<CodingSessionParams>, retrying);
		expect(attempted).toHaveLength(2);
		expect(attempted[1]).toEqual(attempted[0]);
		expect(attempted[0]).toMatchObject({ objective: { runId: "run-T", text: OBJ }, inputId: expect.stringMatching(/^act:run-T:/) });
		expect(objectiveEvents().map((e) => e.state)).toEqual(["delivered"]);
	});

	it("a transport that never succeeds ends the run without ever claiming the objective was delivered", async () => {
		capableRunner();
		runner["/coding/act"] = () => {
			throw new Error("relay dropped the act");
		};
		decisions = [SEND("go"), FINISH("done")];
		const r = await run(params({ objective: OBJ }));
		expect(r.outcome).toBe("failed");
		expect(objectiveEvents().map((e) => e.state)).not.toContain("delivered");
	});

	it("the next run on the same retained session gets its own objective, and an earlier run's read receipt does not count for it", async () => {
		capableRunner({ reads: false, stale: ["act:run-A:s7-act"] });
		decisions = [SEND("next run"), FINISH("done")];
		await run(params({ objective: "the SECOND run's objective" }, { loopRunId: "run-B" } as Partial<CodingSessionParams>));
		expect(bodies[0]).toMatchObject({ objective: { runId: "run-B", text: "the SECOND run's objective" }, inputId: expect.stringMatching(/^act:run-B:/) });
		expect(objectiveEvents().map((e) => e.state)).toEqual(["unconfirmed"]);
	});

	it("a runner without the capability is never sent it, and the run says it was NOT delivered", async () => {
		runner["/coding/act"] = (body) => {
			bodies.push(body.action as (typeof bodies)[number]);
			return pane();
		};
		decisions = [SEND("go"), FINISH("done")];
		await run(params({ objective: OBJ }));
		expect(bodies[0].objective).toBeUndefined();
		expect(objectiveEvents()).toEqual([{ message: expect.stringContaining("was NOT delivered"), state: "unsupported" }]);
	});
});

// ── #1019 second pass: runner generations, origin, receipts, and no blind duplicate turns ─────────────

describe("objective delivery across runner generations, lost replies and origins (#1019)", () => {
	const OBJ = "Read-only investigation of the export bug.";
	let bodies: Array<{ text?: string; objective?: { runId: string; text: string; origin?: { kind: string; by?: string } }; inputId?: string }>;
	let executed: string[];
	let consumed: string[];
	let accepted: string[];
	const events = (): Array<Record<string, unknown> & { event: string; message: string }> =>
		(d1.sqlite.prepare("SELECT event, message, context FROM agent_events WHERE event IN ('coding.run.objective', 'coding.run.input_unknown') ORDER BY rowid").all() as Array<{ event: string; message: string; context: string | null }>).map((r) => ({
			event: r.event,
			message: r.message,
			...(JSON.parse(r.context ?? "{}") as Record<string, unknown>),
		}));
	const V3 = ["coding.sessions", "coding.run-objective", "coding.run-objective.v2", "coding.run-objective.v3", "coding.input-idempotent", "coding.engine-identity"];
	/** A runner whose capabilities can change between generations, and an engine that runs each accepted input once. */
	function machine(opts: { caps?: () => string[]; reads?: () => boolean; stale?: () => string[]; reportsAccepted?: boolean; actFails?: (n: number) => Error | null } = {}) {
		let acts = 0;
		// Every relaunch (a /coding/start after the run's own) spawns a new engine process: a new epoch of one ledger.
		let epoch = 0;
		let starts = 0;
		const ledger: Array<[string, string, number]> = [];
		const reads: Array<[string, number]> = [];
		const engine = () => ({ engine: { ledger: "L-m", epoch, accepted: ledger.slice(-16), consumed: [...(opts.stale?.() ?? []).map((id) => [id, -1] as [string, number]), ...reads].slice(-16) } });
		const start = runner["/coding/start"];
		runner["/coding/start"] = (body) => {
			if (++starts > 1) epoch++;
			return { ...(start(body) as object), ...(opts.reportsAccepted === false ? {} : engine()) };
		};
		runner["/capabilities"] = () => ({ capabilities: (opts.caps ?? (() => V3))() });
		runner["/coding/act"] = (body) => {
			const a = body.action as (typeof bodies)[number];
			bodies.push(a);
			const n = ++acts;
			const ids = () => (opts.reportsAccepted === false ? {} : { acceptedInputs: [...accepted], ...engine() });
			if (a.inputId && accepted.includes(a.inputId)) return { ...pane(), ...ids(), duplicateInput: a.inputId };
			executed.push(String(a.text ?? ""));
			acted.push(String(a.text ?? ""));
			if (a.inputId) {
				accepted.push(a.inputId);
				ledger.push([a.inputId, digestOf(a), epoch]);
			}
			if ((opts.reads ?? (() => true))() && a.inputId) {
				consumed.push(a.inputId);
				reads.push([a.inputId, epoch]);
			}
			const fail = opts.actFails?.(n);
			if (fail) throw fail;
			return { ...pane(), ...ids() };
		};
		runner["/coding/capture"] = () => ({ ...pane(), ...(opts.reportsAccepted === false ? {} : { acceptedInputs: [...accepted], ...engine() }), consumedInputs: [...(opts.stale?.() ?? []), ...consumed] });
	}
	/** Cloudflare re-runs a failed step's callback; this fake does the same, once per step. */
	const retryingRun = (p: CodingSessionParams) => {
		const step = fakeStep(newJournal());
		const retrying = { ...step, do: async (name: string, a: unknown, b?: unknown) => step.do(name, a as never, b as never).catch(() => step.do(name, a as never, b as never)) } as unknown as WorkflowStep;
		return runCodingSessionWorkflow(env, { payload: p } as WorkflowEvent<CodingSessionParams>, retrying);
	};
	beforeEach(() => {
		bodies = [];
		executed = [];
		consumed = [];
		accepted = [];
	});

	it("the verified origin rides the objective: a supervisor's goal is sent as the supervisor's", async () => {
		machine();
		decisions = [SEND("go"), FINISH("done")];
		await run(params({ objective: OBJ, objectiveOrigin: { kind: "supervisor", by: "agent lead-1" } }));
		expect(bodies[0].objective).toEqual({ runId: expect.any(String), text: OBJ, origin: { kind: "supervisor", by: "agent lead-1" } });
	});

	it("a runner that renders only the v1 block is never sent the objective — it would call it the owner's", async () => {
		machine({ caps: () => ["coding.sessions", "coding.run-objective"] });
		decisions = [SEND("go"), FINISH("done")];
		await run(params({ objective: OBJ }));
		expect(bodies[0].objective).toBeUndefined();
		expect(events().map((e) => e.state)).toEqual(["unsupported"]);
	});

	it("receipts carry a digest and the UTF-8 byte length at the accepted maximum — never the objective's text", async () => {
		machine();
		const long = "€".repeat(8_000); // 8000 characters, 24000 UTF-8 bytes
		decisions = [SEND("go"), FINISH("done")];
		await run(params({ objective: long }, { loopRunId: "run-U8" } as Partial<CodingSessionParams>));
		const [delivered] = events();
		const { createHash } = await import("node:crypto");
		expect(delivered).toMatchObject({ state: "delivered", runId: "run-U8", chars: 8_000, utf8Bytes: 24_000, sha256: createHash("sha256").update(long, "utf8").digest("hex"), consumedInputId: bodies[0].inputId, generation: 0 });
		expect(JSON.stringify(events())).not.toContain("€€");
		expect(bodies[0].objective?.text).toBe(long);
	});

	it("a reply lost AFTER the runner accepted the act is reconciled: the engine runs it once, the retry sends nothing new", async () => {
		machine({ actFails: (n) => (n === 1 ? new Error("relay dropped the reply") : null) });
		decisions = [SEND("only once please"), FINISH("done")];
		await retryingRun(params({ objective: OBJ }, { loopRunId: "run-R" } as Partial<CodingSessionParams>));
		expect(executed.filter((t) => t === "only once please")).toHaveLength(1);
		expect(bodies).toHaveLength(1); // the retry read the receipt instead of re-sending
		expect(events().map((e) => e.state)).toEqual(["delivered"]);
	});

	it("a runner that cannot say whether it ran a lost act is NOT re-sent, and the run says unknown — never delivered", async () => {
		machine({ reportsAccepted: false, reads: () => false, actFails: (n) => (n === 1 ? new Error("relay dropped the reply") : null) });
		decisions = [SEND("maybe ran"), FINISH("done")];
		await retryingRun(params({ objective: OBJ }, { loopRunId: "run-X" } as Partial<CodingSessionParams>));
		expect(executed.filter((t) => t === "maybe ran")).toHaveLength(1);
		expect(bodies).toHaveLength(1);
		const ev = events();
		expect(ev.map((e) => e.event)).toEqual(["coding.run.input_unknown", "coding.run.objective"]);
		expect(ev[1]).toMatchObject({ state: "unknown" });
	});

	/** Run `fn` on the RELAUNCH — the second `/coding/start` (the first is the run's own start). */
	function onRelaunch(fn: () => void) {
		const start = runner["/coding/start"];
		let starts = 0;
		runner["/coding/start"] = (body) => {
			if (++starts === 2) fn();
			return start(body);
		};
	}
	/** Drop the relay before the Nth act (nothing dispatched): the guard waits, reconnects and relaunches. */
	async function dropBefore(n: number) {
		const { RunnerUnreachableError } = await import("../../lib/runner-unreachable.js");
		const act = runner["/coding/act"];
		let calls = 0;
		let dropped = false;
		runner["/coding/act"] = (body) => {
			if (++calls === n && !dropped) {
				dropped = true;
				throw new RunnerUnreachableError("No runner connected", { dispatched: false });
			}
			return act(body);
		};
	}

	it("capable machine A, then legacy machine B after a reconnect: delivered on A, explicitly NOT delivered on B", async () => {
		let legacy = false;
		machine({ caps: () => (legacy ? ["coding.sessions", "coding.run-objective"] : V3) });
		await dropBefore(2);
		onRelaunch(() => {
			legacy = true; // the machine that came back is the older one
		});
		decisions = [SEND("on A"), SEND("on B"), SEND("still on B"), FINISH("done")];
		await run(params({ objective: OBJ }));
		expect(bodies.map((b) => [b.text, !!b.objective])).toEqual([["on A", true], ["on B", false], ["still on B", false]]);
		expect(events().map((e) => [e.state, e.generation])).toEqual([["delivered", 0], ["unsupported", 1]]);
	});

	it("a relaunched engine has not read it: owed again on the new generation, and delivered there too", async () => {
		machine();
		await dropBefore(2);
		decisions = [SEND("first engine"), SEND("dropped, then recomposed"), SEND("relaunched engine's next turn"), FINISH("done")];
		await run(params({ objective: OBJ }));
		// The dropped act keeps its id but is RECOMPOSED for the relaunched engine, which is owed the objective (#1019 case 1):
		// the cached pre-relaunch payload (bare, because the predecessor had read it) is never what reaches the new engine.
		expect(bodies.map((b) => [b.text, !!b.objective])).toEqual([["first engine", true], ["dropped, then recomposed", true], ["relaunched engine's next turn", false]]);
		expect(events().map((e) => [e.state, e.generation])).toEqual([["delivered", 0], ["delivered", 1]]);
	});

	it("a late receipt for the predecessor's send does not count for the new generation", async () => {
		let reads = true;
		machine({ reads: () => reads });
		await dropBefore(2);
		onRelaunch(() => {
			reads = false; // the new engine never confirms; only the old id is ever reported read
		});
		decisions = [SEND("first engine"), SEND("dropped, then re-sent"), SEND("relaunched engine"), FINISH("done")];
		await run(params({ objective: OBJ }));
		expect(consumed).toEqual([bodies[0].inputId]); // only the predecessor's id was ever read
		expect(events().map((e) => [e.state, e.generation])).toEqual([["delivered", 0], ["unconfirmed", 1]]);
	});

	it("a same-id retry of a never-dispatched act is sent, once", async () => {
		const { RunnerUnreachableError } = await import("../../lib/runner-unreachable.js");
		let first = true;
		machine();
		const act = runner["/coding/act"];
		runner["/coding/act"] = (body) => {
			if (first) {
				first = false;
				throw new RunnerUnreachableError("No runner connected", { dispatched: false });
			}
			return act(body);
		};
		decisions = [SEND("deliver me"), FINISH("done")];
		await retryingRun(params({ objective: OBJ }));
		expect(executed).toEqual(["deliver me"]);
		expect(events().map((e) => e.state)).toEqual(["delivered"]);
	});
});
