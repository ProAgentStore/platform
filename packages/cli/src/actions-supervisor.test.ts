import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAcPower, readSupervisorStatus, requestSupervisorRecovery, runActionsSupervisor, supervisorPaths, workerInTree, type SupervisorRuntime } from "./actions-supervisor.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function runner() {
  const dir = mkdtempSync(join(tmpdir(), "pags-actions-supervisor-")); dirs.push(dir);
  for (const file of [".runner", ".credentials", "runsvc.sh"]) writeFileSync(join(dir, file), "test");
  mkdirSync(supervisorPaths(dir).base);
  writeFileSync(supervisorPaths(dir).config, JSON.stringify({ version: 1, acRecoveryEnabled: true }));
  return dir;
}
function fakeRuntime() {
  let now = 1000; let busy = false; let alive = true; let online = true; let starts = 0; let power: "ac" | "battery" = "ac";
  let child: EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter };
  const sleeps: Array<() => void> = [];
  const signals: string[] = [];
  const runtime: SupervisorRuntime = {
    acPower: () => power,
    activeWorker: () => busy,
    networkReady: async () => online,
    now: () => now,
    sleep: async () => new Promise<void>((resolve) => { sleeps.push(resolve); }),
    isAlive: () => alive,
    terminateTree: (_pid, signal) => { signals.push(signal); alive = false; child.emit("exit", 0); },
    spawnRunner: () => { starts++; alive = true; child = Object.assign(new EventEmitter(), { pid: 900001, stdout: new EventEmitter(), stderr: new EventEmitter() }); return child as never; },
  };
  const tick = async (elapsed = 2000) => { now += elapsed; const resolve = sleeps.shift(); expect(resolve).toBeDefined(); resolve?.(); await new Promise((r) => setImmediate(r)); };
  return { runtime, tick, signals, get child() { return child; }, get starts() { return starts; }, set busy(v: boolean) { busy = v; }, set online(v: boolean) { online = v; }, set power(v: "ac" | "battery") { power = v; }, exit() { alive = false; child.emit("exit", 1); } };
}

