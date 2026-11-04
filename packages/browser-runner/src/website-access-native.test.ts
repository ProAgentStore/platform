import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpRuntime } from "./mcp-runtime.js";
import { LocalRunner } from "./runner.js";
import type { BrowserWebsiteAccess } from "./browser-website-access.js";

const allowed = "https://allowed.test/form";
const other = "https://other.test/form";
describe("owner website policy at native browser dispatch", () => {
 let browser: Browser; let context: BrowserContext; let page: Page; let mcp: McpRuntime;
 let policy: BrowserWebsiteAccess; let request: ReturnType<typeof vi.fn>; let runner: LocalRunner; let dir: string;
 beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 60_000);
 beforeEach(async () => {
  context = await browser.newContext();
  await context.route("https://**/*", (route) => route.fulfill({ contentType: "text/html", body: '<h1>Form</h1><label>Name<input id="name"></label><button onclick="location.href=\'https://other.test/form\'">Continue</button>' }));
  page = await context.newPage();
  mcp = new McpRuntime(); await mcp.start({ context, activePage: () => page });
  policy = { mode: "ask_once", domains: ["allowed.test"] };
  request = vi.fn(async () => undefined);
  mcp.setCallPolicy({ websiteAccess: () => policy, requestWebsiteApproval: request, isDomainAllowed: () => false });
  dir = mkdtempSync(join(tmpdir(), "website-native-"));
  runner = new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: dir, headless: true });
  vi.spyOn(runner as never, "getActivePage").mockResolvedValue(page as never);
  vi.spyOn(runner as never, "getBrowserContext").mockResolvedValue(context as never);
  vi.spyOn(runner as never, "getMcp").mockResolvedValue(mcp as never);
 });
 afterEach(async () => { await mcp.stop(); await context.close(); rmSync(dir, { recursive: true, force: true }); });
 afterAll(async () => { await browser.close(); });
 async function ref() { const r = await mcp.callTool("browser_snapshot"); return mcp.textOf(r).match(/textbox "Name"[^\n]*\[ref=(\w+)\]/)?.[1]; }
 it("allow_all ignores legacy site gates but preserves non-web scheme refusal", async () => {
  policy = { mode: "allow_all", domains: [] };
  expect((await mcp.callTool("browser_navigate", { url: other })).isError).not.toBe(true);
  expect((await mcp.callTool("browser_type", { element: "Name", target: await ref(), text: "Synthetic" })).isError).not.toBe(true);
  expect(await page.locator("#name").inputValue()).toBe("Synthetic");
  expect((await mcp.callTool("browser_navigate", { url: "file:///etc/passwd" })).isError).toBe(true);
  expect(request).not.toHaveBeenCalled();
 });
 it("strict allowlist denies navigation and redirected reads without an owner prompt", async () => {
  policy = { mode: "allowlist", domains: ["allowed.test"] };
  expect((await mcp.callTool("browser_navigate", { url: other })).websiteAccess).toMatchObject({ decision: "deny", actionDispatched: false });
  expect(page.url()).toBe("about:blank");
  await page.goto(other);
  const result = await mcp.callTool("browser_snapshot");
  expect(result.websiteAccess).toMatchObject({ decision: "deny" });
  expect(mcp.textOf(result)).not.toContain('textbox "Name"');
  expect(request).not.toHaveBeenCalled();
 });
 it("late redirects block typing; approval never replays the paused action", async () => {
  await page.goto(allowed); const target = await ref(); await page.goto(other);
  request.mockImplementation(async () => { policy = { ...policy, rememberedDomains: ["other.test"] }; });
  const result = await mcp.callTool("browser_type", { element: "Name", target, text: "Synthetic" });
  expect(result.websiteAccess).toMatchObject({ decision: "ask", hostname: "other.test", actionDispatched: false });
  expect(await page.locator("#name").inputValue()).toBe("");
  expect((await mcp.callTool("browser_type", { element: "Name", target: await ref(), text: "Synthetic" })).isError).not.toBe(true);
  expect(await page.locator("#name").inputValue()).toBe("Synthetic");
 });
 it("generic snapshot and actions retain enforcement receipts on admission refusal", async () => {
  await page.goto(other);
  expect(await runner.browserSnapshot(undefined, policy)).toMatchObject({ snapshot: "", websiteAccess: { decision: "ask" }, commitGuard: { dispatchSafe: true } });
  expect(await runner.browserAct({ action: "scroll", dy: 100 }, undefined, undefined, undefined, policy)).toMatchObject({ ok: false, websiteAccess: { actionDispatched: false }, commitGuard: { dispatchSafe: true } });
  expect(await runner.browserAct({ action: "navigate", url: allowed }, undefined, undefined, undefined, policy)).toMatchObject({ ok: true });
 });
 it("browser.open parks before dispatch and resumes only the exact approved website request", async () => {
  const task = runner.createTask({ type: "browser.open", input: { url: other } }, policy);
  const paused = await runner.approveTask(task.id, policy);
  expect(paused).toMatchObject({ status: "needs_human", output: { websiteAccess: { decision: "ask", actionDispatched: false } } });
  const block = (paused.output as { websiteAccess: { pauseKey: string } }).websiteAccess;
  expect(page.url()).toBe("about:blank");
  const allowedPolicy = { ...policy, rememberedDomains: ["other.test"] };
  await expect(runner.resumeWebsiteAccess(task.id, "wrong", "allow", allowedPolicy)).rejects.toThrow(/current pause/);
  expect((await runner.resumeWebsiteAccess(task.id, block.pauseKey, "allow", allowedPolicy)).status).toBe("completed");
  expect(page.url()).toBe(other);
  await expect(runner.resumeWebsiteAccess(task.id, block.pauseKey, "allow", allowedPolicy)).rejects.toThrow(/No approved/);
 });
 it("a remembered denial settles an opening request without navigation", async () => {
  const task = runner.createTask({ type: "browser.open", input: { url: other } }, policy);
  const paused = await runner.approveTask(task.id);
  const block = (paused.output as { websiteAccess: { pauseKey: string } }).websiteAccess;
  expect((await runner.resumeWebsiteAccess(task.id, block.pauseKey, "deny", { ...policy, deniedDomains: ["other.test"] })).status).toBe("failed");
  expect(page.url()).toBe("about:blank");
 });
 it("post-dispatch browser.open permission inspects the same page without replaying navigation", async () => {
  let visits = 0;
  await context.route(allowed, (route) => { visits++; return route.fulfill({ contentType: "text/html", body: `<script>setTimeout(() => location.href = "${other}", 0)</script>` }); });
  const goto = page.goto.bind(page);
  vi.spyOn(page, "goto").mockImplementation(async (...args) => { const response = await goto(...args); await page.waitForURL(other); return response; });
  const task = runner.createTask({ type: "browser.open", input: { url: allowed } }, policy);
  const paused = await runner.approveTask(task.id);
  expect(paused, JSON.stringify(paused)).toMatchObject({ status: "needs_human", output: { websiteAccess: { actionDispatched: true } } });
  const block = (paused.output as { websiteAccess: { pauseKey: string } }).websiteAccess;
  expect((await runner.resumeWebsiteAccess(task.id, block.pauseKey, "allow", { ...policy, rememberedDomains: ["other.test"] })).status).toBe("completed");
  expect(visits).toBe(1);
 });
 it("closing the redirected held page cannot turn a website pause into blank-page success", async () => {
  await context.route(allowed, (route) => route.fulfill({ contentType: "text/html", body: `<script>setTimeout(() => location.href = "${other}", 0)</script>` }));
  const goto = page.goto.bind(page);
  vi.spyOn(page, "goto").mockImplementation(async (...args) => { const response = await goto(...args); await page.waitForURL(other); return response; });
  const task = runner.createTask({ type: "browser.open", input: { url: allowed } }, policy);
  const paused = await runner.approveTask(task.id);
  const block = (paused.output as { websiteAccess: { pauseKey: string } }).websiteAccess;
  await page.close();
  await expect(runner.resumeWebsiteAccess(task.id, block.pauseKey, "allow", { ...policy, rememberedDomains: ["other.test"] })).rejects.toThrow(/unavailable/);
  expect(runner.store.getTask(task.id)?.status).toBe("needs_human");
 });
 it("a scroll-triggered redirect returns no unapproved page content", async () => {
  await page.goto(allowed);
  vi.spyOn(page.mouse, "wheel").mockImplementation(async () => { await page.goto(other); });
  const response = await runner.browserAct({ action: "scroll", dy: 100 }, undefined, undefined, undefined, policy);
  expect(response).toMatchObject({ ok: false, title: "", websiteAccess: { decision: "ask", actionDispatched: true } });
  expect(response.screenshot).toBeUndefined();
 });

 it("taskless connector calls honor freshly supplied owner modes", async () => {
  await page.goto(other);
  expect(await runner.browserSnapshot(undefined, { mode: "allowlist", domains: [] })).toMatchObject({ websiteAccess: { decision: "deny" } });
  expect((await runner.browserSnapshot(undefined, { mode: "allow_all", domains: [] })).websiteAccess).toBeUndefined();
  expect(await runner.browserSnapshot(undefined, policy)).toMatchObject({ websiteAccess: { decision: "ask" } });
 });
 it("an approved task retains its trusted policy across a runner restart", async () => {
  const task = runner.createTask({ type: "browser.open", input: { url: other, _pagsWebsitePolicy: { mode: "allow_all", domains: [] } } }, policy);
  const restarted = new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: dir, headless: true });
  expect((await restarted.approveTask(task.id)).status).toBe("needs_human");
  expect(restarted.store.getTask(task.id)?.output).toMatchObject({ websiteAccess: { decision: "ask", hostname: "other.test" } });
  expect(page.url()).toBe("about:blank");
 });

});
