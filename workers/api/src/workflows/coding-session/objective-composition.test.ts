/**
 * The run's objective, the act that carries it, and the engine process that actually read it — bound together (#1019).
 *
 * PRODUCTION-MODULE COMPOSITION, not a native workflow test of one module: the real `runCodingSessionWorkflow`
 * (real `pilotDecide`, `runCodingLoop`, runner guard and D1 schema) talks — through the one edge it has, `callRunner` —
 * to the real browser-runner `CodingRuntime` and `HeadlessSession`, which spawn an INERT stream-json engine: a
 * throwaway node script that appends `{pid, text}` for every turn it reads to a log in a temp dir and answers.
 * Only the BYOK brain (`decideCodingAction`) and the relay's transport failures are simulated. So the assertions
 * are about WHICH PROCESS received WHICH BYTES, and how many times — not only about the cloud's own state.
 * Every fixture is synthetic; nothing touches a live session, a real engine or a real owner process.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { callRunner, decideCodingAction, live } = vi.hoisted(() => ({ callRunner: vi.fn(), decideCodingAction: vi.fn(), live: { node: "A" } }));
vi.mock("../../lib/runner-client.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/runner-client.js")>("../../lib/runner-client.js");
	// Whichever machine is live NOW — a reconnect re-resolves it, exactly as production's getBoundRunnerConn does.
	const conn = () => ({ kind: "relay", instanceId: "i1", runnerNode: live.node, relayName: `i1:node:${live.node}` });
	return {
		...actual,
		callRunner: (...a: unknown[]) => callRunner(...a),
		getRunnerConnIgnoringLiveness: async () => conn(),
		getBoundRunnerConn: async () => conn(),
		relayConnected: async () => true,
	};
});
vi.mock("../../lib/coding-loop.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/coding-loop.js")>("../../lib/coding-loop.js");
	return { ...actual, decideCodingAction: (...a: unknown[]) => decideCodingAction(...a) };
});

import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { CodingRuntime } from "../../../../../packages/browser-runner/src/coding/runtime.js";
import type { CodingDecision, CodingGoal } from "../../lib/coding-loop.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "../../lib/d1-sqlite.js";
import { getLoopRun } from "../../lib/agent-loop-store.js";
import { MAX_OBJECTIVE_CONSTRAINT_CHARS } from "../../lib/coding-objective-delivery.js";
import { IDLE_POLL_FAST_MS } from "../../lib/coding-idle-poll.js";
import { continueRefusal } from "../../routes/loop-continue-routes.js";
import { activeConstraints, constraintLines, constraintSources } from "../../lib/coding-scope-constraints.js";
import { RunnerUnreachableError } from "../../lib/runner-unreachable.js";
import type { Env } from "../../types.js";
import type { CodingSessionParams } from "../coding-session-params.js";
import { runCodingSessionWorkflow } from "./workflow-run.js";

// Real engine PROCESSES are spawned per test, and now given real time to read (see `fakeStep.sleep`), so the 5s
// default — chosen for pure functions — is not this file's budget. 60s, from a deliberately loaded run (eight copies
// of this file at once took up to ~10s a test), the same reasoning as the integration project's 120s; a real hang still fails.
vi.setConfig({ testTimeout: 60_000 });

/** The inert engine: reads stream-json turns, logs what it read and under which pid, answers. Never runs anything. */
const engineScript = (log: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "inert-" + process.pid }) + "\\n");
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type !== "user") return;
  const text = (m.message?.content || []).map((b) => b.text).join(" ");
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, text }) + "\\n");
  // A turn that is READ and never answered (#1364): the kill then always lands before the turn's result, so the turn is
  // LOST and the run sends its one recovery turn — the path that used to happen only when load delayed the result.
  if (text.includes("HOLD-RESULT")) return;
  // An engine that cannot sign in says so and EXITS — the shape a lost login takes (#881).
  if (text.includes("NEEDS-LOGIN")) { process.stdout.write("Not logged in · Please run /login\\n", () => process.exit(1)); return; }
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }) + "\\n");
});
`;

interface Machine {
	name: string;
	rt: CodingRuntime;
	dir: string;
	log: string;
	bin: string;
	/** What its `/capabilities` answers — the real runtime's own unless the machine is an older one. */
	caps?: string[];
}
let root: string;
const machines: Machine[] = [];
function newMachine(name: string, caps?: string[]): Machine {
	const dir = join(root, name);
	mkdirSync(join(dir, "work"), { recursive: true });
	const log = join(dir, "engine.log");
	const bin = join(dir, "inert-engine.js");
	writeFileSync(bin, engineScript(log));
	chmodSync(bin, 0o755);
	const m = { name, rt: new CodingRuntime(join(dir, "repos")), dir, log, bin, caps };
	machines.push(m);
	return m;
}
/** Every turn this machine's engine processes read, in order, with the pid that read it. */
const readBy = (m: Machine): Array<{ pid: number; text: string }> =>
	existsSync(m.log)
		? readFileSync(m.log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
/** How many times ANY engine process on ANY machine read a turn carrying this (unique) instruction. */
const executions = (text: string) => machines.flatMap(readBy).filter((t) => t.text.includes(text)).length;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// An upper bound on a real engine process starting or answering, never a deadline under test: 5s failed under full-suite
// load (#1360) — `loseReplyOf` waited that long for a node process to read its first turn. Returns as soon as it holds.
async function until(cond: () => boolean, ms = 30_000) {
	const t0 = Date.now();
	while (!cond() && Date.now() - t0 < ms) await wait(20);
	if (!cond()) throw new Error("timed out");
}

let target: Machine;
const byName = new Map<string, Machine>();
/** Hooks the relay's failures hang on. `act` wraps the dispatch; `capture` may fail a read. */
let hooks: { act?: (m: Machine, body: Record<string, unknown>, send: () => unknown) => Promise<unknown>; capture?: (n: number) => Error | null; onStart?: (n: number) => void };
let captures = 0;
let starts = 0;
/** Every act id dispatched to a runner, in order — attempts included. */
let actIds: string[] = [];

async function route(path: string, body: Record<string, unknown> = {}): Promise<unknown> {
	if (evicted) throw new Evicted(path); // an evicted instance reaches no runner
	const m = byName.get(live.node) ?? target;
	const sid = String(body.sessionId ?? "s1");
	switch (path) {
		case "/capabilities":
			return { capabilities: m.caps ?? CodingRuntime.capabilities() };
		case "/coding/start": {
			hooks.onStart?.(++starts);
			const t = byName.get(live.node) ?? target;
			return t.rt.start({ ...(body as object), sessionId: sid, repoId: "r1", workDir: join(t.dir, "work"), bin: t.bin, cloneUrl: undefined } as never);
		}
		case "/coding/capture": {
			const fail = hooks.capture?.(++captures);
			if (fail) throw fail;
			return m.rt.snapshot(sid, { drainUsage: !!body.drainUsage });
		}
		case "/coding/act": {
			actIds.push(String((body.action as { inputId?: string }).inputId));
			const send = () => m.rt.act(sid, body.action as never);
			return hooks.act ? hooks.act(m, body, send) : send();
		}
		case "/coding/end":
			return m.rt.end(sid);
		case "/coding/git":
			return { output: "## main...origin/main\n" };
		case "/coding/sync":
			return { checked: true, branch: "main", upstream: "origin/main", localHead: "aaaaaaaa1", remoteHead: "aaaaaaaa1", ahead: 0, behind: 0, fetched: true };
		default:
			return {};
	}
}

let decisions: CodingDecision[];
let d1: RealSchemaD1;
let env: Env;

/** A durable-step journal; `sleep` yields real time so the inert engine's turns can finish between polls. */
interface Journal {
	done: Map<string, unknown>;
	failed: Map<string, unknown>;
}
const newJournal = (): Journal => ({ done: new Map(), failed: new Map() });
/** The workflow instance is EVICTED: the step in flight never completes, and nothing after it runs on this instance. */
class Evicted extends Error {}
let evicted = false;
function fakeStep(j: Journal): WorkflowStep {
	return {
		async do(name: string, a: unknown, b?: unknown) {
			const cb = (typeof a === "function" ? a : b) as () => Promise<unknown>;
			if (evicted) throw new Evicted(name);
			if (j.done.has(name)) return j.done.get(name);
			if (j.failed.has(name)) throw j.failed.get(name); // a step that exhausted its retries replays as that failure
			try {
				const v = await cb();
				j.done.set(name, v);
				return v;
			} catch (e) {
				if (evicted) throw e; // an evicted step is neither done nor failed — it is reconstructed from the journal
				j.failed.set(name, e);
				throw e;
			}
		},
		// A durable sleep is REAL seconds in production (the idle wait's shortest poll is IDLE_POLL_FAST_MS, 2s), and the
		// engine process keeps working through it. A fixed 15ms compressed the run's whole 480-second idle window
		// (`awaitEngineIdle` counts the REQUESTED delay) into ~3s of wall clock, so on a loaded machine a real engine's
		// node startup outlasted it: the run gave up on a turn nobody had read yet — the act B never read, the duplicate
		// turn, the replacement's extra turn in CI. So each sleep yields real time until the live engine is between
		// turns, bounded by the interval asked for and by that 2s floor. Nothing about what is asserted changes.
		async sleep(_name: string, ms = 0) {
			if (evicted) throw new Evicted("sleep");
			await wait(15);
			const m = byName.get(live.node) ?? target;
			const t0 = Date.now();
			while (Date.now() - t0 < Math.min(ms, IDLE_POLL_FAST_MS)) {
				let busy = false;
				try {
					const snap = m.rt.snapshot("s1");
					busy = snap.alive && snap.runState !== "idle";
				} catch {
					busy = false; // no session on this machine: nothing to give time to
				}
				if (!busy) break;
				await wait(20);
			}
		},
	} as unknown as WorkflowStep;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pags-objective-composition-"));
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', 'i1', 'u1', 'acme/widget', '/w/widget', 'ready')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('s1', 'i1', 'r1', 'u1', 'active', 'claude')`);
	env = { DB: d1.DB } as unknown as Env;
	hooks = {};
	captures = 0;
	starts = 0;
	actIds = [];
	evicted = false;
	live.node = "A";
	byName.clear();
	target = newMachine("A");
	byName.set("A", target);
	callRunner.mockReset();
	callRunner.mockImplementation(async (_conn: unknown, path: string, body?: Record<string, unknown>) => route(path, body));
	decideCodingAction.mockReset();
	decideCodingAction.mockImplementation(async () => (decisions.length > 1 ? decisions.shift() : decisions[0]));
});
afterEach(() => {
	for (const m of machines.splice(0)) {
		try {
			m.rt.end("s1");
		} catch {
			/* already ended */
		}
	}
	d1.close();
	rmSync(root, { recursive: true, force: true });
});

