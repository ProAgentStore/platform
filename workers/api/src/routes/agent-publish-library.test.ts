/**
 * Publishing an agent makes it appear in the Library (#793).
 *
 * ── Why this needs its own D1 fake
 *
 * `agents.test.ts`'s catalogue harness answers the page query with canned rows whatever the WHERE
 * clause says. That is right for what it tests (pagination arithmetic) and useless here: the whole
 * question is whether the row the PUT wrote is the row the SELECT then finds, and a stub that
 * ignores `visibility` would pass with the two halves wired to nothing.
 *
 * So this holds ONE agent row and applies the real statements to it — the update's own SET list,
 * the listing's own predicate. Both handlers run for real; only the storage is fake.
 *
 * ── What #793 actually was
 *
 * Not a schema mismatch. The settings form and the Library read the SAME column, and the tests
 * below pin that: publish, then list, and the agent is there. What the reporter saw was the form
 * showing `published` after the server had REFUSED the write — the test-fixture guard (#65) sent a
 * 400 and the console left the user's selection on screen with nothing to contradict it. The
 * console half is `AgentDetail.tsx`; this file holds the API contract it depends on.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { agentRoutes } from "./agents.js";
import type { Env } from "../types.js";

const SECRET = "publish-library-secret";
const OWNER = "user-1";

interface AgentRow {
	id: string;
	owner_id: string;
	slug: string;
	name: string;
	description: string;
	category: string;
	store_type: string;
	icon: string;
	icon_bg: string;
	model: string;
	visibility: string;
	config: string | null;
	created_at: string;
	updated_at: string;
}

const agent = (over: Partial<AgentRow> = {}): AgentRow => ({
	id: "a1",
	owner_id: OWNER,
	slug: "weather-bot",
	name: "Weather Bot",
	description: "Tells you the forecast.",
	category: "general",
	store_type: "agent",
	icon: "",
	icon_bg: "#000",
	model: "claude-sonnet-5",
	visibility: "draft",
	config: null,
	created_at: "2026-09-01",
	updated_at: "2026-09-01",
	...over,
});

/**
 * A D1 fake over ONE row that honours the two statements this path actually issues.
 *
 * The UPDATE's columns are parsed out of the SQL the route composed (`name = ?2, visibility = ?3`)
 * and mapped onto the bound args, so the placeholder arithmetic is exercised rather than assumed —
 * an off-by-one there would write the description into `visibility` and this would catch it.
 */
function buildApp(row: AgentRow) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/agents", agentRoutes);
	app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: String(err) }, 500)));

	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								// The listing's COUNT, and the PUT's pre-read of the row it is about.
								if (sql.includes("COUNT(*) AS n")) return { n: row.visibility === "published" ? 1 : 0 };
								if (sql.includes("FROM agents WHERE id = ?1")) return { ...row };
								return null;
							},
							async all() {
								// The Library page query. `visibility = 'published'` is the whole
								// predicate, applied here exactly as the route writes it.
								if (sql.includes("FROM agents a LEFT JOIN users u")) {
									const visible = row.visibility === "published";
									return { results: visible ? [{ ...row, creator_login: null, creator_name: "Creator", creator_avatar: null, subscriber_count: 0 }] : [] };
								}
								return { results: [] };
							},
							async run() {
								if (sql.startsWith("UPDATE agents SET")) {
									// `params.unshift(id)` puts the id at ?1, so ?N maps to args[N-1].
									for (const m of sql.matchAll(/(\w+) = \?(\d+)/g)) {
										const value = args[Number(m[2]) - 1];
										(row as unknown as Record<string, unknown>)[m[1]] = value;
									}
								}
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;
	return { app, env, row };
}

const token = () => signSession(OWNER, SECRET, { roles: ["user", "creator"] });

const put = async (app: Hono<{ Bindings: Env }>, env: Env, body: unknown) =>
	app.request("/v1/agents/a1", {
		method: "PUT",
		headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}, env);

const library = async (app: Hono<{ Bindings: Env }>, env: Env) => {
	const res = await app.request("/v1/agents", {}, env);
	return (await res.json()) as { agents?: Array<{ id: string; name: string }>; total?: number };
};

