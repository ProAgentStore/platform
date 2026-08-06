import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpRuntime } from "./mcp-runtime.js";
import { startTestJobServer, type TestJobServer } from "./test-job-server.js";

// Proves the runner can host the STANDARD @playwright/mcp server and drive a real browser
// entirely through its MCP tools — the foundation for replacing the hand-rolled action code.
describe("McpRuntime (standard @playwright/mcp)", () => {
	let server: TestJobServer;
	const mcp = new McpRuntime();

	beforeAll(async () => {
		server = await startTestJobServer(0);
		await mcp.start({ isolated: true, headless: true });
	}, 60_000);

	// An explicit budget, because HOOKS DO NOT INHERIT `testTimeout`. The integration
	// project sets 120s for tests, but vitest applies its own 10s default to
	// beforeAll/afterAll — so this teardown, which shuts a real browser down and
	// flushes its profile, was running on a budget meant for pure functions. It fit
	// on a quiet laptop and blew the 10s on CI. `beforeAll` above already had one;
	// this side was simply never given one.
	afterAll(async () => {
		await mcp.stop();
		await server.close();
	}, 60_000);

	it("advertises the standard browser_* tools", async () => {
		const names = (await mcp.listTools()).map((t) => t.name);
		expect(names).toContain("browser_snapshot");
		expect(names).toContain("browser_navigate");
		expect(names).toContain("browser_click");
		expect(names).toContain("browser_type");
	});

	it("navigates + snapshots + types via the standard tools, with refs", async () => {
		await mcp.callTool("browser_navigate", { url: server.jobUrl });
		const snap = mcp.textOf(await mcp.callTool("browser_snapshot", {}));
		expect(snap).toMatch(/\[ref=e\d+\]/); // ref-annotated, exactly like a direct Claude+PW session
		const m = snap.match(/textbox "Full name"[^\n]*\[ref=(e\d+)\]/);
		expect(m).toBeTruthy();
		const typed = await mcp.callTool("browser_type", { element: "Full name textbox", target: (m as RegExpMatchArray)[1], text: "Sergey Ivochkin" });
		expect(typed.isError ?? false).toBe(false); // the standard tool accepted + performed it
		// The field genuinely holds the value (read it back with the standard tool).
		const evalRes = mcp.textOf(await mcp.callTool("browser_evaluate", { function: "() => document.querySelector('input[name=fullName]').value" }));
		expect(evalRes).toContain("Sergey Ivochkin");
	}, 60_000);
});
