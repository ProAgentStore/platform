/**
 * The structured error an engine's own turn-end event carries, kept instead of flattened to a sentence (#1357).
 *
 * The runner used to reduce every failed turn to one printed line, and the cloud then guessed the meaning back with a regex
 * table (`workers/api/src/lib/engine-provider-error.ts`). Where the engine states the cause in a FIELD, that is a statement
 * of fact and a regex over its prose is a guess; this reads the field.
 *
 * ── What each engine really sends (captured, not assumed — the rest of this file leans on it)
 *
 *   Claude Code 2.1.322, stream-json `result`, a request with a rejected key:
 *     {"type":"result","is_error":true,"subtype":"success","api_error_status":401,"api_error_origin":"first_party",
 *      "terminal_reason":"api_error","result":"Invalid API key · Fix external API key",…}
 *   Note `subtype` is "success" EVEN THOUGH `is_error` is true, so the subtype says nothing about failure; the HTTP status does.
 *
 *   Codex 0.163.0 (`exec --json`): a rejected key prints `{"type":"error","message":"Reconnecting… unexpected status 401
 *   Unauthorized…"}` and ends `{"type":"turn.failed","error":{"message":"…"}}`. The error object holds ONLY `message`: the status is
 *   inside the sentence, not beside it.
 *
 *   Grok 1.0.62 (`--output-format streaming-json`), not signed in: `{"type":"error","message":"Not signed in…"}` and no `end`.
 *
 * So today only Claude states a cause structurally. Codex and Grok report nothing here, and the cloud falls back to its text
 * table for them — exactly as for Gemini and older CLIs. That is the honest state, not a gap to paper over with a second regex
 * table on this side. {@link statusFromErrorField} is the one tolerant door for an engine that LATER adds a numeric status field
 * to its error object: it reads a status only from an explicit field, never from prose, and anything it does not recognise is
 * "no structured error".
 *
 * Pure, with no I/O; every function takes the parsed event and returns data.
 */

/** What the provider's refusal means, in the vocabulary the cloud already acts on (`engine-provider-error.ts`). */
export type EngineErrorKind = "limit" | "transient" | "billing" | "auth";

/** A turn's cause, as the engine itself stated it. Carried on `lastTurn.error`. */
export interface EngineTurnError {
	kind: EngineErrorKind;
	/** Who stated it, e.g. `anthropic (claude)` — the same names the cloud's table uses, so a trace reads one vocabulary. */
	provider: string;
	/** The engine's own code for it (the HTTP status, as text). Absent when there was none. */
	code?: string;
	/** When a usage window reopens, epoch ms, when the engine said. Absent otherwise: never inferred. */
	resetsAt?: number;
}

/** The HTTP status → what it means for a run. 408/409-class and unlisted statuses mean nothing here (a 400 is the caller's own error). */
export function kindOfStatus(status: number): EngineErrorKind | null {
	if (status === 401 || status === 403) return "auth";
	if (status === 402) return "billing";
	if (status === 429) return "limit";
	if (status === 408 || status === 425 || (status >= 500 && status <= 599)) return "transient";
	return null;
}

function record(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** An explicit numeric HTTP status on an error object, under the field names engines use. Never read out of prose. */
export function statusFromErrorField(error: unknown): number | null {
	const e = record(error);
	if (!e) return null;
	for (const key of ["status", "status_code", "statusCode", "http_status", "httpStatus"]) {
		const v = e[key];
		if (typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599) return v;
	}
	return null;
}

/** A reset time the engine stated as epoch seconds or milliseconds, or null. Only an explicit field; a sentence is never parsed here. */
function resetOf(e: Record<string, unknown>): number | undefined {
	for (const key of ["resets_at", "resetsAt", "reset_at"]) {
		const v = e[key];
		if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
	}
	return undefined;
}

/**
 * The structured error of a turn that ended in failure, or undefined when the engine stated none.
 *
 * `raw` is the engine's own turn-end event, untouched (`turn_end.raw`). A turn that did not fail never carries one: a successful
 * `result` that happens to hold a status field is not an error.
 */
export function structuredTurnError(engine: "claude" | "codex" | "grok" | string, raw: unknown, failed: boolean): EngineTurnError | undefined {
	if (!failed) return undefined;
	const ev = record(raw);
	if (!ev) return undefined;
	const provider = PROVIDER_OF[engine] ?? engine;
	// Claude: `api_error_status` sits on the `result` event itself.
	if (engine === "claude" && typeof ev.api_error_status === "number" && Number.isInteger(ev.api_error_status)) {
		const kind = kindOfStatus(ev.api_error_status);
		return kind ? { kind, provider, code: String(ev.api_error_status), ...withReset(ev) } : undefined;
	}
	// Any engine: a numeric status on its error OBJECT, if one ever carries it.
	const err = record(ev.error);
	const status = statusFromErrorField(err);
	if (status !== null) {
		const kind = kindOfStatus(status);
		return kind ? { kind, provider, code: String(status), ...withReset(err as Record<string, unknown>) } : undefined;
	}
	return undefined;
}

function withReset(e: Record<string, unknown>): { resetsAt?: number } {
	const at = resetOf(e);
	return at === undefined ? {} : { resetsAt: at };
}

/** The provider names the cloud's table uses, so the structured record and a text match read the same. */
const PROVIDER_OF: Record<string, string> = {
	claude: "anthropic (claude)",
	codex: "openai (codex)",
	grok: "xai (grok)",
};
