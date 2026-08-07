/**
 * Pure logic behind the Teamwork card — the agent-to-agent "pump" (#182).
 *
 * Kept out of the component for the usual reason, and one specific one: every interesting
 * failure of a chain is a QUIET failure. A routing predicate that can never match, a delivery
 * that exhausted its retries, a connection that has never carried anything — none of those
 * throw, and all of them look identical to "working" in a list of rows. The rules that turn
 * that silence into a sentence are the part worth testing, so they live here rather than
 * inside JSX where they can only be checked by clicking.
 */

export type FilterClause = { field: string; op: string; value?: unknown };

/** The routing-predicate vocabulary, mirroring FILTER_OPS in workers/api/src/lib/connections.ts. */
export const FILTER_OPS = ["eq", "ne", "contains", "in", "gt", "gte", "lt", "lte", "exists", "missing", "truthy", "falsy"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Ops that take no value, so the value box can disappear rather than be silently ignored. */
export const VALUELESS_OPS: ReadonlySet<string> = new Set(["exists", "missing", "truthy", "falsy"]);

/** Ops the server compares NUMERICALLY — both sides must be numbers or the clause is a
 *  guaranteed false (`evalClause`), which the create-time validator rejects outright. */
const NUMERIC_OPS: ReadonlySet<string> = new Set(["gt", "gte", "lt", "lte"]);

export interface Connection {
	id: string;
	eventType: string;
	targetInstanceId: string;
	action: string;
	config?: Record<string, unknown>;
	enabled?: boolean;
	createdAt?: string;
	/**
	 * What is wrong with this edge, phrased by the server (#363) — today, a `run_pipeline`
	 * connection naming a pipeline the target agent does not have. Server-owned rather than
	 * re-derived here for the reason #358 gives: the console must not be able to disagree with
	 * the validator in either direction, and only the server can see the target's pipelines.
	 */
	warnings?: string[];
}

export interface Delivery {
	id: string;
	connectionId?: string;
	/** 'connection' | 'trigger' — the outbox is shared (#17), so a row here is not
	 *  necessarily a connection's. Without this the log conflates two different problems. */
	source?: string | null;
	eventType?: string;
	action?: string;
	sourceInstanceId?: string;
	targetInstanceId?: string;
	status: string;
	attempts: number;
	nextAttemptAt?: string | null;
	lastError?: string | null;
	traceId?: string | null;
	createdAt?: string;
	updatedAt?: string;
}

/** How a piece of state should read: fine, worth a look, broken, or simply never used. */
export type Tone = "ok" | "warn" | "bad" | "idle";

// ── filters ──────────────────────────────────────────────────────────────────

/**
 * Read a connection's stored predicate. It is either a bare clause array (AND) or
 * `{where, any}` (OR when `any`) — the same two shapes the `filter` step accepts.
 */
export function readFilter(config: Record<string, unknown> | undefined): { clauses: FilterClause[]; any: boolean } {
	const raw = config?.filter;
	if (Array.isArray(raw)) return { clauses: raw.filter(isClause), any: false };
	if (raw && typeof raw === "object") {
		const f = raw as Record<string, unknown>;
		const where = Array.isArray(f.where) ? f.where.filter(isClause) : [];
		return { clauses: where, any: f.any === true };
	}
	return { clauses: [], any: false };
}

function isClause(v: unknown): v is FilterClause {
	return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as FilterClause).field === "string";
}

/** Render one clause the way a person would say it. */
export function describeClause(c: FilterClause): string {
	if (VALUELESS_OPS.has(c.op)) return `${c.field} ${c.op}`;
	const v = Array.isArray(c.value) ? c.value.join(" / ") : typeof c.value === "string" ? `"${c.value}"` : String(c.value);
	return `${c.field} ${c.op} ${v}`;
}

/**
 * One-line summary of a connection's routing filter. A wired predicate that is not displayed
 * is indistinguishable from a broken chain — the connection reads "enabled" while dropping
 * every event — so this is what makes the filter part of the row rather than part of a blob.
 * Empty string when there is no filter (the connection takes everything).
 */
export function describeFilter(config: Record<string, unknown> | undefined): string {
	const { clauses, any } = readFilter(config);
	if (!clauses.length) return "";
	return clauses.map(describeClause).join(any ? " or " : " and ");
}

/**
 * Turn a typed value into the JS type the predicate will actually compare against.
 *
 * The server's `eq`/`ne` are strict (`===`) and `in` uses `Array.includes`, so `rating eq 4`
 * typed into a text box arrives as the STRING "4", never equals the number 4 in the payload,
 * and drops every event while looking perfectly healthy. A quoted value is the escape hatch
 * for the opposite case (a postcode that must stay a string).
 */
export function parseLiteral(raw: string): unknown {
	const s = raw.trim();
	if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
	if (s === "true") return true;
	if (s === "false") return false;
	if (s === "null") return null;
	// Canonical numbers only: "4" and "4.5" become numbers, "007" and "1,000" stay strings
	// because they do not round-trip and were plainly meant as text.
	if (s !== "" && String(Number(s)) === s) return Number(s);
	return s;
}

