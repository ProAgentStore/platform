/**
 * Deprecated tool names that stay callable for a grace period (#1243).
 *
 * #1241's audit found four pairs that call the SAME API route under two names. The survivors keep
 * their names; each old name becomes an alias with the survivor's input schema and handler, and every
 * reply carries a note naming the survivor. It is registered through `server.tool` like any other
 * tool, so the registration seam gates it and the per-call ledger records the ALIAS name — which is
 * how the removal decision gets its evidence: `admin_mcp_audit summarize` shows whether anything still
 * calls it.
 */
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";

/** When the aliases may be removed: 90 days after they were introduced, if the ledger shows no calls. */
export const DEPRECATED_ALIAS_REMOVAL_DATE = "2027-01-18";

/** A registered tool an alias can be pointed at: its name, its zod raw shape and its handler. */
export interface AliasTarget {
	name: string;
	shape: Record<string, unknown>;
	handler: (args: never, extra: never) => unknown;
}

type ToolRegistrar = (name: string, description: string, shape: Record<string, unknown>, handler: (...a: never[]) => unknown) => unknown;

/** Register a tool and keep what an alias needs to forward to it. Same call, same typing, as `server.tool`. */
export function registerAliasTarget<S extends ZodRawShape>(server: McpServer, name: string, description: string, shape: S, handler: ToolCallback<S>): AliasTarget {
	server.tool(name, description, shape, handler);
	return { name, shape, handler: handler as unknown as AliasTarget["handler"] };
}

/** The line every alias reply ends with. */
export function deprecationNote(canonical: string): string {
	return `⚠️ This tool name is deprecated — use \`${canonical}\` instead. It takes the same arguments and returns the same result; this name will be removed after ${DEPRECATED_ALIAS_REMOVAL_DATE} (#1243).`;
}

/** The handler's result with the deprecation note appended as one more text block. */
export function withDeprecationNote(result: unknown, canonical: string): unknown {
	const r = result as { content?: unknown[] } | null;
	if (!r || !Array.isArray(r.content)) return result;
	return { ...r, content: [...r.content, { type: "text", text: deprecationNote(canonical) }] };
}

/** Register `alias` as a deprecated name for `target`: its schema, its handler, and the note. */
export function registerDeprecatedAlias(server: McpServer, alias: string, target: AliasTarget): void {
	(server.tool as unknown as ToolRegistrar)(
		alias,
		`Deprecated alias for ${target.name} (#1243): the same arguments, the same handler, the same result, plus a note. Call ${target.name} instead — this name is removed after ${DEPRECATED_ALIAS_REMOVAL_DATE}.`,
		target.shape,
		async (args: never, extra: never) => withDeprecationNote(await target.handler(args, extra), target.name),
	);
}
