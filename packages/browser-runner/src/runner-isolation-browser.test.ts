import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalRunner } from "./runner.js";

describe("browser popup ownership with real Playwright tools (#1441)", () => {
	it("snapshot, action and reported page follow the same popup, then recover after browser closure", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pags-popup-"));
		vi.stubEnv("PAGS_RUNNER_CHROMIUM", "1");
		const server = createServer((request, response) => {
			response.setHeader("Content-Type", "text/html");
			response.end(request.url === "/popup" ? '<title>Popup</title><label>Popup name <input id="name"></label>' : '<title>Original</title><button onclick="window.open(\'/popup\')">Open popup</button><label>Original name <input id="name"></label>');
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No fixture port");
		const url = `http://127.0.0.1:${address.port}/`;
		const runner = new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: directory, headless: true });
		try {
			await runner.browserAct({ action: "navigate", url, screenshot: false });
			const original = runner.browsers.current.activePage!;
			const before = await runner.browserSnapshot();
			const button = before.snapshot.match(/button "Open popup"[^\n]*\[ref=(\w+)\]/)?.[1];
			expect(button).toBeTruthy();
			const opened = await runner.browserAct({ action: "click", ref: button, name: "Open popup", screenshot: false });
			expect(opened.url).toBe(`${url}popup`);
			const popup = runner.browsers.current.activePage!;
			const snapshot = await runner.browserSnapshot();
			expect(snapshot.url).toBe(popup.url());
			expect(snapshot.snapshot).toContain('textbox "Popup name"');
			expect(snapshot.snapshot).not.toContain('textbox "Original name"');
			const input = snapshot.snapshot.match(/textbox "Popup name"[^\n]*\[ref=(\w+)\]/)?.[1];
			await runner.browserAct({ action: "type", ref: input, name: "Popup name", text: "On the popup", screenshot: false });
			expect(await popup.locator("#name").inputValue()).toBe("On the popup");
			expect(await original.locator("#name").inputValue()).toBe("");
			const tools = await runner["getMcp"]();
			expect((await tools.callTool("browser_tabs", { action: "select", index: 0 })).isError).not.toBe(true);
			const switched = await runner.browserSnapshot();
			expect(switched.title).toBe("Original");
			expect(switched.snapshot).toContain('textbox "Original name"');
			expect(runner.browsers.current.activePage).toBe(original);
			await popup.context().close();
			expect(runner.browsers.current.context).toBeNull();
			await runner.browserAct({ action: "navigate", url, screenshot: false });
			expect((await runner.browserSnapshot()).title).toBe("Original");
			expect(runner.browsers.current.activePage).not.toBe(original);
		} finally {
			await runner.close();
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
			vi.unstubAllEnvs();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 120_000);
});
