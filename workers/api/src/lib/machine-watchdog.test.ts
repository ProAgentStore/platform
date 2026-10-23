/**
 * #1320 — the always-on control channel, platform side, on the real schema: a closed set of commands, validated arguments, delivered once,
 * settled only by the machine they were handed to, expired when nobody answers, every step audited — and the capability report rides along.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { DELIVERED_TTL_MS, enqueueWatchdogCommand, MAX_DELIVERED_PER_BEAT, parseWatchdogCommand, parseWatchdogStatus, QUEUED_TTL_MS, readWatchdog, WATCHDOG_ONLINE_MS, watchdogHeartbeat } from "./machine-watchdog.js";
import type { Env } from "../types.js";

const M = "3901c9c4-004f-435e-bfc5-0b87b7ac5173";
const OTHER = "99999999-004f-435e-bfc5-0b87b7ac5173";
const NOW = 1_800_000_000_000;
let d1: RealSchemaD1;
let env: Env;
const events = (kind?: string) => (d1.sqlite.prepare("SELECT event, message, context FROM agent_events WHERE source = 'watchdog' ORDER BY ts, rowid").all() as Array<{ event: string; message: string; context: string }>).filter((e) => !kind || e.event === kind);
const status = { version: "0.4.177", uptimeSec: 120, runner: { alive: false, uptimeSec: null }, running: "0.4.177", payloads: ["0.4.177", "0.4.176"], crashes24h: 3, lastError: "relay closed", service: "launchd" };

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

describe("the command set is closed and its arguments are validated (#1320)", () => {
	it("accepts the five kinds and refuses anything else, including anything shaped like a shell command", () => {
		for (const k of ["status", "update", "restart", "rollback"]) expect(parseWatchdogCommand(k, {})).toMatchObject({ ok: true, kind: k });
		for (const k of ["exec", "shell", "run", "", undefined, 5, "UPDATE", "update; rm -rf /"]) expect(parseWatchdogCommand(k, {}).ok).toBe(false);
	});
	it("update takes only a release number (or none = latest); diagnose only an allow-listed check; nothing else takes arguments", () => {
		expect(parseWatchdogCommand("update", { version: "0.4.178" })).toEqual({ ok: true, kind: "update", args: { version: "0.4.178" } });
		expect(parseWatchdogCommand("update", {})).toEqual({ ok: true, kind: "update", args: {} });
		for (const bad of ["latest; curl x|sh", "../../x", "1", "0.4.178 && id", "$(id)"]) expect(parseWatchdogCommand("update", { version: bad }).ok).toBe(false);
		expect(parseWatchdogCommand("diagnose", { check: "disk" })).toMatchObject({ ok: true, args: { check: "disk" } });
		for (const bad of [{}, { check: "cat /etc/passwd" }, { check: "rm" }, { command: "id" }]) expect(parseWatchdogCommand("diagnose", bad).ok).toBe(false);
		expect(parseWatchdogCommand("restart", { force: "yes" }).ok).toBe(false);
		expect(parseWatchdogCommand("rollback", { to: "0.4.1" }).ok).toBe(false);
	});
});

describe("status is clamped and carries no path or secret (#1320)", () => {
	it("keeps good fields, nulls the rest, scrubs paths in the last error and never throws", () => {
		const s = parseWatchdogStatus({ ...status, lastError: "ENOENT /Users/serge/.config/proagentstore/session.json", cpuLoad1: -4, memUsedPct: 400, version: "not a version", payloads: ["0.4.1", "x", "0.4.2", "0.4.3", "0.4.4", "0.4.5", "0.4.6"], token: "sk-secret", service: "cron" });
		expect(s).toMatchObject({ version: null, cpuLoad1: null, memUsedPct: null, service: null, running: "0.4.177", crashes24h: 3 });
		expect(s.payloads).toHaveLength(5);
		expect(s.lastError).toBe("ENOENT <path>");
		expect(JSON.stringify(s)).not.toMatch(/serge|sk-secret/);
		expect(parseWatchdogStatus(null).runner).toEqual({ alive: false, uptimeSec: null });
	});
});

describe("queue → deliver → result, once (#1320)", () => {
	it("queues one command per kind (a repeat returns the open one), hands it out on the next heartbeat, and never twice", async () => {
		await watchdogHeartbeat(env, "u1", M, { status }, NOW);
		const q = await enqueueWatchdogCommand(env, "u1", M, "update", { version: "0.4.178" }, NOW);
		expect(q).toMatchObject({ ok: true, duplicate: false, command: { kind: "update", state: "queued", args: { version: "0.4.178" } } });
		const again = await enqueueWatchdogCommand(env, "u1", M, "update", { version: "0.4.179" }, NOW + 1);
		expect(again).toMatchObject({ ok: true, duplicate: true });
		if (!q.ok || !again.ok) throw new Error("unreachable");
		expect(again.command.id).toBe(q.command.id);
		const beat = await watchdogHeartbeat(env, "u1", M, { status }, NOW + 30_000);
		expect(beat.commands).toEqual([{ id: q.command.id, kind: "update", args: { version: "0.4.178" } }]);
		expect((await watchdogHeartbeat(env, "u1", M, { status }, NOW + 60_000)).commands).toEqual([]); // delivered once
	});

	it("settles a result only for the machine it was delivered to, once, and writes it to the audit log with the reason", async () => {
		const q = await enqueueWatchdogCommand(env, "u1", M, "restart", {}, NOW);
		if (!q.ok) throw new Error("unreachable");
		await watchdogHeartbeat(env, "u1", M, { status }, NOW + 1000);
		// Another machine of the same account cannot settle it; neither can a made-up id.
		await watchdogHeartbeat(env, "u1", OTHER, { status, results: [{ id: q.command.id, state: "done", detail: "forged" }, { id: "nope", state: "done" }] }, NOW + 2000);
		expect((await readWatchdog(env, "u1", M, NOW + 2000)).commands[0]).toMatchObject({ state: "delivered", result: null });
		await watchdogHeartbeat(env, "u1", M, { status, results: [{ id: q.command.id, state: "failed", detail: "launchctl kickstart failed: /Users/serge/x not loaded" }] }, NOW + 3000);
		await watchdogHeartbeat(env, "u1", M, { status, results: [{ id: q.command.id, state: "done", detail: "second" }] }, NOW + 4000);
		const c = (await readWatchdog(env, "u1", M, NOW + 4000)).commands[0];
		expect(c).toMatchObject({ state: "failed", finishedAt: NOW + 3000 });
		expect(c.result).toBe("launchctl kickstart failed: <path> not loaded");
		expect(events().map((e) => e.event)).toEqual(["watchdog.command_queued", "watchdog.command_delivered", "watchdog.command_result"]);
		expect(JSON.parse(events("watchdog.command_result")[0].context)).toMatchObject({ state: "failed", commandId: q.command.id });
	});

	it("hands out at most three per beat, oldest first", async () => {
		for (const k of ["status", "update", "restart", "rollback"]) await enqueueWatchdogCommand(env, "u1", M, k, {}, NOW + ["status", "update", "restart", "rollback"].indexOf(k));
		const beat = await watchdogHeartbeat(env, "u1", M, { status }, NOW + 10);
		expect(beat.commands.map((c) => c.kind)).toEqual(["status", "update", "restart"]);
		expect(MAX_DELIVERED_PER_BEAT).toBe(3);
		expect((await watchdogHeartbeat(env, "u1", M, { status }, NOW + 20)).commands.map((c) => c.kind)).toEqual(["rollback"]);
	});

	it("expires a command nobody collected for a day, and one delivered but never answered after half an hour", async () => {
		await enqueueWatchdogCommand(env, "u1", M, "update", {}, NOW);
		await enqueueWatchdogCommand(env, "u1", M, "restart", {}, NOW);
		await watchdogHeartbeat(env, "u1", M, { status }, NOW + 1); // both delivered
		await enqueueWatchdogCommand(env, "u1", M, "rollback", {}, NOW + 2);
		const later = NOW + QUEUED_TTL_MS + 5;
		await watchdogHeartbeat(env, "u1", M, { status }, later);
		const states = Object.fromEntries((await readWatchdog(env, "u1", M, later)).commands.map((c) => [c.kind, c.state]));
		expect(states).toEqual({ update: "expired", restart: "expired", rollback: "expired" });
		await enqueueWatchdogCommand(env, "u1", M, "diagnose", { check: "disk" }, later);
		await watchdogHeartbeat(env, "u1", M, { status }, later + 1);
		await watchdogHeartbeat(env, "u1", M, { status }, later + 1 + DELIVERED_TTL_MS + 1);
		expect((await readWatchdog(env, "u1", M, later)).commands.find((c) => c.kind === "diagnose")).toMatchObject({ state: "expired", result: "no result was reported" });
	});

	it("is scoped to the account: another user's commands are never handed out", async () => {
		d1.exec("INSERT INTO users (id, github_login) VALUES ('u2', 'u2')");
		await enqueueWatchdogCommand(env, "u2", M, "restart", {}, NOW);
		expect((await watchdogHeartbeat(env, "u1", M, { status }, NOW + 1)).commands).toEqual([]);
		expect((await watchdogHeartbeat(env, "u2", M, { status }, NOW + 1)).commands).toHaveLength(1);
	});
});

describe("the status read-back and the capability report (#1320, #1312)", () => {
	it("reports installed / connected / last status, and a machine that stopped beating reads disconnected", async () => {
		expect(await readWatchdog(env, "u1", M, NOW)).toMatchObject({ installed: false, connected: false, status: null });
		await watchdogHeartbeat(env, "u1", M, { status }, NOW);
		expect(await readWatchdog(env, "u1", M, NOW + 1000)).toMatchObject({ installed: true, connected: true, firstSeenAt: NOW, status: { version: "0.4.177", crashes24h: 3, runner: { alive: false } } });
		expect((await readWatchdog(env, "u1", M, NOW + WATCHDOG_ONLINE_MS + 1)).connected).toBe(false);
		await watchdogHeartbeat(env, "u1", M, { status: { ...status, version: "0.4.178" } }, NOW + 60_000);
		expect(await readWatchdog(env, "u1", M, NOW + 61_000)).toMatchObject({ firstSeenAt: NOW, status: { version: "0.4.178" } });
	});

	it("takes the capability report on the same heartbeat, so a machine whose runner is dead or old still reports", async () => {
		const caps = { detectedAt: "2026-10-24T00:00:00.000Z", os: { name: "macOS", version: "12.7.6", arch: "x64" }, cpuCount: 4, memoryGb: 8, diskGb: 250, nodeVersion: "22.4.0", playwright: { version: "1.58.2", probes: [] }, ios: false, android: false, docker: false, inventory: [] };
		const { capabilityHash } = await import("./machine-capability-schema.js");
		const { parseMachineCapabilities } = await import("./machine-capability-schema.js");
		const hash = await capabilityHash(parseMachineCapabilities(caps)!);
		expect((await watchdogHeartbeat(env, "u1", M, { status, capabilityHash: hash }, NOW)).capabilitiesWanted).toBe(true);
		expect((await watchdogHeartbeat(env, "u1", M, { status, capabilityHash: hash, capabilities: caps }, NOW + 1)).capabilitiesStored).toBe(true);
		expect(d1.sqlite.prepare("SELECT os_version FROM machine_capabilities WHERE machine_id = ?").get(M)).toEqual({ os_version: "12.7.6" });
		expect((await watchdogHeartbeat(env, "u1", M, { status, capabilityHash: hash }, NOW + 2)).capabilitiesStored).toBe(true);
	});

	it("a malformed heartbeat still answers (telemetry is never a reason to cut the channel)", async () => {
		expect(await watchdogHeartbeat(env, "u1", M, { status: "garbage", results: "x", capabilities: 5 }, NOW)).toEqual({ commands: [] });
	});
});
