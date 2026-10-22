/**
 * #1283 — the notification controls share ONE state and ONE writer. A fake server stands in for the preferences route and keeps its
 * real contract: a write REPLACES the whole `notifications` section, so a write that leaves a field out deletes it. That is what made
 * the old per-control writes destructive, and it is why every write here is checked against what the server actually holds, not just
 * against what the page shows.
 */
import { describe, expect, it } from "vitest";
import {
	applyEdit,
	EMPTY_NOTIFICATIONS,
	NotificationsController,
	type NotificationsEdit,
	type NotificationsSection,
	type NotificationsState,
	type NotificationsTransport,
	sectionFrom,
	stateFromResponse,
	toggledScope,
} from "./notificationsStore";
import type { NotificationPolicyRule } from "./types";

const RULE_DEPLOY: NotificationPolicyRule = { type: "deploy", push: false };
const RULE_APPLY: NotificationPolicyRule = { type: "apply", push: false };
const ROSTER = ["inst-a", "inst-b", "inst-c"];

/** The preferences route in miniature: whole-section replacement, strict about shape, with a resolved matrix derived from what is stored. */
function fakeServer(initial: { muted?: string[]; instances?: string[]; rules?: NotificationPolicyRule[] } = {}) {
	let stored: NotificationsSection = { muted: initial.muted ?? [], ...(initial.instances?.length ? { instances: initial.instances } : {}), ...(initial.rules?.length ? { rules: initial.rules } : {}) };
	const log: string[] = [];
	const hooks = {
		failWrites: 0,
		failReads: 0,
		/** Hold the next read until released, so a response can arrive late. */
		holdRead: null as null | { release: () => void; promise: Promise<void> },
		holdWrite: null as null | { release: () => void; promise: Promise<void> },
	};
	const deferred = () => {
		let release: () => void = () => undefined;
		const promise = new Promise<void>((r) => {
			release = () => r();
		});
		return { release, promise };
	};
	const transport: NotificationsTransport = {
		async read() {
			const snapshot = structuredClone(stored);
			const hold = hooks.holdRead;
			hooks.holdRead = null;
			log.push("read");
			if (hold) await hold.promise;
			if (hooks.failReads > 0) {
				hooks.failReads--;
				throw new Error("read failed");
			}
			return stateFromResponse({ preferences: { notifications: snapshot }, notificationEffective: snapshot.rules?.length ? [{ type: "rules", severity: "update", inapp: { allowed: true, source: "account" }, push: { allowed: false, source: "account" } } as never] : [] });
		},
		async write(section) {
			const hold = hooks.holdWrite;
			hooks.holdWrite = null;
			log.push(`write ${JSON.stringify(section)}`);
			if (hold) await hold.promise;
			if (hooks.failWrites > 0) {
				hooks.failWrites--;
				throw new Error("The server refused that.");
			}
			stored = structuredClone(section);
		},
	};
	return { transport, stored: () => structuredClone(stored), log, hooks, hold: deferred };
}

const loaded = async (server: ReturnType<typeof fakeServer>) => {
	const c = new NotificationsController(server.transport);
	await c.load();
	return c;
};

/** The page and the server say the same thing. */
const expectInSync = (c: NotificationsController, server: ReturnType<typeof fakeServer>) => {
	const s = c.getSnapshot().state;
	expect(sectionFrom(s)).toEqual(server.stored());
};

describe("the pure parts", () => {
	it("a write carries every field, and leaves out an empty scope or rule list — absence IS 'all agents' and 'no rules'", () => {
		expect(sectionFrom({ ...EMPTY_NOTIFICATIONS })).toEqual({ muted: [] });
		expect(sectionFrom({ muted: ["deploy"], instances: ["inst-a"], rules: [RULE_DEPLOY], effective: [] })).toEqual({ muted: ["deploy"], instances: ["inst-a"], rules: [RULE_DEPLOY] });
	});

	it("an edit changes one field and carries the rest", () => {
		const s: NotificationsState = { muted: ["a"], instances: ["inst-a"], rules: [RULE_DEPLOY], effective: [] };
		expect(applyEdit(s, { kind: "muted", muted: ["a", "b", "b"] })).toMatchObject({ muted: ["a", "b"], instances: ["inst-a"], rules: [RULE_DEPLOY] });
		expect(applyEdit(s, { kind: "rules", rules: [] })).toMatchObject({ muted: ["a"], instances: ["inst-a"], rules: [] });
		expect(applyEdit(s, { kind: "toggleType", id: "a", notify: true }).muted).toEqual([]);
		expect(applyEdit(s, { kind: "toggleType", id: "c", notify: false }).muted).toEqual(["a", "c"]);
	});

	it("toggling an agent: narrows, widens, clears the scope when all are on, and refuses to leave none on", () => {
		expect(toggledScope([], "inst-b", false, ROSTER)).toEqual(["inst-a", "inst-c"]);
		expect(toggledScope(["inst-a", "inst-c"], "inst-b", true, ROSTER)).toEqual([]);
		expect(toggledScope(["inst-a"], "inst-a", false, ROSTER)).toBeNull();
		expect(toggledScope(["gone", "inst-a"], "inst-b", true, ROSTER)).toEqual(["inst-a", "inst-b"]);
		const s: NotificationsState = { muted: [], instances: ["inst-a"], rules: [], effective: [] };
		expect(applyEdit(s, { kind: "toggleInstance", id: "inst-a", notify: false, roster: ROSTER })).toBe(s);
	});
});

