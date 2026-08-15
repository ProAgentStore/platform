import { isJobSpecificQuestion } from "./profile.js";
import type { Env } from "../types.js";

/**
 * A stable, strong password for ATS account creation — the SAME every run for a
 * given user, so a second application to a site where the user already has an
 * account can log in instead of failing to re-register. Derived (HMAC of the
 * user id under the session secret), so it's reproducible without storage and
 * not guessable. Always contains upper/lower/digit/symbol (the "Pj9!" prefix).
 */
export async function deriveJobPassword(env: Env, userId: string): Promise<string> {
	// Fail closed: a hardcoded fallback would make every user's derived job-site
	// password predictable from their (semi-public) userId if the signing key were
	// ever unset. The key is provisioned in prod; refuse rather than degrade.
	const secret = env.SESSION_SIGNING_KEY;
	if (!secret) throw new Error("SESSION_SIGNING_KEY is not configured");
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`jobpw:${userId}`));
	const b64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, "");
	// 14 chars total (Pj9! + 10) — keeps upper/lower/digit/symbol but fits sites
	// that cap password length (Bendigo enforces ≤18; some ATSes ≤16).
	return `Pj9!${b64.slice(0, 10)}`;
}

/** The ATS host an application targets, used as the per-ATS cache key (no www). */
export function atsHost(url: string): string {
	try {
		return new URL(url).host.replace(/^www\./, "");
	} catch {
		return "";
	}
}

// ── What the cache may carry across employers ────────────────────────────────
//
// The row is keyed on the bare HOST (`ats_apply_cache` PK is `(user_id, host)`), and on the
// multi-tenant platforms the employer is in the PATH, not the host:
// `job-boards.greenhouse.io/<company>`, `jobs.lever.co/<company>`, `jobs.ashbyhq.com/<company>`,
// `jobs.smartrecruiters.com/<company>`. Every employer on those platforms shares one row, and the
// row is injected into the next application's prompt under "reuse the good steps" (#633).
//
// Two production rows on the one apply instance, read back from the run transcripts that write
// them: the `employmenthero.com` blob opens with a cover letter naming **Business AI Group**, and
// the `jobs.ashbyhq.com` blob holds a 90-word answer written for **Xero**. Both were the prior
// context for the NEXT employer on the same host.
//
// This codebase already named the hazard and guarded it for the other channel that carries answers
// into the prompt — `profileCustomAnswers` in `lib/profile.ts`:
//
//   > A job-specific free-text answer ("why do you want to work here?", a cover-letter paragraph)
//   > must NOT be asserted onto a DIFFERENT company's form as an authoritative "use this, don't
//   > ask again" value — that submits company-A's motivation on company-B's application. Bias
//   > toward re-asking (safe) over reusing a possibly-wrong answer (wrong data on a real
//   > application)
//
// The same reasoning, applied to the same content, arriving through a different door. The fix is
// the DISTINCTION, not deletion: how to operate this ATS's widgets is genuinely reusable across
// employers and is most of what the cache is worth; what was typed into them is not.
//
// SHARED (procedural): the action verb, the control's role and label, the ORDER, what failed and
// why, the ⚠ no-visible-change markers, chosen dropdown/checkbox options (those are the page's own
// enumerable options — knowing "Working rights" offers "Australian Permanent Resident" is how the
// next run operates the widget), and the ORIGIN of a navigation.
//
// WITHHELD (answer / employer-specific / secret): every typed value, the read-back of a typed
// value, the result of a mailbox read (one-time sign-in links and codes), and the PATH of a
// navigation — `…/acme/jobs/123` is the previous employer's posting, and replaying it is how a
// chain ends up on the wrong company's form.

/** The value in a `type` line is replaced by this — the marker says why, so the brain re-derives
 *  the answer for THIS employer instead of hunting for one it thinks it lost. */
const WITHHELD_JOB_SPECIFIC = "⟨answer withheld — it was written for a DIFFERENT employer; write a fresh one for this one⟩";
const WITHHELD_VALUE = "⟨value withheld — take it from the candidate data above⟩";

