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

/** Append an engine tool call to the transcript, as the runner writes it. */
function call(tool: string, input: Record<string, unknown>, result: string, ok: boolean | null = true) {
	const mark = ok === null ? " " : ok ? "✓" : "✗";
	const [first, ...rest] = result.split("\n");
	transcript += `\n⚙ ${tool} ${JSON.stringify(input)}\n↳${mark} ${first}${rest.map((l) => `\n  │ ${l}`).join("")}`;
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
		expect(result.detail).toMatch(/rendered in a browser: UNVERIFIED — no browser was driven/);

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
