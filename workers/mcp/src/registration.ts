import type { TextResult } from "./http.js";
import { titleFor } from "./tool-metadata.js";

/**
 * The ONE place every tool registration passes through.
 *
 * Two jobs, both of which have to be done at REGISTRATION time rather than per handler:
 *
 * 1. **The operator-suspension gate (#273).** The bug it closes was a hole in a per-handler
 *    check: the GitHub-backed tools (scaffold, repo files, deploy) never call the API, so
 *    they never met `requireUser`, and `agent_deploy_status` took no token at all. Adding
 *    one more line to seven handlers would fix those seven and leave the eighth tool — the
 *    one nobody has written yet — exactly as exposed. Wrapping the registrar means a tool
 *    cannot opt out of the gate, including everything `registerInstanceTools` /
 *    `registerStorageTools` register and anything added later in any file.
 *
 * 2. **Tool metadata** (#561). Every call site uses the SDK's tuple overload,
 *    `tool(name, description, shape, cb)`, which the SDK froze at protocol 2025-03-26:
 *    "Support for this style is frozen … Future additions to tool definition should *NOT*
 *    be added" (`@modelcontextprotocol/sdk` `dist/esm/server/mcp.js:665-667`). On that path
 *    `outputSchema` is declared and never assigned, and `title` is unreachable. So a server
 *    that registers through it can never publish anything the spec added after that date,
 *    however many call sites it edits.
 *
 *    Translating the tuple into a `registerTool(name, config, cb)` call HERE moves all 135
 *    registrations onto the current path at once, and gives one seam where per-tool
 *    metadata is merged in. The call sites stay exactly as they are.
 *
 * The handler is always the last function argument across every `tool(...)` overload
 * (name+cb, name+desc+cb, name+desc+schema+cb), so it is found by scanning from the end
 * rather than by assuming an arity.
 */

type AnyFn = (...args: unknown[]) => unknown;

/** What this module needs of an `McpServer` — the real one, or a test double. */
export interface RegistrationTarget {
	tool: (...args: unknown[]) => unknown;
	registerTool: (name: string, config: Record<string, unknown>, cb: AnyFn) => unknown;
}

export interface RegistrationOptions {
	/** Returns a refusal to answer with INSTEAD of running the tool, or null to proceed.
	 *  `provided` is the caller's own `token` argument when it passed one. */
	gate: (name: string, provided?: string) => Promise<TextResult | null>;
	/** Per-tool metadata merged into the registration config (annotations, output schema). */
	metadata?: (name: string) => Record<string, unknown> | undefined;
}

export function installRegistrationPipeline(
	server: RegistrationTarget,
	opts: RegistrationOptions,
): void {
	const registerTool = server.registerTool.bind(server);
	server.tool = (...args: unknown[]) => {
		let i = args.length - 1;
		while (i >= 0 && typeof args[i] !== "function") i--;
		const name = typeof args[0] === "string" ? args[0] : null;
		if (i < 0 || !name) {
			// Not a shape this pipeline understands. Registering it unchanged would skip the
			// suspension gate, so refuse loudly instead of quietly publishing an ungated tool.
			throw new Error("mcp: tool registration without a name or a handler");
		}
		const handler = args[i] as AnyFn;
		const gated = async (...handlerArgs: unknown[]) => {
			// A tool may carry its own `token` argument (acting as someone other than the
			// connection), so gate the identity the handler will actually use, not just
			// the connection's.
			const first = handlerArgs[0] as { token?: unknown } | undefined;
			const provided = typeof first?.token === "string" ? first.token : undefined;
			const blocked = await opts.gate(name, provided);
			return blocked ?? handler(...handlerArgs);
		};

		const description = typeof args[1] === "string" ? (args[1] as string) : undefined;
		// The zod raw shape, if this call site passed one: the last object between the
		// description and the handler.
		let inputSchema: Record<string, unknown> | undefined;
		for (let j = 1; j < i; j++) {
			const arg = args[j];
			if (typeof arg === "object" && arg !== null) inputSchema = arg as Record<string, unknown>;
		}

		return registerTool(
			name,
			{
				title: titleFor(name),
				...(description === undefined ? {} : { description }),
				...(inputSchema === undefined ? {} : { inputSchema }),
				...(opts.metadata?.(name) ?? {}),
			},
			gated,
		);
	};
}