describe("switch → rule (the issue's Reproduce A)", () => {
	it("a type switch after a saved rule keeps the rule, in the stored section and on the page", async () => {
		const server = fakeServer({ rules: [RULE_DEPLOY] });
		const c = await loaded(server);
		expect(await c.edit({ kind: "toggleType", id: "deploy", notify: false })).toBe(true);
		expect(server.stored()).toEqual({ muted: ["deploy"], rules: [RULE_DEPLOY] });
		expect(c.getSnapshot().state.rules).toEqual([RULE_DEPLOY]);
		expectInSync(c, server);
	});

	it("then a rule change keeps the mute", async () => {
		const server = fakeServer();
		const c = await loaded(server);
		await c.edit({ kind: "toggleType", id: "deploy", notify: false });
		await c.edit({ kind: "rules", rules: [RULE_APPLY] });
		expect(server.stored()).toEqual({ muted: ["deploy"], rules: [RULE_APPLY] });
		expectInSync(c, server);
	});
});

describe("rule → switch (the issue's Reproduce B)", () => {
	it("a rule change after the page muted a type and narrowed the agents does NOT restore the loaded values", async () => {
		const server = fakeServer();
		const c = await loaded(server); // loaded with no mutes and every agent on
		await c.edit({ kind: "toggleType", id: "deploy", notify: false });
		await c.edit({ kind: "toggleInstance", id: "inst-b", notify: false, roster: ROSTER });
		await c.edit({ kind: "rules", rules: [RULE_APPLY] }); // the old editor sent its load-time snapshot here
		expect(server.stored()).toEqual({ muted: ["deploy"], instances: ["inst-a", "inst-c"], rules: [RULE_APPLY] });
		expectInSync(c, server);
	});

	it("and a switch after that keeps the rule and the scope", async () => {
		const server = fakeServer({ muted: ["deploy"], instances: ["inst-a", "inst-c"], rules: [RULE_APPLY] });
		const c = await loaded(server);
		await c.edit({ kind: "toggleType", id: "deploy", notify: true });
		expect(server.stored()).toEqual({ muted: [], instances: ["inst-a", "inst-c"], rules: [RULE_APPLY] });
		expectInSync(c, server);
	});
});

describe("Which agents", () => {
	it("narrowing, then widening back to all, keeps mutes and rules and clears the scope key", async () => {
		const server = fakeServer({ muted: ["deploy"], rules: [RULE_DEPLOY] });
		const c = await loaded(server);
		await c.edit({ kind: "toggleInstance", id: "inst-c", notify: false, roster: ROSTER });
		expect(server.stored()).toEqual({ muted: ["deploy"], instances: ["inst-a", "inst-b"], rules: [RULE_DEPLOY] });
		await c.edit({ kind: "toggleInstance", id: "inst-c", notify: true, roster: ROSTER });
		expect(server.stored()).toEqual({ muted: ["deploy"], rules: [RULE_DEPLOY] });
		expectInSync(c, server);
	});
});

describe("reload", () => {
	it("a fresh page reads back exactly what the previous page showed, for every edit order", async () => {
		const orders: NotificationsEdit[][] = [
			[{ kind: "toggleType", id: "deploy", notify: false }, { kind: "rules", rules: [RULE_DEPLOY] }, { kind: "toggleInstance", id: "inst-a", notify: false, roster: ROSTER }],
			[{ kind: "rules", rules: [RULE_DEPLOY] }, { kind: "toggleInstance", id: "inst-a", notify: false, roster: ROSTER }, { kind: "toggleType", id: "deploy", notify: false }],
			[{ kind: "toggleInstance", id: "inst-a", notify: false, roster: ROSTER }, { kind: "toggleType", id: "deploy", notify: false }, { kind: "rules", rules: [RULE_DEPLOY] }],
		];
		for (const order of orders) {
			const server = fakeServer();
			const first = await loaded(server);
			for (const e of order) await first.edit(e);
			const shown = first.getSnapshot().state;
			const second = await loaded(server); // "reload"
			expect(second.getSnapshot().state).toEqual(shown);
			expect(server.stored()).toEqual({ muted: ["deploy"], instances: ["inst-b", "inst-c"], rules: [RULE_DEPLOY] });
		}
	});

	it("the resolved matrix is read back from the server after a write, not guessed", async () => {
		const server = fakeServer();
		const c = await loaded(server);
		expect(c.getSnapshot().state.effective).toEqual([]);
		await c.edit({ kind: "rules", rules: [RULE_DEPLOY] });
		expect(c.getSnapshot().state.effective).toHaveLength(1);
	});
});

