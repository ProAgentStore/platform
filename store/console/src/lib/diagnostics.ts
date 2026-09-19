/**
 * What is recurring, and how long has nobody fixed it (#823).
 *
 * ── The distinction this file exists to draw ──
 *
 * The durable error log collapses an identical repeat into a counter, but its bucket is capped at
 * ONE HOUR (`error-log.ts` `COLLAPSE_WINDOW_MS`). That is correct for a write-side dedupe and it
 * means a warning firing every few minutes for three days is roughly SEVENTY-TWO rows, each one
 * looking like a fresh incident with a modest count. #823 was filed after precisely that: a
 * commit-close-watch warning repeating for days across two repos, which the issue describes as
 * "buried as one row per hour".
 *
 * `GET /v1/errors/summary` groups those rows into signatures. What the grouping cannot say on its
 * own is the thing the owner actually wants to know, which is not "how many" but **"how long has
 * this been true"** — a signature seen 200 times in ten minutes is an incident, and one seen 200
 * times over four days is something nobody is looking at. Both read as a big number.
 *
 * So recurrence here is measured in TIME SPANNED, not in occurrences, and the two are reported
 * separately rather than folded into one score. Everything is pure, so "is this stale" is a tested
 * property of the data rather than a threshold buried in a component.
 */

// The producer's own declaration rather than a hand-copied twin (#608) — the same import direction
// `usageFigures.ts` uses for `PayerCoverage`, and for the same reason: a structural copy drifts
// silently, and the copy is always the one that is wrong.
import type { ErrorSignature, ErrorSummaryResponse } from "../../../../workers/api/src/lib/admin-errors";
export type { ErrorSignature, ErrorSummaryResponse };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * How long a signature has to have been recurring before it stops being an incident and starts
 * being something nobody addressed.
 *
 * A DAY, and the number is doing real work rather than being round. Below it, a burst is most
 * likely one event: a deploy, an outage, a bad run. At a day or more the thing has survived a
 * working session, a night, and whatever anyone did in between — which is the specific claim
 * "unaddressed" makes, and the specific claim the issue asked to be able to see.
 */
export const PERSISTENT_AFTER_MS = DAY_MS;

/** A signature seen this recently is still happening, not merely recorded. */
export const ACTIVE_WITHIN_MS = HOUR_MS;

/**
 * `once` — one occurrence. Not a pattern, and must not be dressed as one.
 * `recurring` — repeated, but inside a day: most likely one incident.
 * `persistent` — repeating across a day or more. THE #823 FLAG.
 */
export type Recurrence = "once" | "recurring" | "persistent";

export interface RecurrenceFacts {
	kind: Recurrence;
	/** First occurrence to last, in ms. Zero for a single occurrence. */
	spanMs: number;
	/** Since the most recent occurrence, in ms. Negative clock skew is clamped to 0. */
	sinceMs: number;
	/** Still being hit, as opposed to merely on record. */
	active: boolean;
}

const ms = (iso: string): number => {
	// D1 writes `YYYY-MM-DD HH:MM:SS` (no zone) and ISO strings appear too. Treat the bare form as
	// UTC, which is what `datetime('now')` wrote — parsing it as local time would shift every span
	// by the viewer's offset and turn a 23-hour span into a persistent one, or the reverse.
	const t = Date.parse(/[T ]/.test(iso) && !/[Z+]|\d-\d\d:\d\d$/.test(iso) ? `${iso.replace(" ", "T")}Z` : iso);
	return Number.isNaN(t) ? 0 : t;
};

export function recurrenceOf(sig: Pick<ErrorSignature, "count" | "firstSeen" | "lastSeen">, nowMs: number): RecurrenceFacts {
	const first = ms(sig.firstSeen);
	const last = ms(sig.lastSeen);
	const spanMs = Math.max(0, last - first);
	const sinceMs = Math.max(0, nowMs - last);
	const active = sinceMs <= ACTIVE_WITHIN_MS;
	// COUNT and SPAN are both required for `persistent`, and neither alone is enough. A single
	// occurrence spans nothing however old it is; a thousand occurrences in one minute span nothing
	// either, and calling that "unaddressed" would put the loudest incident of the day under the
	// label meant for the quiet thing nobody noticed.
	const kind: Recurrence = sig.count <= 1 ? "once" : spanMs >= PERSISTENT_AFTER_MS ? "persistent" : "recurring";
	return { kind, spanMs, sinceMs, active };
}

