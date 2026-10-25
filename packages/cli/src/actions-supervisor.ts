/** One PAGS-owned GitHub Actions listener per configured runner folder (#1366).
 * The launchd system service runs this as the runner owner. No relay or cloud token is needed.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { connect } from "node:net";

export type SupervisorHealth = "starting" | "ready" | "waiting_network" | "deferred_active_job" | "recovering" | "backoff" | "stopped" | "error";
export type RecoveryReason = "ac_return" | "manual";
export type RecoveryState = "queued" | "deferred_active_job" | "waiting_network" | "restarting" | "ready" | "error";
export interface RecoveryReceipt { id: string; reason: RecoveryReason; state: RecoveryState; requestedAt: number; completedAt?: number; error?: string }
export interface SupervisorStatus {
  version: 1;
  runnerDir: string;
  supervisorPid: number;
  listenerPid?: number;
  health: SupervisorHealth;
  acPower: "ac" | "battery" | "unknown";
  lastAcReturnAt?: number;
  lastRestartAt?: number;
  lastRestartReason?: "startup" | "ac_return" | "manual" | "child_exit";
  lastReadyAt?: number;
  lastError?: string;
  activeJob: boolean;
  updatedAt: number;
  lastRecovery?: RecoveryReceipt;
  lastManualRequestId?: string;
}
export interface SupervisorConfig { version: 1; acRecoveryEnabled: boolean }
export interface RecoveryRequest { id: string; reason: "manual"; requestedAt: number }

export function supervisorPaths(dir: string) {
  const base = join(dir, ".pags-supervisor");
  return { base, config: join(base, "config.json"), status: join(base, "status.json"), recover: join(base, "recover.json"), lock: join(base, "lock") };
}
function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
function writeJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
function validDir(dir: string): string {
  if (!isAbsolute(dir) || resolve(dir) !== dir) throw new Error("runner directory must be an absolute normalized path");
  if (!existsSync(join(dir, ".runner")) || !existsSync(join(dir, ".credentials")) || !existsSync(join(dir, "runsvc.sh"))) throw new Error("runner directory lacks .runner, .credentials, or runsvc.sh");
  return dir;
}
export function readSupervisorConfig(dir: string): SupervisorConfig | null {
  const data = readJson(supervisorPaths(dir).config) as Partial<SupervisorConfig> | null;
  return data?.version === 1 && typeof data.acRecoveryEnabled === "boolean" ? data as SupervisorConfig : null;
}
/** The local copy is the supervisor's source of truth; the loop re-reads it every cycle. */
export function setSupervisorAcRecovery(dir: string, enabled: boolean): SupervisorConfig {
  validDir(dir);
  const config = readSupervisorConfig(dir);
  if (!config) throw new Error("runner has no valid PAGS supervisor configuration");
  const next: SupervisorConfig = { ...config, acRecoveryEnabled: enabled };
  writeJson(supervisorPaths(dir).config, next);
  return next;
}