describe("edits made before the page re-renders", () => {
	it("two quick changes both land in ONE write built from the latest state, and the queued second finds nothing left to send", async () => {
		const server = fakeServer();
		const c = await loaded(server);
		const writing = server.hold();
		server.hooks.holdWrite = writing;
		const a = c.edit({ kind: "toggleType", id: "deploy", notify: false });
		const b = c.edit({ kind: "toggleType", id: "apply", notify: false }); // made while the first write is still in flight
		expect(c.getSnapshot().saving).toBe(true);
		expect(c.getSnapshot().state.muted).toEqual(["deploy", "apply"]);
		writing.release();
		expect(await Promise.all([a, b])).toEqual([true, true]);
		expect(server.stored()).toEqual({ muted: ["deploy", "apply"] });
		const writes = server.log.filter((l) => l.startsWith("write"));
		expect(writes).toEqual(['write {"muted":["deploy","apply"]}']);
		expect(c.getSnapshot().saving).toBe(false);
		expectInSync(c, server);
	});
});

describe("writes are ordered", () => {
	it("a change made while an earlier write is in flight is written AFTER it, with the earlier change included", async () => {
		const server = fakeServer();
		const c = await loaded(server);
		const writing = server.hold();
		server.hooks.holdWrite = writing;
		const a = c.edit({ kind: "toggleType", id: "deploy", notify: false });
		await new Promise((r) => setTimeout(r, 0)); // the first write is now in flight, built from the state at that moment
		const b = c.edit({ kind: "rules", rules: [RULE_DEPLOY] });
		writing.release();
		await Promise.all([a, b]);
		expect(server.log.filter((l) => l.startsWith("write"))).toEqual(['write {"muted":["deploy"]}', `write {"muted":["deploy"],"rules":[${JSON.stringify(RULE_DEPLOY)}]}`]);
		expectInSync(c, server);
	});

	it("changes that cancel out send nothing", async () => {
		const server = fakeServer();
		const c = await loaded(server);
		const writing = server.hold();
		server.hooks.holdWrite = writing;
		const a = c.edit({ kind: "toggleType", id: "deploy", notify: false });
		const b = c.edit({ kind: "toggleType", id: "deploy", notify: true });
		writing.release();
		await Promise.all([a, b]);
		expect(server.stored()).toEqual({ muted: [] });
		expect(server.log.filter((l) => l.startsWith("write")).length).toBeLessThanOrEqual(1);
	});
});

describe("stale responses", () => {
	it("a read that was asked for before an edit and answers after it is ignored", async () => {
		const server = fakeServer({ muted: ["old"] });
		const c = new NotificationsController(server.transport);
		await c.load();
		const late = server.hold();
		server.hooks.holdRead = late;
		const reload = c.load(); // asks for the stored state ...
		await c.edit({ kind: "toggleType", id: "deploy", notify: false }); // ... the owner changes something ...
		late.release();
		await reload; // ... and the old answer arrives afterwards
		expect(c.getSnapshot().state.muted).toEqual(["old", "deploy"]);
		expectInSync(c, server);
	});

	it("the first read landing after the owner already edited does not put the loaded values back", async () => {
		const server = fakeServer({ muted: ["a"] });
		const c = new NotificationsController(server.transport);
		await c.load();
		const late = server.hold();
		server.hooks.holdRead = late;
		const refresh = c.load();
		const edit = c.edit({ kind: "rules", rules: [RULE_DEPLOY] });
		late.release();
		await Promise.all([refresh, edit]);
		expect(c.getSnapshot().state.rules).toEqual([RULE_DEPLOY]);
		expect(server.stored().rules).toEqual([RULE_DEPLOY]);
	});

	it("the read-back after a write is dropped if a newer edit was made while it was in flight", async () => {
		const server = fakeServer();
		const c = await loaded(server);
		const late = server.hold();
		await c.edit({ kind: "toggleType", id: "deploy", notify: false }); // write 1 + its read-back
		server.hooks.holdRead = late; // the NEXT read-back is slow
		const first = c.edit({ kind: "toggleType", id: "apply", notify: false });
		// wait until the slow read-back is the thing in flight
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));
		const second = c.edit({ kind: "toggleType", id: "coding", notify: false });
		late.release();
		await Promise.all([first, second]);
		expect(c.getSnapshot().state.muted).toEqual(["deploy", "apply", "coding"]);
		expectInSync(c, server);
	});
});

