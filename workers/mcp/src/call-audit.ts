/**
 * One audit event per MCP tool call, whatever happened to it (#1089).
 *
 * Before this, the ledger held whatever each handler chose to write: most mutation handlers audited
 * success only, a returned error left no row (or a `completed` row with `ok:false`), a suspension
 * refusal bypassed the handler and so its audit, a schema-validation failure never reached a handler
 * at all, and a thrown handler surfaced only as latency telemetry. The caller whose reply was lost
 * could not find out from `mcp_audit_log` why a call failed — only, sometimes, that one succeeded.
 *
 * Now the registration pipeline opens a {@link CallAuditRecord} for every call (at the `tools/call`
 * boundary when the real SDK server is underneath, so validation failures are seen too), and closes it
 * with ONE event whose `action` is the call's outcome:
 *
 *  - `completed` — the tool returned a non-error result. A receipt for the TOOL CALL, not for the
 *    engine turn, run or deploy it started (`receiptOf: "tool_call"`).
 *  - `dry_run` — previewed; nothing changed.
 *  - `denied` — refused before acting: suspension, missing scope, read-only, confirmation, sign-in.
 *  - `failed` — the tool RETURNED an error (an `Error:` text, a JSON `error`, `isError`), or reported it did
 *    not succeed (`success: false`, or a handler audit with `result.ok === false` — a nested tool's refusal, #1118).
 *  - `error` — the handler THREW; whatever it started may or may not have landed.
 *  - `invalid_input` — the SDK rejected the call before the handler ran (schema, unknown tool).
 *  - `unknown` — the tool could not confirm whether its write landed (`outcome:"unknown"`).
 *
 * The handlers' own `audit()` calls during the call are ABSORBED into that event (their `input` /
 * `result` / `reason` are kept), so a mutation leaves one row, not a `completed` row from the handler
 * plus another from here. Metadata only (ADR 0004): failure reasons come from a fixed vocabulary and
 * an error's `name`, never its message, a response body or the caller's argument values.
 *
 * Successful read-only calls are the one thing not written: they change nothing, and a polling client
 * (a terminal capture every few seconds) would otherwise turn the ledger into a read log at two KV
 * writes a poll. Their failures, denials and gate fail-opens ARE written.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type CallOutcome = "completed" | "dry_run" | "denied" | "failed" | "error" | "invalid_input" | "unknown";

export interface CallAuditRecord {
	tool: string;
	startedAt: number;
	/** A handler run has taken this record (the outer `tools/call` layer opens it before the handler exists). */
	claimed: boolean;
	finished: boolean;
	readOnly: boolean;
	/** The caller's own `token` argument, so the event is filed under the identity the handler used. */
	provided?: string;
	/** Top-level argument NAMES and the instance the call was about — never argument values. */
	argKeys?: string[];
	/** The full number of argument names, present only when `argKeys` was cut. */
	argCount?: number;
	instanceId?: string;
	/** `audit()` events the handler wrote during this call, absorbed rather than written. */
	handlerEvents: Array<Record<string, unknown>>;
	gate?: { check: "passed" | "unverified" | "denied"; reason?: string };
	ran: boolean;
	thrown?: string;
	result?: unknown;
	/** What the SDK finally answered — differs from `result` when it rejected the call or the output. */
	final?: unknown;
	/** The last non-2xx HTTP status the platform API answered during this call. */
	upstreamStatus?: number;
}

const store = new AsyncLocalStorage<CallAuditRecord>();

export function newCallRecord(tool: string, readOnly = false): CallAuditRecord {
	return { tool, startedAt: Date.now(), claimed: false, finished: false, readOnly, handlerEvents: [], ran: false };
}

export function withCallAudit<T>(record: CallAuditRecord, fn: () => T): T {
	return store.run(record, fn);
}

export function currentCallAudit(): CallAuditRecord | undefined {
	return store.getStore();
}

/** The suspension gate's verdict, noted on the call it gated. */
export function noteGate(check: "passed" | "unverified" | "denied", reason?: string): void {
	const rec = store.getStore();
	if (rec) rec.gate = { check, ...(reason ? { reason } : {}) };
}

/** A platform API call made during the open call answered non-2xx (`http.ts`). */
export function noteUpstreamStatus(status: number): void {
	const rec = store.getStore();
	if (rec) rec.upstreamStatus = status;
}

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ID = /^[A-Za-z0-9._:-]{1,120}$/;

/** What may be recorded about the arguments: their names, and the instance id the call targeted. */
export function noteArguments(rec: CallAuditRecord, args: unknown): void {
	if (!args || typeof args !== "object" || Array.isArray(args)) return;
	const names = Object.keys(args).filter((k) => SAFE_NAME.test(k));
	// Names are labels, capped so a caller cannot inflate the record; `argCount` says when the list is cut.
	rec.argKeys = names.slice(0, 30);
	if (names.length > rec.argKeys.length) rec.argCount = names.length;
	const id = (args as { instance_id?: unknown }).instance_id;
	if (typeof id === "string" && ID.test(id)) rec.instanceId = id;
}

