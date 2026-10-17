/** MCP reply helpers. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { callEvent, newCallRecord, withCallAudit } from "./call-audit.js";
import { apiCall, chatReplyText } from "./http.js";

describe("chatReplyText (#898)", () => {
	it("returns a finished reply as is", () => {
		expect(chatReplyText({ message: { content: "All done." } })).toBe("All done.");
	});

	it("says a reply that hit the output cap is not the whole answer", () => {
		const out = chatReplyText({ message: { content: "Step 1… step 4. O" }, truncated: true, notice: "⚠️ cut off at the 4,096-token length limit" });
		expect(out.startsWith("Step 1… step 4. O")).toBe(true);
		expect(out).toMatch(/cut off at the 4,096-token length limit/);
	});

	it("still marks the cut when an older API sends the flag without its notice", () => {
		expect(chatReplyText({ message: { content: "x" }, truncated: true })).toMatch(/not the whole answer/);
	});
});

describe("a tool call's API requests carry one request id, and its outcome event names it (#1135)", () => {
	afterEach(() => vi.unstubAllGlobals());
	const stubFetch = () => {
		const seen: Array<string | null> = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			seen.push(new Headers(init.headers).get("X-Request-Id"));
			return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
		});
		return seen;
	};

	it("every request inside one call sends the same mcp- id, and the call's event records it", async () => {
		const seen = stubFetch();
		const rec = newCallRecord("list_errors");
		await withCallAudit(rec, async () => {
			await apiCall("/v1/a");
			await apiCall("/v1/b");
		});
		expect(seen).toHaveLength(2);
		expect(seen[0]).toMatch(/^mcp-[0-9a-f-]{36}$/);
		expect(seen[1]).toBe(seen[0]);
		rec.ran = true;
		rec.result = { content: [{ type: "text", text: "Error: boom" }] };
		expect(callEvent(rec)).toMatchObject({ apiRequestId: seen[0] });
	});

	it("two calls get two ids; a request outside any call sends none and the API mints its own", async () => {
		const seen = stubFetch();
		await withCallAudit(newCallRecord("a"), () => apiCall("/v1/a"));
		await withCallAudit(newCallRecord("b"), () => apiCall("/v1/b"));
		await apiCall("/v1/c");
		expect(seen[0]).not.toBe(seen[1]);
		expect(seen[2]).toBeNull();
	});
});
