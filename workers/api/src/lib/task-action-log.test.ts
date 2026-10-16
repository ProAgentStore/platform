/**
 * #1108 — every task type writes one ordered action log per board card, and it reads back the same
 * way for all of them. Over the real schema, through the real writers:
 *
 *   - CODING: `traceCodingRun` (start, end) and `recordEngineActs` (a push), on the session's card
 *     and on a board ticket's card.
 *   - APPLICATION: `syncApplicationCard` for a Tailor run and a Runner run, as the domains call it on
 *     every transition — only the action service's queue read (`getQueueItem`) and the application
 *     row are stubbed, because they need a whole Scout → Tailor → Runner pipeline to exist.
 *   - BROWSER: the runner's own task events (`mirrorRuntimeEvent`), projected on read — not copied.
 *
 * Plus paging (cursor, `tail` for live polling), ownership, redaction before persistence (#1069) and
 * the Runner trace keeping its NEWEST events.
 *
 * TODO(#1104): grouping a card's log with other tasks on the same work subject is deferred — the
 * subject model is an open owner design decision. Nothing here keys on a subject.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "./d1-sqlite.js";
import type { Env } from "../types.js";

const fake = vi.hoisted(() => ({ submittedUrl: "", appStatus: "tailoring" }));
vi.mock("./applications/control.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./applications/control.js")>()),
	getQueueItem: async () => ({
		item: { status: fake.appStatus, stateVersion: 3, actions: [], execution: { stage: "x" }, blockReason: null, fillProgress: null },
		pipeline: { runners: ["runner-1"] },
	}),
}));
vi.mock("./local-artifact/store.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./local-artifact/store.js")>()),
	getOwnedApplication: async (_env: unknown, _uid: string, id: string) => ({ id, lead: { title: "Engineer", company: "Acme", url: "https://jobs.example/role/1" }, submittedUrl: fake.submittedUrl }),
}));

const { readActionLog, writeActionEntry, redactUrlsInText } = await import("./task-action-log.js");
const { traceCodingRun } = await import("./coding-run-trace.js");
const { recordEngineActs } = await import("./engine-acts.js");
const { syncApplicationCard } = await import("./applications/application-board.js");
const { mirrorRuntimeEvent } = await import("../routes/instances-runtime.js");
const { getApplyRun, updateApplyRun, MAX_APPLY_TRACE } = await import("./local-apply/store.js");

const SECRETS = ["SYNTH-STATE-7f3a", "SYNTH-SESSION-55aa", "SYNTH-TOKEN-9b"];
let d1: RealSchemaD1;
let env: Env;
const card = (id: string, instanceId = "coder-1", type = "coding.session") =>
	d1.exec(`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at) VALUES ('${id}', '${instanceId}', 'u1', '${type}', 'running', '{}', datetime('now'), datetime('now'))`);
const rawPayloads = (taskId: string) => (d1.sqlite.prepare("SELECT payload FROM instance_runtime_task_events WHERE task_id = ?").all(taskId) as Array<{ payload: string }>).map((r) => r.payload).join("\n");
const log = async (taskId: string, instanceId = "coder-1", extra: { cursor?: string | null; limit?: number } = {}) => {
	const page = await readActionLog(env, { instanceId, userId: "u1", taskId, ...extra });
	if ("error" in page) throw new Error(page.error);
	return page;
};

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder-1", "tailor-1", "runner-1", "browser-1"] });
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u2', 'u2')`);
	env = { DB: d1.DB } as unknown as Env;
	fake.submittedUrl = "";
});
afterEach(() => d1.close());

describe("a CODING task logs its run on its card (#1108)", () => {
	it("start → a push → end, in order, typed, with the run's outcome — and a replayed start or end is not logged twice", async () => {
		card("csess-s1");
		const ctx = { userId: "u1", instanceId: "coder-1", sessionId: "s1", runId: "run-1", repo: "acme/app" };
		await traceCodingRun(env, ctx, "coding.run.start", "objective: fix the login bug");
		await recordEngineActs(env, { userId: "u1", instanceId: "coder-1", sessionId: "s1", traceId: "run-1" }, [
			{ id: "tu-1", kind: "push.trunk", command: "git push origin main", target: "origin main", irreversible: true, ok: true, at: new Date().toISOString(), atReliable: true },
		]);
		await traceCodingRun(env, ctx, "coding.run.end", `done — see https://github.com/acme/app/pull/7?token=${SECRETS[2]}`, { outcome: "done" });
		// A workflow step replay re-runs both writes.
		await traceCodingRun(env, ctx, "coding.run.start", "objective: fix the login bug");
		await traceCodingRun(env, ctx, "coding.run.end", "done", { outcome: "done" });

		const { entries, total } = await log("csess-s1");
		expect(total).toBe(3);
		expect(entries.map((e) => [e.actor, e.actionType, e.status])).toEqual([
			["coding-engine", "checkpoint", "running"],
			["coding-engine", "commit", "ok"],
			["coding-engine", "outcome", "ok"],
		]);
		expect(entries[0].summary).toBe("Coding run started — objective: fix the login bug");
		expect(entries[1].summary).toMatch(/pushed directly to the trunk/);
		expect(entries[2].summary).toBe("done — see https://github.com/acme/app/pull/7");
		expect(rawPayloads("csess-s1")).not.toContain(SECRETS[2]);
	});

	it("a run started from a board ticket logs on THAT card; a failed run ends `error`, a blocked one is a blocker", async () => {
		card("ticket-9");
		const ctx = { userId: "u1", instanceId: "coder-1", sessionId: "s2", runId: "run-2", cardId: "ticket-9" };
		await traceCodingRun(env, ctx, "coding.run.blocked", "base could not be confirmed");
		await traceCodingRun(env, ctx, "coding.run.end", "failed — engine crashed", { outcome: "failed" });
		const { entries } = await log("ticket-9");
		expect(entries.map((e) => [e.actionType, e.status])).toEqual([
			["blocker", "error"],
			["outcome", "error"],
		]);
	});
});

describe("an APPLICATION logs its Tailor and Runner on its card (#1108)", () => {
	it("tailor started/finished, runner started/submitted — one line per transition, the submitted URL redacted before it is stored", async () => {
		fake.submittedUrl = `https://boards.example/apply/done?state=${SECRETS[0]}&JobseekerSessionId=${SECRETS[1]}#frag`;
		const sync = (id: string, instanceId: string, status: string, kind: "tailor" | "fill") => syncApplicationCard(env, "u1", { id, instanceId, applicationId: "a1", status }, kind);
		await sync("tr-1", "tailor-1", "running", "tailor");
		await sync("tr-1", "tailor-1", "running", "tailor"); // a repeated sync of an unchanged run
		await sync("tr-1", "tailor-1", "completed", "tailor");
		await sync("fr-1", "runner-1", "running", "fill");
		await sync("fr-1", "runner-1", "submitted", "fill");
		await sync("fr-1", "runner-1", "submitted", "fill");
		// The reconciliation backfill writes the card, never a log line stamped with today's time.
		await syncApplicationCard(env, "u1", { id: "fr-old", instanceId: "runner-1", applicationId: "a1", status: "failed" }, "fill", { log: false });

		const { entries } = await log("app-a1", "runner-1");
		expect(entries.map((e) => [e.actor, e.actionType, e.status])).toEqual([
			["tailor", "checkpoint", "running"],
			["tailor", "outcome", "ok"],
			["runner", "checkpoint", "running"],
			["runner", "submit", "ok"],
		]);
		expect(entries[3].artifacts).toEqual([{ label: "submitted application", url: "https://boards.example/apply/done" }]);
		const raw = rawPayloads("app-a1");
		for (const s of SECRETS.slice(0, 2)) expect(raw, `${s} was persisted`).not.toContain(s);
		expect(raw).not.toContain("#frag");
	});
});

describe("a BROWSER task's own events are its log — projected, not copied (#1108)", () => {
	it("created → navigated → completed, in order; URLs reduced; the raw payload never surfaces", async () => {
		card("task_b1", "browser-1", "job.apply_agent");
		const ev = (id: string, type: string, message: string, at: string, extra: Record<string, unknown> = {}) =>
			mirrorRuntimeEvent(env, "browser-1", "u1", { id, taskId: "task_b1", type, message, createdAt: at, ...extra });
		await ev("e1", "task.created", "Task created: job.apply_agent", "2026-10-16T01:00:00Z");
		await ev("e2", "browser.navigated", `Opened https://login.seek.com/login?state=${SECRETS[0]}`, "2026-10-16T01:00:05Z", { url: `https://login.seek.com/login?state=${SECRETS[0]}`, data: { password: "hunter2" } });
		await ev("e3", "task.completed", "Completed", "2026-10-16T01:02:00Z");
		const { entries } = await log("task_b1", "browser-1");
		expect(entries.map((e) => [e.actionType, e.status])).toEqual([
			["checkpoint", "running"],
			["navigate", "ok"],
			["outcome", "ok"],
		]);
		expect(entries[1]).toMatchObject({ actor: "browser-agent", summary: "Opened https://login.seek.com/login", artifacts: [{ label: "page", url: "https://login.seek.com/login" }] });
		expect(JSON.stringify(entries)).not.toContain(SECRETS[0]);
		expect(JSON.stringify(entries)).not.toContain("hunter2");
	});
});

describe("paging, live tail, ownership", () => {
	it("pages oldest-first by cursor without gaps or repeats, and `tail` returns only what is new", async () => {
		card("csess-p");
		const t0 = Date.parse("2026-10-16T02:00:00Z");
		for (let i = 0; i < 5; i++) await writeActionEntry(env, { instanceId: "coder-1", userId: "u1", taskId: "csess-p", actor: "coding-engine", actionType: "tool_call", summary: `step ${i}`, status: "ok", at: t0 + i * 100 });
		const p1 = await log("csess-p", "coder-1", { limit: 2 });
		const p2 = await log("csess-p", "coder-1", { limit: 2, cursor: p1.nextCursor });
		const p3 = await log("csess-p", "coder-1", { limit: 2, cursor: p2.nextCursor });
		expect([...p1.entries, ...p2.entries, ...p3.entries].map((e) => e.summary)).toEqual(["step 0", "step 1", "step 2", "step 3", "step 4"]);
		expect([p1.hasMore, p2.hasMore, p3.hasMore]).toEqual([true, true, false]);
		expect(p3.nextCursor).toBeNull();
		expect(p1.total).toBe(5);
		// Live: nothing new yet, then exactly the new step.
		expect((await log("csess-p", "coder-1", { cursor: p3.tail })).entries).toEqual([]);
		await writeActionEntry(env, { instanceId: "coder-1", userId: "u1", taskId: "csess-p", actor: "coding-engine", actionType: "outcome", summary: "finished", status: "ok", at: t0 + 10_000 });
		expect((await log("csess-p", "coder-1", { cursor: p3.tail })).entries.map((e) => e.summary)).toEqual(["finished"]);
	});

	it("another owner, another instance or an unknown card is not_found; a forged cursor is refused", async () => {
		card("csess-o");
		expect(await readActionLog(env, { instanceId: "coder-1", userId: "u2", taskId: "csess-o" })).toEqual({ error: "not_found" });
		expect(await readActionLog(env, { instanceId: "runner-1", userId: "u1", taskId: "csess-o" })).toEqual({ error: "not_found" });
		expect(await readActionLog(env, { instanceId: "coder-1", userId: "u1", taskId: "nope" })).toEqual({ error: "not_found" });
		expect(await readActionLog(env, { instanceId: "coder-1", userId: "u1", taskId: "csess-o", cursor: "not-a-cursor" })).toEqual({ error: "bad_cursor" });
	});

	it("ticket-thread turns share the table but are not actions", async () => {
		card("csess-t");
		await mirrorRuntimeEvent(env, "coder-1", "u1", { id: "q1", taskId: "csess-t", type: "ticket.question", message: "why?", createdAt: "2026-10-16T03:00:00Z" });
		expect((await log("csess-t")).entries).toEqual([]);
	});

	it("redactUrlsInText keeps origin + path and drops what cannot be parsed", () => {
		expect(redactUrlsInText(`see https://a.example/p?x=${SECRETS[1]}#f and https://b.example/`)).toBe("see https://a.example/p and https://b.example/");
	});
});

describe("the Runner's run trace keeps its NEWEST events (#1108)", () => {
	it("past the cap, the oldest are dropped — not every event after the 500th", async () => {
		const old = Array.from({ length: MAX_APPLY_TRACE }, (_, i) => ({ type: "browser.navigated", at: new Date(Date.parse("2026-10-16T00:00:00Z") + i * 1000).toISOString() }));
		d1.DB.prepare(
			`INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, status, policy, trace, created_at, updated_at) VALUES ('fr-cap', 'runner-1', 'u1', 'a1', 'req', 'running', '{}', ?1, 1, 1)`,
		)
			.bind(JSON.stringify(old))
			.run();
		const run = await getApplyRun(env, "runner-1", "u1", "fr-cap");
		const updated = await updateApplyRun(env, run as NonNullable<typeof run>, { events: [{ type: "submit.confirmed", at: "2026-10-16T02:00:00.000Z" } as never] }, 2);
		expect(updated?.trace).toHaveLength(MAX_APPLY_TRACE);
		expect(updated?.trace.at(-1)).toMatchObject({ type: "submit.confirmed" });
	});
});
