/**
 * The wire shape of `GET /v1/usage` — declared ONCE, imported by the producer and by the console.
 *
 * ── Why this file exists (#608)
 *
 * `UsageSummary["totals"]` omitted `cacheReadTokens`/`cacheWriteTokens`, which `aggregateUsage`
 * has computed and returned since #547. The data crossed the wire, the page read it, and the type
 * said it did not exist — so the compiler could not help anyone on either side. The console had
 * already worked around it by declaring its OWN parallel shape with the two fields marked
 * optional, which is the tell: a second declaration is not a description of the response, it is a
 * guess about it that nothing checks. #547 fixed exactly this for `daily` and left the habit in
 * place; a third instance was `PayerCoverage`, declared in `usage-coverage.ts` and again in
 * `store/console/src/lib/usageFigures.ts`.
 *
 * So the shape is not restated anywhere. `routes/usage.ts` annotates its response body with
 * {@link UsageResponse}, which is what makes the producer unable to drift: a field the aggregator
 * returns and this file does not declare is a compile error at the route, not a silent omission.
 *
 * ── Why the console imports a Worker file, when the Worker imports nothing of the console's
 *
 * This module has NO imports — not `Env`, not a Cloudflare type, not another lib. That is a
 * constraint, not an accident: `store/console` typechecks without `@cloudflare/workers-types`, so
 * anything reachable from here would have to typecheck there too. Keep it a leaf.
 *
 * The edge only runs one way, and only at the type level. `lib/normalize-speech.ts` records why
 * the reverse (the API Worker depending on `@proagentstore/sdk`) was refused: a published package,
 * a new exports subpath, and a build step in front of `wrangler deploy`. None of that applies to a
 * type-only import that esbuild erases — it adds no dependency, no bundle byte and no deploy step,
 * and it is the only arrangement in which the two sides cannot disagree.
 */

/**
 * What KIND of call a ledger row records — and the vocabulary `byKind` buckets are keyed by.
 *
 * Declared in this leaf rather than in `usage.ts` (#302/#556 fix-forward): `usage.ts` needs
 * `PromptSectionInput` from `prompt-section-estimates.ts`, and that module needs a kind to label
 * its log event with. Both facing the other way is a two-module cycle, type-only and therefore
 * invisible at runtime — exactly the shape `import-graph.test.ts` exists to reject, and exactly
 * the shape the connector graph was untangled into a leaf to escape.
 *
 * `usage.ts` re-exports it, so it stays the module you import a kind FROM. Nothing else moved.
 */
export type UsageKind =
	| "chat"
	| "apply"
	| "coding"
	/**
	 * The coding Engine itself (#267) — the CLI child process on the user's machine.
	 *
	 * Distinct from "coding", which is the cloud-side Pilot deciding what to instruct it to do.
	 * Conflating them would hide the split that matters: the Pilot's decisions are cents, the
	 * Engine's turns are the actual bill.
	 */
	| "engine"
	| "copilot"
	| "overseer"
	| "run"
	| "resume"
	| "translate"
	| "voice"
	// Declarative pipeline LLM step (ai_generate) — e.g. the Outreach agent drafting per lead.
	| "pipeline"
	// Platform-paid internal AI (issue #44), billed to the platform, not BYOK.
	| "embedding"
	| "summary";

/** One slice of a range, in the two units the page reports. */
export interface CoverageSlice {
	calls: number;
	costMicros: number;
}

/** What `/v1/usage` reports about the gap between the requested range and the payer's coverage (#544). */
export interface PayerCoverage {
	/**
	 * The earliest row IN THIS RANGE carrying a payer we could establish. `null` when none does.
	 *
	 * Deliberately not called a start date. Over a 7-day window it is a timestamp inside that
	 * window and says nothing about when tracking began; the page must label it for what it is.
	 */
	firstAttributedAt: string | null;
	/** Rows whose payer is established — charged or not (a subscription row is attributed and free). */
	attributed: CoverageSlice;
	/**
	 * No payer, and older than {@link firstAttributedAt}. This is the bucket that makes a long range
	 * understate: it cannot enter the charged figure and nothing on the page used to say it existed.
	 */
	unattributedBefore: CoverageSlice;
	/**
	 * No payer, and NOT older than {@link firstAttributedAt} — so, alongside calls we could attribute.
	 *
	 * A different problem with a different remedy: a coding engine on a machine login (#551), which
	 * one stored token fixes. When nothing in the range is attributed at all, every unattributed row
	 * lands here, which is vacuously true (none of them is older than a row that does not exist) and
	 * is the honest reading — with no boundary, there is no "before" to be on the far side of.
	 */
	unattributedSince: CoverageSlice;
}

