/**
 * What `my_agents` puts on the wire (#595).
 *
 * PURE — no SDK, no `fetch`. `index.ts` calls one function; the size judgement is here, where it
 * can be tested against four hundred agents without an account.
 *
 * ── The measurement
 *
 * `my_agents` served 66,013 bytes for 41 owned agents on the live account (2026-08-15), against a
 * calling host's 64 KiB limit. Already compact — #586 does not help it. Attributed before anything
 * was changed, because #578's lesson is that the field you would blame is not the field that fills
 * the payload: **`config` is 60.9%** (40,196 B), `description` 14.2% (9,365 B), and every other
 * column is under 3%. One agent — `site-builder`, which embeds two whole pipeline definitions in
 * its config — is 13,908 B by itself.
 *
 * ── Why `config` is PAGED and not dropped
 *
 * Dropping the 61% is the obvious fix and it would remove a capability. Checked against the live
 * API rather than assumed, on 2026-08-15:
 *
 *   · `agent_info` reads `/v1/public/agents/:id`, which returns **no `config` field at all** and
 *     **404s for a draft agent** — and 26 of this account's 41 agents are drafts.
 *   · the owner-scoped `/v1/agents/:id` returns 200 for a draft and also **omits `config`**.
 *
 * So `my_agents` is the ONLY read on the entire MCP surface through which an owner can see their
 * own agent's capabilities, pipelines, settings schema or behaviour. A "narrower default with an
 * opt-in for detail" has nowhere to opt in to; dropping the field would make that configuration
 * unreadable rather than cheaper. Paging keeps every byte reachable.
 *
 * ── Two rules, borrowed from #503 because it is the same failure
 *
 *  1. **The roster is never the thing that gets cut.** `total` and `roster` come first and list
 *     EVERY owned agent, so "how many do I have" and "which ones" survive a reply that could
 *     carry detail for three of them. A Coder Lead spent two days answering "3" to "how many
 *     agents do you have" because the count lived in the part that got truncated.
 *  2. **A reduction says so.** `page` states the offset, the count, the total and where to
 *     continue, so a caller can tell a first page from a whole answer.
 */

import { type PageMeta, WIRE_BUDGET_BYTES, fitPage, wireBytes } from "./wire-budget.js";

/** The columns `/v1/agents/my/agents` returns. ONLY the five roster fields are named — deliberately,
 *  and there is no index signature: everything else (including the 61% that is `config`) rides
 *  through to the page untouched, so a column added to the table appears in the reply without an
 *  edit here. The #468 rule, applied to a row rather than a list. */
export interface OwnedAgent {
	id?: unknown;
	slug?: unknown;
	name?: unknown;
	status?: unknown;
	visibility?: unknown;
}

/** One line of the complete roster — the part of the answer that is never reduced.
 *
 *  Five fields, ~90 bytes: enough to answer "which agents do I own, and which are live" without
 *  a second call, and small enough that four hundred of them are still under a fifth of the
 *  budget. `config` and `description` — 75% of the payload between them — are deliberately not
 *  here; they are what the page is for. */
export interface AgentRosterLine {
	id: unknown;
	slug: unknown;
	name: unknown;
	status: unknown;
	visibility: unknown;
}

const rosterLine = (a: OwnedAgent): AgentRosterLine => ({ id: a.id, slug: a.slug, name: a.name, status: a.status, visibility: a.visibility });

/**
 * The head, the complete roster, and as much detail as the budget allows.
 *
 * The roster is fitted BEFORE the page rather than trusted to be small. It is small in every
 * real case (41 agents is 3.7 KB) but it is not bounded by anything, and a head that cannot fit
 * on its own would make every page over-budget while looking like a paging problem. When it has
 * to be shortened, `rosterOmitted` says by how much — the roster degrades last and never
 * silently, which is rule 1 above applied to the roster itself.
 */
export function buildAgentListing(input: { agents: readonly OwnedAgent[]; offset?: number; limit?: number; budget?: number }): {
	text: string;
	meta: PageMeta;
	rosterShown: number;
} {
	const total = input.agents.length;
	const roster = input.agents.map(rosterLine);

	const head = (lines: readonly AgentRosterLine[], rows: unknown[], page: PageMeta) => ({
		total,
		roster: lines,
		...(lines.length < total ? { rosterOmitted: total - lines.length } : {}),
		page,
		agents: rows,
	});

	// The empty page whose size decides how much roster there is room for. `of`/`nextOffset` are
	// the real values so the probe measures the head it will actually ship, not a smaller one.
	const emptyMeta: PageMeta = { offset: 0, count: 0, of: total, nextOffset: total ? 0 : null, hasMore: total > 0 };
	const budget = input.budget ?? WIRE_BUDGET_BYTES;
	/**
	 * The roster may take at most this much of the budget, and the remainder is guaranteed to the
	 * page.
	 *
	 * Without the split, a roster large enough to fill the budget on its own leaves no room for a
	 * single agent's record — and `fitPage`, seeing that nothing fits, invokes its
	 * one-row-over-budget escape and ships a reply LARGER than the ceiling. Measured: 4,000
	 * agents produced 48,318 bytes against a 48,000 budget. The roster is still the priority (it
	 * degrades last, and only with `rosterOmitted` saying by how much) but "the roster is never
	 * cut" cannot mean "the roster may eat the entire reply", because then the tool answers
	 * nothing else and still does not fit.
	 *
	 * A fixed RESERVE rather than a percentage, because what the page needs is an absolute: room
	 * for a few agent records. A roster line is ~95 bytes and a typical record ~700 (the median
	 * `config` is `"{}"`), so 8,000 guarantees roughly ten records and still lets the roster run
	 * to ~420 agents complete — an order of magnitude past the 41 that produced this issue.
	 */
	const PAGE_RESERVE_BYTES = 8_000;
	const headFits = (keep: number) => wireBytes(JSON.stringify(head(roster.slice(0, keep), [], emptyMeta))) <= budget - PAGE_RESERVE_BYTES;

	let lines = roster;
	if (!headFits(total)) {
		let lo = 0;
		let hi = total;
		let best = 0;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (headFits(mid)) {
				best = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		lines = roster.slice(0, best);
	}

	const fitted = fitPage({
		rows: input.agents,
		offset: input.offset,
		limit: input.limit,
		budget,
		build: (rows, page) => head(lines, rows as unknown[], page),
	});
	return { text: fitted.text, meta: fitted.meta, rosterShown: lines.length };
}