/** One transcript line, stripped of everything that belongs to one employer. */
export function sanitizeCacheLine(line: string): string {
	let out = line;
	// The `N. ` prefix is part of every STORED line (`saveAtsCache` numbers them), so the read-side
	// filter that neutralises the live rows has to see through it. Written this way because the
	// first cut anchored on `^type` and silently passed every existing row through untouched.
	const NUM = "(?:\\d+\\.\\s*)?";
	// `type "<value>" into <role> "<field>"` — greedy to the LAST ` into `, because the typed value
	// itself routinely contains quotes and newlines (a cover letter).
	out = out.replace(new RegExp(`^(\\s*${NUM})type "([\\s\\S]*)" into ([\\s\\S]*)$`), (_m, pad: string, _text: string, rest: string) => {
		const field = rest.match(/"([^"]*)"\s*$/)?.[1] ?? rest.match(/"([^"]*)"/)?.[1] ?? "";
		return `${pad}type ${isJobSpecificQuestion(field) ? WITHHELD_JOB_SPECIFIC : WITHHELD_VALUE} into ${rest}`;
	});
	// The runner's write-back feedback repeats the value the field now holds.
	out = out.replace(/ now reads "[\s\S]*?"(?= —|$)/g, ' now reads "⟨withheld⟩"');
	// A mailbox read returns a one-time sign-in link and any verification code.
	out = out.replace(new RegExp(`^(\\s*${NUM}read_email_link →)[\\s\\S]*$`), "$1 ⟨result withheld — read the inbox again for THIS run⟩");
	// A navigation path carries the employer and the job id.
	out = out.replace(/(navigate to )(https?:\/\/[^/\s]+)(\S*)/g, (_m, verb: string, origin: string, rest: string) => `${verb}${origin}${rest && rest !== "/" ? "/…" : ""}`);
	return out;
}

/** Line cap for the hint, mirroring `decideAction`'s `MAX_LOG`. The action log was capped when an
 *  unbounded one "bloated the context until the AI call timed out"; the cache hint is the LARGER
 *  of the two inputs — a whole prior run, re-sent on every one of the next run's ~60 decisions —
 *  and was never capped at all (#633). Head + tail, because the opening steps are the route in and
 *  the closing ones are the route out. */
const HINT_HEAD = 10;
const HINT_TAIL = 30;
const HINT_MAX_CHARS = 6000;

export function capCacheHint(notes: string): string {
	const lines = notes.split("\n");
	const kept =
		lines.length > HINT_HEAD + HINT_TAIL
			? [...lines.slice(0, HINT_HEAD), `… (${lines.length - HINT_HEAD - HINT_TAIL} steps omitted) …`, ...lines.slice(-HINT_TAIL)]
			: lines;
	const text = kept.join("\n");
	// A per-line cap is not enough on its own: one line can be a whole cover letter, and a row
	// written before the value filter existed still holds them.
	return text.length > HINT_MAX_CHARS ? `${text.slice(0, HINT_MAX_CHARS)}\n… (hint truncated)` : text;
}

/**
 * How good a run's outcome was, for deciding whether it may REPLACE what is already stored (#655).
 *
 * There is one row per (user, host) and no history, and `saveAtsCache` was called on every terminal
 * path with an unconditional upsert — so a runner disconnect, a captcha timeout or the owner
 * pressing Cancel two steps in replaced a 40-step route that had actually submitted, permanently.
 * The next application to that ATS was then prompted with the truncated failure as its route.
 */
export function outcomeRank(outcome: string | null | undefined): number {
	switch ((outcome ?? "").toLowerCase()) {
		case "submitted": return 4;
		case "ready": return 3; // a completed dry run — it reached the final submit, so the route is whole
		case "max_steps":
		case "stuck":
		case "needs_input":
		case "captcha":
		case "blocked": return 2; // got somewhere and stopped; better than nothing, worse than a finish
		case "expired": return 1;
		case "cancelled":
		case "failed": return 0; // abandoned — carries no evidence that any of it worked
		default: return 2;
	}
}

/** A stored row older than this has no claim on the slot: an ATS redesign must not be locked out
 *  by a good route from months ago that no longer exists. */
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** May a run with `incoming` replace what is stored? Pure, so the rule is testable without D1. */
export function shouldReplaceCache(
	incoming: { outcome: string; now?: number },
	stored: { outcome?: string | null; updatedAt?: string | null } | null | undefined,
): boolean {
	if (!stored) return true;
	if (outcomeRank(incoming.outcome) >= outcomeRank(stored.outcome)) return true;
	const t = Date.parse(`${stored.updatedAt ?? ""}Z`.replace(/ /, "T"));
	if (!Number.isFinite(t)) return true; // an unreadable timestamp must not pin a slot forever
	return (incoming.now ?? Date.now()) - t > STALE_AFTER_MS;
}