const OBJ = "Investigate the export bug — ünïcødé ✓ 漢字 🚀 — and report.";
const SEND = (text: string): CodingDecision => ({ action: { kind: "message", text } });
const FINISH: CodingDecision = { finish: { status: "done", detail: "done" } };
function params(goal: Partial<CodingGoal> = {}, over: Partial<CodingSessionParams> = {}): CodingSessionParams {
	return { instanceId: "i1", userId: "u1", sessionId: "s1", repoId: "r1", runnerNode: "A", loopRunId: "run-C", goal: { objective: OBJ, repo: "acme/widget", clientType: "claude", ...goal }, ...over } as CodingSessionParams;
}
const run = (p = params(), j = newJournal()) => runCodingSessionWorkflow(env, { payload: p } as WorkflowEvent<CodingSessionParams>, fakeStep(j));
const events = (): Array<Record<string, unknown> & { event: string }> =>
	(d1.sqlite.prepare("SELECT event, message, context FROM agent_events WHERE event IN ('coding.run.objective', 'coding.run.input_unknown') ORDER BY rowid").all() as Array<{ event: string; message: string; context: string | null }>).map((r) => ({
		event: r.event,
		message: r.message,
		...(JSON.parse(r.context ?? "{}") as Record<string, unknown>),
	}));
