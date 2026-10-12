/** Durable browser takeovers (#1031) over the real schema: the state machine, idempotency and expiry. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canTransitionTakeover, closeLiveTakeoverFor, expireStaleTakeovers, listTakeovers, requestTakeover, TAKEOVER_TTL_MS, transitionTakeover } from "./browser-takeovers.js";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";

let d1: RealSchemaD1;
const env = () => ({ DB: d1.DB });
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag', 'u1', 't1031', 'Scout')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'ag', 'u1', 'active', '{}')`);
});
afterEach(() => d1.close());

const ask = (subjectId = "run-1", now = 1_000) => requestTakeover(env(), { userId: "u1", instanceId: "i1", subjectKind: "local_browser_run", subjectId, reason: "captcha", mobileAllowed: true, now });

describe("the takeover state machine (#1031)", () => {
	it("allows exactly requested → active → resumed, and ended/expired from either live state", () => {
		expect(canTransitionTakeover("requested", "active")).toBe(true);
		expect(canTransitionTakeover("active", "resumed")).toBe(true);
		expect(canTransitionTakeover("requested", "resumed")).toBe(true); // fixed at the machine itself
		for (const from of ["requested", "active"] as const) {
			expect(canTransitionTakeover(from, "ended")).toBe(true);
			expect(canTransitionTakeover(from, "expired")).toBe(true);
		}
		for (const from of ["resumed", "ended", "expired"] as const) {
			for (const to of ["requested", "active", "resumed", "ended", "expired"] as const) expect(canTransitionTakeover(from, to)).toBe(false);
		}
		expect(canTransitionTakeover("active", "requested")).toBe(false);
	});

	it("a request is durable and idempotent per subject: asking again joins the live one", async () => {
		const first = await ask();
		expect(first).toMatchObject({ created: true, takeover: { state: "requested", reason: "captcha", subjectKind: "local_browser_run", subjectId: "run-1", agentId: "ag", mobileAllowed: true } });
		expect(first?.takeover.expiresAt).toBe(new Date(1_000 + TAKEOVER_TTL_MS).toISOString());
		const again = await ask();
		expect(again).toMatchObject({ created: false, takeover: { id: first?.takeover.id } });
		expect(await listTakeovers(env(), "u1", "i1")).toHaveLength(1);
	});

	it("transitions are recorded, repeating one is a no-op, and an impossible one is refused", async () => {
		const id = (await ask())!.takeover.id;
		expect(await transitionTakeover(env(), "u1", "i1", id, "active", { now: 2_000 })).toMatchObject({ ok: true, changed: true, takeover: { state: "active", activatedAt: new Date(2_000).toISOString() } });
		expect(await transitionTakeover(env(), "u1", "i1", id, "active")).toMatchObject({ ok: true, changed: false });
		expect(await transitionTakeover(env(), "u1", "i1", id, "resumed", { now: 3_000 })).toMatchObject({ ok: true, takeover: { state: "resumed", endedAt: new Date(3_000).toISOString() } });
		expect(await transitionTakeover(env(), "u1", "i1", id, "active")).toMatchObject({ ok: false, error: "A takeover that is resumed cannot become active." });
		// Once it is closed, the subject can be asked about again — a NEW request.
		expect(await ask("run-1", 4_000)).toMatchObject({ created: true });
	});

	it("is single-writer: of two racing moves out of `requested`, one wins and the other is refused", async () => {
		const id = (await ask())!.takeover.id;
		const [a, b] = await Promise.all([transitionTakeover(env(), "u1", "i1", id, "ended", { endReason: "declined" }), transitionTakeover(env(), "u1", "i1", id, "resumed")]);
		expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
	});

	it("is owner-scoped: another user can neither read nor move it", async () => {
		const id = (await ask())!.takeover.id;
		expect(await listTakeovers(env(), "u2", "i1")).toEqual([]);
		expect(await transitionTakeover(env(), "u2", "i1", id, "active")).toMatchObject({ ok: false, takeover: null });
	});

	it("the cron expires live takeovers past their time, and only those", async () => {
		const live = (await ask("run-1", 1_000))!.takeover.id;
		const done = (await ask("run-2", 1_000))!.takeover.id;
		await transitionTakeover(env(), "u1", "i1", done, "ended", { endReason: "run_finished" });
		expect(await expireStaleTakeovers(env(), 1_000 + TAKEOVER_TTL_MS - 1)).toBe(0);
		expect(await expireStaleTakeovers(env(), 1_000 + TAKEOVER_TTL_MS)).toBe(1);
		const rows = await listTakeovers(env(), "u1", "i1");
		expect(rows.find((r) => r.id === live)).toMatchObject({ state: "expired", endReason: "expired" });
		expect(rows.find((r) => r.id === done)).toMatchObject({ state: "ended", endReason: "run_finished" });
	});

	it("closeLiveTakeoverFor closes the live one for a subject and leaves a closed one alone", async () => {
		await ask();
		expect(await closeLiveTakeoverFor(env(), "u1", "i1", "local_browser_run", "run-1", "ended", 2_000, "run_finished")).toMatchObject({ state: "ended", endReason: "run_finished" });
		expect(await closeLiveTakeoverFor(env(), "u1", "i1", "local_browser_run", "run-1", "resumed")).toBeNull();
		// Resumed while never opened: the owner cleared it at the machine.
		await ask("run-2");
		expect(await closeLiveTakeoverFor(env(), "u1", "i1", "local_browser_run", "run-2", "resumed")).toMatchObject({ state: "resumed", endReason: "resumed_at_machine" });
	});

	it("stores nothing but ids, a closed vocabulary and times — no URL, token, cookie or page", () => {
		const cols = d1.DB.prepare("SELECT name FROM pragma_table_info('browser_takeovers')");
		return cols.all<{ name: string }>().then(({ results }) => {
			for (const { name } of results ?? []) expect(name).not.toMatch(/url|token|cookie|session|frame|page|content|secret/i);
		});
	});
});