export function readSupervisorStatus(dir: string): SupervisorStatus | null {
  const data = readJson(supervisorPaths(dir).status) as Partial<SupervisorStatus> | null;
  return data?.version === 1 && data.runnerDir === dir && typeof data.updatedAt === "number" ? data as SupervisorStatus : null;
}
export function requestSupervisorRecovery(dir: string): RecoveryReceipt {
  validDir(dir);
  if (!readSupervisorConfig(dir)) throw new Error("runner has no valid PAGS supervisor configuration");
  const status = readSupervisorStatus(dir);
  if (!status || !isAlive(status.supervisorPid) || Date.now() - status.updatedAt > 90_000) throw new Error("runner supervisor is not reporting; start its service before requesting recovery");
  const paths = supervisorPaths(dir);
  const writeLock = join(paths.base, "recover-write.lock");
  const nonce = randomUUID();
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      const fd = openSync(writeLock, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), nonce })); } finally { closeSync(fd); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      let ino: number | undefined;
      try {
        const stat = statSync(writeLock); ino = stat.ino;
        const owner = JSON.parse(readFileSync(writeLock, "utf8")) as { pid?: unknown; at?: unknown };
        const alive = typeof owner.pid === "number" && isAlive(owner.pid);
        stale = !alive || (typeof owner.at === "number" && Date.now() - owner.at > 30_000);
      } catch { try { stale = Date.now() - statSync(writeLock).mtimeMs > 30_000; } catch { /* another writer removed it */ } }
      if (stale && ino !== undefined) try { if (statSync(writeLock).ino === ino) rmSync(writeLock); } catch { /* another writer won */ }
      if (Date.now() > deadline) throw new Error("another recovery request is being written; retry shortly");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const existing = readJson(paths.recover) as RecoveryRequest | null;
    if (existsSync(paths.recover) && (existing?.reason !== "manual" || typeof existing.id !== "string" || typeof existing.requestedAt !== "number")) throw new Error("unknown recovery request already exists; refusing to overwrite it");
    if (existing) {
      const receipt = status.lastRecovery;
      if (status.lastManualRequestId !== existing.id) return { ...existing, state: status.activeJob ? "deferred_active_job" : "queued" };
      if (receipt?.id === existing.id && receipt.state !== "ready" && receipt.state !== "error") return receipt;
    }
    const req: RecoveryRequest = { id: randomUUID(), reason: "manual", requestedAt: Date.now() };
    writeJson(paths.recover, req);
    return { ...req, state: status.activeJob ? "deferred_active_job" : "queued" };
  } finally {
    try {
      const owner = JSON.parse(readFileSync(writeLock, "utf8")) as { nonce?: unknown };
      if (owner.nonce === nonce) rmSync(writeLock);
    } catch { /* a killed writer leaves a lock for the next request to recover */ }
  }
}
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export function parseAcPower(text: string): "ac" | "battery" | "unknown" {
  if (/Now drawing from 'AC Power'/i.test(text)) return "ac";
  if (/Now drawing from 'Battery Power'/i.test(text)) return "battery";
  return "unknown";
}
export function macAcPower(): "ac" | "battery" | "unknown" {
  if (process.platform !== "darwin") return "unknown";
  const r = spawnSync("/usr/bin/pmset", ["-g", "batt"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? parseAcPower(String(r.stdout)) : "unknown";
}
/** Only descendants of this supervisor's direct runsvc.sh child can count as an active job. */
export function workerInTree(rootPid: number | undefined, psText: string): boolean {
  if (!rootPid) return false;
  const rows = psText.split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter((r): r is RegExpExecArray => r !== null);
  const byParent = new Map<number, number[]>();
  const workers = new Set<number>();
  for (const row of rows) {
    const pid = Number(row[1]); const ppid = Number(row[2]);
    byParent.set(ppid, [...(byParent.get(ppid) ?? []), pid]);
    if (/(?:^|[/ ])Runner\.Worker(?:\s|$)/.test(row[3])) workers.add(pid);
  }
  const queue = [rootPid]; const seen = new Set<number>();
  while (queue.length) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (pid !== rootPid && workers.has(pid)) return true;
    queue.push(...(byParent.get(pid) ?? []));
  }
  return false;
}
function activeWorker(pid: number | undefined): boolean {
  if (!pid) return false;
  const r = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 5000 });
  // An unreadable process table is treated as busy, so recovery does not interrupt a job.
  return r.status !== 0 || workerInTree(pid, String(r.stdout));
}
function networkReady(): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "github.com", port: 443, timeout: 5000 });
    let settled = false;
    const finish = (ok: boolean) => { if (settled) return; settled = true; socket.destroy(); done(ok); };
    socket.once("connect", () => finish(true)); socket.once("timeout", () => finish(false)); socket.once("error", () => finish(false));
  });
}
function sleep(ms: number): Promise<void> { return new Promise((done) => setTimeout(done, ms)); }

export interface SupervisorRuntime {
  acPower(): "ac" | "battery" | "unknown";
  activeWorker(pid: number | undefined): boolean;
  networkReady(): Promise<boolean>;
  spawnRunner(dir: string): ChildProcessWithoutNullStreams;
  sleep(ms: number): Promise<void>;
  now(): number;
  isAlive(pid: number): boolean;
  terminateTree(pid: number, signal: NodeJS.Signals): void;
}
export const liveSupervisorRuntime: SupervisorRuntime = {
  acPower: macAcPower, activeWorker, networkReady, sleep, now: Date.now, isAlive,
  terminateTree: (pid, signal) => process.kill(-pid, signal),
  spawnRunner: (dir) => spawn(join(dir, "runsvc.sh"), [], { cwd: dir, stdio: ["pipe", "pipe", "pipe"], detached: true, env: { ...process.env, ACTIONS_RUNNER_SVC: "1" } }),
};