const objectiveStates = () => events().filter((e) => e.event === "coding.run.objective").map((e) => e.state);
const carriesObjective = (t: { text: string }) => t.text.includes("[pags] RUN OBJECTIVE") && t.text.includes(OBJ);
const LEGACY_0_4_103 = ["coding.sessions", "coding.stream", "human.takeover", "coding.inspect", "coding.repo-write", "coding.run-objective"];

/** The engine process dies (an inert fixture, so SIGKILL harms nothing); resolved once the session has seen the exit. */
async function killEngine(m: Machine) {
	process.kill(readBy(m)[0].pid, "SIGKILL");
	await until(() => !m.rt.snapshot("s1").alive);
}

/** The act's reply is lost AFTER the runner accepted it and the engine READ it: the runner did the work, the cloud never heard. */
function loseReplyOf(nth: number, then?: (m: Machine) => void | Promise<void>) {
	let n = 0;
	hooks.act = async (m, _b, send) => {
		const before = readBy(m).length;
		const r = send();
		if (++n !== nth) return r;
		await until(() => readBy(m).length > before);
		await then?.(m);
		throw new RunnerUnreachableError("Runner disconnected", { dispatched: true });
	};
}

describe("first objective-bearing act interrupted, then the machine changes (#1019 case 1)", () => {
	it("before dispatch: the retry is RECOMPOSED for legacy 0.4.103 machine B — no objective envelope reaches B's engine", async () => {
		const b = newMachine("B", LEGACY_0_4_103);
		byName.set("B", b);
		let n = 0;
		hooks.act = async (_m, _b, send) => {
			if (++n === 1) throw new RunnerUnreachableError("No runner connected", { dispatched: false });
			return send();
		};
		hooks.onStart = (s) => {
			if (s === 2) live.node = "B"; // the machine that comes back is the older one
		};
		decisions = [SEND("first instruction"), FINISH];
		await run(params({ objectiveOrigin: { kind: "supervisor", by: "agent lead-1" } }));
		expect(readBy(target)).toEqual([]); // nothing reached A
		const onB = readBy(b);
		expect(onB).toHaveLength(1);
		expect(onB[0].text).not.toContain("RUN OBJECTIVE");
		expect(onB[0].text).not.toContain(OBJ);
		expect(onB[0].text).toContain("first instruction");
		expect(objectiveStates()).toEqual(["unsupported"]);
	});

	it("after dispatch: A ran it and the reply was lost; capable B (empty ledger) cannot authorize a replay — it runs nowhere twice", async () => {
		const b = newMachine("B");
		byName.set("B", b);
		loseReplyOf(1);
		hooks.onStart = (s) => {
			if (s === 2) live.node = "B";
		};
		decisions = [SEND("do the irreversible thing"), SEND("next"), FINISH];
		await run();
		expect(readBy(target).map((t) => t.text.endsWith("do the irreversible thing"))).toEqual([true]);
		expect(readBy(b).some((t) => t.text.includes("do the irreversible thing"))).toBe(false); // B never re-ran A's act
		expect(executions("do the irreversible thing")).toBe(1);
		expect(events().some((e) => e.event === "coding.run.input_unknown" && e.outcome === "unknown")).toBe(true);
	});
});

