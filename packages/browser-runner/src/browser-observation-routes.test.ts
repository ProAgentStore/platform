import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startRunnerServer } from "./server.js";
let server: Awaited<ReturnType<typeof startRunnerServer>>; let dir: string;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "browser-observe-")); server = await startRunnerServer({ host: "127.0.0.1", port: 0, dataDir: dir, token: "fixture", headless: true }); });
afterEach(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
const post = (path: string, body: unknown, instance = "owner-agent") => fetch(`${server.url}${path}`, { method: "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json", "X-PAGS-Instance-Id": instance }, body: JSON.stringify(body) });
it("returns unavailable without opening a browser and rejects another instance's task", async () => {
 const task = await server.runner.browsers.run("owner-agent", undefined, false, async () => server.runner.createTask({ type: "browser.task", input: {} }), false);
 const state = await post("/browser-state", { subjectKind: "runtime_task", subjectId: task.id });
 expect(state.status).toBe(200);
 expect(await state.json()).toMatchObject({ subject: { kind: "runtime_task", id: task.id }, current: false, availability: "unavailable" });
 expect(await server.runner.browsers.run("owner-agent", undefined, false, async () => server.runner.browsers.current.context, false)).toBeNull();
 for (const path of ["/browser-state", "/browser-calls"]) expect((await post(path, { subjectKind: "runtime_task", subjectId: task.id }, "different-agent")).status).toBe(403);
});
it("pages retained calls with an honest epoch and watermark using old or nested request shapes", async () => {
 const task = await server.runner.browsers.run("owner-agent", undefined, false, async () => {
  const task = server.runner.createTask({ type: "browser.task", input: {} });
  for (let i = 0; i < 5; i++) server.runner.browsers.current.calls.record({ subject: { kind: "runtime_task", id: task.id }, tool: "browser_snapshot", args: {}, startedAt: Date.now(), outcome: "ok", internal: false });
  return task;
 }, false);
 const first = await (await post("/browser-calls", { subjectKind: "runtime_task", subjectId: task.id, limit: 2 })).json() as { epoch: string; lastSeq: number; calls: unknown[] };
 expect(first).toMatchObject({ lastSeq: 2, latestSeq: 5, hasMore: true, epoch: expect.any(String) });
 expect(first.calls).toHaveLength(2);
 const next = await (await post("/browser-calls", { subject: { kind: "runtime_task", id: task.id }, afterSeq: 2, limit: 100 })).json();
 expect(next).toMatchObject({ epoch: first.epoch, lastSeq: 5, latestSeq: 5, hasMore: false });
});