export interface UsageBucket {
	key: string;
	label?: string;
	inputTokens: number;
	outputTokens: number;
	/**
	 * Prompt-cache tokens, reported separately so the hit rate is visible.
	 *
	 * cacheReadTokens ÷ (inputTokens + cacheReadTokens) IS the cache hit rate. Before this they
	 * were summed into inputTokens, so the ratio could not be computed and nobody could tell
	 * whether caching worked — while the cost line silently assumed it never did.
	 */
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costMicros: number;
	/**
	 * The subset of `costMicros` in this bucket that someone is actually charged (#543).
	 *
	 * `costMicros` is notional value on every row, so a breakdown carrying only it answers "how
	 * much AI did this use", never "what did it cost me" — and the page printed the notional
	 * figure beside a charged headline, in the same `$` format, with nothing saying which was
	 * which. The totals loop had computed exactly this since #346; the buckets simply never did,
	 * so `byAgent`/`byKind`/`byModel`/`byPayer` (and both admin breakdowns, which share `bump`)
	 * were all notional-only.
	 *
	 * Accumulated in one `bump()` rather than as a parallel `chargedByAgent` array: two arrays
	 * joined by key are two things that can disagree.
	 *
	 * A bucket at 0 is NOT a claim that the work was free — `isCharged` excludes `subscription`
	 * (no marginal charge) and NULL (payer not established). The console says so beside it.
	 */
	chargedCostMicros: number;
	calls: number;
	/**
	 * Distinct coding SESSIONS behind this bucket's rows (#551, item 3) — absent when not measured.
	 *
	 * `calls` and value answer "how much could we not attribute". They cannot answer "is this one
	 * stray session or every session I have ever run", and on the measured account it is the
	 * second: 449 engine calls, $9,541 of value, and not one row that ever resolved to a payer.
	 * Reaching that today means opening each session and reading `engineAuthReport` (#248).
	 *
	 * Counted from the ledger, not a new column. An engine row's id is `engine:{sessionId}:{id}`,
	 * so `ai_usage` has persisted the session and the resolved credential together since #267 —
	 * see `engineSessionFromRowId`. The last analysis of item 3 concluded a column was needed
	 * because `coding_sessions` has none; true, and beside the point.
	 *
	 * `undefined` means NOT MEASURED, and is not zero: the admin aggregates share this shape and
	 * do not select `ai_usage.id`, so they cannot count sessions and must not appear to have
	 * counted none. `0` on a `/v1/usage` bucket IS a measurement — no coding engine ran in it.
	 *
	 * PER-BUCKET DISTINCT, so the column does NOT sum to a distinct account total on every axis.
	 * Measured in production 2026-08-16: `byPayer`, `byKind`, `byAgent` and `byInstance` each sum
	 * to 37, and `byModel` sums to 39 — because a session belongs to exactly one instance but can
	 * SWITCH MODEL, and is then counted in both model buckets. That is the right per-row answer
	 * ("how many sessions touched Opus 5") and the wrong total, so a caller adding this column up
	 * is making a claim the data does not support. The console reports the buckets, not a sum.
	 */
	sessions?: number;
}

/**
 * The account-wide roll-up.
 *
 * Every field here is accumulated by the same loop in `aggregateUsage`, and that loop's
 * accumulator is ANNOTATED with this type. Adding a column to one without the other does not
 * compile, which is the whole point: the two cache columns were summed into the accumulator and
 * dropped by the declared type for the entire life of #547.
 */
