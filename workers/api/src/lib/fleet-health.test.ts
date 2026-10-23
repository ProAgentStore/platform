/** #1320 — fleet visibility on the real schema: one alert per episode, cleared on recovery, judged from facts the platform holds. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { CAPABILITY_GRACE_MS, CAPABILITY_STALE_MS, collectMachineFacts, CRASH_LOOP_STARTS_24H, currentRelease, DRIFT_GRACE_MS, judgeMachine, type MachineFacts, ONLINE_MS, RELEASE_CHECK_MS, runFleetHealth } from "./fleet-health.js";
import { olderVersion } from "./fleet-version.js";
import type { Env } from "../types.js";

const NOW = Date.parse("2026-10-24T00:00:00Z");
const H = 3_600_000;
const M = "3901c9c4-004f-435e-bfc5-0b87b7ac5173";
const base = (over: Partial<MachineFacts> = {}): MachineFacts => ({ userId: "u1", machineId: M, label: "tiny-laptop", instanceId: "i1", lastSeenAt: NOW - 60_000, firstRegisteredAt: NOW - 5 * H, runnerVersion: "0.4.177", starts24h: 1, capabilityAt: NOW - H, updateStatus: "enabled", updateError: null, ...over });
const RELEASE = { version: "0.4.177", firstSeenAt: NOW - 30 * H };
const kinds = (m: MachineFacts, release: typeof RELEASE | null = RELEASE) => judgeMachine(m, release, NOW).map((j) => j.kind);

describe("what is wrong with a machine (#1320)", () => {
	it("a healthy, current machine raises nothing", () => {
		expect(kinds(base())).toEqual([]);
	});
	it("never reported: an alert only after the grace from its first registration", () => {
		expect(kinds(base({ capabilityAt: null, firstRegisteredAt: NOW - CAPABILITY_GRACE_MS + 60_000 }))).toEqual([]);
		expect(kinds(base({ capabilityAt: null, firstRegisteredAt: NOW - CAPABILITY_GRACE_MS - 60_000 }))).toEqual(["capability_missing"]);
		expect(judgeMachine(base({ capabilityAt: null, firstRegisteredAt: NOW - 5 * H }), null, NOW)[0].detail).toMatch(/never reported its capabilities.*pags update/);
	});
	it("a report older than 36 hours on an online machine is stale; a day-old one is not", () => {
		expect(kinds(base({ capabilityAt: NOW - 24 * H }))).toEqual([]);
		expect(kinds(base({ capabilityAt: NOW - CAPABILITY_STALE_MS - H }))).toEqual(["capability_stale"]);
	});
	it("drift: behind a release that has been out past the grace; not behind a brand-new one; not when current", () => {
		expect(kinds(base({ runnerVersion: "0.4.176" }))).toEqual(["version_drift"]);
		expect(kinds(base({ runnerVersion: "0.4.176" }), { version: "0.4.177", firstSeenAt: NOW - DRIFT_GRACE_MS + H })).toEqual([]);
		expect(kinds(base({ runnerVersion: "0.4.177" }))).toEqual([]);
		expect(kinds(base({ runnerVersion: "0.4.178" }))).toEqual([]); // ahead of what npm shows (a trial): not drift
		expect(kinds(base({ runnerVersion: "0.4.176" }), null)).toEqual([]); // the release is unknown: nothing to compare to
	});
	it("a failed update and a crash loop each raise their own alert, with the reason", () => {
		const j = judgeMachine(base({ updateStatus: "failed", updateError: "pre-flight failed: only 90 MB free", starts24h: CRASH_LOOP_STARTS_24H }), RELEASE, NOW);
		expect(j.map((x) => x.kind).sort()).toEqual(["crash_loop", "update_failed"]);
		expect(j.find((x) => x.kind === "update_failed")?.detail).toContain("only 90 MB free");
		expect(kinds(base({ starts24h: CRASH_LOOP_STARTS_24H - 1 }))).toEqual([]); // three starts (pink-laptop) is not yet a loop
	});
	it("an offline machine is not judged here at all: silence has its own alarm", () => {
		expect(kinds(base({ lastSeenAt: NOW - ONLINE_MS - 1, capabilityAt: null, runnerVersion: "0.1.0", starts24h: 50 }))).toEqual([]);
	});
	it("compares versions numerically", () => {
		expect(olderVersion("0.4.9", "0.4.10")).toBe(true);
		expect(olderVersion("0.4.177", "0.4.177")).toBe(false);
		expect(olderVersion("0.4.177-rc.1", "0.4.177")).toBe(false);
		expect(olderVersion("1.0.0", "0.9.9")).toBe(false);
	});
});

describe("the pass, on the real schema", () => {
	let d1: RealSchemaD1;
	let env: Env;
	let sent: Array<{ type: string; title: string; body: string; instanceId?: string; key?: string; kind?: string }>;
	let now: number;
	const latest = { v: "0.4.177" };
	const deps = () => ({ now: () => now, fetchLatest: async () => latest.v, notify: (async (_e: Env, _u: string, type: string, title: string, body: string, _url: unknown, opts: { instanceId?: string; key?: string; kind?: string } = {}) => { sent.push({ type, title, body, ...opts }); return "sent"; }) as never });
	const node = (over: Record<string, unknown> = {}) => {
		const v = { instance_id: "i1", runner_node: "Tiny", version: "0.4.177", seen: new Date(NOW - 60_000).toISOString().replace("T", " ").slice(0, 19), created: new Date(NOW - 5 * H).toISOString().replace("T", " ").slice(0, 19), ...over };
		d1.exec(`INSERT OR REPLACE INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, runner_version, machine_id, status, last_seen_at, created_at) VALUES ('${v.instance_id}', 'u1', '${v.runner_node}', 'relay://', '${v.version}', '${M}', 'online', '${v.seen}', '${v.created}')`);
	};
	const caps = (ageMs: number) => d1.exec(`INSERT OR REPLACE INTO machine_capabilities (machine_id, user_id, schema_version, detected_at, os_name, os_version, arch, capability_hash, raw_json, updated_at) VALUES ('${M}', 'u1', 1, 'x', 'macOS', '12', 'x64', 'h', '{}', '${new Date(NOW - ageMs).toISOString().replace("T", " ").slice(0, 19)}')`);
	const open = () => d1.sqlite.prepare("SELECT kind FROM fleet_alerts WHERE cleared_at IS NULL ORDER BY kind").all().map((r) => (r as { kind: string }).kind);

	beforeEach(() => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
		env = { DB: d1.DB } as unknown as Env;
		sent = [];
		now = NOW;
		latest.v = "0.4.177";
	});
	afterEach(() => d1.close());

	it("raises ONE alert per episode however often it runs, and notifies once with a link target, an instance and a stable key", async () => {
		node();
		const first = await runFleetHealth(env, deps());
		expect(first).toMatchObject({ machines: 1, raised: 1 });
		expect(open()).toEqual(["capability_missing"]);
		now += 5 * 60_000;
		expect(await runFleetHealth(env, deps())).toMatchObject({ raised: 0, cleared: 0 });
		now += 5 * 60_000;
		await runFleetHealth(env, deps());
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ type: "runner_fleet", title: "A machine has not reported its capabilities", kind: "alert", instanceId: "i1", key: `fleet:${M}:capability_missing` });
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE source = 'fleet'").get()).toEqual({ n: 1 });
	});

	it("clears the alert when the machine recovers, and a later failure is a new episode with a new notice", async () => {
		node();
		await runFleetHealth(env, deps());
		caps(60_000); // it reported
		now += 5 * 60_000;
		expect(await runFleetHealth(env, deps())).toMatchObject({ cleared: 1 });
		expect(open()).toEqual([]);
		d1.exec("DELETE FROM machine_capabilities");
		now += 5 * 60_000;
		await runFleetHealth(env, deps());
		expect(open()).toEqual(["capability_missing"]);
		expect(sent).toHaveLength(2);
	});

	it("detects drift from the release the platform saw, with the grace measured from when it first saw it", async () => {
		node({ version: "0.4.176" });
		caps(H);
		latest.v = "0.4.177";
		await runFleetHealth(env, deps()); // first sight of 0.4.177: the grace starts now
		expect(open()).toEqual([]);
		now += DRIFT_GRACE_MS + RELEASE_CHECK_MS + 60_000;
		node({ version: "0.4.176", seen: new Date(now - 60_000).toISOString().replace("T", " ").slice(0, 19) });
		caps(H);
		await runFleetHealth(env, deps());
		expect(open()).toEqual(["version_drift"]);
		expect(sent.at(-1)?.body).toMatch(/runs 0\.4\.176; 0\.4\.177 has been out for 1\d hours/);
		// A new release restarts the clock rather than inheriting the old one's age.
		latest.v = "0.4.178";
		now += RELEASE_CHECK_MS + 60_000;
		node({ version: "0.4.177", seen: new Date(now - 60_000).toISOString().replace("T", " ").slice(0, 19) });
		caps(H);
		await runFleetHealth(env, deps());
		expect(open()).toEqual([]); // updated to 0.4.177, and 0.4.178 is brand new
	});

	it("a failed update and a restart storm are alerts with their reasons; an offline machine keeps its alerts and is not judged", async () => {
		node();
		caps(H);
		d1.exec(`INSERT INTO machine_policies (user_id, machine_id, auto_update, status, last_error) VALUES ('u1', '${M}', 1, 'failed', 'npm exited 1')`);
		d1.exec(`UPDATE instance_runtime_nodes SET resources = '${JSON.stringify({ loadAvg: [0, 0, 0], cpus: 4, memTotalBytes: 8e9, memFreeBytes: 4e9, platform: "darwin", sampledAt: NOW, runner: { startedAt: NOW - 1000, uptimeSec: 1, starts24h: 7, relayReconnects: 0 } })}'`);
		await runFleetHealth(env, deps());
		expect(open()).toEqual(["crash_loop", "update_failed"]);
		expect(sent.find((s) => s.key?.endsWith("update_failed"))?.body).toContain("npm exited 1");
		// The machine goes quiet: nothing is cleared (silence is judged elsewhere) and nothing new is raised.
		now += 2 * H;
		expect(await runFleetHealth(env, deps())).toMatchObject({ raised: 0, cleared: 0 });
		expect(open()).toEqual(["crash_loop", "update_failed"]);
	});

	it("a machine without an id cannot be tracked, and a failing release lookup never breaks the pass", async () => {
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, status, last_seen_at) VALUES ('i1', 'u1', 'Anon', 'relay://', 'online', '${new Date(NOW).toISOString().slice(0, 19).replace("T", " ")}')`);
		expect(await collectMachineFacts(env)).toEqual([]);
		node();
		const out = await runFleetHealth(env, { ...deps(), fetchLatest: async () => { throw new Error("registry down"); } });
		expect(out.machines).toBe(1);
	});

	it("looks up the release at most hourly and keeps the last known one when the registry fails", async () => {
		let calls = 0;
		const fetchLatest = async () => { calls++; return "0.4.177"; };
		expect(await currentRelease(env, NOW, { fetchLatest })).toEqual({ version: "0.4.177", firstSeenAt: NOW });
		await currentRelease(env, NOW + 60_000, { fetchLatest });
		expect(calls).toBe(1);
		expect(await currentRelease(env, NOW + RELEASE_CHECK_MS + 1, { fetchLatest: async () => { throw new Error("down"); } })).toEqual({ version: "0.4.177", firstSeenAt: NOW });
		expect(await currentRelease(env, NOW + RELEASE_CHECK_MS + 2, { fetchLatest: async () => "garbage" })).toMatchObject({ version: "0.4.177" });
	});
});