describe("a rejected write", () => {
	it("returns the page to what the server holds, says why, and never leaves the unsaved value looking applied", async () => {
		const server = fakeServer({ muted: [], rules: [RULE_DEPLOY] });
		const c = await loaded(server);
		server.hooks.failWrites = 1;
		expect(await c.edit({ kind: "toggleType", id: "deploy", notify: false })).toBe(false);
		const snap = c.getSnapshot();
		expect(snap.error).toBe("The server refused that.");
		expect(snap.state.muted).toEqual([]);
		expect(snap.state.rules).toEqual([RULE_DEPLOY]);
		expect(snap.saving).toBe(false);
		expect(server.stored()).toEqual({ muted: [], rules: [RULE_DEPLOY] });
		expectInSync(c, server);
	});

	it("a refused rule edit leaves the mutes and scope exactly as they were", async () => {
		const server = fakeServer({ muted: ["deploy"], instances: ["inst-a"] });
		const c = await loaded(server);
		server.hooks.failWrites = 1;
		await c.edit({ kind: "rules", rules: [RULE_APPLY] });
		expect(c.getSnapshot().state).toMatchObject({ muted: ["deploy"], instances: ["inst-a"], rules: [] });
		expectInSync(c, server);
	});

	it("edits queued behind a refused write are dropped, because they were built on a state that never existed", async () => {
		const server = fakeServer();
		const c = await loaded(server);
		const writing = server.hold();
		server.hooks.holdWrite = writing;
		server.hooks.failWrites = 1;
		const a = c.edit({ kind: "toggleType", id: "deploy", notify: false });
		const b = c.edit({ kind: "toggleType", id: "apply", notify: false });
		writing.release();
		expect(await Promise.all([a, b])).toEqual([false, false]);
		expect(c.getSnapshot().state.muted).toEqual([]);
		expect(server.stored()).toEqual({ muted: [] });
		expect(server.log.filter((l) => l.startsWith("write"))).toHaveLength(1);
		expect(c.getSnapshot().saving).toBe(false);
	});

	it("the next edit after a refusal works and clears the error", async () => {
		const server = fakeServer();
		const c = await loaded(server);
		server.hooks.failWrites = 1;
		await c.edit({ kind: "toggleType", id: "deploy", notify: false });
		expect(c.getSnapshot().error).not.toBe("");
		expect(await c.edit({ kind: "toggleType", id: "deploy", notify: false })).toBe(true);
		expect(c.getSnapshot().error).toBe("");
		expect(server.stored()).toEqual({ muted: ["deploy"] });
	});

	it("still reports the refusal when the follow-up read also fails", async () => {
		const server = fakeServer({ muted: ["a"] });
		const c = await loaded(server);
		server.hooks.failWrites = 1;
		server.hooks.failReads = 1;
		expect(await c.edit({ kind: "toggleType", id: "b", notify: false })).toBe(false);
		expect(c.getSnapshot().state.muted).toEqual(["a"]);
	});
});

describe("before the stored settings are known", () => {
	it("refuses to write — a write from defaults would overwrite what is stored", async () => {
		const server = fakeServer({ rules: [RULE_DEPLOY] });
		const c = new NotificationsController(server.transport);
		expect(c.getSnapshot().loaded).toBe(false);
		expect(await c.edit({ kind: "toggleType", id: "deploy", notify: false })).toBe(false);
		expect(server.log.filter((l) => l.startsWith("write"))).toEqual([]);
		expect(c.getSnapshot().error).toMatch(/haven't loaded/);
		expect(server.stored()).toEqual({ muted: [], rules: [RULE_DEPLOY] });
	});

	it("a failed first read leaves it not loaded with the reason, and a retry recovers", async () => {
		const server = fakeServer({ muted: ["a"] });
		server.hooks.failReads = 1;
		const c = new NotificationsController(server.transport);
		await c.load();
		expect(c.getSnapshot()).toMatchObject({ loaded: false, error: "read failed" });
		await c.load();
		expect(c.getSnapshot()).toMatchObject({ loaded: true, error: "" });
		expect(c.getSnapshot().state.muted).toEqual(["a"]);
	});

	it("notifies subscribers on every change and stops when unsubscribed", async () => {
		const server = fakeServer();
		const c = new NotificationsController(server.transport);
		let n = 0;
		const off = c.subscribe(() => n++);
		await c.load();
		const afterLoad = n;
		expect(afterLoad).toBeGreaterThan(0);
		off();
		await c.edit({ kind: "toggleType", id: "x", notify: false });
		expect(n).toBe(afterLoad);
	});
});
