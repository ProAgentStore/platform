import type { BrowserStateObservation, BrowserStateSnapshot } from "./browser-state-contract.js";
import type { BrowserToolDiagnostic } from "./browser-tool-recovery.js";
/**
 * One recorder at the runner's Playwright chokepoint (#1409) — every browser call the agent makes,
 * on every path, lands in one ordered, redacted, in-memory stream the cloud can pull.
 *
 * `McpRuntime.callTool` (mcp-runtime.ts) is the one place every caller already drives the browser
 * through — wrapping THERE, not in each of the ~40 call sites across the runner, is what makes
 * "every call is recorded" a structural fact rather than a convention a new caller could forget.
 *
 * ## Coverage matrix (#1409 acceptance) — every non-test `callTool` site, its subject source, its `internal` flag
 *
 * | File:line (approx)                              | Subject source                                   | internal |
 * |--------------------------------------------------|---------------------------------------------------|----------|
 * | local-apply/live-run-browser.ts (via runtime.ts)  | `local_apply_run`, set once per run               | false    |
 * | local-browser/runtime.ts (via live-run-browser)   | `local_browser_run`, set once per run             | false    |
 * | runner.ts callBrowserTool (navigate/type/click/…) | `runtime_task`, set from `/browser/act`'s taskId  | false    |
 * | runner.ts browserSnapshot                         | `runtime_task`, set from `/browser/snapshot`'s taskId | false |
 * | runner.ts readBackField/isChecked/evalJson        | whatever is current (same run)                    | true     |
 * | runner.ts dialog auto-clear (`browser_handle_dialog`) | whatever is current (same run)                | true     |
 * | local-browser/bridge.ts inspect()                 | whatever is current (same run)                    | true     |
 * | local-browser/bridge.ts refuse()                  | whatever is current (same run), via `refused()`   | n/a (outcome is "refused") |
 * | local-apply/bridge.ts inspect()                   | whatever is current (same run)                    | true     |
 * | local-apply/bridge.ts refuse()                    | whatever is current (same run), via `refused()`   | n/a (outcome is "refused") |
 * | local-apply/follow-tab.ts                         | whatever is current (same run)                    | false    |
 * | runner.ts commit-guard refusal (before Playwright) | `runtime_task`, via `refused()`                   | n/a (outcome is "refused") |
 * | runner.ts scroll (raw `page.mouse.wheel`, bypasses MCP) | `runtime_task`, via `recordExternal()`       | false, tool `page.scroll` |
 *
 * Chat-connector calls (`workers/api/src/lib/connectors/browser.ts`, reaching the runner through the
 * SAME `/browser/act`) have no subject source yet — that wiring is #1424, a separate ticket — so they
 * record with `subject: null`, same as any call made before a run has claimed the browser.
 *
 * ## What is kept, and what never is
 *
 * Per call: a sequence number, an opaque call id, the subject (or null), the tool name, a SAFE
 * summary of its arguments (element/role/ref, a URL reduced to origin+path, a typed value's LENGTH
 * only — never its content), when it started, how long it took, its outcome, and (bounded) an error
 * head. Redaction happens BEFORE the record is built, not as a later pass: nothing unsafe is ever
 * held, even in memory, even briefly.
 *
 * ## Storage
 *
 * In memory, per subject, capped at {@link BROWSER_CALL_CAP} — a long research or apply run must not
 * grow this without bound. Once a subject's stream is full, further calls are dropped (not stored)
 * and counted; `seq` keeps advancing regardless, so a puller's resume cursor is never stuck behind a
 * drop it cannot see. The no-subject stream (chat-path calls, or calls before a run sets one) is
 * never capped — per #1409's own acceptance, a call with no subject is never dropped. Everything here
 * is lost on a runner restart; there is no durability claim, and the cloud marks the gap it sees.
 */

export type BrowserCallOutcome = "ok" | "tool_error" | "thrown" | "refused";

/** The same closed vocabulary the cloud's `browser_run_artifacts` subjects use (#1063) — not imported (this
 *  module imports nothing, so it can be vendored), just the same three names on purpose. */
export const BROWSER_CALL_SUBJECT_KINDS = ["runtime_task", "local_browser_run", "local_apply_run"] as const;
export type BrowserCallSubjectKind = (typeof BROWSER_CALL_SUBJECT_KINDS)[number];
export const isBrowserCallSubjectKind = (v: unknown): v is BrowserCallSubjectKind => (BROWSER_CALL_SUBJECT_KINDS as readonly string[]).includes(v as string);

export interface BrowserCallSubject {
	kind: string;
	id: string;
}

