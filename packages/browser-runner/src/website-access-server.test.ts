import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startRunnerServer } from "./server.js";
let server: Awaited<ReturnType<typeof startRunnerServer>>; let dir: string;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "website-http-")); server = await startRunnerServer({ host: "127.0.0.1", port: 0, dataDir: dir, headless: true, token: "fixture" }); });
afterEach(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
const post = (path: string, body: unknown, trusted = false) => fetch(`${server.url}${path}`, { method: "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json", ...(trusted ? { "X-PAGS-Website-Policy": "1" } : {}) }, body: JSON.stringify(body) });
it("generic browser actions ignore a spoofed body policy and receive only marked reserved owner metadata", async () => {
 const act = vi.spyOn(server.runner, "browserAct").mockResolvedValue({ ok: true, url: "", title: "", challenge: null, commitGuard: { supported: true, dispatchSafe: true }, completedOutcome: true });
 const policy = { mode: "allowlist", domains: ["allowed.test"] };
 expect((await post("/browser/act", { action: "scroll", browserWebsiteAccess: { mode: "allow_all", domains: [] }, _pagsBrowserWebsiteAccess: policy })).status).toBe(200);
 expect(act.mock.calls[0][4]).toBeUndefined();
 expect((await post("/browser/act", { action: "scroll", _pagsBrowserWebsiteAccess: policy }, true)).status).toBe(200);
 expect(act.mock.calls[1][4]).toEqual(policy);
});
it.each(["localApply", "localBrowser"] as const)("%s resume overrides body policy with trusted owner policy", async (runtime) => {
 const resume = vi.spyOn(server.runner[runtime], "resume").mockReturnValue({ runId: "run-1", status: "running" } as never);
 const route = runtime === "localApply" ? "/local-apply/resume" : "/local-browser/resume";
 const body = { runId: "run-1", browserWebsiteAccess: { mode: "allow_all", domains: [] }, expectedWebsitePauseKey: "pause-1" };
 expect((await post(route, body)).status).toBe(200);
 expect(resume.mock.calls[0][0]).toMatchObject({ runId: "run-1", browserWebsiteAccess: undefined });
 const owner = { mode: "ask_once", domains: [], rememberedDomains: ["allowed.test"] };
 expect((await post(route, { ...body, _pagsBrowserWebsiteAccess: owner }, true)).status).toBe(200);
 expect(resume.mock.calls[1][0]).toMatchObject({ browserWebsiteAccess: owner, expectedWebsitePauseKey: "pause-1" });
});