/**
 * The prior run's route on this ATS, as the prompt sees it.
 *
 * Sanitized on READ as well as on write: the rows quoted at the top of this file are LIVE, and a
 * read-side filter neutralises them without a backfill migration. It also means a row written by a
 * Worker older than this change cannot leak through a rolling deploy.
 *
 * The outcome is stated, which is what `0017_ats_cache_outcome.sql` added the column FOR — "so the
 * … next run sees the prior result". Until now the reader selected `notes` alone, so the prompt
 * asked the model to "reuse the good steps, avoid the failed ones" over a transcript with no
 * verdict on it anywhere (#655).
 */
export async function getAtsCacheHint(env: Env, userId: string, host: string): Promise<string | undefined> {
	if (!host) return undefined;
	const row = await env.DB.prepare("SELECT notes, outcome, updated_at FROM ats_apply_cache WHERE user_id = ?1 AND host = ?2")
		.bind(userId, host)
		.first<{ notes: string; outcome?: string | null; updated_at?: string | null }>();
	const notes = row?.notes;
	if (!notes) return undefined;
	const body = capCacheHint(notes.split("\n").map(sanitizeCacheLine).join("\n"));
	return `${describeCacheOutcome(row?.outcome)}\n${body}`;
}

/** The one-line verdict that goes above the route. */
export function describeCacheOutcome(outcome: string | null | undefined): string {
	const o = (outcome ?? "").toLowerCase();
	if (o === "submitted") return "That run ENDED IN A SUBMITTED APPLICATION — this route works; follow it.";
	if (o === "ready") return "That run was a TEST that reached the final submit without sending it — the route is complete up to the submit.";
	if (!o) return "That run's outcome was not recorded — treat the route as unproven.";
	return `That run ENDED IN "${o}" — it did NOT submit, so treat the later steps as unproven and expect to deviate.`;
}

/**
 * Record this run's route on this ATS, for the next application + the transparency view.
 *
 * Sanitized before it is stored, so the answer content never enters the row in the first place —
 * the read-side filter above is for rows written before this shipped.
 *
 * Read-then-write rather than one atomic upsert: the rule (`shouldReplaceCache`) is worth being
 * able to prove in a test more than this write is worth being atomic. Two applications by ONE user
 * to ONE host at the same moment are already single-flighted per instance by `startJobApply`, and
 * the worst case of the remaining cross-instance race is one lost cache update.
 */
export async function saveAtsCache(env: Env, userId: string, host: string, transcript: string[], outcome = "submitted"): Promise<void> {
	if (!host || transcript.length === 0) return;
	const stored = await env.DB.prepare("SELECT outcome, updated_at FROM ats_apply_cache WHERE user_id = ?1 AND host = ?2")
		.bind(userId, host)
		.first<{ outcome?: string | null; updated_at?: string | null }>()
		.catch(() => null);
	if (!shouldReplaceCache({ outcome }, stored ? { outcome: stored.outcome, updatedAt: stored.updated_at } : null)) return;
	const notes = transcript.map((a, i) => `${i + 1}. ${sanitizeCacheLine(a)}`).join("\n");
	await env.DB.prepare(
		`INSERT INTO ats_apply_cache (user_id, host, notes, steps, outcome, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
		 ON CONFLICT(user_id, host) DO UPDATE SET notes = excluded.notes, steps = excluded.steps, outcome = excluded.outcome, updated_at = excluded.updated_at`,
	)
		.bind(userId, host, notes, transcript.length, outcome)
		.run();
}

/** All the user's per-ATS learnings (for the transparency view). */
export async function listAtsCache(env: Env, userId: string): Promise<Array<{ host: string; outcome?: string; steps?: number; notes: string; updatedAt: string }>> {
	const res = await env.DB.prepare("SELECT host, outcome, steps, notes, updated_at FROM ats_apply_cache WHERE user_id = ?1 ORDER BY updated_at DESC")
		.bind(userId)
		.all<{ host: string; outcome: string | null; steps: number | null; notes: string; updated_at: string }>();
	// Sanitized here too: this is what the console's Rules & Tips tab renders, and the live rows
	// hold a password and two employers' free-text answers. Nothing is destroyed — the filter is on
	// the way out, and the route, which is what "what the agent learned about this site" means, is
	// intact.
	return (res.results ?? []).map((r) => ({
		host: r.host,
		outcome: r.outcome ?? undefined,
		steps: r.steps ?? undefined,
		notes: r.notes.split("\n").map(sanitizeCacheLine).join("\n"),
		updatedAt: r.updated_at,
	}));
}
