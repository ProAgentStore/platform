/**
 * #1283 — the Preferences notification controls against the REAL preferences route and a real stored blob. The route replaces the
 * `notifications` section whole (that contract is deliberate and unchanged); what is proved here is that the page's controls, driven
 * through one shared store, never lose each other's values to that replacement, and that what the page shows is what is stored.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { NotificationsController, type NotificationsEdit, type NotificationsTransport, stateFromResponse } from "../../../../store/console/src/lib/notificationsStore";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";
import { preferenceRoutes } from "./preferences.js";

const SECRET = "test-secret";
const RULE_DEPLOY = { type: "deploy", push: false };
const RULE_APPLY = { type: "apply", push: false };
const ROSTER = ["inst-a", "inst-b", "inst-c"];

function server(stored: Record<string, unknown> = {}) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/preferences", preferenceRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	let blob = JSON.stringify(stored);
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB: {
			prepare: (sql: string) => ({
				bind: (...args: unknown[]) => ({
					first: async () => (sql.startsWith("SELECT") ? { preferences: blob } : null),
					run: async () => {
						blob = String(args[0]);
						return { success: true };
					},
				}),
			}),
		},
	} as unknown as Env;
	const request = async (init?: RequestInit) => app.request("/v1/preferences", { ...init, headers: { Authorization: `Bearer ${await signSession("user-1", SECRET)}` } }, env);
	const transport: NotificationsTransport = {
		read: async () => stateFromResponse((await (await request()).json()) as never),
		write: async (section) => {
			const res = await request({ method: "PUT", body: JSON.stringify({ notifications: section }) });
			if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`);
		},
	};
	return { transport, stored: () => (JSON.parse(blob) as { notifications?: Record<string, unknown> }).notifications, raw: () => JSON.parse(blob) as Record<string, unknown>, request };
}

const open = async (s: ReturnType<typeof server>) => {
	const c = new NotificationsController(s.transport);
	await c.load();
	return c;
};

describe("the section contract is unchanged: a write replaces `notifications` whole", () => {
	it("a write that names only the mutes deletes the rules (why the page must always send all three)", async () => {
		const s = server({ notifications: { muted: [], rules: [RULE_DEPLOY] } });
		await s.request({ method: "PUT", body: JSON.stringify({ notifications: { muted: ["deploy"] } }) });
		expect(s.stored()).toEqual({ muted: ["deploy"] });
	});

	it("a write that carries all three keeps all three", async () => {
		const s = server({ notifications: { muted: [], rules: [RULE_DEPLOY] } });
		await s.request({ method: "PUT", body: JSON.stringify({ notifications: { muted: ["deploy"], instances: ["inst-a"], rules: [RULE_DEPLOY] } }) });
		expect(s.stored()).toEqual({ muted: ["deploy"], instances: ["inst-a"], rules: [RULE_DEPLOY] });
	});

	it("other sections are not touched by a notifications write", async () => {
		const s = server({ timezone: "Australia/Sydney", attention: { pushOff: ["approval_required"] }, notifications: { muted: [] } });
		await s.request({ method: "PUT", body: JSON.stringify({ notifications: { muted: ["deploy"] } }) });
		expect(s.raw()).toMatchObject({ timezone: "Australia/Sydney", attention: { pushOff: ["approval_required"] } });
	});
});

describe("the issue's two reproductions, through the page's store and the real route", () => {
	it("A: configure a rule, then flip a type switch and a Which agents box — the stored rule survives, and so does what the page shows", async () => {
		const s = server({ notifications: { muted: [], rules: [RULE_DEPLOY] } });
		const c = await open(s);
		await c.edit({ kind: "toggleType", id: "deploy", notify: false });
		expect(s.stored()).toEqual({ muted: ["deploy"], rules: [RULE_DEPLOY] });
		await c.edit({ kind: "toggleInstance", id: "inst-b", notify: false, roster: ROSTER });
		expect(s.stored()).toEqual({ muted: ["deploy"], instances: ["inst-a", "inst-c"], rules: [RULE_DEPLOY] });
		expect(c.getSnapshot().state.rules).toEqual([RULE_DEPLOY]);
		const reloaded = await open(s);
		expect(reloaded.getSnapshot().state).toEqual(c.getSnapshot().state);
	});

	it("B: mute a type and narrow the agents, then change a rule without reloading — the mute and the scope are NOT restored", async () => {
		const s = server();
		const c = await open(s); // loaded with nothing muted and every agent on
		await c.edit({ kind: "toggleType", id: "deploy", notify: false });
		await c.edit({ kind: "toggleInstance", id: "inst-a", notify: false, roster: ROSTER });
		await c.edit({ kind: "rules", rules: [RULE_APPLY] });
		expect(s.stored()).toEqual({ muted: ["deploy"], instances: ["inst-b", "inst-c"], rules: [RULE_APPLY] });
		expect(c.getSnapshot().state).toMatchObject({ muted: ["deploy"], instances: ["inst-b", "inst-c"], rules: [RULE_APPLY] });
	});

	it("every order of the three kinds of edit ends in the same stored section", async () => {
		const edits: NotificationsEdit[] = [
			{ kind: "toggleType", id: "deploy", notify: false },
			{ kind: "toggleInstance", id: "inst-c", notify: false, roster: ROSTER },
			{ kind: "rules", rules: [RULE_DEPLOY] },
		];
		const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
		for (const order of orders) {
			const s = server();
			const c = await open(s);
			for (const i of order) await c.edit(edits[i] as NotificationsEdit);
			expect(s.stored(), order.join("")).toEqual({ muted: ["deploy"], instances: ["inst-a", "inst-b"], rules: [RULE_DEPLOY] });
			expect((await open(s)).getSnapshot().state, order.join("")).toEqual(c.getSnapshot().state);
		}
	});

	it("the resolved matrix the rules editor shows is the server's, re-read after the write", async () => {
		const s = server();
		const c = await open(s);
		await c.edit({ kind: "rules", rules: [{ type: "deploy", push: false }] });
		const row = c.getSnapshot().state.effective.find((r) => r.type === "deploy");
		expect(row?.push.allowed).toBe(false);
	});
});

describe("a write the server refuses", () => {
	it("is rolled back on the page, reported, and leaves what is stored untouched", async () => {
		const s = server({ notifications: { muted: [], rules: [RULE_DEPLOY] } });
		const c = await open(s);
		expect(await c.edit({ kind: "toggleType", id: "not-a-real-type", notify: false })).toBe(false);
		expect(c.getSnapshot().error).toMatch(/unknown notification type/);
		expect(c.getSnapshot().state.muted).toEqual([]);
		expect(s.stored()).toEqual({ muted: [], rules: [RULE_DEPLOY] });
		// and the page is not wedged
		expect(await c.edit({ kind: "toggleType", id: "deploy", notify: false })).toBe(true);
		expect(s.stored()).toEqual({ muted: ["deploy"], rules: [RULE_DEPLOY] });
	});

	it("a rule the server rejects does not erase the mutes or the scope, and the rows go back", async () => {
		const s = server({ notifications: { muted: ["deploy"], instances: ["inst-a"] } });
		const c = await open(s);
		expect(await c.edit({ kind: "rules", rules: [{ type: "no-such-type", push: false }] })).toBe(false);
		expect(c.getSnapshot().state.rules).toEqual([]);
		expect(s.stored()).toEqual({ muted: ["deploy"], instances: ["inst-a"] });
	});
});