export interface BrowserCallRecord {
	seq: number;
	callId: string;
	subject: BrowserCallSubject | null;
	tool: string;
	/** A safe summary — never raw typed text, page content, or a secret value. */
	args: Record<string, unknown>;
	startedAt: string;
	durationMs: number;
	outcome: BrowserCallOutcome;
	/** Bounded to 200 chars. Absent for a successful call. */
	errorHead?: string;
	/** Origin + path, when cheaply known from the call's own arguments — never a live page read. */
	urlAfter?: string;
	internal: boolean;
	browserState?: BrowserStateSnapshot;
	toolDiagnostic?: BrowserToolDiagnostic;
}

export interface BrowserCallsPage {
	epoch?: string;
	latestSeq?: number;
	hasMore?: boolean;
	calls: BrowserCallRecord[];
	lastSeq: number;
	dropped: number;
}

/** Per subject. A long-running research or apply call must not grow this without bound. */
export const BROWSER_CALL_CAP = 2000;

const NO_SUBJECT_KEY = "\0none";
const subjectKey = (subject: BrowserCallSubject | null): string => (subject ? `${subject.kind}:${subject.id}` : NO_SUBJECT_KEY);

interface CallStream {
	seq: number;
	dropped: number;
	records: BrowserCallRecord[];
	state?: BrowserStateObservation;
}

/** A page URL reduced to origin + path — no query, no fragment, no credentials. Empty-safe: never throws. */
function originPath(raw: unknown): string | undefined {
	if (typeof raw !== "string" || !raw) return undefined;
	try {
		const u = new URL(raw);
		if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
		return `${u.origin}${u.pathname}`;
	} catch {
		return undefined;
	}
}

/** Every string value a secret's value exactly equals, or contains, becomes its NAME instead — never the value. */
function maskSecrets(value: string, secrets: Readonly<Record<string, string>>): string {
	let out = value;
	for (const [name, secret] of Object.entries(secrets)) {
		if (!secret.length) continue;
		out = out.split(secret).join(`<secret>${name}</secret>`);
	}
	return out;
}

/**
 * The args summary #1409 asks for: tool-shape-aware, never a typed value or page content.
 *
 * `element` / `role` / `ref` / `target` are accessible-name/ref labels the agent already sees in its
 * own snapshot — not secret. `text` / `values` become a LENGTH, never their content. `url` becomes
 * origin + path. `function` (browser_evaluate) is code the runner itself wrote for an internal probe,
 * or never exists at all for an agent call (evaluate is refused to every agent) — its presence is
 * noted, never its body. Everything else is dropped: a tool this does not recognise still gets `tool`
 * and nothing else, which is the safe default, not a bug.
 */
export function summarizeCallArgs(args: Record<string, unknown>, secrets: Readonly<Record<string, string>> = {}): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length ? maskSecrets(v, secrets).slice(0, max) : undefined);
	if (str(args.element, 200) !== undefined) out.element = str(args.element, 200);
	if (str(args.role, 60) !== undefined) out.role = str(args.role, 60);
	if (str(args.ref, 100) !== undefined) out.ref = str(args.ref, 100);
	if (str(args.target, 100) !== undefined) out.target = str(args.target, 100);
	if (typeof args.text === "string") out.textLength = args.text.length;
	if (typeof args.url === "string") {
		let url = originPath(args.url);
		if (url) {
			for (const secret of Object.values(secrets)) if (secret) for (const value of new Set([secret, encodeURIComponent(secret)])) url = url.split(value).join("[REDACTED]");
			out.url = url;
		}
	}
	if (str(args.key, 40) !== undefined) out.key = str(args.key, 40);
	if (typeof args.time === "number") out.time = args.time;
	if (typeof args.accept === "boolean") out.accept = args.accept;
	if (str(args.action, 40) !== undefined) out.action = str(args.action, 40);
	if (typeof args.index === "number") out.index = args.index;
	if (Array.isArray(args.values)) out.valuesCount = args.values.length;
	if (Array.isArray(args.paths)) out.pathsCount = args.paths.length;
	if (typeof args.function === "string") out.hasFunction = true;
	if (typeof args.dx === "number") out.dx = args.dx;
	if (typeof args.dy === "number") out.dy = args.dy;
	return out;
}

/** What `callTool`/`refused`/`recordExternal` pass in — everything `record` needs to build one row. */
export interface RecordInput {
	subject: BrowserCallSubject | null;
	tool: string;
	args: Record<string, unknown>;
	secrets?: Readonly<Record<string, string>>;
	startedAt: number;
	outcome: BrowserCallOutcome;
	errorHead?: string;
	internal: boolean;
	browserState?: BrowserStateSnapshot;
	toolDiagnostic?: BrowserToolDiagnostic;
}