describe("same engine process versus a replacement (#1019 case 2)", () => {
	it("a relay reconnect to the SAME live process keeps the real receipt — no replacement delivery invented, nothing re-sent", async () => {
		loseReplyOf(1);
		decisions = [SEND("read the code"), SEND("now the tests"), FINISH];
		await run();
		const read = readBy(target);
		expect(new Set(read.map((t) => t.pid)).size).toBe(1); // one engine process throughout
		expect(read.map((t) => [carriesObjective(t), t.text.includes("read the code") ? "read the code" : t.text.includes("now the tests") ? "now the tests" : "?"])).toEqual([
			[true, "read the code"],
			[false, "now the tests"],
		]);
		const delivered = events().filter((e) => e.state === "delivered");
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toMatchObject({ generation: 0, consumedInputId: actIds[0] });
	});

	it("a REPLACEMENT process after a lost reply is not credited with its predecessor's reading: it is sent the objective itself", async () => {
		loseReplyOf(1, async (m) => {
			// The engine process FINISHES the act's turn, then dies; the relaunch spawns a new one in the same session.
			//
			// "Finishes" is waited for, not assumed (#1227). Killing the moment the read was LOGGED raced the inert
			// engine's own `result` line, which the runner needs to record the turn as consumed (#1019). On a loaded CI
			// machine the SIGKILL sometimes landed first: the turn was then LOST rather than finished, and #1053 rightly
			// sent the replacement its one recovery turn before "continue" — run 39205053900, `[true, false]` on the
			// replacement. That is a different case, owned by turn-recovery.test.ts and coding-turn-recovery.test.ts;
			// every assertion below describes this one, so the kill now waits for the runner to record the turn.
			await until(() => (m.rt.snapshot("s1").consumedInputs?.length ?? 0) >= 1);
			return killEngine(m);
		});
		decisions = [SEND("read the code"), SEND("continue"), FINISH];
		await run();
		const read = readBy(target);
		const pids = [...new Set(read.map((t) => t.pid))];
		expect(pids).toHaveLength(2);
		const [p1, p2] = pids;
		expect(read.filter((t) => t.pid === p1).map(carriesObjective)).toEqual([true]);
		expect(read.filter((t) => t.pid === p2).map(carriesObjective)).toEqual([true]); // owed again, carried to the replacement
		expect(executions("read the code")).toBe(1); // the predecessor's act was not replayed into the replacement
		expect(read.filter((t) => t.pid === p2).map((t) => t.text.includes("continue"))).toEqual([true]);
		// The receipt names the act the REPLACEMENT read — never the predecessor's act credited to it.
		const delivered = events().filter((e) => e.state === "delivered");
		expect(delivered).toHaveLength(1);
		const secondAct = actIds.find((id) => id !== actIds[0]);
		expect(delivered[0]).toMatchObject({ consumedInputId: secondAct, generation: expect.any(Number) });
		expect(delivered[0].generation).toBeGreaterThan(0);
	});

	it("a re-auth restart (end + start) resets the objective: the signed-in replacement engine is sent it", async () => {
		d1.exec(`UPDATE agent_instances SET config = '${JSON.stringify({ engineReauth: { clientType: "claude", method: "setup-token", session: "s1", status: "succeeded", startedAt: 1, completedAt: Date.now() + 10_000_000 } })}' WHERE id = 'i1'`);
		// The first engine READS the objective (delivered), then loses its sign-in and exits.
		decisions = [SEND("look around"), SEND("NEEDS-LOGIN now"), SEND("after sign-in"), FINISH];
		const r = await run();
		const read = readBy(target);
		const pids = [...new Set(read.map((t) => t.pid))];
		expect(pids).toHaveLength(2);
		expect(read.filter((t) => t.pid === pids[0]).map(carriesObjective)).toEqual([true, false]);
		const after = read.filter((t) => t.pid === pids[1]);
		expect(after.map((t) => [carriesObjective(t), t.text.includes("after sign-in")])).toEqual([[true, true]]);
		expect(events().filter((e) => e.state === "delivered")).toHaveLength(2); // once per engine that actually read it
		expect(r.outcome).not.toBe("needs_reauth");
	});
});

describe("lost outcomes are journalled facts, not re-derived (#1019 case 4)", () => {
	it("act reply AND reconciliation captures fail, the final capture recovers the read: a terminal receipt names it", async () => {
		loseReplyOf(1);
		let failing = false;
		const act = hooks.act;
		hooks.act = async (m, b, send) => {
			try {
				return await act?.(m, b, send);
			} catch (e) {
				failing = true;
				throw e;
			}
		};
		// Every capture from the lost reply until the run ends fails as a generic error; the closing drain reads again.
		hooks.capture = () => (failing && captures < 1_000 ? new Error("capture unavailable") : null);
		const drain = route;
		callRunner.mockImplementation(async (_c: unknown, path: string, body?: Record<string, unknown>) => {
			if (path === "/coding/capture" && body?.drainUsage && failing) failing = false; // the final drain gets through
			return drain(path, body);
		});
		decisions = [SEND("the only act"), FINISH];
		await run();
		expect(executions("the only act")).toBe(1);
		expect(objectiveStates()).toEqual(["delivered"]);
		expect(events().find((e) => e.state === "delivered")).toMatchObject({ consumedInputId: actIds[0] });
	});

	it("…and when no capture ever recovers it, the run ends `unknown` — never silent, never `delivered`", async () => {
		loseReplyOf(1);
		let lost = false;
		const act = hooks.act;
		hooks.act = async (m, b, send) => {
			try {
				return await act?.(m, b, send);
			} catch (e) {
				lost = true;
				throw e;
			}
		};
		hooks.capture = () => (lost ? new Error("capture unavailable") : null);
		decisions = [SEND("the only act"), FINISH];
		await run();
		expect(executions("the only act")).toBe(1);
		expect(objectiveStates()).toEqual(["unknown"]);
	});

	it("a completed-step replay of an UNKNOWN outcome reproduces it exactly — no new evidence, no new verdict, nothing re-sent", async () => {
		// A machine that cannot say: no ledger, no accepted ids (an older runner), reply lost after the engine read it.
		const legacyish = { ...target, caps: [...CodingRuntime.capabilities()] };
		byName.set("A", legacyish);
		const realSnapshot = target.rt.snapshot.bind(target.rt);
		target.rt.snapshot = ((sid: string, o?: { drainUsage?: boolean }) => {
			const { acceptedInputs: _a, engine: _e, consumedInputs: _c, ...rest } = realSnapshot(sid, o);
			return rest;
		}) as typeof target.rt.snapshot;
		loseReplyOf(1);
		decisions = [SEND("maybe ran"), FINISH];
		const j = newJournal();
		await run(params(), j);
		const first = events();
		const execs = executions("maybe ran");
		decisions = [SEND("maybe ran"), FINISH];
		await run(params(), j);
		expect(events()).toEqual(first);
		expect(executions("maybe ran")).toBe(execs);
		expect(first.filter((e) => e.event === "coding.run.objective").map((e) => e.state)).toEqual(["unknown"]);
	});
});

