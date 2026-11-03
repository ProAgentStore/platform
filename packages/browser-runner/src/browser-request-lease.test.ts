import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { BrowserSessions } from "./browser-sessions.js";
import { withBrowserRequest } from "./browser-request.js";
import type { LocalRunner } from "./runner.js";

describe("browser leases preserve dispatch retry receipts (#1441)", () => {
	it.each(["/local-browser/run", "/local-apply/run"])("%s accepts a known request without admitting another run", async (path) => {
		const browsers = new BrowserSessions("/unused-browser-fixture", true, () => false, () => true);
		const existing = { instanceId: "agent", runId: "run-1", requestId: "request-1" };
		const hasRequest = vi.fn((raw: typeof existing) => raw.instanceId === existing.instanceId && raw.requestId === existing.requestId);
		const runner = { browsers, localBrowser: { hasRequest }, localApply: { hasRequest }, store: { getTask: () => undefined } } as unknown as LocalRunner;
		const request = (requestId: string) => Object.assign(Readable.from([Buffer.from(JSON.stringify({ ...existing, requestId }))]), { method: "POST", url: path, headers: { "x-pags-instance-id": "agent" } }) as IncomingMessage;
		const execute = vi.fn(async () => ({ existing: true }));
		await expect(withBrowserRequest(runner, request("request-1"), execute)).resolves.toEqual({ existing: true });
		await expect(withBrowserRequest(runner, request("request-2"), execute)).rejects.toThrow(/still in use/);
		expect(execute).toHaveBeenCalledTimes(1);
	});
});
