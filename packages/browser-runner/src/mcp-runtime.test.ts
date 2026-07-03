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

	afterAll(async () => {
		await mcp.stop();
		await server.close();
	});

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