export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	/** Prompt-cache reads. 98.2% of what a token ceiling counts on a real Coder account (#547). */
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Notional list-price value of EVERYTHING here. Not a bill, and not what anyone owes. */
	costMicros: number;
	/**
	 * The subset of `costMicros` that someone is actually charged (`payer` in byok-api /
	 * platform). Reported separately rather than replacing the total, because the two answer
	 * different questions and adding them together is the error #346 is about — a subscription
	 * row's tokens are real consumption worth seeing, at a dollar figure worth nothing.
	 */
	chargedCostMicros: number;
	calls: number;
}

/**
 * One day of the series, carrying ALL FOUR token columns (#547).
 *
 * It carried only input and output, so the chart plotted 4.2M tokens for 2026-08-11 — the day a
 * 250M-token circuit breaker tripped at 268M. Cache reads are 98.2% of what that ceiling counts
 * (`accountUsageSince` sums all four), so the one view that could answer "which day did I blow the
 * ceiling, and on what?" was off by 137x.
 */
export interface UsageDay {
	date: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costMicros: number;
	calls: number;
}

/**
 * What the Usage total leaves out, as a measured quantity (#348).
 *
 * `windowDays` is part of the answer, not metadata. The trace prunes at 14 days, so a 90-day usage
 * range cannot be matched here — and a count silently covering a shorter window than the dollars
 * beside it would be its own small version of this bug.
 */
export interface UnmeteredUsageSummary {
	/** Distinct (instance, target, day) drives on an unmetered path. */
	drives: number;
	/** Of those, the ones where a known AI coding CLI was observed running in the pane. */
	aiCliDrives: number;
	/** How many of the user's agents did it. */
	instances: number;
	/** ms epoch of the most recent observation, or null. */
	lastAt: number | null;
	/** The window this count actually covers — never longer than the trace's retention. */
	windowDays: number;
}

/** What `aggregateUsage` returns: the same rows, rolled up along every axis the page offers. */
export interface UsageSummary {
	totals: UsageTotals;
	daily: UsageDay[];
	byModel: UsageBucket[];
	byKind: UsageBucket[];
	byAgent: UsageBucket[];
	/**
	 * The same value split by INSTANCE — the subscriber's own copy of an agent (#526).
	 *
	 * `byAgent` groups by template, which is the creator's unit and not the owner's: seven Repo
	 * Coders working on seven repositories collapse into one row called "Repo Coder". So the page
	 * could show a five-figure total and not answer "what did Chess coder 2 cost me this week?",
	 * which is the question it exists for. Nothing new is measured — `ai_usage.instance_id` has
	 * carried this on every chat, Pilot and engine row since the ledger shipped; it was aggregated
	 * away.
	 *
	 * Rows with no instance (a creator's direct run against a template, account-scoped voice) keep
	 * their own bucket rather than being dropped, so this axis sums to the same totals as the others.
	 */
	byInstance: UsageBucket[];
	/** Value split by who pays it — the axis the page needs to stop implying everything is a bill. */
	byPayer: UsageBucket[];
	/**
	 * What the charged figure does not cover, counted (#544).
	 *
	 * `Est. billed` read $36.35 at 7d, 30d AND all-time, because `payer` shipped without a backfill
	 * and every older row resolves to NULL. The sum was right; the range it implied was not. This
	 * says which rows are outside the payer's coverage and by how much, without asserting a start
	 * date the page cannot derive — see `usage-coverage.ts` for what is derivable and what is not.
	 */
	payerCoverage: PayerCoverage;
}

/**
 * The exact JSON body of `GET /v1/usage`.
 *
 * `routes/usage.ts` annotates its response with this, and `store/console/src/pages/Usage.tsx`
 * consumes it. That is the guard: the route cannot return a field this does not declare, and the
 * page cannot read one the route does not send.
 */
export interface UsageResponse extends UsageSummary {
	/** The range the caller asked for — "7d" | "30d" | "90d" | "all". */
	range: string;
	/** Sessions whose cost could not be read at all (#348). */
	unmetered: UnmeteredUsageSummary;
}
