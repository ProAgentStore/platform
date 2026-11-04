import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import type { BrowserWebsiteAccess } from "../browser-website-access.js";
import { McpRuntime } from "../mcp-runtime.js";
import { ApplyBridge, type ApplyBridgeHost } from "./bridge.js";

it.each(["approved", "stopped", "revoked", "format"] as const)("styled upload keeps its checkpoint while preserving %s dispatch checks", async (outcome) => {
 let stopped = false;
 let website: BrowserWebsiteAccess = { mode: "ask_once", domains: [], rememberedDomains: ["fixture.test"] };
 const dir = mkdtempSync(join(tmpdir(), "pags-chooser-diagnostic-"));
 const artifact = join(dir, "resume.txt"); writeFileSync(artifact, "Synthetic resume fixture");
 const browser = await chromium.launch({ headless: true });
 const context = await browser.newContext();
 await context.route("https://fixture.test/**", (route) => route.fulfill({ contentType: "text/html", body: '<h1>Application</h1><button type="button" onclick="document.querySelector(\'#resume\').click()">Upload resume</button><input id="resume" type="file" accept=".txt" hidden><label>Name<input></label>' }));
 const page = await context.newPage(); const mcp = new McpRuntime();
 await mcp.start({ context, activePage: () => page });
 const checkpoints: unknown[] = [];
 const host: ApplyBridgeHost = {
  emit: () => undefined, pause: async () => "stopped", supervisorCheckpoint: async (c) => { checkpoints.push(c); return "continue"; },
  isAllowed: () => true, websiteAccess: () => website, grounding: () => "Synthetic resume fixture", artifactPath: () => ({ path: artifact, sha256: "a".repeat(64) }),
  overTime: () => false, isStopped: () => stopped, now: Date.now, limits: { maxMinutes: 20, maxPages: 30, maxActions: 300 }, mode: "fill_and_review",
 };
 mcp.setCallPolicy({ websiteAccess: host.websiteAccess, isCancelled: () => stopped });
 const bridge = new ApplyBridge(mcp, host);
 const text = (r: {content: Array<{text?:string}>}) => r.content.map((b) => b.text ?? "").join("\n");
 try {
  expect((await bridge.callTool("browser_navigate", { url: "https://fixture.test/apply" })).isError).not.toBe(true);
  const snapshot = text(await bridge.callTool("browser_snapshot"));
  const ref = snapshot.match(/button "Upload resume"[^\n]*\[ref=(\w+)\]/)?.[1]; expect(ref).toBeTruthy();
  await bridge.callTool("supervisor_checkpoint", { checkpointId: "initial", phase: "initial" });
  const clicked = await bridge.callTool("browser_click", { target: ref, action_intent: "edit_form" });
  expect(clicked.isError).not.toBe(true);
  expect(text(clicked)).toMatch(/file chooser/i);
  const snapshotAfter = await bridge.callTool("browser_snapshot");
  expect(snapshotAfter.isError).toBe(true); expect(text(snapshotAfter)).toMatch(/modal state/);
  const probe = await mcp.callTool("browser_evaluate", { function: "() => location.href" }, { internal: true });
  expect(probe.isError).toBe(true); expect(mcp.textOf(probe)).toMatch(/modal state/);
  expect(checkpoints).toHaveLength(1);
  if (outcome === "stopped") stopped = true;
  if (outcome === "revoked") website = { ...website, rememberedDomains: [], deniedDomains: ["fixture.test"] };
  if (outcome === "format") await page.locator("#resume").evaluate((el) => el.setAttribute("accept", ".pdf"));
  const uploaded = await bridge.callTool("upload_artifact", { kind: "resume" });
  if (outcome === "approved") expect(uploaded.isError).not.toBe(true);
  else expect(uploaded.isError).toBe(true);
  expect(await page.locator("#resume").evaluate((el) => (el as HTMLInputElement).files?.length)).toBe(outcome === "approved" ? 1 : 0);
  expect(checkpoints).toHaveLength(1);
  expect(bridge.uploaded.has("resume")).toBe(outcome === "approved");
  if (outcome === "approved") expect(mcp.pendingUploadId()).toBeNull();
 } finally { await mcp.stop(); await browser.close(); rmSync(dir, { recursive: true, force: true }); }
}, 60_000);

it("a pending chooser refuses misleading navigation success and can be explicitly cancelled before fresh navigation", async () => {
 const browser = await chromium.launch({ headless: true }); const context = await browser.newContext();
 await context.route("https://fixture.test/**", (route) => route.fulfill({ contentType: "text/html", body: '<h1>Next page</h1><input id="file" type="file">' }));
 const page = await context.newPage(); const mcp = new McpRuntime(); await mcp.start({ context, activePage: () => page });
 mcp.setCallPolicy({ websiteAccess: () => ({ mode: "allow_all", domains: [] }) });
 try {
  await mcp.callTool("browser_navigate", { url: "https://fixture.test/first" });
  const chooser = page.waitForEvent("filechooser"); await page.locator("#file").click(); await chooser;
  const navigated = await mcp.callTool("browser_navigate", { url: "https://fixture.test/second" });
  expect(navigated.isError).toBe(true); expect(mcp.textOf(navigated)).toContain("No navigation was dispatched"); expect(page.url()).toBe("https://fixture.test/first");
  const snapshot = await mcp.callTool("browser_snapshot");
  expect(snapshot.isError).toBe(true); expect(mcp.textOf(snapshot)).toMatch(/modal state/);
  const cancelled = await mcp.callTool("browser_file_upload", {});
  expect(cancelled.isError).not.toBe(true);
  expect((await mcp.callTool("browser_snapshot")).isError).not.toBe(true);
  expect((await mcp.callTool("browser_navigate", { url: "https://fixture.test/second" })).isError).not.toBe(true);
  expect(page.url()).toBe("https://fixture.test/second");
 } finally { await mcp.stop(); await browser.close(); }
}, 60_000);
