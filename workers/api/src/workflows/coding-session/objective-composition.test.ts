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
import { RunnerUnreachableError } from "../../lib/runner-unreachable.js";
import type { Env } from "../../types.js";
import type { CodingSessionParams } from "../coding-session-params.js";
import { runCodingSessionWorkflow } from "./workflow-run.js";

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
async function until(cond: () => boolean, ms = 5_000) {
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
function fakeStep(j: Journal): WorkflowStep {
	return {
		async do(name: string, a: unknown, b?: unknown) {
			const cb = (typeof a === "function" ? a : b) as () => Promise<unknown>;
			if (j.done.has(name)) return j.done.get(name);
			if (j.failed.has(name)) throw j.failed.get(name); // a step that exhausted its retries replays as that failure
			try {
				const v = await cb();
				j.done.set(name, v);
				return v;
			} catch (e) {
				j.failed.set(name, e);
				throw e;
			}
		},
		async sleep() {
			await wait(15);
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
		loseReplyOf(1, (m) => {
			// The engine process dies after reading the act; the relaunch spawns a new one in the same session.
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