describe("PAGS Actions supervisor", () => {
  it("parses AC and finds only an owned runner worker", () => {
    expect(parseAcPower("Now drawing from 'AC Power'")).toBe("ac");
    expect(parseAcPower("Now drawing from 'Battery Power'")).toBe("battery");
    expect(workerInTree(10, "10 1 runsvc.sh\n11 10 RunnerService.js\n12 11 /x/Runner.Worker run\n20 1 Runner.Worker")).toBe(true);
    expect(workerInTree(10, "10 1 runsvc.sh\n11 10 RunnerService.js\n20 1 Runner.Worker")).toBe(false);
  });

  it("accepts readiness only from the current child, and waits for an active worker on stop", async () => {
    const dir = runner(); const f = fakeRuntime(); const abort = new AbortController();
    const loop = runActionsSupervisor(dir, f.runtime, abort.signal);
    await new Promise((r) => setImmediate(r));
    expect(readSupervisorStatus(dir)?.health).toBe("starting");
    f.child.stdout.emit("data", Buffer.from("2026-10-26: Listening for Jobs\n"));
    expect(readSupervisorStatus(dir)?.health).toBe("ready");
    expect(readSupervisorStatus(dir)?.lastReadyAt).toBe(1000);
    f.busy = true; abort.abort(); await f.tick();
    expect(readSupervisorStatus(dir)?.health).toBe("deferred_active_job");
    expect(f.signals).toEqual([]);
    f.busy = false; await f.tick(); await loop;
    expect(f.signals).toEqual(["SIGTERM"]);
    expect(readSupervisorStatus(dir)?.health).toBe("stopped");
  });

  it("records a recovery error when a fresh ready line never arrives", async () => {
    const dir = runner(); const f = fakeRuntime(); const abort = new AbortController();
    writeFileSync(supervisorPaths(dir).recover, JSON.stringify({ id: "request-1", reason: "manual", requestedAt: 1000 }));
    const loop = runActionsSupervisor(dir, f.runtime, abort.signal);
    await new Promise((r) => setImmediate(r));
    expect(readSupervisorStatus(dir)?.lastRecovery?.id).toBe("request-1");
    await f.tick(121_000);
    expect(readSupervisorStatus(dir)?.lastRecovery?.state).toBe("error");
    expect(readSupervisorStatus(dir)?.lastRecovery?.error).toMatch(/fresh Listening for Jobs/);
    expect(f.signals).toEqual(["SIGTERM"]);
    abort.abort(); await f.tick(); await loop;
  });

  it("defers an AC reconnect through network delay and an active worker", async () => {
    const dir = runner(); const f = fakeRuntime(); const abort = new AbortController();
    const loop = runActionsSupervisor(dir, f.runtime, abort.signal);
    await new Promise((r) => setImmediate(r));
    f.child.stdout.emit("data", Buffer.from("Listening for Jobs\n"));
    f.power = "battery"; await f.tick();
    f.power = "ac"; f.busy = true; await f.tick();
    expect(readSupervisorStatus(dir)?.lastRecovery?.state).toBe("deferred_active_job");
    expect(f.signals).toEqual([]);
    f.busy = false; f.online = false; await f.tick();
    expect(readSupervisorStatus(dir)?.lastRecovery?.state).toBe("waiting_network");
    expect(f.signals).toEqual([]);
    f.online = true; await f.tick();
    expect(f.signals).toEqual(["SIGTERM"]);
    expect(readSupervisorStatus(dir)?.lastRestartReason).toBe("ac_return");
    expect(readSupervisorStatus(dir)?.lastRecovery?.state).toBe("restarting");
    f.child.stdout.emit("data", Buffer.from("Listening for Jobs\n"));
    expect(readSupervisorStatus(dir)?.lastRecovery?.state).toBe("ready");
    abort.abort(); await f.tick(); await loop;
  });

  it("does not replay a consumed manual request after an AC event", async () => {
    const dir = runner(); const f = fakeRuntime(); const abort = new AbortController();
    writeFileSync(supervisorPaths(dir).recover, JSON.stringify({ id: "manual-once", reason: "manual", requestedAt: 1000 }));
    const loop = runActionsSupervisor(dir, f.runtime, abort.signal);
    await new Promise((r) => setImmediate(r));
    f.child.stdout.emit("data", Buffer.from("Listening for Jobs\n"));
    expect(readSupervisorStatus(dir)?.lastManualRequestId).toBe("manual-once");
    f.power = "battery"; await f.tick();
    f.power = "ac"; f.busy = true; await f.tick();
    expect(readSupervisorStatus(dir)?.lastRecovery?.reason).toBe("ac_return");
    await f.tick();
    expect(readSupervisorStatus(dir)?.lastRecovery?.reason).toBe("ac_return");
    f.busy = false; abort.abort(); await f.tick(); await loop;
  });

  it("restarts an exited child with increasing bounded delays", async () => {
    const dir = runner(); const f = fakeRuntime(); const abort = new AbortController();
    const loop = runActionsSupervisor(dir, f.runtime, abort.signal);
    await new Promise((r) => setImmediate(r));
    expect(f.starts).toBe(1);
    f.exit(); await f.tick();
    expect(f.starts).toBe(1);
    await f.tick(999); expect(f.starts).toBe(1);
    await f.tick(1); expect(f.starts).toBe(2);
    f.exit(); await f.tick();
    await f.tick(1999); expect(f.starts).toBe(2);
    await f.tick(1); expect(f.starts).toBe(3);
    abort.abort(); await f.tick(); await loop;
  });

  it("refuses to create a second listener while an orphan PID still lives", async () => {
    const dir = runner(); const f = fakeRuntime();
    writeFileSync(supervisorPaths(dir).status, JSON.stringify({ version: 1, runnerDir: dir, supervisorPid: 1, listenerPid: process.pid, health: "ready", acPower: "ac", activeJob: false, updatedAt: 1 }));
    await expect(runActionsSupervisor(dir, f.runtime)).rejects.toThrow(/refusing duplicate service/);
    expect(f.starts).toBe(0);
    expect(readSupervisorStatus(dir)?.health).toBe("error");
  });

  it("writes a durable manual request only for a live configured supervisor", () => {
    const dir = runner();
    expect(() => requestSupervisorRecovery(dir)).toThrow(/not reporting/);
    writeFileSync(supervisorPaths(dir).status, JSON.stringify({ version: 1, runnerDir: dir, supervisorPid: process.pid, health: "ready", acPower: "ac", activeJob: true, updatedAt: Date.now() }));
    writeFileSync(join(supervisorPaths(dir).base, "recover-write.lock"), JSON.stringify({ pid: -1, at: 1, nonce: "stale" }));
    const receipt = requestSupervisorRecovery(dir);
    expect(receipt.state).toBe("deferred_active_job");
    expect(JSON.parse(readFileSync(supervisorPaths(dir).recover, "utf8")).id).toBe(receipt.id);
    expect(requestSupervisorRecovery(dir).id).toBe(receipt.id);
    writeFileSync(supervisorPaths(dir).status, JSON.stringify({ version: 1, runnerDir: dir, supervisorPid: process.pid, health: "recovering", acPower: "ac", activeJob: false, updatedAt: Date.now(), lastRecovery: { ...receipt, state: "restarting" }, lastManualRequestId: receipt.id }));
    expect(requestSupervisorRecovery(dir).id).toBe(receipt.id);
    writeFileSync(supervisorPaths(dir).status, JSON.stringify({ version: 1, runnerDir: dir, supervisorPid: process.pid, health: "ready", acPower: "ac", activeJob: false, updatedAt: Date.now(), lastRecovery: { ...receipt, state: "ready", completedAt: Date.now() }, lastManualRequestId: receipt.id }));
    expect(requestSupervisorRecovery(dir).id).not.toBe(receipt.id);
  });
});
