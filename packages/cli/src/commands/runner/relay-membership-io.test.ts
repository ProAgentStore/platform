/** #1556: a stuck membership request cannot permanently own discovery or cloud control. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectViaRelay } from "./relay.js";

vi.mock("../../output.js", () => ({ writeLine: () => undefined, writeError: () => undefined }));
vi.mock("../../machine.js", () => ({ loadMachineIdentity: () => ({ id: "", names: [] }) }));
vi.mock("../../capabilities/detect.js", () => ({ CapabilityReporter: class { refreshIfDue() {} payload() { return {}; } accept() {} } }));
vi.mock("./resources.js", () => ({
	probeRuntimeHealth: async () => ({ state: "responsive" }), recordRunnerStart: () => 1,
	sampleDisk: () => null, sampleMemAvailable: () => null, sampleResources: () => ({ cpus: 4, sessions: [] }),
}));
vi.mock("./cleanup-sync.js", () => ({ createCleanupSync: () => ({ collect: async () => ({ status: null }), accept: async () => undefined }) }));
vi.mock("../../bootstrap/update-log.js", () => ({ updateLogUpload: () => ({ body: () => ({}), answered() {} }) }));
vi.mock("./release-trial.js", () => ({
	releaseTrial: () => ({ rollbacks: () => [], rolledBack: () => false, proven() {} }),
	agentsStillMissing: () => [], rollbackAvailable: () => false, applyRetryRolledBack: () => ({}),
}));

const FIRST = "first-agent", NEW = "new-agent";
const instance = (id: string) => ({ id, status: "active", config: {}, capabilities: { runtime: "coding", surfaces: ["coding"], tools: [] } });
let reads: number;
let mode: "fetch" | "body";
let slowSignal: AbortSignal | undefined;
let finishSlow: ((response: Response) => void) | undefined;
let registered: string[];
let stallRegistration: boolean;
class FakeSocket {
 static OPEN = 1;
 static all: FakeSocket[] = [];
 readyState = 1; closed = false; sent: string[] = [];
 onopen?: (() => void) | null;
 onmessage?: ((event: { data: string }) => Promise<void>) | null;
 onclose?: ((event: { code: number; reason: string }) => void) | null;
 onerror?: (() => void) | null;
 constructor(public url: string) { FakeSocket.all.push(this); queueMicrotask(() => this.onopen?.()); }
 send(data: string) { this.sent.push(data); if (data.startsWith("rtt:")) queueMicrotask(() => this.onmessage?.({ data: data.replace("rtt:", "rtt-echo:") })); }
 close() { this.closed = true; }
}
beforeEach(() => {
 vi.useFakeTimers(); stallRegistration = false; reads = 0; registered = []; slowSignal = undefined; finishSlow = undefined; FakeSocket.all = [];
 vi.stubGlobal("WebSocket", FakeSocket);
 vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
  if (url.endsWith("/my/instances")) {
   reads++;
   if (reads === 2) {
    slowSignal = init?.signal ?? undefined;
    if (mode === "fetch") return new Promise<Response>((resolve) => { finishSlow = resolve; });
    return new Response(new ReadableStream({ start(controller) { slowSignal?.addEventListener("abort", () => controller.error(slowSignal?.reason), { once: true }); } }));
   }
   return Response.json({ instances: [instance(FIRST), ...(reads >= 3 ? [instance(NEW)] : [])] });
  }
  if (url.endsWith("/runtime")) {
   registered.push(url.includes(NEW) ? NEW : FIRST);
   if (stallRegistration && url.includes(FIRST)) return new Promise<Response>(() => undefined);
  }
  return Response.json({ capabilities: [], token: "inert-relay", autoUpdate: false });
 });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function start() { await connectViaRelay([FIRST], "http://local.test", "runner-test", { pagsToken: "inert-test-token", apiBase: "https://api.test" }, false, true); }

describe("bounded membership/discovery IO", () => {
 it.each(["fetch", "body"] as const)("a hanging %s releases the membership queue and the next poll can discover an agent", async (stall) => {
  mode = stall; await start(); await vi.advanceTimersByTimeAsync(20_000);
  expect(reads).toBe(2);
  await vi.advanceTimersByTimeAsync(35_000);
  expect(reads).toBeGreaterThanOrEqual(3);
  expect(slowSignal?.aborted).toBe(true);
  expect(registered).toContain(NEW);
  expect(FakeSocket.all.some(ws => ws.url.includes(NEW))).toBe(true);
 });
 it("a stalled startup registration cannot permanently prevent registering later agents", async () => {
  stallRegistration = true;
  let started = false;
  const startup = connectViaRelay([FIRST, NEW], "http://local.test", "runner-test", { pagsToken: "inert-test-token", apiBase: "https://api.test" }).then(() => { started = true; });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(registered).toContain(NEW); expect(started).toBe(true); await startup;
 });
 it("cloud sync can run after a timed-out poll, and late old membership cannot detach its agents", async () => {
  mode = "fetch"; await start(); await vi.advanceTimersByTimeAsync(20_000);
  const first = FakeSocket.all.find(ws => ws.url.includes(FIRST))!;
  let answered = false;
  const control = first.onmessage?.({ data: JSON.stringify({ id: "sync-after-timeout", path: "/pags/membership/sync" }) }).then(() => { answered = true; });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(answered).toBe(true); await control;
  expect(registered).toContain(NEW);
  finishSlow?.(Response.json({ instances: [] })); await vi.advanceTimersByTimeAsync(0);
  expect(first.closed).toBe(false);
  expect(first.sent.map(text => { try { return JSON.parse(text); } catch { return {}; } })).toContainEqual(expect.objectContaining({ id: "sync-after-timeout", status: 200 }));
 });
});
