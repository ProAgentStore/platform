import { jsonText, text, type McpEnv, type TextResult } from "./http.js";
import { clipMarked } from "./clip-marked.js";
import {
	AUDIT_INDEX_PREFIX,
	AUDIT_TTL_SECONDS,
	type AuditPage,
	auditGlobalKey,
	auditIndexKey,
	auditKeyMetadata,
	readAuditPage,
} from "./audit-ledger.js";

export const MCP_SCOPES = ["read", "write", "runtime", "destructive"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** Default grant when a client requests no (valid) scope — e.g. a plain browser
 *  sign-in via mcp-remote. Everything EXCEPT `destructive`: read/write/runtime cover
 *  normal use, but delete-agent / overwrite-repo require an explicit `destructive`
 *  scope so they can never run on a default connection. */
const DEFAULT_SCOPES: McpScope[] = ["read", "write", "runtime"];

export interface SafetyContext {
	env: McpEnv;
	subject?: string;
	scopes?: string[] | null;
	readOnly?: boolean;
	/**
	 * Late-bound audit subject, for a caller that authenticated with a per-call `token`
	 * argument instead of an OAuth grant (#702).
	 *
	 * `subject` cannot be filled in eagerly there: the identity is inside a signed token that
	 * has to be verified, and verification is async while `SafetyResolver` — the shape ~100
	 * call sites across `coding-tools.ts`, `storage-tools.ts` and `instance-tools/shared.ts`
	 * consume — is synchronous. Making the resolver async would touch every one of them to
	 * change nothing about what they do. So the async part stays where it is already async:
	 * only `audit()` and `listAuditEvents()` await this, and only when `subject` is absent.
	 *
	 * The implementation MUST memoise, because one tool call audits more than once.
	 */
	resolveSubject?: () => Promise<string | undefined>;
	/**
	 * The MCP request this call answers (#1038): JSON-RPC `requestId` and `mcpSessionId`, written on
	 * every audit event so a caller whose reply was lost can find what its call did. Supplied by the
	 * host (`index.ts`, from `call-context.ts`), so this module stays import-free for vendoring.
	 */
	correlation?: () => { requestId?: string; mcpSessionId?: string } | undefined;
}

/** The audit subject: the OAuth grant's, or the one a `token` argument resolves to. Exported for
 *  `recent-instances.ts` (#787), which must key by the SAME identity the audit trail does. */
export async function subjectFor(ctx: SafetyContext): Promise<string | undefined> {
	if (ctx.subject) return ctx.subject;
	return ctx.resolveSubject ? await ctx.resolveSubject() : undefined;
}

export function parseScopes(value: string | string[] | null | undefined): McpScope[] {
	if (!value) return [...DEFAULT_SCOPES];
	const parts = Array.isArray(value) ? value : value.split(/[,\s]+/);
	const scopes = parts.filter((part): part is McpScope =>
		(MCP_SCOPES as readonly string[]).includes(part),
	);
	return scopes.length > 0 ? Array.from(new Set(scopes)) : [...DEFAULT_SCOPES];
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

/**
 * The longest string an audit event may carry (ADR 0004).
 *
 * An id is the unit: a uuid is 36 characters, a commit SHA 40, a slug or a repo path fewer, and
 * `/v1/instances/{uuid}/chat` about 50. 120 clears all of them with room to spare and still
 * catches prose — the 1,519-byte chat prompt, the file `content` on a refused write, the
 * objective handed to a loop.
 */
export const AUDIT_VALUE_MAX = 120;

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/**
 * Reduce an audited payload to identities and sizes (ADR 0004).
 *
 * The refusal and dry-run paths pass the caller's `input` VERBATIM while the success paths pick
 * their own fields, so the log kept the full text of a `write_agent_file` that was refused and
 * four bytes for the one that ran — the file we would not write is on the record and the file we
 * wrote is not (#701). Symmetry is restored by storing LESS, not more: a string too long to be an
 * identifier becomes a byte count under a `…Bytes` key, which is the shape the success paths
 * already chose by hand (`messageBytes`, `objectiveBytes`) and the vocabulary
 * `lib/connectors/mcp.ts` and `routes/tools.ts` settled on.
 *
 * It runs inside `audit()` rather than at the three helpers, so all ~75 call sites are covered
 * and a new one cannot opt out by not knowing about it.
 */
function summarize(value: unknown, depth = 0): unknown {
	if (depth > 8) return "[truncated]";
	if (typeof value === "string") {
		// A bare long string has no key to hang a `…Bytes` name off, so it states its own size.
		return value.length <= AUDIT_VALUE_MAX ? value : `[${byteLength(value)} bytes]`;
	}
	if (Array.isArray(value)) return value.map((item) => summarize(item, depth + 1));
	if (!value || typeof value !== "object") return value;

	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string" && item.length > AUDIT_VALUE_MAX) {
			out[`${key}Bytes`] = byteLength(item);
		} else {
			out[key] = summarize(item, depth + 1);
		}
	}
	return out;
}