export interface Verdict {
	action: CallOutcome;
	failureClass?: "denied" | "invalid_input" | "exception" | "upstream" | "returned_error" | "protocol" | "unconfirmed";
	reason?: string;
}

function textOf(result: unknown): string | undefined {
	const content = (result as { content?: Array<{ type?: string; text?: unknown }> } | undefined)?.content;
	const t = Array.isArray(content) ? content[0]?.text : undefined;
	return typeof t === "string" ? t : undefined;
}

const UNKNOWN_REASONS = new Set(["deadline-exceeded", "gateway-error", "transport-error"]);

/** What a RETURNED result says about the call — without keeping any of its text. */
export function classifyReturn(result: unknown): Verdict {
	if (!result || typeof result !== "object") return { action: "completed" };
	const body = textOf(result);
	if (body !== undefined && /^\s*\{/.test(body)) {
		try {
			const parsed = JSON.parse(body) as { outcome?: unknown; error?: unknown; success?: unknown; confirmation?: { reason?: unknown } };
			if (parsed && typeof parsed === "object") {
				if (parsed.outcome === "unknown") {
					const r = parsed.confirmation?.reason;
					return { action: "unknown", failureClass: "unconfirmed", reason: typeof r === "string" && UNKNOWN_REASONS.has(r) ? r : "unconfirmed" };
				}
				if (parsed.error) return errorVerdict(typeof parsed.error === "string" ? parsed.error : "", "error_field");
				// A refusal answered as HTTP 200 `{success:false}` with no `error` (#1118): the tool said no.
				if (parsed.success === false) return { action: "failed", failureClass: "returned_error", reason: "success_false" };
			}
		} catch {
			// Not JSON after all: judged as text below.
		}
	}
	if (body !== undefined && /^Error\b/.test(body)) return errorVerdict(body, "error_text");
	if ((result as { isError?: unknown }).isError === true) return { action: "failed", failureClass: "returned_error", reason: "is_error" };
	return { action: "completed" };
}

/** The reason a returned error carries, reduced to a fixed vocabulary. */
function errorVerdict(message: string, fallback: string): Verdict {
	if (/authentication required/i.test(message)) return { action: "denied", failureClass: "denied", reason: "auth_required" };
	if (/account is suspended/i.test(message)) return { action: "denied", failureClass: "denied", reason: "suspended" };
	const api = /\bAPI (\d{3})\b/.exec(message);
	if (api) return { action: "failed", failureClass: "upstream", reason: `api_${api[1]}` };
	return { action: "failed", failureClass: "returned_error", reason: fallback };
}

/** An SDK refusal that happened before (or instead of) the handler, from its fixed message prefixes. */
function protocolVerdict(final: unknown): Verdict {
	const body = textOf(final) ?? "";
	if (/Input validation error/.test(body)) return { action: "invalid_input", failureClass: "invalid_input", reason: "invalid_arguments" };
	if (/Output validation error/.test(body)) return { action: "failed", failureClass: "protocol", reason: "output_validation" };
	if (/Tool \S+ not found/.test(body)) return { action: "invalid_input", failureClass: "invalid_input", reason: "unknown_tool" };
	if (/Tool \S+ disabled/.test(body)) return { action: "invalid_input", failureClass: "invalid_input", reason: "tool_disabled" };
	return { action: "failed", failureClass: "protocol", reason: "protocol_error" };
}

export function decide(rec: CallAuditRecord): Verdict {
	if (!rec.ran && rec.gate?.check !== "denied") return protocolVerdict(rec.final);
	if (rec.thrown) return { action: "error", failureClass: "exception", reason: rec.thrown };
	if (rec.gate?.check === "denied") return { action: "denied", failureClass: "denied", reason: rec.gate.reason ?? "gate" };
	const denied = rec.handlerEvents.find((e) => e.action === "denied");
	if (denied) return { action: "denied", failureClass: "denied", reason: typeof denied.reason === "string" ? denied.reason : "denied" };
	if (rec.handlerEvents.some((e) => e.action === "dry_run")) return { action: "dry_run" };
	const returned = classifyReturn(rec.result);
	// A returned error whose text did not carry the status still had one: the API's answer, noted by `http.ts`.
	if (returned.action === "failed" && returned.failureClass === "returned_error" && rec.upstreamStatus) return { action: "failed", failureClass: "upstream", reason: `api_${rec.upstreamStatus}` };
	if (returned.action !== "completed") return returned;
	// The handler judged the result itself and said it failed (#1118): a nested tool's `{success:false}`
	// audits as `result.ok: false` (`auditOk`), and a paged reply need not carry `success` at its top level.
	if (rec.handlerEvents.some((e) => (e.result as { ok?: unknown } | undefined)?.ok === false)) return { action: "failed", failureClass: "returned_error", reason: "success_false" };
	const last = rec.handlerEvents.at(-1)?.action;
	if (last === "unknown" || last === "unconfirmed") return { action: "unknown", failureClass: "unconfirmed", reason: "unconfirmed" };
	if (last === "failed") return { action: "failed", failureClass: "returned_error", reason: "handler_failed" };
	// The handler returned fine but the SDK still answered with an error: its output was rejected.
	if ((rec.final as { isError?: unknown } | undefined)?.isError === true) return protocolVerdict(rec.final);
	return { action: "completed" };
}

/**
 * The plain-language line a reader gets with each outcome. Each stays within `AUDIT_VALUE_MAX` (120):
 * a longer string would be recorded as its byte count, like any other long value (ADR 0004).
 */
const EXPLAIN: Record<string, string> = {
	suspended: "Refused: this account is suspended. The tool did not run.",
	missing_scope: "Refused: the connection does not hold the scope this tool requires. The tool did not run.",
	read_only: "Refused: MCP is in read-only mode. The tool did not run.",
	missing_confirmation: "Refused: the exact confirm string was missing or wrong. Nothing was changed.",
	auth_required: "Refused: the call carried no usable sign-in. The tool did not run.",
	invalid_arguments: "Rejected before the tool ran: the arguments did not match its input schema (see argKeys).",
	unknown_tool: "Rejected: no tool by that name is registered on this connection.",
	tool_disabled: "Rejected: the tool is disabled on this connection.",
	output_validation: "The tool ran, but its result broke its output schema; the caller got a protocol error.",
	protocol_error: "The MCP server answered with a protocol error.",
	handler_failed: "The tool reported that its operation failed.",
	success_false: "The tool answered success:false — it refused or did not do what was asked.",
	is_error: "The tool returned an error result.",
	error_text: "The tool returned an error result.",
	error_field: "The tool returned an error result.",
};

export function explain(v: Verdict): string {
	switch (v.action) {
		case "completed":
			return "The tool call returned. Work it started (run, turn, deploy, task) is tracked by its own record.";
		case "dry_run":
			return "Dry run: nothing was changed.";
		case "error":
			return `The tool threw ${v.reason}; anything it had already sent may or may not have landed.`;
		case "unknown":
			return `The tool could not confirm its write landed (${v.reason}). Poll before retrying; not proof of failure.`;
		default:
			if (v.reason?.startsWith("api_")) return `The platform API answered HTTP ${v.reason.slice(4)}; the tool reported the failure.`;
			return (v.reason && EXPLAIN[v.reason]) || "The call did not complete.";
	}
}

/** Only a JS identifier-ish error name is recorded — never the message. */
export function errorName(err: unknown): string {
	const name = err instanceof Error ? err.name : "";
	return /^[A-Za-z]{1,40}$/.test(name) ? name : "Error";
}

/**
 * The one event for a finished call, or null when nothing is to be written (a successful read with
 * nothing absorbed and a gate that answered). Absorbed handler fields ride along; the identity and
 * outcome fields are written last so a handler payload cannot overwrite them.
 */
export function callEvent(rec: CallAuditRecord): Record<string, unknown> | null {
	const v = decide(rec);
	const gateUnverified = rec.gate?.check === "unverified";
	if (v.action === "completed" && rec.readOnly && rec.handlerEvents.length === 0 && !gateUnverified) return null;

	// The handler event that describes the call best: its refusal or preview if it wrote one, else its last.
	const events = rec.handlerEvents;
	const primary = events.find((e) => e.action === "denied" || e.action === "dry_run") ?? events.at(-1);
	const { tool: auditedAs, action: handlerAction, ...detail } = primary ?? {};
	const steps = events.filter((e) => e !== primary).map(({ tool: _t, ...rest }) => rest);
	const input = detail.input ?? { ...(rec.instanceId ? { instance_id: rec.instanceId } : {}), ...(rec.argKeys ? { argKeys: rec.argKeys } : {}), ...(rec.argCount ? { argCount: rec.argCount } : {}) };

	return {
		...detail,
		input,
		...(steps.length ? { steps } : {}),
		...(typeof auditedAs === "string" && auditedAs !== rec.tool ? { auditedAs } : {}),
		...(typeof handlerAction === "string" && handlerAction !== v.action ? { handlerAction } : {}),
		tool: rec.tool,
		action: v.action,
		...(v.failureClass ? { failureClass: v.failureClass } : {}),
		...(v.reason ? { reason: v.reason } : {}),
		// A fail-open gate is the thing to explain on a call that otherwise went fine.
		explanation: gateUnverified && v.action === "completed" ? `Suspension check failed (${rec.gate?.reason ?? "unverified"}); the call was allowed fail-open.` : explain(v),
		...(rec.gate ? { gate: rec.gate.check, ...(rec.gate.reason ? { gateReason: rec.gate.reason } : {}) } : {}),
		durationMs: Date.now() - rec.startedAt,
		receiptOf: "tool_call",
	};
}