/** "3 days", "5 hours", "12 minutes" — one unit, never "3 days 2 hours". */
export function humanDuration(msSpan: number): string {
	if (msSpan < 60_000) return "less than a minute";
	const mins = Math.floor(msSpan / 60_000);
	if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
	const hours = Math.floor(msSpan / HOUR_MS);
	if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
	const days = Math.floor(msSpan / DAY_MS);
	return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The sentence beside a signature. States the SPAN and the recency as separate facts, because
 * "happening for 4 days" and "last seen 3 minutes ago" answer different questions and a reader
 * given only one of them will assume the other.
 */
export function describeRecurrence(sig: Pick<ErrorSignature, "count" | "rows" | "firstSeen" | "lastSeen">, nowMs: number): string {
	const f = recurrenceOf(sig, nowMs);
	const ago = f.sinceMs < 60_000 ? "just now" : `${humanDuration(f.sinceMs)} ago`;
	if (f.kind === "once") return `Once, ${ago}.`;
	const times = `${sig.count.toLocaleString()} times`;
	const span = `${times} over ${humanDuration(f.spanMs)}`;
	if (f.kind === "recurring") return `${span}, last ${ago}.`;
	// A persistent signature says WHICH it is. "Still happening" and "unaddressed" are different
	// findings — one needs looking at now, the other needs closing out — and a single phrase
	// covering both would make the page unable to tell them apart.
	return `${span} — ${f.active ? "still happening" : "unaddressed"}, last ${ago}.`;
}

/** Error signatures first, then persistent ones, then by occurrences. */
export function triageOrder(a: ErrorSignature, b: ErrorSignature, nowMs: number): number {
	const rank = (s: ErrorSignature) => {
		const f = recurrenceOf(s, nowMs);
		// A persistent ERROR outranks a persistent warn, and both outrank a loud one-off — the
		// ordering the issue asked for, where a thing repeating for days is not buried under
		// whatever happened most recently.
		return (s.level === "warn" ? 0 : 2) + (f.kind === "persistent" ? 1 : 0);
	};
	return rank(b) - rank(a) || b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : -1);
}

export interface DiagnosticsFilter {
	level?: "error" | "warn";
	source?: string;
	/** Only signatures that have been recurring for a day or more. */
	persistentOnly?: boolean;
}

export function filterSignatures(sigs: readonly ErrorSignature[], f: DiagnosticsFilter, nowMs: number): ErrorSignature[] {
	return sigs.filter((s) => {
		if (f.level && (s.level ?? "error") !== f.level) return false;
		if (f.source && s.source !== f.source) return false;
		if (f.persistentOnly && recurrenceOf(s, nowMs).kind !== "persistent") return false;
		return true;
	});
}

/** The sources present, most-affected first — the filter chips, derived rather than hardcoded. */
export function sourcesOf(sigs: readonly ErrorSignature[]): Array<{ source: string; count: number }> {
	const m = new Map<string, number>();
	for (const s of sigs) m.set(s.source, (m.get(s.source) ?? 0) + s.count);
	return [...m.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}

export interface DiagnosticsTotals {
	signatures: number;
	occurrences: number;
	errors: number;
	warnings: number;
	/** Signatures recurring for a day or more — the number the page leads with. */
	persistent: number;
}

export function totalsOf(sigs: readonly ErrorSignature[], nowMs: number): DiagnosticsTotals {
	let occurrences = 0;
	let errors = 0;
	let warnings = 0;
	let persistent = 0;
	for (const s of sigs) {
		occurrences += s.count;
		if ((s.level ?? "error") === "warn") warnings += 1;
		else errors += 1;
		if (recurrenceOf(s, nowMs).kind === "persistent") persistent += 1;
	}
	return { signatures: sigs.length, occurrences, errors, warnings, persistent };
}

/**
 * The headline, or null when there is nothing worth saying.
 *
 * Null on a clean account is load-bearing: a page that always announces something teaches people
 * that its announcements mean nothing, which is the state #823 was filed about one level down.
 */
export function headline(t: DiagnosticsTotals): string | null {
	if (!t.signatures) return null;
	if (t.persistent) {
		return `${t.persistent} ${t.persistent === 1 ? "problem has" : "problems have"} been recurring for a day or more.`;
	}
	return null;
}