/**
 * Coerce a raw text input for one op. Numeric ops force a number and `contains` forces a
 * string — the two cases the create-time validator rejects outright, which a text-only editor
 * could otherwise never satisfy. Everything else goes through {@link parseLiteral}.
 */
export function clauseValue(op: string, raw: string): unknown {
	if (VALUELESS_OPS.has(op)) return undefined;
	if (NUMERIC_OPS.has(op)) {
		const n = Number(raw.trim());
		// NaN is left as the raw string on purpose: the server then says "gte compares numbers"
		// rather than the UI silently inventing a 0 that quietly matches the wrong rows.
		return Number.isFinite(n) && raw.trim() !== "" ? n : raw.trim();
	}
	if (op === "contains") return raw;
	if (op === "in") {
		return raw
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean)
			.map(parseLiteral);
	}
	return parseLiteral(raw);
}

export interface ClauseDraft {
	field: string;
	op: string;
	value: string;
}

/** Build the clause array from the editor's rows, dropping any row with no field yet. */
export function buildClauses(drafts: ClauseDraft[]): FilterClause[] {
	const out: FilterClause[] = [];
	for (const d of drafts) {
		const field = d.field.trim();
		if (!field) continue;
		const clause: FilterClause = { field, op: d.op };
		if (!VALUELESS_OPS.has(d.op)) clause.value = clauseValue(d.op, d.value);
		out.push(clause);
	}
	return out;
}

export interface ConnectionConfigInput {
	action: string;
	pipeline?: string;
	clauses: ClauseDraft[];
	/** OR the clauses together instead of AND. */
	any?: boolean;
	/** Static params belonging to the WIRING, merged UNDER the event payload. */
	params?: Record<string, unknown>;
}

/**
 * Assemble a connection's `config`. A single AND-ed predicate is written in the bare-array
 * form (what every existing connection already stores); `any` switches to `{where, any}`
 * rather than emitting a shape the server would have to guess at.
 */
export function buildConnectionConfig(input: ConnectionConfigInput): Record<string, unknown> {
	const cfg: Record<string, unknown> = {};
	if (input.action === "run_pipeline" && input.pipeline?.trim()) cfg.pipeline = input.pipeline.trim();
	if (input.params && Object.keys(input.params).length) cfg.params = input.params;
	const clauses = buildClauses(input.clauses);
	if (clauses.length) cfg.filter = input.any ? { where: clauses, any: true } : clauses;
	return cfg;
}

// ── deliveries ───────────────────────────────────────────────────────────────

export interface DeliveryCounts {
	pending: number;
	delivered: number;
	dead: number;
	total: number;
}

/** Tally an outbox listing by status. Anything unrecognised still counts toward `total`. */
export function deliveryCounts(list: readonly Delivery[]): DeliveryCounts {
	const counts: DeliveryCounts = { pending: 0, delivered: 0, dead: 0, total: list.length };
	for (const d of list) {
		if (d.status === "pending") counts.pending++;
		else if (d.status === "delivered") counts.delivered++;
		else if (d.status === "dead") counts.dead++;
	}
	return counts;
}

/**
 * Parse a timestamp the API might hand back in either shape. SQLite's `datetime('now')`
 * has no timezone and JS reads it as LOCAL, which turns a retry due in one minute into one
 * due ten hours ago for a user at UTC+10 — the same normalisation the SDK's formatTime does.
 */
export function parseTs(iso: string | null | undefined): number | null {
	if (!iso) return null;
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso) ? `${iso.replace(" ", "T")}Z` : iso;
	const t = new Date(normalized).getTime();
	return Number.isNaN(t) ? null : t;
}

