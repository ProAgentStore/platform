import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchCdpBrowser } from "./local-apply/live-run-browser.js";
import { startTestJobServer, type TestJobServer } from "./test-job-server.js";

// Proves the runner can host the STANDARD @playwright/mcp server and drive a real browser
// entirely through its MCP tools — the foundation for replacing the hand-rolled action code.
// #1419/#1431: every browser is launched BY the runner (`launchCdpBrowser` retains its
// compatibility name, now supplying the native context). MCP never launches the browser.
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
		expect(typed.isError ?? false, launched.mcp.textOf(typed)).toBe(false); // keep the tool's actual failure diagnosis
		// The field genuinely holds the value (read it back with the standard tool).
		const evalRes = launched.mcp.textOf(await launched.mcp.callTool("browser_evaluate", { function: "() => document.querySelector('input[name=fullName]').value" }));
		expect(evalRes).toContain("Sergey Ivochkin");
	}, 60_000);

	// #1409: the recorder wraps `callTool` itself, so every one of these real calls — through the
	// SAME `launched.mcp` the test above drove by hand — is recorded with no per-call wiring here.
	it("records every call made through this one chokepoint, under the subject that claimed it, with no typed value kept", async () => {
		launched.mcp.setSubject({ kind: "local_apply_run", id: "run-1409" });
		await launched.mcp.callTool("browser_navigate", { url: server.jobUrl });
		const snap = launched.mcp.textOf(await launched.mcp.callTool("browser_snapshot", {}));
		const m = snap.match(/textbox "Full name"[^\n]*\[ref=([\w]+)\]/);
		const ref = (m as RegExpMatchArray)[1];
		await launched.mcp.callTool("browser_type", { element: "Full name textbox", target: ref, text: "a leaked value nobody should record" });
		launched.mcp.refused("browser_run_code", { code: "1" }, "scripts are refused");

		const page = launched.mcp.pullCalls({ kind: "local_apply_run", id: "run-1409" }, 0);
		expect(page.calls.map((c) => c.tool)).toEqual(["browser_navigate", "browser_snapshot", "browser_type", "browser_run_code"]);
		expect(page.calls.map((c) => c.outcome)).toEqual(["ok", "ok", "ok", "refused"]);
		expect(page.calls.at(-1)?.errorHead).toBe("scripts are refused");
		const dump = JSON.stringify(page.calls);
		expect(dump).not.toContain("leaked value");
		expect(page.calls[2].args.textLength).toBe("a leaked value nobody should record".length);

		// A different subject sees none of this — the streams are genuinely separate (the no-subject
		// stream is shared with the test above, which never sets one, so it is not asserted empty here).
		expect(launched.mcp.pullCalls({ kind: "local_apply_run", id: "run-OTHER" }, 0).calls).toEqual([]);
	}, 60_000);
});