/** Tool errors may echo supplied text; apply the same value policy before keeping an error. */
function redactCallError(error: string, args: Record<string, unknown>, secrets: Readonly<Record<string, string>> = {}): string {
	let safe = maskSecrets(error, secrets);
	const values: unknown[] = [args.text, ...(Array.isArray(args.values) ? args.values : [])];
	if (Array.isArray(args.fields)) for (const field of args.fields) {
		if (field && typeof field === "object" && "value" in field) values.push(field.value);
	}
	for (const value of values) if (typeof value === "string" && value) safe = safe.split(value).join("[REDACTED]");
	return safe;
}

export class BrowserCallRecorder {
	readonly epoch = crypto.randomUUID();
	private readonly streams = new Map<string, CallStream>();

	constructor(private readonly cap: number = BROWSER_CALL_CAP) {}

	private streamFor(subject: BrowserCallSubject | null): CallStream {
		const key = subjectKey(subject);
		let stream = this.streams.get(key);
		if (!stream) {
			stream = { seq: 0, dropped: 0, records: [] };
			this.streams.set(key, stream);
		}
		return stream;
	}

	/** Build and store one record. Never throws — a recording failure must never fail the call it describes. */
	record(input: RecordInput): void {
		try {
			const stream = this.streamFor(input.subject);
			const seq = ++stream.seq;
			// The no-subject stream is never dropped (#1409 acceptance) — only a bound subject's stream caps.
			if (input.subject !== null && stream.records.length >= this.cap) {
				stream.dropped++;
				return;
			}
			const args = summarizeCallArgs(input.args, input.secrets);
			// `urlAfter` (#1409) is best-effort and cheap on purpose: whatever origin+path the summary
			// already reduced a `url` argument to (e.g. `browser_navigate`'s target) — never a live page
			// read, which would mean an extra call just to describe this one.
			const record: BrowserCallRecord = {
				seq,
				callId: crypto.randomUUID(),
				subject: input.subject,
				tool: input.tool,
				args,
				startedAt: new Date(input.startedAt).toISOString(),
				durationMs: Math.max(0, Date.now() - input.startedAt),
				outcome: input.outcome,
				...(input.errorHead ? { errorHead: redactCallError(input.errorHead, input.args, input.secrets).slice(0, 200) } : {}),
				...(typeof args.url === "string" ? { urlAfter: args.url } : {}),
				internal: input.internal,
				...(input.browserState ? { browserState: structuredClone(input.browserState) } : {}),
				...(input.toolDiagnostic ? { toolDiagnostic: { ...structuredClone(input.toolDiagnostic), message: redactCallError(input.toolDiagnostic.message, input.args, input.secrets), ...(input.toolDiagnostic.originalError ? { originalError: redactCallError(input.toolDiagnostic.originalError, input.args, input.secrets).slice(0, 2000) } : {}) } } : {}),
			};
			stream.records.push(record);
		} catch {
			// Recording is best-effort; the call it describes already happened either way.
		}
	}

	/** The calls after `afterSeq` for one subject, paged, with the subject's own cumulative drop count. */
	page(subject: BrowserCallSubject | null, afterSeq: number, limit = 100): BrowserCallsPage {
		const stream = this.streamFor(subject);
		const pending = stream.records.filter((r) => r.seq > afterSeq);
		const calls: BrowserCallRecord[] = [];
		const max = Math.max(1, Math.min(100, Math.floor(limit) || 100));
		let bytes = 0;
		for (const record of pending) {
			const size = new TextEncoder().encode(JSON.stringify(record)).byteLength;
			if (calls.length && (calls.length >= max || bytes + size > 256 * 1024)) break;
			calls.push(record); bytes += size;
		}
		const hasMore = calls.length < pending.length;
		return { calls, epoch: this.epoch, latestSeq: stream.seq, hasMore, lastSeq: hasMore ? calls.at(-1)!.seq : stream.seq, dropped: stream.dropped };
	}
	rememberState(subject: BrowserCallSubject, state: BrowserStateSnapshot): void {
		this.streamFor(subject).state = { subject: { ...subject }, epoch: this.epoch, capturedAt: new Date().toISOString(), current: false, availability: "available", state: structuredClone(state) };
	}
	state(subject: BrowserCallSubject, current = false): BrowserStateObservation {
		const saved = this.streamFor(subject).state;
		return saved ? { ...structuredClone(saved), current } : { subject: { ...subject }, epoch: this.epoch, capturedAt: new Date().toISOString(), current: false, availability: "unavailable" };
	}
}
