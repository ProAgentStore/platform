import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchCdpBrowser } from "./local-apply/live-run-browser.js";
import { startTestJobServer, type TestJobServer } from "./test-job-server.js";

// Proves the runner can host the STANDARD @playwright/mcp server and drive a real browser
// entirely through its MCP tools — the foundation for replacing the hand-rolled action code.
// #1419: every browser is launched BY the runner (`launchCdpBrowser`, the same CDP-attach
// pattern every other path uses) — McpRuntime itself only ever attaches, never launches.
describe("McpRuntime (standard @playwright/mcp)", () => {
	let server: TestJobServer;
	let profileDir: string;
	let launched: Awaited<ReturnType<typeof launchCdpBrowser>>;

	beforeAll(async () => {
		server = await startTestJobServer(0);
		profileDir = mkdtempSync(join(tmpdir(), "pags-mcp-runtime-test-"));
		launched = await launchCdpBrowser(profileDir, true);
	}, 60_000);

	// An explicit budget, because HOOKS DO NOT INHERIT `testTimeout`. The integration
	// project sets 120s for tests, but vitest applies its own 10s default to
	// beforeAll/afterAll — so this teardown, which shuts a real browser down and
	// flushes its profile, was running on a budget meant for pure functions. It fit
	// on a quiet laptop and blew the 10s on CI. `beforeAll` above already had one;
	// this side was simply never given one.
	afterAll(async () => {
		await launched.stop();
		rmSync(profileDir, { recursive: true, force: true });
		await server.close();
	}, 60_000);

	it("advertises the standard browser_* tools", async () => {
		const names = (await launched.mcp.listTools()).map((t) => t.name);
		expect(names).toContain("browser_snapshot");
		expect(names).toContain("browser_navigate");
		expect(names).toContain("browser_click");
		expect(names).toContain("browser_type");
	});

	it("navigates + snapshots + types via the standard tools, with refs", async () => {
		await launched.mcp.callTool("browser_navigate", { url: server.jobUrl });
		const snap = launched.mcp.textOf(await launched.mcp.callTool("browser_snapshot", {}));
		expect(snap).toMatch(/\[ref=[\w]+\]/); // ref-annotated, exactly like a direct Claude+PW session
		const m = snap.match(/textbox "Full name"[^\n]*\[ref=([\w]+)\]/);
		expect(m).toBeTruthy();
		const typed = await launched.mcp.callTool("browser_type", { element: "Full name textbox", target: (m as RegExpMatchArray)[1], text: "Sergey Ivochkin" });
		expect(typed.isError ?? false).toBe(false); // the standard tool accepted + performed it
		// The field genuinely holds the value (read it back with the standard tool).
		const evalRes = launched.mcp.textOf(await launched.mcp.callTool("browser_evaluate", { function: "() => document.querySelector('input[name=fullName]').value" }));
		expect(evalRes).toContain("Sergey Ivochkin");
	}, 60_000);
});