describe("the objective envelope carries the precedence AND the constraints in force (#1019 case 6)", () => {
	it("a standing owner restriction reaches the engine's bytes with the preserved goal, in the first envelope", async () => {
		d1.exec(`UPDATE coding_repos SET instructions = 'Read-only from now on. Do not push.' WHERE id = 'r1'`); // the repo's standing rule
		decisions = [SEND("summarise the export module"), FINISH];
		await run();
		const [first] = readBy(target);
		expect(carriesObjective(first)).toBe(true);
		expect(first.text).toContain("take precedence over it");
		expect(first.text).toMatch(/CONSTRAINTS IN FORCE NOW[\s\S]*read-only/i);
		// Objective first, its constraints beneath it, the Pilot's own instruction last.
		expect(first.text.indexOf(OBJ)).toBeLessThan(first.text.search(/CONSTRAINTS IN FORCE NOW/));
		expect(first.text.search(/CONSTRAINTS IN FORCE NOW/)).toBeLessThan(first.text.indexOf("summarise the export module"));
	});

	it("a restriction added since the last DECISION is in the RECOVERY turn the replacement engine reads (#1364)", async () => {
		// The turn is read and never answered, so the kill lands before its result: the turn is lost and the run sends its
		// one recovery turn to the replacement, with the objective. That envelope's constraints were the ones read at the
		// last decision — before this restriction — though it says "CONSTRAINTS IN FORCE NOW".
		loseReplyOf(1, (m) => {
			d1.exec(`INSERT INTO coding_session_directives (id, session_id, instance_id, user_id, repo_id, run_id, kind, delivery, content, created_at)
			  VALUES ('dir-rec', 's1', 'i1', 'u1', 'r1', NULL, 'steer', 'queued', 'Read-only from now on.', ${Date.now()})`);
			return killEngine(m);
		});
		decisions = [SEND("look around HOLD-RESULT"), SEND("summarise"), FINISH];
		await run();
		const read = readBy(target);
		const [first] = read;
		expect(first.text).not.toMatch(/read-only/i);
		const replacement = read.filter((t) => t.pid !== first.pid);
		expect(replacement.length).toBeGreaterThan(0);
		// The replacement's FIRST read is the recovery turn, and it carries the objective — with the newer restriction.
		expect(replacement[0].text).toMatch(/previous turn/i);
		expect(carriesObjective(replacement[0])).toBe(true);
		expect(replacement[0].text).toMatch(/CONSTRAINTS IN FORCE NOW[\s\S]*read-only/i);
	});

	it("a NEWER restriction arriving mid-run is in the envelope the replacement engine reads", async () => {
		loseReplyOf(1, (m) => {
			d1.exec(`INSERT INTO coding_session_directives (id, session_id, instance_id, user_id, repo_id, run_id, kind, delivery, content, created_at)
			  VALUES ('dir-new', 's1', 'i1', 'u1', 'r1', NULL, 'steer', 'queued', 'Read-only from now on.', ${Date.now()})`);
			return killEngine(m);
		});
		decisions = [SEND("look around"), SEND("summarise"), FINISH];
		await run();
		const read = readBy(target);
		const [first] = read;
		expect(first.text).not.toMatch(/read-only/i);
		const replacement = read.filter((t) => t.pid !== first.pid);
		expect(replacement.length).toBeGreaterThan(0);
		expect(carriesObjective(replacement[0])).toBe(true);
		expect(replacement[0].text).toMatch(/CONSTRAINTS IN FORCE NOW[\s\S]*read-only/i);
	});
});

describe("retained controls", () => {
	it("a fresh run on a capable machine delivers the 20k-character Unicode objective whole, once, with its exact digest", async () => {
		const unicode = "€".repeat(13_331) + "a".repeat(6_669); // 20,000 characters, 46,662 UTF-8 bytes
		decisions = [SEND("go"), SEND("again"), FINISH];
		await run(params({ objective: unicode, objectiveOrigin: { kind: "account" } }));
		const read = readBy(target);
		expect(read.filter((t) => t.text.includes(unicode))).toHaveLength(1);
		expect(read[0].text).toContain("submitted for run run-C through the owner's authenticated account");
		const { createHash } = await import("node:crypto");
		expect(events().find((e) => e.state === "delivered")).toMatchObject({ chars: 20_000, utf8Bytes: 46_662, sha256: createHash("sha256").update(unicode, "utf8").digest("hex") });
		expect(JSON.stringify(events())).not.toContain("€€€");
	});

	it("an act is executed once by the engine, in the same session, with no lost reply", async () => {
		decisions = [SEND("one"), SEND("two"), FINISH];
		await run();
		expect(executions("one")).toBe(1);
		expect(executions("two")).toBe(1);
		expect(objectiveStates()).toEqual(["delivered"]);
	});
});

// ── Workflow-instance EVICTION mid-send: the journal is all that survives (#1019) ───────────────────

