/**
 * `PATCH /v1/instances/:instanceId/tasks/:taskId` — the merge, driven against the real schema
 * (PAS #137).
 *
 * `instances.contract.test.ts` already pins that this route EXISTS and that a stranger is
 * refused. Neither of those says the merge is a merge. The bug this route exists to avoid is
 * silent and specific: `POST /tasks/direct` with an existing id already overwrote the card,
 * and looked like an edit right up until the fields nobody mentioned came back empty. So the
 * assertions below are mostly about what did NOT change.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import { mirrorRuntimeTask, mirroredRuntimeTask } from "./instances-runtime.js";
import { registerTaskRoutes } from "./instances-tasks.js";
import type { Env } from "../types.js";

const SECRET = "tasks-patch-secret";
const USER = "owner-1";
const INSTANCE = "inst-1";
const TASK = "task-1";

function buildApp(d1: RealSchemaD1) {
	const env = { SESSION_SIGNING_KEY: SECRET, DB: d1.DB } as unknown as Env;
	const app = new Hono<{ Bindings: Env }>();
	const router = new Hono<{ Bindings: Env }>();
	registerTaskRoutes(router);
	app.route("/v1/instances", router);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: (err as Error).message }, 500);
	});
	return { app, env };
}

/** An actionable ticket, as `POST /tasks/direct` would have written it. */
const TICKET = {
	id: TASK,
	type: "ticket",
	status: "needs_approval",
	title: "Aply to Acme",
	description: "Senior engineer, remote",
	reasoning: "Matches the saved search and the salary floor.",
	action: { kind: "run_pipeline", config: { pipeline: "apply" } },
	createdAt: "2026-08-01T09:00:00.000Z",
	updatedAt: "2026-08-01T09:00:00.000Z",
};

async function setup() {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: USER, instanceIds: [INSTANCE] });
	const { app, env } = buildApp(d1);
	await mirrorRuntimeTask(env, INSTANCE, USER, TICKET);
	const token = await signSession(USER, SECRET, { roles: ["user"] });
	return { d1, app, env, token };
}

const patch = (app: Hono<{ Bindings: Env }>, env: Env, token: string, body: unknown, taskId = TASK) =>
	app.request(
		`/v1/instances/${INSTANCE}/tasks/${taskId}`,
		{
			method: "PATCH",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
		env,
	);

describe("PATCH a board ticket (PAS #137)", () => {
	it("amends only the field it was given, and leaves the rest of the ticket alone", async () => {
		const { app, env, token } = await setup();

		const res = await patch(app, env, token, { title: "Apply to Acme" });
		expect(res.status).toBe(200);

		// The regression that motivated the route: a one-word title fix must not blank the
		// prose either side of it, demote the card out of its column, or drop the work the
		// ticket stands for.
		const stored = (await mirroredRuntimeTask(env, INSTANCE, USER, TASK)) as Record<string, unknown>;
		expect(stored.title).toBe("Apply to Acme");
		expect(stored.description).toBe(TICKET.description);
		expect(stored.reasoning).toBe(TICKET.reasoning);
		expect(stored.status).toBe("needs_approval");
		expect(stored.action).toEqual(TICKET.action);
		expect(stored.type).toBe("ticket");
	});

	it("pins identity and creation time, and moves updatedAt", async () => {
		const { app, env, token } = await setup();

		await patch(app, env, token, { reasoning: "Re-checked: salary floor confirmed." });

		const stored = (await mirroredRuntimeTask(env, INSTANCE, USER, TASK)) as Record<string, unknown>;
		expect(stored.id).toBe(TASK);
		expect(stored.createdAt).toBe(TICKET.createdAt);
		expect(stored.updatedAt).not.toBe(TICKET.updatedAt);
	});

	it("treats an empty string as clear-this-field, not as absent", async () => {
		const { app, env, token } = await setup();

		await patch(app, env, token, { description: "" });

		const stored = (await mirroredRuntimeTask(env, INSTANCE, USER, TASK)) as Record<string, unknown>;
		expect(stored.description).toBe("");
		// …and the distinction is only meaningful if an omitted field still survives.
		expect(stored.reasoning).toBe(TICKET.reasoning);
	});

	it("amends several fields at once", async () => {
		const { app, env, token } = await setup();

		await patch(app, env, token, { title: "Apply to Acme Corp", description: "Staff engineer, remote" });

		const stored = (await mirroredRuntimeTask(env, INSTANCE, USER, TASK)) as Record<string, unknown>;
		expect(stored.title).toBe("Apply to Acme Corp");
		expect(stored.description).toBe("Staff engineer, remote");
		expect(stored.reasoning).toBe(TICKET.reasoning);
	});

	it("refuses a patch with nothing amendable in it rather than answering ok", async () => {
		const { app, env, token } = await setup();

		// `status` is deliberately not amendable here — moving a card is POST /board/status,
		// which validates the target against the agent's columns. Sending only that is an
		// empty patch, and must not read as success.
		const res = await patch(app, env, token, { status: "completed" });
		expect(res.status).toBe(400);

		const stored = (await mirroredRuntimeTask(env, INSTANCE, USER, TASK)) as Record<string, unknown>;
		expect(stored.status).toBe("needs_approval");
	});

	it("refuses an empty title and a non-string field", async () => {
		const { app, env, token } = await setup();

		expect((await patch(app, env, token, { title: "   " })).status).toBe(400);
		expect((await patch(app, env, token, { title: 42 })).status).toBe(400);
		expect((await patch(app, env, token, { description: null })).status).toBe(400);

		const stored = (await mirroredRuntimeTask(env, INSTANCE, USER, TASK)) as Record<string, unknown>;
		expect(stored.title).toBe(TICKET.title);
	});

	it("caps a field at its create-time limit, so editing cannot grow it", async () => {
		const { app, env, token } = await setup();

		await patch(app, env, token, { title: "x".repeat(500) });

		const stored = (await mirroredRuntimeTask(env, INSTANCE, USER, TASK)) as Record<string, unknown>;
		expect((stored.title as string).length).toBe(200);
	});

	it("404s for a task id that is not on this instance", async () => {
		const { app, env, token } = await setup();

		const res = await patch(app, env, token, { title: "nope" }, "task-does-not-exist");
		expect(res.status).toBe(404);
	});
});
