/**
 * The CLI-side forwarder holds no policy (#944): it relays list and call to the runner, and turns a
 * runner failure into a tool error the CLI can read.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { type BridgePost, createBridgeServer } from "./bridge-stdio.js";

async function connect(post: BridgePost) {
	const server = createBridgeServer({ url: "http://127.0.0.1:1", runId: "r1", token: "t" }, post);
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(b);
	const client = new Client({ name: "test", version: "1" });
	await client.connect(a);
	return client;
}

describe("bridge-stdio", () => {
	it("relays tools/list and tools/call to the runner, with the run id", async () => {
		const seen: unknown[] = [];
		const client = await connect(async (endpoint, body) => {
			seen.push({ runId: endpoint.runId, ...body });
			return body.op === "list" ? { tools: [{ name: "browser_navigate", inputSchema: { type: "object" } }] } : { content: [{ type: "text", text: "ok" }] };
		});
		expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["browser_navigate"]);
		expect(await client.callTool({ name: "browser_navigate", arguments: { url: "https://a.com" } })).toMatchObject({ content: [{ text: "ok" }] });
		expect(seen).toEqual([{ runId: "r1", op: "list" }, { runId: "r1", op: "call", name: "browser_navigate", args: { url: "https://a.com" } }]);
	});

	it("turns a runner failure into a tool error, not a crash", async () => {
		const client = await connect(async (_e, body) => {
			if (body.op === "list") return { tools: [] };
			throw new Error("Unauthorized");
		});
		expect(await client.callTool({ name: "browser_snapshot", arguments: {} })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/unavailable: Unauthorized/) }] });
	});
});
