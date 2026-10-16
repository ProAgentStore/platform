import { jsonText, text, type McpEnv, type TextResult } from "./http.js";
import { clipMarked } from "./clip-marked.js";
import {
	AUDIT_INDEX_PREFIX,
	AUDIT_LOSS_PREFIX,
	AUDIT_SPOOL_FIRST_DELAY_MS,
	AUDIT_SPOOL_MAX,
	AUDIT_SPOOL_PREFIX,
	AUDIT_SPOOL_TTL_SECONDS,
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
	/**
	 * The tool call in progress, when the host records one event per call (#1089, `call-audit.ts`).
	 * While it is open, `audit()` hands its event to the call instead of writing it, so a handler's
	 * own audit and the call's outcome become ONE row. Supplied by the host, like `correlation`.
	 */
	callAudit?: () => { finished: boolean; handlerEvents: Array<Record<string, unknown>> } | undefined;
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

/** The subject of a call event no identity could be resolved for (#1089) — filed cross-owner only. */
export const UNATTRIBUTED = "unattributed";

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
 * What an audit write did (#1084): `persisted` (both keys landed), `queued` (one landed and the other
 * is spooled for the API cron to finish), `lost` (nothing durable — logged and counted where KV still
 * answers), `skipped` (no ledger bound, or an anonymous call with no subject to file it under), or
 * `deferred` (handed to the open tool call, which writes it with its outcome — #1089).
 */
export type AuditWrite = "persisted" | "queued" | "lost" | "skipped" | "deferred";

/**
 * Record a tool call in the MCP audit log. BEST-EFFORT: it never throws (#885).
 *
 * Every write tool audits AFTER its write has landed, so an audit that threw turned a completed
 * action into a bare "tool call failed" — the caller then told its user a pin move had failed while
 * the pin was saved. The action's own result is what the caller must see; a lost audit entry is
 * logged and COUNTED (#1084), not surfaced in its place.
 */
export async function audit(
	ctx: SafetyContext,
	event: Record<string, unknown>,
): Promise<AuditWrite> {
	const call = ctx.callAudit?.();
	if (call && !call.finished) {
		call.handlerEvents.push(event);
		return "deferred";
	}
	return writeBestEffort(ctx, event, false);
}

/**
 * Write the ONE event that closes a tool call (#1089). Unlike a handler's `audit()`, a call with no
 * resolvable subject — no sign-in, or a `token` argument that does not verify — is still recorded,
 * as `subject: "unattributed"` in the cross-owner index only: it is evidence of a failed call, but it
 * belongs to no owner, so no owner's ledger may show it.
 */
export async function auditCallOutcome(ctx: SafetyContext, event: Record<string, unknown>): Promise<AuditWrite> {
	return writeBestEffort(ctx, event, true);
}

async function writeBestEffort(ctx: SafetyContext, event: Record<string, unknown>, unattributed: boolean): Promise<AuditWrite> {
	try {
		return await writeAudit(ctx, event, unattributed);
	} catch (e) {
		console.warn(JSON.stringify({ event: "mcp.audit_failed", tool: event.tool ?? null, error: e instanceof Error ? e.message : String(e) }));
		if (ctx.env.OAUTH_KV) await countAuditLoss(ctx.env.OAUTH_KV, Date.now());
		return "lost";
	}
}

async function writeAudit(ctx: SafetyContext, event: Record<string, unknown>, unattributed: boolean): Promise<AuditWrite> {
	const kv = ctx.env.OAUTH_KV;
	if (!kv) return "skipped";
	const resolved = await subjectFor(ctx);
	if (!resolved && !unattributed) return "skipped";
	const subject = resolved ?? UNATTRIBUTED;
	const ms = Date.now();
	// Minted ONCE (#1084): both keys, and any replay of a missing one, carry this id — so a
	// reconciled index holds the same event, never a second one.
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
		...(resolved ? {} : { attributed: false }),
	});
	// Two keys, one value: the owner's time-ordered index and the cross-owner one the admin
	// sweep reads (#1016). See `audit-ledger.ts` for why the time is inverted.
	const metadata = auditKeyMetadata(recorded);
	const keys = resolved ? [auditIndexKey(subject, ms, id), auditGlobalKey(subject, ms, id)] : [auditGlobalKey(subject, ms, id)];
	const settled = await Promise.allSettled(keys.map((k) => kv.put(k, value, { expirationTtl: AUDIT_TTL_SECONDS, metadata })));
	const missing = keys.filter((_, i) => settled[i].status === "rejected");
	if (missing.length === 0) return "persisted";
	if (missing.length === keys.length) throw (settled[0] as PromiseRejectedResult).reason;
	// One index has the event and the other does not. Record what is missing for the API cron to
	// re-put — same key, same value, same absolute expiry — rather than leaving the indexes to disagree.
	try {
		const pending = await kv.list({ prefix: AUDIT_SPOOL_PREFIX, limit: AUDIT_SPOOL_MAX });
		if (pending.keys.length >= AUDIT_SPOOL_MAX) throw new Error("spool_full");
		const record = {
			sink: "mcp_audit",
			id,
			payload: { keys: missing, value, expiration: Math.floor(ms / 1000) + AUDIT_TTL_SECONDS, metadata },
			attempts: 0,
			nextAt: ms + AUDIT_SPOOL_FIRST_DELAY_MS,
			createdAt: ms,
		};
		await kv.put(`${AUDIT_SPOOL_PREFIX}${id}`, JSON.stringify(record), { expirationTtl: AUDIT_SPOOL_TTL_SECONDS, metadata: { nextAt: record.nextAt, createdAt: ms } });
		return "queued";
	} catch (e) {
		console.warn(JSON.stringify({ event: "mcp.audit_partial_lost", tool: event.tool ?? null, missing: missing.length, error: e instanceof Error ? e.message : String(e) }));
		await countAuditLoss(kv, ms);
		return "lost";
	}
}

/** One more lost audit write today. Best-effort: when KV itself is down this is a floor, not the truth. */
async function countAuditLoss(kv: KVNamespace, ms: number): Promise<void> {
	try {
		const key = `${AUDIT_LOSS_PREFIX}${new Date(ms).toISOString().split("T")[0]}`;
		const n = Number((await kv.get(key)) ?? 0) || 0;
		await kv.put(key, String(n + 1), { expirationTtl: 30 * 86_400 });
	} catch {
		// Nothing left to write to; the console line is the record.
	}
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
