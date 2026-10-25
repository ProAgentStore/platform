/**
 * #1358 — the capture's record cursor, over the real schema with only the runner faked.
 *
 * The runner numbers the usage and act records it produces and forgets one only when a later capture acknowledges it. The cloud persists
 * what a capture returns and sends the cursor back as the next capture's `ack`, taken from the JOURNALLED result so a replay resumes
 * where the last kept batch ended. A stream that failed to persist keeps its old cursor, so the runner sends it again; the inserts are
 * keyed on each record's own id, so a re-send writes nothing twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { callRunner } = vi.hoisted(() => ({ callRunner: vi.fn() }));
vi.mock("../../lib/runner-client.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/runner-client.js")>("../../lib/runner-client.js");
	return { ...actual, callRunner: (...a: unknown[]) => callRunner(...a) };
});

import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../../lib/d1-sqlite.js";
import type { RecordCursor } from "../../lib/coding-loop.js";
import type { RunnerConn } from "../../lib/runner-client.js";
import type { Env } from "../../types.js";
import { makeCapture } from "./coding-capture.js";

const IDLE = { pane: "$ ", runState: "idle", ready: true, alive: true, sessionId: "s1" };
const usage = (id: string, tokens = 10) => ({ id, provider: "anthropic", model: "claude-opus-5", inputTokens: tokens, outputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 });
const act = (id: string, command = "git push origin main") => ({ id, kind: "push.trunk", command, target: "origin main", irreversible: true, ok: true, at: "2026-10-26T10:00:00Z", atReliable: true });

let d1: RealSchemaD1;
let failBatch = false;
let failEvents = false;
let sent: Array<Record<string, unknown>>;
let replies: Array<Record<string, unknown>>;

/** A D1 whose usage batch, and whose trace writes, can be made to fail on demand. */
function flakyEnv(): Env {
	const DB = new Proxy(d1.DB, {
		get(target, prop) {
			if (prop === "batch") return (stmts: unknown[]) => (failBatch ? Promise.reject(new Error("d1 blip")) : target.batch(stmts as never));
			if (prop === "prepare") {
				return (sql: string) => {
					if (failEvents && /INSERT INTO (agent_events|instance_runtime_task_events)/.test(sql)) throw new Error("d1 blip");
					return target.prepare(sql);
				};
			}
			const v = Reflect.get(target, prop);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
	return { DB } as unknown as Env;
}

function capture(over: { getAck?: () => RecordCursor | undefined; mergePolicy?: "merge" | "none" } = {}) {
	return makeCapture({
		env: flakyEnv(),
		instanceId: "i1",
		userId: "u1",
		sessionId: "s1",
		loopRunId: undefined,
		driverId: undefined,
		repo: "owner/repo",
		mergePolicy: over.mergePolicy ?? "merge",
		writeScope: ["owner/repo"],
		cardId: null,
		getConn: () => ({ kind: "relay", instanceId: "i1" }) as unknown as RunnerConn,
		getAck: over.getAck ?? (() => undefined),
	});
}

const usageRows = () => d1.sqlite.prepare("SELECT id FROM ai_usage WHERE instance_id = 'i1'").all() as Array<{ id: string }>;
const actRows = () => d1.sqlite.prepare("SELECT id FROM agent_events WHERE event = 'act.consequential'").all() as Array<{ id: string }>;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', 'i1', 'u1', 'owner/repo', '/w/repo', 'ready')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('s1', 'i1', 'r1', 'u1', 'active', 'claude')`);
	failBatch = false;
	failEvents = false;
	sent = [];
	replies = [];
	callRunner.mockReset();
	callRunner.mockImplementation(async (_conn: unknown, path: string, body: Record<string, unknown>) => {
		if (path !== "/coding/capture") return {};
		sent.push(body);
		return replies.shift() ?? IDLE;
	});
});
afterEach(() => d1.close());

describe("the capture opts in to the cursor and keeps it (#1358)", () => {
	it("opens with the empty ack, persists what it is given, and hands the cursor back in the journalled pane — records stripped", async () => {
		replies.push({ ...IDLE, usage: [usage("u1")], acts: [act("a1")], recordCursor: { epoch: "e1", usage: 1, acts: 1 } });
		const out = await capture()();

		expect(sent[0]?.ack).toEqual({ epoch: null, usage: 0, acts: 0 });
		expect(out.recordAck).toEqual({ epoch: "e1", usage: 1, acts: 1 });
		expect(out).not.toHaveProperty("usage");
		expect(out).not.toHaveProperty("acts");
		expect(out).not.toHaveProperty("recordCursor");
		expect(usageRows()).toHaveLength(1);
		expect(actRows()).toHaveLength(1);
	});

	it("sends the cursor it last kept with the next capture", async () => {
		const cap = capture();
		replies.push({ ...IDLE, usage: [usage("u1")], recordCursor: { epoch: "e1", usage: 1, acts: 0 } });
		await cap();
		replies.push({ ...IDLE, usage: [usage("u2")], recordCursor: { epoch: "e1", usage: 2, acts: 0 } });
		await cap();
		expect(sent[1]?.ack).toEqual({ epoch: "e1", usage: 1, acts: 0 });
		expect(usageRows()).toHaveLength(2);
	});

	it("a replayed run resumes from the JOURNALLED cursor, not from nothing", async () => {
		// A fresh process: no memory of the last capture, only what the workflow journalled.
		await capture({ getAck: () => ({ epoch: "e1", usage: 7, acts: 3 }) })();
		expect(sent[0]?.ack).toEqual({ epoch: "e1", usage: 7, acts: 3 });
	});
});

describe("a re-send writes nothing twice", () => {
	it("the runner sends the same record again after a lost reply; the ledger and the audit trail keep one row each", async () => {
		const cap = capture();
		const batch = { ...IDLE, usage: [usage("u1")], acts: [act("a1")], recordCursor: { epoch: "e1", usage: 1, acts: 1 } };
		replies.push(batch, batch); // the first reply never reached the cloud's journal, so the same batch comes again
		await cap();
		await cap();
		expect(usageRows()).toHaveLength(1);
		expect(actRows()).toHaveLength(1);
	});
});

describe("a stream that could not be kept is not acknowledged (#1358)", () => {
	it("a refused usage write keeps the usage cursor where it was, acknowledges the acts, and the next capture's re-send is kept", async () => {
		const cap = capture();
		replies.push({ ...IDLE, usage: [usage("u1")], acts: [act("a1")], recordCursor: { epoch: "e1", usage: 1, acts: 1 } });
		failBatch = true;
		const first = await cap();
		expect(first.recordAck).toEqual({ epoch: "e1", usage: 0, acts: 1 }); // usage NOT acknowledged
		expect(usageRows()).toHaveLength(0);
		expect(actRows()).toHaveLength(1);

		// The runner still holds u1, so it comes again; the ledger is back.
		failBatch = false;
		replies.push({ ...IDLE, usage: [usage("u1")], acts: [], recordCursor: { epoch: "e1", usage: 1, acts: 1 } });
		const second = await cap();
		expect(sent[1]?.ack).toEqual({ epoch: "e1", usage: 0, acts: 1 });
		expect(second.recordAck).toEqual({ epoch: "e1", usage: 1, acts: 1 });
		expect(usageRows()).toHaveLength(1);
	});

	it("an act that reached neither the log nor the spool keeps the acts cursor — it is the audit trail", async () => {
		failEvents = true;
		replies.push({ ...IDLE, usage: [], acts: [act("a1")], recordCursor: { epoch: "e1", usage: 0, acts: 1 } });
		const out = await capture()();
		expect(out.recordAck).toEqual({ epoch: "e1", usage: 0, acts: 0 });
	});

	it("after a runner restart the failed stream starts again from zero — the old epoch's numbers are not its own", async () => {
		const cap = capture({ getAck: () => ({ epoch: "old", usage: 50, acts: 50 }) });
		replies.push({ ...IDLE, usage: [usage("u9")], acts: [], recordCursor: { epoch: "new", usage: 1, acts: 0 } });
		failBatch = true;
		const out = await cap();
		expect(out.recordAck).toEqual({ epoch: "new", usage: 0, acts: 0 });
	});

	it("neither failure throws or ends the run: the capture still returns its pane", async () => {
		failBatch = true;
		failEvents = true;
		replies.push({ ...IDLE, usage: [usage("u1")], acts: [act("a1")], recordCursor: { epoch: "e1", usage: 1, acts: 1 } });
		const out = await capture()();
		expect(out).toMatchObject({ pane: "$ ", alive: true });
	});
});

describe("an older runner is read as not speaking cursors", () => {
	it("no cursor back means no ack to send, and its records are persisted exactly as before", async () => {
		const cap = capture();
		replies.push({ ...IDLE, usage: [usage("u1")], acts: [act("a1")] }); // drained by the runner already
		const out = await cap();
		expect(out).not.toHaveProperty("recordAck");
		expect(usageRows()).toHaveLength(1);
		expect(actRows()).toHaveLength(1);
		replies.push({ ...IDLE });
		await cap();
		expect(sent[1]?.ack).toEqual({ epoch: null, usage: 0, acts: 0 }); // still offering the protocol each time, harmlessly
	});

	it("a malformed cursor is the same as none", async () => {
		for (const bad of [{ epoch: "", usage: 1, acts: 1 }, { epoch: "e", usage: -1, acts: 0 }, { epoch: "e", usage: 1.5, acts: 0 }, "x", 5]) {
			replies.push({ ...IDLE, recordCursor: bad });
			expect(await capture()()).not.toHaveProperty("recordAck");
		}
	});
});

describe("enforcement does not wait on persistence", () => {
	it("an unpermitted merge halts the run even while the audit write fails — and the cursor still withholds the act", async () => {
		failEvents = true;
		replies.push({ ...IDLE, usage: [], acts: [act("a1", "gh pr merge 12 --squash")].map((a) => ({ ...a, kind: "pr.merge" })), recordCursor: { epoch: "e1", usage: 0, acts: 1 } });
		const out = await capture({ mergePolicy: "none" })();
		expect(out.cancelled).toBe(true);
		expect(out.stopReason).toBeTruthy();
		expect(out.recordAck).toEqual({ epoch: "e1", usage: 0, acts: 0 });
	});
});