/** "in 4m" / "in 2h" / "due now" — the forward-looking twin of the SDK's "5m ago". */
export function countdown(iso: string | null | undefined, now: number = Date.now()): string {
	const t = parseTs(iso);
	if (t === null) return "";
	const diff = t - now;
	if (diff <= 0) return "due now";
	if (diff < 60_000) return "in <1m";
	if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`;
	if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
	return `in ${Math.round(diff / 86_400_000)}d`;
}

/** How many attempts remain before a pending delivery dead-letters. Mirrors MAX_ATTEMPTS. */
export const MAX_ATTEMPTS = 5;

/**
 * The one-line state of a delivery: what happened, and what happens next. "Pending" alone is
 * useless — the question is always whether it is coming back and when.
 */
export function describeDelivery(d: Delivery, now: number = Date.now()): { tone: Tone; text: string } {
	const tries = `${d.attempts} attempt${d.attempts === 1 ? "" : "s"}`;
	if (d.status === "delivered") return { tone: "ok", text: d.attempts > 1 ? `delivered after ${tries}` : "delivered" };
	if (d.status === "dead") return { tone: "bad", text: `gave up after ${tries} — replay when the cause is fixed` };
	if (d.status === "pending") {
		const when = countdown(d.nextAttemptAt, now);
		const left = Math.max(0, MAX_ATTEMPTS - d.attempts);
		if (!d.attempts) return { tone: "warn", text: when ? `queued, next attempt ${when}` : "queued" };
		return { tone: "warn", text: `${tries} failed, retrying${when ? ` ${when}` : ""} · ${left} left` };
	}
	return { tone: "idle", text: d.status };
}

/**
 * What a connection is ACTUALLY doing, from the deliveries it produced.
 *
 * The negative is the point. `deliverEvent` writes an outbox row only for a payload that
 * PASSES the routing filter, so a connection with a filter and no deliveries has never once
 * matched — the single failure mode that leaves a chain stopped while every row on screen
 * says "enabled". Pass the full recent log (all statuses); this narrows to one connection.
 */
export function connectionHealth(conn: Connection, deliveries: readonly Delivery[]): { tone: Tone; text: string } {
	if (conn.enabled === false) return { tone: "idle", text: "disabled — it routes nothing" };
	const mine = deliveries.filter((d) => d.connectionId === conn.id);
	const { pending, delivered, dead, total } = deliveryCounts(mine);
	if (dead) return { tone: "bad", text: `${dead} undelivered` };
	if (pending) return { tone: "warn", text: `${pending} retrying` };
	if (delivered) return { tone: "ok", text: `${delivered} delivered` };
	if (total) return { tone: "warn", text: `${total} in flight` };
	const filter = describeFilter(conn.config);
	if (filter) return { tone: "warn", text: "nothing has matched this filter yet" };
	return { tone: "idle", text: "no events yet" };
}

/**
 * The account-wide headline. A per-connection chip cannot say "something, somewhere, is
 * stuck" — and that is the question the outbox exists to answer.
 */
export function deliveryHeadline(counts: DeliveryCounts): { tone: Tone; text: string } {
	if (counts.dead) return { tone: "bad", text: `${counts.dead} event${counts.dead === 1 ? "" : "s"} never arrived` };
	if (counts.pending) return { tone: "warn", text: `${counts.pending} waiting to retry` };
	if (counts.total) return { tone: "ok", text: "every event reached its agent" };
	return { tone: "idle", text: "no events sent yet" };
}

/** Tailwind text colour per tone, so the same rule paints every chip in the card. */
export function toneClass(tone: Tone): string {
	return tone === "bad" ? "text-red" : tone === "warn" ? "text-yellow" : tone === "ok" ? "text-green" : "text-muted-soft";
}

/** One row of `GET /v1/instances/:id/tools` — only the fields this rule needs. */
export interface ToolVerdict {
	connector?: string;
	reason?: string;
}

/**
 * Can this agent delegate? (#354)
 *
 * The supervision GRAPH is instance-level and the ABILITY is agent-level, so a picker that
 * offers supervision on an agent with no delegation tool wires an edge that can never be used.
 * The route refuses it; this hides the editor, and the two must agree in BOTH directions — a
 * picker that offers nothing is fine, one that offers what the route rejects is not.
 *
 * Read off the tool listing rather than a copied list of tool names, because that listing already
 * carries each tool's `connector` from the registry the route checks against. A fifth supervision
 * tool therefore needs no change here.
 *
 * DECLARED, not `allowed`: an owner who switched the delegation tools off has not made the wiring
 * impossible, only paused it, and hiding their existing links would be the wrong answer.
 */
export function canDelegate(tools: readonly ToolVerdict[]): boolean {
	return tools.some((t) => t.connector === "supervision" && t.reason !== "not_declared");
}

/** The standing direction on a supervision edge — the Lead's epic for that one agent (#330). */
export interface Direction {
	text: string;
	/** Who put it there. Only the owner's carries authority — see `directionState`. */
	setBy: "user" | "agent";
	updatedAt?: string;
}

/** Mirrors MAX_DIRECTION_CHARS in workers/api/src/lib/agent-direction.ts. */
export const MAX_DIRECTION_CHARS = 600;

/**
 * What a row should SAY about its direction — and the reason the console shows `setBy` at all
 * rather than only the text.
 *
 * An agent-written direction is a PROPOSAL. It is durable, and the agent reads it back on later
 * turns, so a surface that rendered it identically to one the owner set would leave the owner no
 * way to notice that a repo's standing brief is text their agent lifted out of an issue body.
 * Confirming a proposal means the owner re-sending it through the one route that stamps
 * `setBy: "user"` — this label is where that choice becomes visible.
 */
export function directionState(direction: Direction | null | undefined): { tone: Tone; label: string } {
	if (!direction?.text) return { tone: "idle", label: "No direction set — this agent has no standing brief." };
	if (direction.setBy === "user") return { tone: "ok", label: "You set this. It is on the Lead's prompt every turn." };
	return { tone: "warn", label: "Proposed by the agent — it carries no authority until you confirm it." };
}
