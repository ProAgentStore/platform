/**
 * `POST /v1/instances/:instanceId/board/status` — the display snapshot, driven against the
 * real schema (#652).
 *
 * The `board_items` columns exist for one reason: a card the user MOVED has to survive its
 * runtime tasks being cleared or aged out, and the snapshot taken at move time is the only
 * place its title, subtitle and url are then recorded. Two callers write through this route
 * and they disagree about which fields the request carries — the console sends all three,
 * MCP's `set_board_item_status` sends jobKey + status and nothing else — so the route's
 * treatment of a MISSING field is the whole contract.
 *
 * Run against `realSchemaD1` rather than a SQL-matching stub, because the fix is an upsert
 * conflict clause: a stub that records statements would have accepted `COALESCE(?5,
 * board_items.title)` without ever proving SQLite runs it, and the assertion that matters
 * here is what the row CONTAINS after a second write, not what SQL was issued.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { jobKeyForTask } from "../lib/board.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import { mirrorRuntimeTask } from "./instances-runtime.js";
import { registerTaskRoutes } from "./instances-tasks.js";
import type { Env } from "../types.js";

const SECRET = "board-status-secret";
const USER = "owner-1";
const INSTANCE = "inst-1";

/** In BOTH the default and the apply column sets, so the move is valid whichever the
 *  seeded agent resolves to — the route rejects a status no column claims. */
const STATUS = "needs_human";

/** A live runtime task, so the board has a real card to snapshot. */
const TASK = {
	id: "t1",
	type: "job.apply_agent",
	status: "running",
	title: "Acme — Senior Engineer",
	subtitle: "acme.co",
	input: { url: "https://acme.co/careers/eng" },
	createdAt: "2026-08-01T09:00:00.000Z",
	updatedAt: "2026-08-01T09:00:00.000Z",
};

const JOB_KEY = jobKeyForTask(TASK);

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

async function setup(opts: { withTask?: boolean } = {}) {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: USER, instanceIds: [INSTANCE] });
	const { app, env } = buildApp(d1);
	if (opts.withTask !== false) await mirrorRuntimeTask(env, INSTANCE, USER, TASK);
	const token = await signSession(USER, SECRET, { roles: ["user"] });
	return { d1, app, env, token };
}

const move = (app: Hono<{ Bindings: Env }>, env: Env, token: string, body: unknown) =>
	app.request(
		`/v1/instances/${INSTANCE}/board/status`,
		{ method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
		env,
	);

/** The stored card, read straight out of SQLite. */
function storedCard(d1: RealSchemaD1, jobKey = JOB_KEY) {
	return d1.sqlite
		.prepare("SELECT user_status, title, subtitle, url FROM board_items WHERE instance_id = ? AND user_id = ? AND job_key = ?")
		.get(INSTANCE, USER, jobKey) as { user_status: string; title: string; subtitle: string; url: string } | undefined;
}

describe("POST /board/status — the display snapshot (#652)", () => {
	it("a caller that sends no display fields does not blank the ones already stored", async () => {
		// THE regression. The console moves a card and stores its label; MCP later moves the
		// same card and sends only jobKey + status. Before the fix each absent field became ""
		// and the upsert wrote all three from `excluded.*`, so this second move wiped the
		// snapshot — invisibly, until the runs aged out and the card rendered its raw jobKey.
		const { d1, app, env, token } = await setup();

		expect((await move(app, env, token, { jobKey: JOB_KEY, status: STATUS, title: "Acme — Senior Engineer", subtitle: "acme.co", url: "https://acme.co/careers/eng" })).status).toBe(200);
		expect((await move(app, env, token, { jobKey: JOB_KEY, status: "blocked" })).status).toBe(200);

		const row = storedCard(d1)!;
		expect(row.user_status).toBe("blocked"); // the move itself still landed
		expect(row.title).toBe("Acme — Senior Engineer");
		expect(row.subtitle).toBe("acme.co");
		expect(row.url).toBe("https://acme.co/careers/eng");
		d1.close();
	});

	it("an explicitly empty title clears it — absent and \"\" are different instructions", async () => {
		// The distinction the fix turns on. If "" were folded into "absent" a caller could
		// never blank a wrong title again, which is a different bug in the same column.
		const { d1, app, env, token } = await setup();

		await move(app, env, token, { jobKey: JOB_KEY, status: STATUS, title: "Typo Co", subtitle: "acme.co", url: "https://acme.co/careers/eng" });
		await move(app, env, token, { jobKey: JOB_KEY, status: STATUS, title: "" });

		const row = storedCard(d1)!;
		expect(row.title).toBe("");
		expect(row.subtitle).toBe("acme.co"); // untouched: it was absent, not cleared
		d1.close();
	});

	it("a first move that sends no display fields snapshots what the board is showing", async () => {
		// Preserving a stored value is only half the defect: a card moved for the FIRST time
		// over MCP had nothing to preserve, so it recorded an empty row and degraded to the raw
		// jobKey just the same. The route fills the gaps from the live card instead.
		const { d1, app, env, token } = await setup();

		expect((await move(app, env, token, { jobKey: JOB_KEY, status: STATUS })).status).toBe(200);

		const row = storedCard(d1)!;
		expect(row.title).toBe("Acme — Senior Engineer");
		expect(row.title).not.toBe(JOB_KEY);
		expect(row.subtitle).toBe("acme.co");
		expect(row.url).toBe("https://acme.co/careers/eng");
		d1.close();
	});

	it("records an empty snapshot rather than a jobKey when the board has no card to read", async () => {
		// A jobKey is a normalized URL or a task id. Writing one into `title` would look like a
		// title the user chose and would survive every later "leave it alone" write, so a gap
		// that cannot be filled honestly stays a gap.
		const { d1, app, env, token } = await setup({ withTask: false });

		expect((await move(app, env, token, { jobKey: "csess-abc", status: STATUS })).status).toBe(200);

		const row = storedCard(d1, "csess-abc")!;
		expect(row.user_status).toBe(STATUS);
		expect(row.title).toBe("");
		d1.close();
	});

	it("an empty status still deletes the row, snapshot and all", async () => {
		const { d1, app, env, token } = await setup();

		await move(app, env, token, { jobKey: JOB_KEY, status: STATUS });
		expect(storedCard(d1)).toBeTruthy();

		expect((await move(app, env, token, { jobKey: JOB_KEY, status: "" })).status).toBe(200);
		expect(storedCard(d1)).toBeUndefined();
		d1.close();
	});

	it("refuses a status no column claims, and writes nothing", async () => {
		const { d1, app, env, token } = await setup();
		const res = await move(app, env, token, { jobKey: JOB_KEY, status: "not-a-column" });
		expect(res.status).toBe(400);
		expect(storedCard(d1)).toBeUndefined();
		d1.close();
	});

	it("404s for someone else's instance without touching the board", async () => {
		const { d1, app, env } = await setup();
		const stranger = await signSession("intruder", SECRET, { roles: ["user"] });
		const res = await move(app, env, stranger, { jobKey: JOB_KEY, status: STATUS });
		expect(res.status).toBe(404);
		expect(storedCard(d1)).toBeUndefined();
		d1.close();
	});
});
