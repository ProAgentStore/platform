import { describe, expect, it } from "vitest";
import { extractToolResult } from "./mcp-result.js";

describe("extractToolResult — unwrapping the MCP content envelope", () => {
	it("parses JSON text content so pipelines can $ref fields off it", () => {
		const r = extractToolResult({ content: [{ type: "text", text: '{"session_id":"s-1","slug":"cafe"}' }] });
		expect(r.data).toEqual({ session_id: "s-1", slug: "cafe" });
		expect(r.isError).toBe(false);
	});

	it("keeps plain (non-JSON) text as a string", () => {
		expect(extractToolResult({ content: [{ type: "text", text: "done" }] }).data).toBe("done");
	});

	it("joins multiple text parts", () => {
		expect(extractToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }).data).toBe("a\nb");
	});

	it("prefers structuredContent when the server sends it", () => {
		const r = extractToolResult({ structuredContent: { id: 7 }, content: [{ type: "text", text: "ignored" }] });
		expect(r.data).toEqual({ id: 7 });
	});

	it("surfaces isError from the server", () => {
		expect(extractToolResult({ content: [{ type: "text", text: "nope" }], isError: true }).isError).toBe(true);
	});

	it("retains image blocks structurally without mixing their base64 into tool text", () => {
		const r = extractToolResult({ content: [{ type: "text", text: '{"session_id":"s-1"}' }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] });
		expect(r.data).toEqual({ session_id: "s-1" });
		expect(r.images).toEqual([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
	});
});