describe("an evicted workflow instance reconstructed from its journal (#1019 durable intent)", () => {
	/**
	 * Evict on the run's FIRST act: `afterDispatch` lets A accept and read it first (the reply is then lost
	 * with the instance); otherwise the instance dies before anything is dispatched. Then a fresh workflow
	 * instance is reconstructed from the completed-step journal on `node`, whose runner holds the session.
	 */
	async function evictAndReconstruct(opts: { afterDispatch: boolean; node: "A" | "B" }) {
		let n = 0;
		hooks.act = async (m, _b, send) => {
			if (++n !== 1) return send();
			if (opts.afterDispatch) {
				const before = readBy(m).length;
				send();
				await until(() => readBy(m).length > before && m.rt.snapshot("s1").runState === "idle");
			}
			evicted = true;
			throw new Evicted("instance evicted mid-act");
		};
		decisions = [SEND("the evicted act"), SEND("after reconstruction"), FINISH];
		const j = newJournal();
		await run(params(), j).catch(() => undefined);
		expect([...j.done.keys()].some((k) => k.endsWith("-act-intent"))).toBe(true); // the intent outlived the instance
		evicted = false;
		hooks.act = undefined;
		if (opts.node === "B") {
			const b = newMachine("B");
			byName.set("B", b);
			live.node = "B";
			b.rt.start({ sessionId: "s1", repoId: "r1", workDir: join(b.dir, "work"), clientType: "claude", bin: b.bin } as never); // B's runner resumes the session
		}
		decisions = [SEND("after reconstruction"), FINISH];
		await run(params(), j);
		return machines.find((m) => m.name === "B");
	}
	const unknownFor = (id: string) => events().some((e) => e.event === "coding.run.input_unknown" && e.inputId === id);

	it("accepted + reply lost, reconstructed on the SAME ledger: reconciled from A's receipt — executed once, never re-sent", async () => {
		await evictAndReconstruct({ afterDispatch: true, node: "A" });
		expect(executions("the evicted act")).toBe(1);
		expect(actIds.filter((id) => id === actIds[0])).toHaveLength(1); // one dispatch of that id, ever
	});

	it("accepted + reply lost, reconstructed on capable B (a different ledger): A1 + B0 — unknown, not a replay", async () => {
		const b = await evictAndReconstruct({ afterDispatch: true, node: "B" });
		expect(readBy(target).filter((t) => t.text.includes("the evicted act"))).toHaveLength(1);
		expect(readBy(b as Machine).some((t) => t.text.includes("the evicted act"))).toBe(false);
		expect(unknownFor(actIds[0])).toBe(true);
		expect(events().filter((e) => e.state === "delivered").every((e) => e.consumedInputId !== actIds[0])).toBe(true);
	});

	it("evicted BEFORE dispatch, reconstructed on the same ledger: that ledger proves it absent — sent exactly once", async () => {
		await evictAndReconstruct({ afterDispatch: false, node: "A" });
		expect(executions("the evicted act")).toBe(1);
		expect(readBy(target).filter((t) => t.text.includes("the evicted act")).map(carriesObjective)).toEqual([true]);
	});

	it("evicted BEFORE dispatch, reconstructed on B: the intent's uncertainty does not authorize B — unknown, never a false 'unsent'", async () => {
		const b = await evictAndReconstruct({ afterDispatch: false, node: "B" });
		expect(executions("the evicted act")).toBe(0);
		expect(readBy(b as Machine).some((t) => t.text.includes("the evicted act"))).toBe(false);
		expect(unknownFor(actIds[0])).toBe(true); // the act the evicted instance was about to send is reported unknown, by its own id
	});
});

// ── Same id, different content: a conflict is never delivery of the changed content (#1019 case 5) ─────

describe("the workflow never reports changed content delivered under an id the runner holds for other content (#1019 case 5)", () => {
	/** Before the workflow's FIRST act reaches the runner, the same id was already accepted and READ — with `seeded` content. */
	function seedSameId(seeded: (action: Record<string, unknown>) => Record<string, unknown>) {
		let n = 0;
		hooks.act = async (m, body, send) => {
			if (++n === 1) {
				const before = readBy(m).length;
				m.rt.act("s1", seeded(body.action as Record<string, unknown>) as never);
				await until(() => readBy(m).length > before && m.rt.snapshot("s1").runState === "idle");
			}
			return send();
		};
	}
	const objectiveOf = (a: Record<string, unknown>) => a.objective as Record<string, unknown>;

	it("changed instruction AND objective: the runner refuses it, the engine read only FIRST, and no receipt says delivered", async () => {
		seedSameId((a) => ({ ...a, text: "FIRST", objective: { ...objectiveOf(a), text: "FIRST OBJECTIVE" } }));
		decisions = [SEND("CHANGED"), FINISH];
		await run(params({ objective: "CHANGED UNSEEN OBJECTIVE" }));
		const read = readBy(target);
		expect(read).toHaveLength(1);
		expect(read[0].text).toContain("FIRST OBJECTIVE");
		expect(machines.flatMap(readBy).some((t) => t.text.includes("CHANGED"))).toBe(false);
		expect(objectiveStates()).not.toContain("delivered");
		expect(objectiveStates()).toEqual(["unknown"]);
		expect(events().some((e) => e.event === "coding.run.input_unknown" && e.outcome === "conflict")).toBe(true);
	});

	it("same instruction and objective but CHANGED constraints under the same id: a conflict too — never delivered", async () => {
		d1.exec(`UPDATE coding_repos SET instructions = 'Read-only from now on.' WHERE id = 'r1'`);
		seedSameId((a) => ({ ...a, objective: { ...objectiveOf(a), constraints: ["- an older constraint set"] } }));
		decisions = [SEND("summarise"), FINISH];
		await run();
		expect(readBy(target)).toHaveLength(1);
		expect(readBy(target)[0].text).toContain("an older constraint set");
		expect(objectiveStates()).toEqual(["unknown"]);
	});

	it("the SAME content under the same id (a retry whose first reply was lost) is the positive: executed once, delivered", async () => {
		seedSameId((a) => ({ ...a }));
		decisions = [SEND("same both times"), FINISH];
		await run();
		expect(executions("same both times")).toBe(1);
		expect(objectiveStates()).toEqual(["delivered"]);
		expect(events().find((e) => e.state === "delivered")).toMatchObject({ consumedInputId: actIds[0] });
	});
});

