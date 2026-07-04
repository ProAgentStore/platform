import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export interface McpRuntimeOptions {
	/** Attach to an already-running Chrome over CDP (version-agnostic). Preferred:
	 *  the runner launches the real-profile browser, @playwright/mcp drives it. */
	cdpEndpoint?: string;
	/** Or let @playwright/mcp launch a persistent profile itself. */
	userDataDir?: string;
	headless?: boolean;
	isolated?: boolean;
}

export interface McpToolResult {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

/**
 * Hosts the INDUSTRY-STANDARD `@playwright/mcp` server in the runner and an in-process
 * MCP client to drive it. Every browser action goes through the standard Playwright MCP
 * tools (browser_snapshot, browser_click, browser_type, browser_select_option,
 * browser_fill_form, browser_file_upload, …) — no hand-rolled browser code. When the lib
 * updates, we get its fixes for free. The cloud brain calls these same tools over the relay.
 */
export class McpRuntime {
	private server?: Server;
	private client?: Client;

	async start(opts: McpRuntimeOptions): Promise<void> {
		if (this.client) return;
		const browser = opts.cdpEndpoint
			? { cdpEndpoint: opts.cdpEndpoint }
			: { userDataDir: opts.userDataDir, isolated: opts.isolated, launchOptions: { headless: opts.headless ?? false } };
		// The runner is a trusted local process uploading the user's OWN résumé, which
		// lives under the runner's data dir (outside the CWD). Lift the file-root guard
		// (meant to stop an LLM reading arbitrary host files) so browser_file_upload can
		// attach it — the runner, not the model, chooses the path.
		this.server = await createConnection({ browser, allowUnrestrictedFileAccess: true });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await this.server.connect(serverTransport);
		this.client = new Client({ name: "pags-runner", version: "1.0.0" });
		await this.client.connect(clientTransport);
	}

	/** The standard Playwright MCP tool schemas — advertised to the cloud brain verbatim. */
	async listTools(): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
		const res = await this.client!.listTools();
		return res.tools as Array<{ name: string; description?: string; inputSchema: unknown }>;
	}

	async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
		return (await this.client!.callTool({ name, arguments: args })) as McpToolResult;
	}

	/** Text of the last tool result (the standard tools return their output as text content). */
	textOf(res: McpToolResult): string {
		return (res.content || []).map((c) => c.text ?? "").join("\n");
	}

	async stop(): Promise<void> {
		await this.client?.close().catch(() => undefined);
		await this.server?.close().catch(() => undefined);
		this.client = undefined;
		this.server = undefined;
	}
}
