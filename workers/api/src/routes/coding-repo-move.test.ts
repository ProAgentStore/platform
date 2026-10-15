/**
 * PR835 / #829 — moving a repo (`PUT /coding/repos/:id` with a new `workdir`) cannot land it on a
 * folder another binding on the same instance already uses.
 *
 * The add paths already refuse a second binding on one checkout (`routes/coding-repo-add.ts`); a move
 * was the way round it. Driven over the real migrated schema (`d1-sqlite.ts`), with only the runner
 * connection faked (no machine: a moved path is stored `unknown`, never probed), and every assertion
 * reads the row the table actually holds afterwards.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";

const { getBoundRunnerConn } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn() }));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/runner-client.js")>()), getBoundRunnerConn }));

const { registerRepoRoutes } = await import("./coding-repos.js");

const SECRET = "coding-repo-move-secret";
let d1: RealSchemaD1;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1", "i2"] });
	const repo = (id: string, instance: string, name: string, workdir: string) =>
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, provider, workdir, clone_status) VALUES ('${id}', '${instance}', 'u1', '${name}', 'local', '${workdir}', 'ready')`);
	repo("repo-a", "i1", "apps/alpha", "~/dev/alpha");
	repo("repo-b", "i1", "apps/beta", "~/dev/beta");
	repo("repo-z", "i2", "apps/other", "~/dev/shared");
	getBoundRunnerConn.mockReset();
	getBoundRunnerConn.mockResolvedValue(null);
});
afterEach(() => d1.close());

async function move(repoId: string, body: Record<string, unknown>, instanceId = "i1") {
	const routes = new Hono<{ Bindings: Env }>();
	registerRepoRoutes(routes);
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", routes);
	app.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500));
	const token = await signSession("u1", SECRET, { roles: [] });
	const res = await app.request(
		`/v1/instances/${instanceId}/coding/repos/${repoId}`,
		{ method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
		{ SESSION_SIGNING_KEY: SECRET, DB: d1.DB } as unknown as Env,
	);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const workdirOf = (id: string) => (d1.sqlite.prepare("SELECT workdir FROM coding_repos WHERE id = ?").get(id) as { workdir: string }).workdir;

describe("PUT /coding/repos/:id — a move never lands on another binding's folder (PR835, #829)", () => {
	it("refuses a move onto the folder another binding on this instance uses, naming it, and writes nothing", async () => {
		const { status, body } = await move("repo-a", { workdir: "~/dev/beta" });
		expect(status).toBe(409);
		expect(body).toMatchObject({ existingId: "repo-b", existingName: "apps/beta" });
		expect(String(body.error)).toMatch(/already the folder of "apps\/beta"/);
		expect(workdirOf("repo-a")).toBe("~/dev/alpha");
		expect(workdirOf("repo-b")).toBe("~/dev/beta");
	});

	it("matches the folder whatever trailing slashes either side carries", async () => {
		const { status } = await move("repo-a", { workdir: "~/dev/beta/" });
		expect(status).toBe(409);
		expect(workdirOf("repo-a")).toBe("~/dev/alpha");
	});

	it("resending the repo's OWN folder is a no-op, and a respelling of it is not a conflict with itself", async () => {
		expect((await move("repo-a", { name: "alpha", workdir: "~/dev/alpha" })).status).toBe(200);
		expect(workdirOf("repo-a")).toBe("~/dev/alpha");
		expect((await move("repo-a", { workdir: "~/dev/alpha/" })).status).toBe(200);
	});

	it("moves to a free folder, keeping the row", async () => {
		const { status, body } = await move("repo-a", { workdir: "~/dev/alpha-v2" });
		expect(status).toBe(200);
		expect(body).toMatchObject({ ok: true, repo: { id: "repo-a" } });
		expect(workdirOf("repo-a")).toBe("~/dev/alpha-v2");
	});

	it("a folder another INSTANCE uses is not a conflict — one binding per checkout is per instance", async () => {
		const { status } = await move("repo-a", { workdir: "~/dev/shared" });
		expect(status).toBe(200);
		expect(workdirOf("repo-a")).toBe("~/dev/shared");
	});
});