describe("publish → the Library lists it (#793)", () => {
	it("a draft agent is absent, and the same agent published is present", async () => {
		// The ticket's exact claim, as one case. Both halves matter: an assertion that a published
		// agent appears proves nothing unless a draft one demonstrably does not.
		const { app, env } = buildApp(agent({ visibility: "draft" }));
		expect((await library(app, env)).agents ?? []).toHaveLength(0);

		const res = await put(app, env, { visibility: "published" });
		expect(res.status).toBe(200);

		const listed = await library(app, env);
		expect(listed.agents ?? []).toHaveLength(1);
		expect((listed.agents ?? [])[0].id).toBe("a1");
		expect(listed.total).toBe(1);
	});

	it("persists `published` to the column the Library reads, not somewhere else", async () => {
		// The issue's first hypothesis was that the two ends use different fields. They do not, and
		// this is what says so: the value lands on `visibility`, which is the listing's predicate.
		const { app, env, row } = buildApp(agent({ visibility: "draft" }));
		await put(app, env, { visibility: "published" });
		expect(row.visibility).toBe("published");
	});

	it("writes each field to its OWN column — the placeholder arithmetic, exercised", async () => {
		// `sets.push(`${column} = ?${params.length + 1}`)` looks off by one until you notice
		// `params.unshift(id)` below it. If that pairing ever breaks, a multi-field save writes the
		// description into `visibility` and the agent vanishes from the Library for a reason nobody
		// would look for here.
		const { app, env, row } = buildApp(agent({ visibility: "draft" }));
		await put(app, env, { name: "Renamed", description: "New copy.", visibility: "published" });
		expect(row.name).toBe("Renamed");
		expect(row.description).toBe("New copy.");
		expect(row.visibility).toBe("published");
	});

	it("unpublishing removes it again", async () => {
		const { app, env } = buildApp(agent({ visibility: "published" }));
		expect((await library(app, env)).agents ?? []).toHaveLength(1);
		await put(app, env, { visibility: "draft" });
		expect((await library(app, env)).agents ?? []).toHaveLength(0);
	});
});

describe("the test-fixture guard, and its override (#65)", () => {
	it("refuses to publish an agent whose copy reads as a fixture, and says which word", async () => {
		// The guard is the reason a publish can be refused at all, and the refusal has to name the
		// marker — one that will not say what it saw gets worked around by renaming at random.
		const { app, env, row } = buildApp(agent({ name: "Sandbox Helper", visibility: "draft" }));
		const res = await put(app, env, { visibility: "published" });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("sandbox");
		// And nothing was written — a refused publish must not half-apply.
		expect(row.visibility).toBe("draft");
	});

	it("names `allowTestAgent`, which is what the console keys its override on", async () => {
		// `AgentDetail.tsx`'s `isTestFixtureRefusal` matches on this flag name rather than on the
		// sentence, so that a copy edit cannot silently stop offering the override. That makes the
		// flag part of the contract, and this is where it is pinned.
		const { app, env } = buildApp(agent({ name: "Smoke Agent", visibility: "draft" }));
		const res = await put(app, env, { visibility: "published" });
		expect(((await res.json()) as { error: string }).error).toContain("allowTestAgent");
	});

	it("publishes anyway with allowTestAgent, and the Library then lists it", async () => {
		// The override end to end — the path the console now takes after the user confirms.
		const { app, env } = buildApp(agent({ name: "Sandbox Helper", visibility: "draft" }));
		const res = await put(app, env, { visibility: "published", allowTestAgent: true });
		expect(res.status).toBe(200);
		expect((await library(app, env)).agents ?? []).toHaveLength(1);
	});

	it("never blocks the way BACK to draft, whatever the copy says", async () => {
		// Stated in the guard's own docstring and worth pinning: unpublishing must always work,
		// including for an agent already published that would now fail the check. A guard that can
		// trap something in the storefront is worse than one that let it in.
		const { app, env, row } = buildApp(agent({ name: "Smoke Agent", visibility: "published" }));
		const res = await put(app, env, { visibility: "draft" });
		expect(res.status).toBe(200);
		expect(row.visibility).toBe("draft");
	});

	it("leaves an unrelated edit alone — the guard only gates `published`", async () => {
		// A creator renaming a draft fixture must not be refused; the gate is on becoming public.
		const { app, env, row } = buildApp(agent({ name: "Smoke Agent", visibility: "draft" }));
		const res = await put(app, env, { description: "Still a fixture." });
		expect(res.status).toBe(200);
		expect(row.description).toBe("Still a fixture.");
	});
});