// ── Constraints that do not fit one envelope: refused whole, never cut — and NOTHING reaches the engine ─────────
//
// A runner that renders the envelope (v3) must receive the constraints in force WHOLE, or no act at all: the run
// stops before any engine input, with a refused receipt (#1019). Lines are computed with the production
// constraintLines(), so the boundary is the real one. Legacy `unsupported` runners keep their own path (case 1 above).

describe("constraints are delivered whole or the run stops before ANY engine input (#1019)", () => {
	const grants = (names: string[]) => names.map((n) => `You may kill the ${n} processes.`).join(" ");
	const linesFor = (names: string[]) => constraintLines(activeConstraints(constraintSources({ standingInstructions: grants(names) })));
	const name = (i: number) => `worker-pool-process-name-${String(i).padStart(2, "0")}-abcdefgh`;
	/** The most process names whose single grant line still fits one envelope line — and the count one past it. */
	const atLimit = (() => {
		let k = 1;
		while (linesFor(Array.from({ length: k + 1 }, (_, i) => name(i))).every((l) => l.length <= MAX_OBJECTIVE_CONSTRAINT_CHARS)) k++;
		return k;
	})();
	const names = (k: number) => Array.from({ length: k }, (_, i) => name(i));
	const standing = (k: number) => d1.exec(`UPDATE coding_repos SET instructions = '${grants(names(k))}' WHERE id = 'r1'`);
	const stopEvents = () => events().filter((e) => e.state === "refused");

	it("one name past the limit: ZERO engine inputs, nothing accepted, a refused receipt, and the run stops naming why", async () => {
		standing(atLimit + 1);
		expect(linesFor(names(atLimit + 1)).some((l) => l.length > MAX_OBJECTIVE_CONSTRAINT_CHARS)).toBe(true);
		decisions = [SEND("list the stray workers"), FINISH];
		const r = await run();
		expect(readBy(target)).toEqual([]); // no engine process read anything
		expect(executions("list the stray workers")).toBe(0);
		expect(actIds).toEqual([]); // nothing was even dispatched to the runner
		expect(objectiveStates()).toEqual(["refused"]);
		expect(stopEvents()[0]).toMatchObject({ constraintLines: linesFor(names(atLimit + 1)).length });
		expect(String(stopEvents()[0].message)).toContain("a partial set is never sent");
		expect(String(stopEvents()[0].message)).toContain("stopped before the engine received anything");
		// Not `cancelled`: the owner cancelled nothing. A failed act-send whose stop reason is constraint_refused (#1019).
		expect(r).toMatchObject({ outcome: "failed", detail: expect.stringContaining("a partial set is never sent") });
	});

	it("exactly at the limit: delivered WHOLE — one execution, the exact line (with its Unicode em dash) in the engine's bytes", async () => {
		standing(atLimit);
		const lines = linesFor(names(atLimit));
		expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(MAX_OBJECTIVE_CONSTRAINT_CHARS);
		expect(lines.some((l) => l.includes("—"))).toBe(true);
		decisions = [SEND("list the stray workers"), FINISH];
		await run();
		const read = readBy(target);
		expect(executions("list the stray workers")).toBe(1);
		expect(carriesObjective(read[0])).toBe(true);
		for (const line of lines) expect(read[0].text).toContain(line); // byte-exact, Unicode included
		expect(objectiveStates()).toEqual(["delivered"]);
	});

	it("a replay of the refused run from its journal refuses again: still zero engine inputs, the receipt not re-reported", async () => {
		standing(atLimit + 1);
		decisions = [SEND("list the stray workers"), FINISH];
		const j = newJournal();
		await run(params(), j);
		const first = events();
		decisions = [SEND("list the stray workers"), FINISH];
		const again = await run(params(), j);
		expect(readBy(target)).toEqual([]);
		expect(actIds).toEqual([]);
		expect(events()).toEqual(first);
		expect(again).toMatchObject({ outcome: "failed" });
	});

	it("already DELIVERED, then a newer directive makes the set overlong: the next act is stopped — delivery is no bypass", async () => {
		let n = 0;
		hooks.act = async (_m, _b, send) => {
			const out = send();
			if (++n === 1) {
				d1.exec(`INSERT INTO coding_session_directives (id, session_id, instance_id, user_id, repo_id, run_id, kind, delivery, content, created_at)
				  VALUES ('dir-grants', 's1', 'i1', 'u1', 'r1', NULL, 'steer', 'queued', '${grants(names(atLimit + 1))}', ${Date.now()})`);
			}
			return out;
		};
		decisions = [SEND("first, within the constraints"), SEND("second, after the directive"), FINISH];
		const r = await run();
		expect(executions("first, within the constraints")).toBe(1);
		expect(executions("second, after the directive")).toBe(0);
		expect(actIds).toHaveLength(1);
		expect(objectiveStates()).toEqual(["delivered", "refused"]);
		expect(r).toMatchObject({ outcome: "failed" });
	});
});

// ── #1019: the refusal is the run's TERMINAL reason — on its last step too — and history it does not rewrite ───────

