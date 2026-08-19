/**
 * The Ops queue's two display decisions, pulled out of the page so they can be measured (#638).
 *
 * ## What was wrong
 *
 * The status legend was built entirely on values `coding_sessions.status` cannot hold:
 *
 *     s === "failed" || s === "blocked" ? "text-danger" : s === "needs_human" ? "text-warning" : "text-muted"
 *
 * `CodingSessionStatus` is `"active" | "ended" | "error" | "suspended"`, so every one of those
 * three branches was unreachable and the legend had never rendered a colour other than
 * `text-muted`. It matched a server filter that named the same three phantom values and omitted
 * `'error'` — the one failure status anything writes — so the panel reported "No stuck sessions.
 * 🎉" for exactly the failure mode it exists to surface.
 *
 * ## Why a lib module rather than a helper in the page
 *
 * The `src/lib` layer of each store SPA is what this repo unit-tests (see the coverage note in
 * `vitest.config.ts`); a `const` in a `.tsx` page is e2e's job, and no e2e spec covers the admin
 * portal at all. A decision that had been wrong since it was written, and that nothing could see,
 * belongs on the measured side of that line.
 */

/**
 * The failure statuses the server's stuck-session filter asks for, mirrored.
 *
 * A MIRROR, not an import: `workers/api` is a different deployable and the admin SPA must not
 * bundle Worker source. `ops-queue.test.ts` parses `routes/admin-ops.ts` and fails when the two
 * drift — the same arrangement `workers/mcp/src/state-vocabulary.test.ts` uses across that seam,
 * for the same reason.
 */
export const STUCK_SESSION_STATUSES = ["error"] as const;

/**
 * The colour for a row in the stuck-session table, over the REAL `CodingSessionStatus` domain.
 *
 * Two things land in this list and they mean different things, so they are coloured differently:
 * `error` is a session the platform gave up on and closed, and `active` is here only because the
 * second half of the filter caught it idle for 20 minutes — a wedged engine, not a dead one.
 * `ended` and `suspended` cannot reach this table; they render neutral rather than as a fifth
 * invented state, because a display should not assert more than it knows.
 */
export function stuckSessionColor(status: string): string {
	if ((STUCK_SESSION_STATUSES as readonly string[]).includes(status)) return "text-danger";
	if (status === "active") return "text-warning";
	return "text-muted";
}

/**
 * What to print in the Status column.
 *
 * An `active` row is in this table only because it has not been updated for 20 minutes, and
 * printing "active" in a panel headed "Stuck / failed coding sessions" says the opposite of why
 * it is there. Every other value is printed as itself.
 */
export function stuckSessionLabel(status: string): string {
	return status === "active" ? "idle >20m" : status;
}

/**
 * The suffix that turns a capped list length into an honest figure: `"+"`, or `""`.
 *
 * Each Ops list is `LIMIT 50`, and the page rendered `list.length` as a bare count — so a fleet
 * with 5,000 stuck sessions and one with exactly 50 produce the same "50", with nothing saying
 * the number stopped counting. `cap` is now published by the endpoint; an older response that
 * omits it degrades to the plain count rather than to a wrong "+".
 *
 * A suffix rather than a formatter, so the page keeps using `fmtInt` for the number itself and
 * this module stays free of the API layer.
 */
export function capSuffix(n: number, cap?: number | null): string {
	return cap && n >= cap ? "+" : "";
}

/** Hover text for a capped figure — where the "+" is explained. */
export function capTitle(n: number, cap?: number | null): string | undefined {
	return cap && n >= cap ? `Capped at ${cap} — there may be more` : undefined;
}
