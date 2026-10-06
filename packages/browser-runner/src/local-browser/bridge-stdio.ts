/**
 * The research CLI's only MCP server (#944): a stdio forwarder to the runner.
 *
 * Codex and Claude Code launch MCP servers as their own child processes, so the policy cannot live
 * in this process — it would be a second copy of the run's state. This file therefore holds NO
 * policy: it relays `tools/list` and `tools/call` to the runner's `POST /local-browser/bridge`,
 * where `BrowserBridge` decides everything. A run-scoped token authorizes it, and the runner
 * accepts that token for that one run and that one path only.
 *
 * `node:http` rather than `fetch`: a consent or captcha pause holds a call open for minutes, and
 * fetch's undici agent abandons a response that has not started within five.
 */
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface BridgeEndpoint {
	/** The runner's local base URL, e.g. http://127.0.0.1:4317. */
	url: string;
	runId: string;
	token: string;
}

/** Env var names the runtime sets on this process. */
export const BRIDGE_ENV = { url: "PAGS_BRIDGE_URL", runId: "PAGS_BRIDGE_RUN", token: "PAGS_BRIDGE_TOKEN" } as const;

export type BridgePost = (endpoint: BridgeEndpoint, body: Record<string, unknown>) => Promise<unknown>;

/** POST to the runner's bridge path and return the parsed JSON body. */
export const postToRunner: BridgePost = (endpoint, body) =>
	new Promise((resolve, reject) => {
		const payload = JSON.stringify({ ...body, runId: endpoint.runId });
		const req = request(
			`${endpoint.url.replace(/\/$/, "")}/local-browser/bridge`,
			{ method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), "X-Pags-Bridge-Token": endpoint.token } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(Buffer.from(c)));
				res.on("end", () => {
					try {
						const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
						if ((res.statusCode ?? 500) >= 400) reject(new Error(typeof parsed.error === "string" ? parsed.error : `runner answered ${res.statusCode}`));
						else resolve(parsed);
					} catch (err) {
						reject(err);
					}
				});
			},
		);
		req.on("error", reject);
		req.end(payload);
	});

/** The MCP server, wired to a runner endpoint. Exported so tests drive it without a real stdio. */
export function createBridgeServer(endpoint: BridgeEndpoint, post: BridgePost = postToRunner): Server {
	const server = new Server({ name: "pags_browser", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const res = (await post(endpoint, { op: "list" })) as { tools?: unknown[] };
		return { tools: (res.tools ?? []) as never };
	});
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		try {
			return (await post(endpoint, { op: "call", name: req.params.name, args: req.params.arguments ?? {} })) as never;
		} catch (err) {
			// The runner refusing or going away is a tool error the CLI can read, not a crash.
			return { content: [{ type: "text", text: `The research browser is unavailable: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
		}
	});
	return server;
}

async function main(): Promise<void> {
	const url = process.env[BRIDGE_ENV.url];
	const runId = process.env[BRIDGE_ENV.runId];
	const token = process.env[BRIDGE_ENV.token];
	if (!url || !runId || !token) {
		process.stderr.write("pags_browser: missing bridge environment; this server is started by the PAGS runner only\n");
		process.exit(2);
	}
	await createBridgeServer({ url, runId, token }).connect(new StdioServerTransport());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((err) => {
		process.stderr.write(`pags_browser: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	});
}