describe("a refused envelope is the run's own terminal reason, and earlier facts stand (#1019)", () => {
	const grants = (n: number) => Array.from({ length: n }, (_, i) => `You may kill the worker-pool-process-name-${String(i).padStart(2, "0")}-abcdefgh processes.`).join(" ");
	const overlong = () => d1.exec(`UPDATE coding_repos SET instructions = '${grants(14)}' WHERE id = 'r1'`);
	/** The run's own loop row, as the platform opens it — the terminal report and the continue decision read it. */
	const openRow = () => d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-C', 'u1', 'i1', 'synthetic', 'running', 10, ${Date.now()}, 's1')`);
	const notices = () => (d1.sqlite.prepare("SELECT title, body FROM notifications WHERE user_id = 'u1' ORDER BY rowid").all() as Array<{ title: string; body: string }>);

	it.each([
		["a message", SEND("list the stray workers")],
		["an interrupt", { action: { kind: "interrupt" } } as CodingDecision],
	])("refused on its FINAL step (%s): the refusal is the outcome, not max_steps — zero dispatch, one decision", async (_kind, decision) => {
		overlong();
		openRow();
		decisions = [decision, FINISH];
		const r = await run(params({}, { maxSteps: 1 } as Partial<CodingSessionParams>));
		expect(r).toMatchObject({ outcome: "failed", detail: expect.stringContaining("a partial set is never sent") });
		expect(String(r.detail)).not.toContain("gave up after");
		expect(actIds).toEqual([]);
		expect(readBy(target)).toEqual([]);
		expect(decideCodingAction).toHaveBeenCalledTimes(1);
		expect(await getLoopRun(env, "u1", "run-C")).toMatchObject({ stopReason: "constraint_refused", status: "needs_human" });
	});

	it("initial refusal: the terminal row is constraint_refused (continuable), the notice says stopped — never finished, never 'you stopped'", async () => {
		overlong();
		openRow();
		decisions = [SEND("list the stray workers"), FINISH];
		await run();
		const row = await getLoopRun(env, "u1", "run-C");
		expect(row).toMatchObject({ stopReason: "constraint_refused", status: "needs_human" });
		expect(continueRefusal(row as NonNullable<typeof row>)).toBeNull(); // preview and POST share this decision
		const n = notices();
		expect(n.map((x) => x.title)).not.toContain("✅ Coder finished");
		expect(n.some((x) => x.title === "⚠️ Coder stopped" && x.body.includes("a partial set is never sent"))).toBe(true);
		expect(String(row?.detail ?? "")).not.toContain("you stopped");
	});

	it("post-delivery refusal: the earlier delivery and read stand in the receipt AND the terminal reason; only the next act is refused", async () => {
		openRow();
		let n = 0;
		hooks.act = async (_m, _b, send) => {
			const out = send();
			if (++n === 1) {
				d1.exec(`INSERT INTO coding_session_directives (id, session_id, instance_id, user_id, repo_id, run_id, kind, delivery, content, created_at)
				  VALUES ('dir-g', 's1', 'i1', 'u1', 'r1', NULL, 'steer', 'queued', '${grants(14)}', ${Date.now()})`);
			}
			return out;
		};
		decisions = [SEND("first, within the constraints"), SEND("second, after the directive"), FINISH];
		const r = await run();
		expect(executions("first, within the constraints")).toBe(1);
		expect(executions("second, after the directive")).toBe(0);
		const refused = events().find((e) => e.state === "refused");
		expect(refused).toMatchObject({ priorRead: { inputId: actIds[0] }, actsSent: 1 });
		for (const said of [String(refused?.message), String(r.detail)]) {
			expect(said).toContain(`was delivered earlier and read by the engine (input ${actIds[0]}`);
			expect(said).toContain("stopped before its next act reached the engine");
			expect(said).not.toContain("was NOT delivered");
			expect(said).not.toContain("before the engine received anything");
		}
		const row = await getLoopRun(env, "u1", "run-C");
		expect(row).toMatchObject({ stopReason: "constraint_refused" });
		expect(continueRefusal(row as NonNullable<typeof row>)).toBeNull();
		expect(notices().map((x) => x.title)).not.toContain("✅ Coder finished");
	});

	it("a replay of the refused run settles the same terminal reason and receipt", async () => {
		overlong();
		openRow();
		decisions = [SEND("list the stray workers"), FINISH];
		const j = newJournal();
		const first = await run(params(), j);
		const ev = events();
		decisions = [SEND("list the stray workers"), FINISH];
		const again = await run(params(), j);
		expect(again).toEqual(first);
		expect(events()).toEqual(ev);
		expect(actIds).toEqual([]);
	});

	it("CONTROL: a genuine owner cancel is still `cancelled` — 'you stopped that run', not continuable", async () => {
		openRow();
		let n = 0;
		hooks.act = async (_m, _b, send) => {
			const out = send();
			if (++n === 1) d1.exec("UPDATE agent_loop_runs SET cancel_requested = 1 WHERE run_id = 'run-C'");
			return out;
		};
		decisions = [SEND("first"), SEND("second"), FINISH];
		const r = await run();
		expect(r.outcome).toBe("cancelled");
		const row = await getLoopRun(env, "u1", "run-C");
		expect(row?.stopReason).toBe("cancelled");
		expect(continueRefusal(row as NonNullable<typeof row>)).toContain("you stopped that run");
	});
});

// ── #1019: a delivery settled by the act's own pane counts that act ─────────────────────────────────────────────────

describe("the first delivered receipt counts the act that delivered it (#1019)", () => {
	it("a lost reply reconciled from a capture that already shows the read: delivered with actsSent 1, not 0", async () => {
		let n = 0;
		hooks.act = async (m, _b, send) => {
			const out = send();
			if (++n !== 1) return out;
			// The engine finishes reading the act; then the reply is lost. The retry's reconciling capture carries the read.
			await until(() => readBy(m).length === 1 && m.rt.snapshot("s1").runState === "idle" && (m.rt.snapshot("s1").engine?.consumed ?? []).length === 1);
			throw new RunnerUnreachableError("Runner disconnected", { dispatched: true });
		};
		decisions = [SEND("the only act"), FINISH];
		await run();
		const delivered = events().filter((e) => e.state === "delivered");
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toMatchObject({ consumedInputId: actIds[0], actsSent: 1 });
		expect(executions("the only act")).toBe(1);
	});
});
