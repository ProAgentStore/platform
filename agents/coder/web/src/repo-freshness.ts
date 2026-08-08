// How OLD is what this row is telling you (#440)?
//
// `pas/platform` on the Coder Home instance read "Path unusable" for five days. The verdict had
// been taken on 2026-08-03 by a `POST /coding/start` that failed on a closed laptop — it never
// looked at the directory — and nothing replaced it, because the list's re-check is conditional on
// a runner connection the instance's "Runs on" pin would not resolve. Every surface said the same
// thing with the same confidence on day one and on day five.
//
// So the row now carries WHEN, and the card says it. Two states, and keeping them apart is the
// whole value:
//
//   - a recorded time  → "checked 4 minutes ago" — a machine looked, this recently;
//   - nothing recorded → "never checked" — the status is what somebody ASSUMED. Not "old".
//
// Pure and separate from ./repo-status.ts on purpose: that module reconciles the LIVE engine
// signals (is it working, is the runner up), this one describes the age of a stored fact. They
// answer different questions and share no inputs.

/**
 * `datetime('now')` writes `YYYY-MM-DD HH:MM:SS`, no zone, UTC.
 *
 * Given to `Date.parse` as-is a browser reads it as LOCAL time, which in Sydney renders a check
 * taken a minute ago as ten hours old. The zone is appended rather than assumed.
 */
function parseSqlTime(v: string): number {
	const t = v.trim();
	if (!t) return Number.NaN;
	return Date.parse(/[Zz]|[+-]\d{2}:?\d{2}$/.test(t) ? t.replace(" ", "T") : `${t.replace(" ", "T")}Z`);
}

/**
 * The freshness phrase for a repo row, or null when there is nothing to say.
 *
 * Only local repos have a checkout to look at; a cloned one's `clone_status` is written by the
 * clone itself, and offering an age for it would describe a check that never happens.
 */
export function repoFreshnessLabel(
	repo: { workdir?: string; cloneCheckedAt?: string },
	now: number = Date.now(),
): string | null {
	if (!repo.workdir) return null;
	if (!repo.cloneCheckedAt) return "never checked";
	const at = parseSqlTime(repo.cloneCheckedAt);
	if (!Number.isFinite(at)) return "never checked";
	// Clock skew between D1 and the browser must not produce "in 3 minutes".
	const mins = Math.floor(Math.max(0, now - at) / 60_000);
	if (mins < 2) return "checked just now";
	if (mins < 60) return `checked ${mins} min ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 48) return `checked ${hours}h ago`;
	return `checked ${Math.floor(hours / 24)}d ago`;
}

/**
 * What the LIST as a whole managed to do — see the `recheck` field on `GET …/coding/repos` (#440).
 *
 * `ran: false` is the state that used to be invisible: the response looked identical whether the
 * platform had just confirmed every path or had not looked since Monday.
 */
export interface RecheckReport {
	ran?: boolean;
	checked?: number;
	reason?: string;
}

/**
 * The sentence above the list when nothing was re-checked, or null when something was.
 *
 * The server's own `reason` is appended verbatim — it is `diagnoseAttachment`'s diagnosis, the same
 * one `/runtime/status` gives, and it is the only thing that can name a stale "Runs on" pin. A
 * hardcoded "run `pags up`" here would be the #341 mistake again: telling someone to run a command
 * they are already running.
 */
export function staleListNotice(recheck: RecheckReport | undefined, localRepoCount: number): string | null {
	if (!localRepoCount) return null;
	if (recheck?.ran !== false) return null;
	const why = (recheck.reason || "").trim();
	return `Showing the last known state of your checkouts — nothing was re-checked just now.${why ? ` ${why}` : ""}`;
}