function acquireLock(dir: string): () => void {
  const p = supervisorPaths(dir);
  mkdirSync(p.base, { recursive: true, mode: 0o700 });
  try { mkdirSync(p.lock, { mode: 0o700 }); }
  catch {
    const pid = Number(readFileSync(join(p.lock, "pid"), "utf8"));
    if (isAlive(pid)) throw new Error(`runner supervisor already active (pid ${pid})`);
    // A dead owner leaves a directory after SIGKILL or power loss. The live owner check above
    // is conservative: PID reuse may refuse recovery, but cannot create two listeners.
    rmSync(p.lock, { recursive: true, force: true });
    mkdirSync(p.lock, { mode: 0o700 });
  }
  writeFileSync(join(p.lock, "pid"), String(process.pid), { flag: "wx", mode: 0o600 });
  return () => {
    try { if (Number(readFileSync(join(p.lock, "pid"), "utf8")) === process.pid) rmSync(p.lock, { recursive: true, force: true }); } catch { /* a successor owns it */ }
  };
}

/** Long-running loop. A fresh ready line must come from the current child's pipes. */
export async function runActionsSupervisor(dir: string, runtime: SupervisorRuntime = liveSupervisorRuntime, stopSignal?: AbortSignal): Promise<void> {
  validDir(dir);
  if (!readSupervisorConfig(dir)) throw new Error("runner has no valid PAGS supervisor configuration");
  const unlock = acquireLock(dir);
  const paths = supervisorPaths(dir);
  const old = readSupervisorStatus(dir);
  // A killed supervisor can leave runsvc.sh alive. Never launch a second listener over it.
  if (old?.listenerPid && isAlive(old.listenerPid)) {
    writeJson(paths.status, { ...old, supervisorPid: process.pid, health: "error", lastError: `previous listener process ${old.listenerPid} is still alive; refusing duplicate service`, updatedAt: runtime.now() });
    unlock();
    throw new Error(`previous listener process ${old.listenerPid} is still alive; refusing duplicate service`);
  }
  const status: SupervisorStatus = { version: 1, runnerDir: dir, supervisorPid: process.pid, health: "starting", acPower: old?.acPower ?? "unknown", lastAcReturnAt: old?.lastAcReturnAt, lastRestartAt: old?.lastRestartAt, lastRestartReason: old?.lastRestartReason, lastReadyAt: old?.lastReadyAt, lastError: undefined, activeJob: false, updatedAt: runtime.now(), lastRecovery: old?.lastRecovery, lastManualRequestId: old?.lastManualRequestId };
  const save = () => { status.updatedAt = runtime.now(); writeJson(paths.status, status); };
  let child: ChildProcessWithoutNullStreams | undefined;
  let childExit = false;
  let nextStart = 0;
  let retryMs = 1000;
  let readyDeadline = 0;
  let pending: RecoveryReceipt | undefined;
  let stopped = false;
  const onStop = () => { stopped = true; };
  process.on("SIGTERM", onStop); process.on("SIGINT", onStop);
  stopSignal?.addEventListener("abort", onStop);
  const stopChild = async () => {
    const pid = child?.pid;
    if (!pid || !runtime.isAlive(pid)) { child = undefined; return; }
    // Safety is checked immediately before signalling the exact process group created by spawnRunner.
    if (runtime.activeWorker(pid)) throw new Error("active Runner.Worker; recovery deferred");
    try { runtime.terminateTree(pid, "SIGTERM"); } catch { if (runtime.isAlive(pid)) throw new Error("could not stop owned listener tree"); }
    for (let n = 0; n < 20 && runtime.isAlive(pid); n++) await runtime.sleep(250);
    if (runtime.isAlive(pid)) {
      if (runtime.activeWorker(pid)) throw new Error("active Runner.Worker; recovery deferred");
      runtime.terminateTree(pid, "SIGKILL");
    }
    child = undefined;
  };
  const start = (reason: SupervisorStatus["lastRestartReason"]) => {
    childExit = false;
    const current = runtime.spawnRunner(dir);
    child = current;
    status.listenerPid = current.pid;
    status.health = "starting";
    status.lastRestartAt = runtime.now(); status.lastRestartReason = reason; status.lastError = undefined; readyDeadline = runtime.now() + 120_000;
    // A line buffered stream avoids treating a partial or old diagnostic as readiness.
    let buffer = "";
    current.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      buffer += chunk.toString();
      if (buffer.length > 8192) buffer = buffer.slice(-8192);
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (child === current && /(?:^|\s)Listening for Jobs(?:\s|$)/.test(line)) {
          status.lastReadyAt = runtime.now(); status.health = "ready";
          if (pending) { pending.state = "ready"; pending.completedAt = status.lastReadyAt; status.lastRecovery = pending; pending = undefined; }
          save();
        }
        index = buffer.indexOf("\n");
      }
    });
    current.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    current.on("error", (err) => { status.lastError = err.message; status.health = "error"; childExit = true; save(); });
    current.on("exit", () => { if (child === current) { childExit = true; status.listenerPid = undefined; status.health = "backoff"; save(); } });
    save();
  };
  try {
    save();
    while (!stopped && !stopSignal?.aborted) {
      const now = runtime.now();
      const ac = runtime.acPower();
      const previousAc = status.acPower;
      if (ac !== "unknown") status.acPower = ac;
      const config = readSupervisorConfig(dir);
      if (!config) { status.health = "error"; status.lastError = "supervisor configuration missing or invalid"; save(); break; }
      if (config.acRecoveryEnabled && previousAc === "battery" && ac === "ac") {
        status.lastAcReturnAt = now;
        pending = { id: randomUUID(), reason: "ac_return", state: "queued", requestedAt: now };
        status.lastRecovery = pending;
      }
      const request = readJson(paths.recover) as Partial<RecoveryRequest> | null;
      if (request?.reason === "manual" && typeof request.id === "string" && status.lastManualRequestId !== request.id) {
        status.lastManualRequestId = request.id;
        pending = { id: request.id, reason: "manual", state: "queued", requestedAt: typeof request.requestedAt === "number" ? request.requestedAt : now };
        status.lastRecovery = pending;
      }
      if (childExit) { if (status.lastRestartAt && now - status.lastRestartAt > 300_000) retryMs = 1000; child = undefined; childExit = false; nextStart = now + retryMs; retryMs = Math.min(retryMs * 2, 60_000); status.health = "backoff"; }
      status.activeJob = runtime.activeWorker(child?.pid);
      if (child && status.health === "starting" && now >= readyDeadline && !status.activeJob) {
        const message = "listener did not emit a fresh Listening for Jobs line within 120 seconds";
        status.lastError = message; status.health = "error";
        if (pending) { pending.state = "error"; pending.error = message; pending.completedAt = now; status.lastRecovery = pending; pending = undefined; }
        save();
        try { await stopChild(); nextStart = now + retryMs; retryMs = Math.min(retryMs * 2, 60_000); }
        catch (e) { status.lastError = e instanceof Error ? e.message : String(e); }
      }
      if (pending && child) {
        if (status.activeJob) { pending.state = "deferred_active_job"; status.health = "deferred_active_job"; }
        else if (!(await runtime.networkReady())) { pending.state = "waiting_network"; status.health = "waiting_network"; }
        else {
          pending.state = "restarting"; status.health = "recovering"; save();
          try { await stopChild(); nextStart = 0; start(pending.reason); }
          catch (e) { pending.state = "deferred_active_job"; status.health = "deferred_active_job"; status.lastError = e instanceof Error ? e.message : String(e); }
        }
      } else if (!child && now >= nextStart) {
        if (await runtime.networkReady()) start(pending?.reason ?? (status.lastRestartAt ? "child_exit" : "startup"));
        else { status.health = "waiting_network"; nextStart = now + 5000; }
      }
      save();
      await runtime.sleep(2000);
    }
  } finally {
    // A job may outlive a launchd stop request. Keep the lock and child ownership until it ends.
    while (child) {
      if (child.pid && runtime.activeWorker(child.pid)) {
        status.activeJob = true; status.health = "deferred_active_job"; save();
        await runtime.sleep(2000);
        continue;
      }
      try { await stopChild(); }
      catch (e) {
        status.health = "error"; status.lastError = e instanceof Error ? e.message : String(e); save();
        await runtime.sleep(2000);
      }
    }
    status.health = "stopped"; status.listenerPid = undefined; status.activeJob = false; save();
    stopSignal?.removeEventListener("abort", onStop);
    process.off("SIGTERM", onStop); process.off("SIGINT", onStop);
    unlock();
  }
}