/**
 * Record a tool call in the MCP audit log. BEST-EFFORT: it never throws (#885).
 *
 * Every write tool audits AFTER its write has landed, so an audit that threw turned a completed
 * action into a bare "tool call failed" — the caller then told its user a pin move had failed while
 * the pin was saved. The action's own result is what the caller must see; a lost audit entry is
 * logged, not surfaced in its place.
 */
export async function audit(
	ctx: SafetyContext,
	event: Record<string, unknown>,
): Promise<void> {
	try {
		await writeAudit(ctx, event);
	} catch (e) {
		console.warn(JSON.stringify({ event: "mcp.audit_failed", tool: event.tool ?? null, error: e instanceof Error ? e.message : String(e) }));
	}
}

async function writeAudit(ctx: SafetyContext, event: Record<string, unknown>): Promise<void> {
	const kv = ctx.env.OAUTH_KV;
	if (!kv) return;
	const subject = await subjectFor(ctx);
	if (!subject) return;
	const ms = Date.now();
	const id = crypto.randomUUID();
	// Summarise BEFORE redacting: `summarize` decides what is recorded at all, `redact`
	// masks what survives. The other order would run the value-shape regex over prose
	// that is about to be discarded, and would mask a secret into a string whose length
	// then decided whether the field was kept.
	const recorded = redact(summarize(event)) as Record<string, unknown>;
	// The identity fields are written LAST so an audited payload cannot overwrite them.
	const corr = ctx.correlation?.();
	const value = JSON.stringify({
		...recorded,
		...(corr?.requestId ? { requestId: corr.requestId } : {}),
		...(corr?.mcpSessionId ? { mcpSessionId: corr.mcpSessionId } : {}),
		id,
		time: new Date(ms).toISOString(),
		subject,
	});
	// Two keys, one value: the owner's time-ordered index and the cross-owner one the admin
	// sweep reads (#1016). See `audit-ledger.ts` for why the time is inverted.
	const options = { expirationTtl: AUDIT_TTL_SECONDS, metadata: auditKeyMetadata(recorded) };
	await Promise.all([
		kv.put(auditIndexKey(subject, ms, id), value, options),
		kv.put(auditGlobalKey(subject, ms, id), value, options),
	]);
}

/**
 * One page of the caller's own audit ledger, newest first (#1016). `cursor` is the previous
 * page's `nextCursor`; the prefix is always built from the caller's subject, so a cursor cannot
 * reach another owner's events. A storage failure throws rather than returning a short page.
 */
export async function listAuditEvents(
	ctx: SafetyContext,
	{ limit = 50, cursor, tool, receipt, requestId, mcpSessionId }: { limit?: number; cursor?: string; tool?: string; receipt?: string; requestId?: string; mcpSessionId?: string } = {},
): Promise<AuditPage | null> {
	if (!ctx.env.OAUTH_KV) return null;
	const subject = await subjectFor(ctx);
	if (!subject) return null;
	return readAuditPage(ctx.env.OAUTH_KV, {
		prefix: `${AUDIT_INDEX_PREFIX}${subject}:`,
		limit: Math.max(1, Math.min(200, limit)),
		cursor,
		tool,
		receipt,
		requestId,
		mcpSessionId,
	});
}

// Value shapes that look like a live secret even under an innocent key name.
const SECRET_VALUE = new RegExp(
	[
		"sk-(?:ant-)?[A-Za-z0-9_-]{16,}", // OpenAI / Anthropic
		"gh[pousr]_[A-Za-z0-9]{20,}", // GitHub tokens
		"xox[baprs]-[A-Za-z0-9-]{10,}", // Slack
		"AIza[0-9A-Za-z_-]{20,}", // Google API key
		"eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{4,}", // JWT
		"Bearer\\s+[A-Za-z0-9._-]{12,}", // bearer header
	].join("|"),
	"gi",
);

function redact(value: unknown, depth = 0): unknown {
	if (depth > 8) return "[truncated]";
	if (typeof value === "string") {
		const masked = value.replace(SECRET_VALUE, "[redacted]");
		// Marked with both lengths (#959): an audit entry read back must not pass for the whole value.
		return clipMarked(masked, 500);
	}
	if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
	if (!value || typeof value !== "object") return value;

	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (/token|secret|password|credential|authorization|auth|api[_-]?key|apikey|access[_-]?(code|token)|refresh[_-]?token|bearer|private[_-]?key|client[_-]?secret|cookie/i.test(key)) {
			out[key] = "[redacted]";
		} else {
			out[key] = redact(item, depth + 1);
		}
	}
	return out;
}
