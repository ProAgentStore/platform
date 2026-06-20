import { jsonText, text, type McpEnv, type TextResult } from "./http.js";

export const MCP_SCOPES = ["read", "write", "runtime", "destructive"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export interface SafetyContext {
	env: McpEnv;
	subject?: string;
	scopes?: string[] | null;
	readOnly?: boolean;
}

export function parseScopes(value: string | string[] | null | undefined): McpScope[] {
	if (!value) return [...MCP_SCOPES];
	const parts = Array.isArray(value) ? value : value.split(/[,\s]+/);
	const scopes = parts.filter((part): part is McpScope =>
		(MCP_SCOPES as readonly string[]).includes(part),
	);
	return scopes.length > 0 ? Array.from(new Set(scopes)) : [...MCP_SCOPES];
}

export function hasScope(ctx: SafetyContext, scope: McpScope): boolean {
	return parseScopes(ctx.scopes ?? null).includes(scope);
}

export async function requirePermission(
	ctx: SafetyContext,
	scope: McpScope,
	tool: string,
	input?: Record<string, unknown>,
): Promise<TextResult | null> {
	const readOnly = ctx.readOnly || ctx.env.MCP_READ_ONLY === "1";
	if (scope !== "read" && readOnly) {
		await audit(ctx, {
			tool,
			action: "denied",
			reason: "read_only",
			requiredScope: scope,
			input,
		});
		return text(`Error: ${tool} requires ${scope} permission, but MCP is in read-only mode.`);
	}
	if (!hasScope(ctx, scope)) {
		await audit(ctx, {
			tool,
			action: "denied",
			reason: "missing_scope",
			requiredScope: scope,
			scopes: ctx.scopes ?? null,
			input,
		});
		return text(`Error: ${tool} requires MCP scope "${scope}". Reconnect with that scope or use a token that allows it.`);
	}
	return null;
}

export async function requireConfirmation(
	ctx: SafetyContext,
	tool: string,
	confirm: string | undefined,
	expected: string,
	input?: Record<string, unknown>,
): Promise<TextResult | null> {
	if (confirm === expected) return null;
	await audit(ctx, {
		tool,
		action: "denied",
		reason: "missing_confirmation",
		expected,
		input,
	});
	return text(`Error: ${tool} requires confirm="${expected}".`);
}

export async function dryRun(
	ctx: SafetyContext,
	tool: string,
	action: string,
	input: Record<string, unknown>,
	wouldDo: unknown,
): Promise<TextResult> {
	const body = { dryRun: true, tool, action, wouldDo };
	await audit(ctx, { tool, action: "dry_run", input, result: body });
	return jsonText(body);
}

export async function audit(
	ctx: SafetyContext,
	event: Record<string, unknown>,
): Promise<void> {
	if (!ctx.env.OAUTH_KV || !ctx.subject) return;
	const now = new Date().toISOString();
	const key = `audit:${ctx.subject}:${now}:${crypto.randomUUID()}`;
	await ctx.env.OAUTH_KV.put(
		key,
		JSON.stringify({
			time: now,
			subject: ctx.subject,
			...(redact(event) as Record<string, unknown>),
		}),
		{ expirationTtl: 90 * 86_400 },
	);
}

export async function listAuditEvents(
	ctx: SafetyContext,
	limit = 50,
): Promise<unknown[]> {
	if (!ctx.env.OAUTH_KV || !ctx.subject) return [];
	const safeLimit = Math.max(1, Math.min(200, limit));
	const listed = await ctx.env.OAUTH_KV.list({
		prefix: `audit:${ctx.subject}:`,
		limit: safeLimit,
	});
	const rows = await Promise.all(
		listed.keys
			.sort((a, b) => b.name.localeCompare(a.name))
			.slice(0, safeLimit)
			.map(async (key) => {
				const raw = await ctx.env.OAUTH_KV?.get(key.name);
				if (!raw) return null;
				try {
					return JSON.parse(raw) as unknown;
				} catch {
					return { raw };
				}
			}),
	);
	return rows.filter((row) => row !== null);
}

function redact(value: unknown, depth = 0): unknown {
	if (depth > 8) return "[truncated]";
	if (typeof value === "string") {
		return value.length > 500 ? `${value.slice(0, 500)}...` : value;
	}
	if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
	if (!value || typeof value !== "object") return value;

	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (/token|secret|password|credential|authorization/i.test(key)) {
			out[key] = "[redacted]";
		} else {
			out[key] = redact(item, depth + 1);
		}
	}
	return out;
}
