/**
 * #1162 — the owner is told when a runner machine goes silent, once per silence, mid-update included.
 *
 * Over the real schema; only `notifyUser` (the push/bell funnel) is faked, so what is asserted is what
 * the owner would receive. The incident: dell-laptop offline since 01:40Z "with only a grey dot to show
 * for it", and two machines dark mid-update on 2026-10-17 with nothing but an error_log row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { notifyUser } = vi.hoisted(() => ({ notifyUser: vi.fn() }));
vi.mock("../routes/push.js", () => ({ notifyUser }));

import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { MACHINE_SILENCE_LOOKBACK_MS, MACHINE_SILENT_MS, notifySilentMachines } from "./machine-silence.js";
import { isKnownNotificationType } from "./notifications.js";
import type { Env } from "../types.js";

const NOW = Date.UTC(2026, 9, 18, 9, 0);
const MIN = 60_000;
let d1: RealSchemaD1;
let env: Env;

const sqlTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

function node(instance: string, name: string, seenAgo: number, opts: { machineId?: string | null; user?: string; version?: string } = {}) {
	d1.sqlite
		.prepare(
			`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at)
			 VALUES (?, ?, ?, 'relay://', ?, ?, 'registered', ?)
			 ON CONFLICT(instance_id, runner_node) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
		)
		.run(instance, opts.user ?? "u1", name, opts.version ?? "0.4.149", opts.machineId === undefined ? `machine-${name}` : opts.machineId, sqlTime(NOW - seenAgo));
}

/** What the owner received: [type, title, body, link, key]. */
const received = () => notifyUser.mock.calls.map((c) => ({ user: c[1], type: c[2], title: c[3] as string, body: c[4] as string, url: c[5] as string, key: (c[6] as { key?: string })?.key }));

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1", "i2"] });
	env = { DB: d1.DB } as unknown as Env;
	notifyUser.mockReset().mockResolvedValue("delivered");
});
afterEach(() => d1.close());

describe("a machine that stops reporting is told to its owner (#1162)", () => {
	it("silent past the threshold: one notification with the machine's last report, the fix, and a link to its page", async () => {
		node("i1", "dell-laptop", 20 * MIN, { version: "0.4.152" });
		node("i2", "dell-laptop", 25 * MIN, { version: "0.4.152" });
		expect(await notifySilentMachines(env, NOW)).toBe(1);
		const [n] = received();
		expect(n).toMatchObject({ user: "u1", type: "machine", url: "/console/terminals/machines/machine-dell-laptop" });
		expect(n.title).toContain("dell-laptop stopped reporting");
		expect(n.body).toContain("Last heard from 20 minutes ago (2026-10-18 08:40:00 UTC), running pags 0.4.152, serving 2 agents.");
		expect(n.body).toContain("pags up --install-service");
	});

	it("ONCE per silence: the next ticks send nothing more", async () => {
		node("i1", "dell-laptop", 20 * MIN);
		await notifySilentMachines(env, NOW);
		await notifySilentMachines(env, NOW + MIN);
		await notifySilentMachines(env, NOW + 60 * MIN);
		expect(notifyUser).toHaveBeenCalledTimes(1);
	});

	it("a machine that comes back and goes quiet again is a NEW silence, and is told again", async () => {
		node("i1", "dell-laptop", 20 * MIN);
		await notifySilentMachines(env, NOW);
		node("i1", "dell-laptop", 0); // it reported
		expect(await notifySilentMachines(env, NOW)).toBe(0);
		expect(await notifySilentMachines(env, NOW + MACHINE_SILENT_MS + MIN)).toBe(1);
		expect(notifyUser).toHaveBeenCalledTimes(2);
	});

	it("a blip is not news: silent under the threshold sends nothing", async () => {
		node("i1", "dell-laptop", MACHINE_SILENT_MS - MIN);
		expect(await notifySilentMachines(env, NOW)).toBe(0);
	});

	it("a machine retired long ago is not news either — the first deploy pages nobody about old laptops", async () => {
		node("i1", "old-imac", MACHINE_SILENCE_LOOKBACK_MS + MIN);
		expect(await notifySilentMachines(env, NOW)).toBe(0);
	});

	it("one stale agent on a machine that is still up is not the machine going down", async () => {
		node("i1", "Sergeys-Mac-mini.local", 3 * 60 * MIN);
		node("i2", "Sergeys-Mac-mini.local", 30_000);
		expect(await notifySilentMachines(env, NOW)).toBe(0);
	});

	it("a runner that sends no machine id is still covered, by hostname, linked to the Terminals list", async () => {
		node("i1", "pink-laptop", 40 * MIN, { machineId: null });
		expect(await notifySilentMachines(env, NOW)).toBe(1);
		expect(received()[0]).toMatchObject({ url: "/console/terminals", key: `machine-silent:pink-laptop:${sqlTime(NOW - 40 * MIN)}` });
	});

	it("each owner hears only about their own machines", async () => {
		seedTenant(d1, { userId: "u2", instanceIds: ["j1"] });
		node("j1", "their-box", 20 * MIN, { user: "u2" });
		await notifySilentMachines(env, NOW);
		expect(received().map((n) => n.user)).toEqual(["u2"]);
	});
});

describe("mid-update silence is told too, and says so (#1162 covering #1141's sweep)", () => {
	it("a machine silent while installing an update names the update and the restart remedy", async () => {
		node("i1", "Sergeys-Mac-mini.local", 20 * MIN, { machineId: "mac-mini-0001" });
		d1.sqlite
			.prepare(`INSERT INTO machine_policies (user_id, machine_id, auto_update, status, latest_version, last_heartbeat_at, updated_at) VALUES ('u1', ?, 1, 'installing', '0.4.149', ?, ?)`)
			.run("mac-mini-0001", NOW - 20 * MIN, NOW - 20 * MIN);
		expect(await notifySilentMachines(env, NOW)).toBe(1);
		const [n] = received();
		expect(n.title).toContain("went silent during an update");
		expect(n.body).toContain("installing an automatic update to 0.4.149");
		expect(n.body).toContain("Restart `pags up` on that machine");
	});

	it("once the silence sweep has failed the update, the owner is still told it was mid-update", async () => {
		node("i1", "pink-laptop", 30 * MIN);
		d1.sqlite
			.prepare(`INSERT INTO machine_policies (user_id, machine_id, auto_update, status, latest_version, last_error, last_heartbeat_at, updated_at) VALUES ('u1', ?, 1, 'failed', '0.4.149', ?, ?, ?)`)
			.run("machine-pink-laptop", "No heartbeat within 5 minutes of installing an update (0.4.149): the machine reported \"installing\" and then stopped reporting.", NOW - 30 * MIN, NOW - 20 * MIN);
		await notifySilentMachines(env, NOW);
		expect(received()[0].title).toContain("went silent during an update");
	});
});

describe("the owner can control it", () => {
	it("`machine` is a known notification type, so it can be muted", () => {
		expect(isKnownNotificationType("machine")).toBe(true);
	});

	it("is sent as an update, not an alert — an alert could not be muted", async () => {
		node("i1", "dell-laptop", 20 * MIN);
		await notifySilentMachines(env, NOW);
		expect((notifyUser.mock.calls[0][6] as { kind?: string }).kind).toBeUndefined();
	});
});
