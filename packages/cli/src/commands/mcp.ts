import { spawn } from "node:child_process";
import { Command } from "commander";

export const DEFAULT_MCP_URL = "https://mcp.proagentstore.online/mcp";

export interface McpProxyOptions {
	url?: string;
}

export function buildMcpRemoteArgs(
	opts: McpProxyOptions,
	extraArgs: string[] = [],
): string[] {
	return ["-y", "mcp-remote", opts.url || DEFAULT_MCP_URL, ...extraArgs];
}

export async function runMcpProxy(
	opts: McpProxyOptions,
	extraArgs: string[] = [],
): Promise<void> {
	const child = spawn("npx", buildMcpRemoteArgs(opts, extraArgs), {
		stdio: "inherit",
		env: process.env,
	});

	await new Promise<void>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => {
			if (code && code !== 0) reject(new Error(`mcp proxy exited with code ${code}`));
			else resolve();
		});
	});
}

export const mcpCommand = new Command("mcp")
	.description("Run a local stdio proxy for the official ProAgentStore MCP server")
	.option("--url <url>", "Remote MCP endpoint", DEFAULT_MCP_URL)
	.argument("[args...]", "Extra arguments passed to mcp-remote")
	.action(async (args: string[], opts: McpProxyOptions) => {
		await runMcpProxy(opts, args);
	});
