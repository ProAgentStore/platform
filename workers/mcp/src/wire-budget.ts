/**
 * How much a tool may put on the wire, and how a page is fitted to it (#595).
 *
 * PURE — no SDK, no `fetch`, no env. The tools that use it live in `index.ts` and
 * `instance-tools/knowledge.ts`; the size judgement lives here so it can be tested against a
 * 6,000-row inventory without a network.
 *
 * ── The failure this exists to end
 *
 * #586 made every MCP result compact, which recovered ~22% across 114 call sites. Measured in
 * production immediately afterwards, two tools were still over a calling host's 64 KiB limit —
 * `vector_stats` at 151,547 B (2.3x the ceiling, i.e. a host that enforces the limit cannot call
 * it at all) and `my_agents` at 65,760 B. Both were ALREADY compact. Compaction bought them the
 * 22% they no longer waste and left them over anyway, so this was never a serialisation problem.
 *
 * ── What the bytes actually were, measured before anything was changed
 *
 * The lesson of #578 is that the field you would blame is not the field that fills the payload
 * (`schemas` was 18%; the `description` prose on rows the agent cannot run was 38%). So both were
 * attributed first, across the whole population — 34 instances and 41 owned agents on the live
 * account, 2026-08-15:
 *
 *   · `vector_stats`, worst case 151,700 B over 315 sources on the Repo Chat instance:
 *     `preview` 81,370 B (53.6%), `sourceId` 22,007 B (14.5%), `name` 20,731 B (13.7%),
 *     `lastIndexed` 12,915 B (8.5%). 314 of the 315 rows carry a `name` byte-identical to their
 *     `sourceId` (a repo source's id IS its label — `agent-storage/vectors.ts` sets
 *     `g.name = g.sourceId`), so an eighth of the payload is a duplicate of another eighth.
 *   · `my_agents`, 66,013 B over 41 agents: `config` 40,196 B (60.9%), `description` 9,365 B
 *     (14.2%). One agent (`site-builder`, which embeds two whole pipeline definitions) is
 *     13,908 B by itself.
 *
 * ── Why paging, and not a narrower row
 *
 * Deleting `preview` outright takes `vector_stats` to 70,330 B — still over. Deleting the
 * duplicated `name` as well takes it to 49,629 B, which fits, and which is worth exactly nothing:
 * an instance may index 20 repos of 300 files (`REPO_MAX_REPOS`), so the same trimmed row shape
 * reaches ~940 KB on a store this feature already permits. **A trim moves the cliff; it does not
 * remove it.** The collection is unbounded, so the bound has to be on the collection.
 *
 * That is also the shape that has worked twice here: `instance_messages` got a real `before`
 * cursor (#566) and `coding_timeline` a `since_seq` (#581). This is the third, deliberately built
 * from the same parts rather than as a new idea.
 *
 * ── And why the budget is in BYTES rather than characters
 *
 * `String.prototype.length` counts UTF-16 code units. A host limit is bytes. Every non-ASCII
 * character in a payload — a Chinese preview from the Language Buddy instance, an em dash in a
 * description, an emoji in an agent name — is 2-4 bytes and 1-2 units, so a character count
 * UNDER-reports exactly the payloads most likely to overflow. {@link wireBytes} encodes.
 */

/**
 * The limit the calling host in #569 applied, and the number every assertion here is against.
 *
 * Not a knob. It is a property of somebody else's client, restated in one place so that a test
 * and a budget cannot drift apart.
 */
export const WIRE_LIMIT_BYTES = 64 * 1024;

/**
 * What one tool may actually emit — the limit less a margin, and the margin is the point.
 *
 * `WIRE_LIMIT_BYTES` is what the host refuses at, not what a tool may aim for. Between this
 * function and that refusal sit the JSON-RPC envelope, the `content` block wrapper, and whatever
 * a future SDK adds beside them; #569's tool was budgeted to ~54,000 and still served 66,042 B
 * because the measurement was taken one layer above the one that serialises. Budgeting to the
 * ceiling is how that happens again.
 *
 * 48,000 leaves ~17,500 bytes of headroom. That is generous on purpose: the cost of a smaller
 * page is one more call, and the cost of a page that does not fit is a tool the host cannot call
 * at all — which is the entire finding of #595.
 */
export const WIRE_BUDGET_BYTES = 48_000;

/** Bytes on the wire, not UTF-16 code units. See the header — this distinction is load-bearing. */
export function wireBytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** What a caller needs in order to ask for the next page, and to know it is not seeing everything. */
export interface PageMeta {
	/** Where this page started. */
	offset: number;
	/** How many rows it carries. */
	count: number;
	/** The whole collection — NEVER reduced, so "how many are there" survives any page. */
	of: number;
	/** Pass as `offset` to continue. `null` when this page is the end. */
	nextOffset: number | null;
	hasMore: boolean;
	/** Present only when a single row could not fit a whole page on its own — see {@link fitPage}. */
	note?: string;
}

/**
 * Fit as many rows as the budget allows, and report honestly what did not fit.
 *
 * `build` renders the WHOLE payload — head, page meta and rows — because the head is part of the
 * budget too. Measuring the rows alone is the same class of mistake as measuring the API body
 * instead of the wire (#569): it asserts a number that is not the one the host applies.
 *
 * ── The zero-row corner, which is reachable and must not hang a caller
 *
 * A single row can exceed the whole budget: `my_agents`'s largest real `config` is 13,908 B today
 * and nothing bounds a pipeline definition. A pager that emitted zero rows and left `nextOffset`
 * where it was would loop forever, so a page that cannot fit even its first row still ADVANCES —
 * it carries that one row, `hasMore` from the true remainder, and a `note` naming the row's size.
 * The caller gets an over-budget response ONCE, for a genuinely over-budget row, instead of an
 * infinite sequence of empty ones; the alternative is silently skipping the row, which is the
 * failure this whole file is about wearing different clothes.
 */
export function fitPage<Row>(input: {
	rows: readonly Row[];
	offset?: number;
	limit?: number;
	budget?: number;
	build: (rows: Row[], meta: PageMeta) => unknown;
}): { text: string; meta: PageMeta } {
	const budget = input.budget ?? WIRE_BUDGET_BYTES;
	const total = input.rows.length;
	// A caller may send anything. Clamp rather than throw: an out-of-range offset is a caller
	// walking off the end of a collection that shrank between calls, which is normal.
	const offset = Math.max(0, Math.min(Math.trunc(input.offset ?? 0), total));
	const available = total - offset;
	const ceiling = input.limit === undefined ? available : Math.max(0, Math.min(Math.trunc(input.limit), available));

	// `note` is threaded THROUGH `build` rather than attached to the returned meta afterwards.
	// It was attached afterwards in the first cut, which meant the caller's own return value
	// carried the warning and the payload the model reads did not — a transparency fix that
	// reached everybody except the reader. Caught by `agent-listing.test.ts`.
	const render = (keep: number, note?: string): { text: string; meta: PageMeta } => {
		const rows = input.rows.slice(offset, offset + keep) as Row[];
		const consumed = offset + keep;
		const hasMore = consumed < total;
		const meta: PageMeta = { offset, count: rows.length, of: total, nextOffset: hasMore ? consumed : null, hasMore, ...(note ? { note } : {}) };
		return { text: JSON.stringify(input.build(rows, meta)), meta };
	};

	const fits = (keep: number) => wireBytes(render(keep).text) <= budget;

	// Binary search for the largest page that fits. The payload grows with `keep`, but not
	// STRICTLY — `"hasMore":false` is one byte longer than `"hasMore":true`, and `nextOffset`
	// gains digits — so the search is followed by a linear correction rather than trusted. Both
	// are cheap; a wrong page here is an over-limit response, which is the bug.
	let lo = 0;
	let hi = ceiling;
	let best = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (fits(mid)) {
			best = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	while (best > 0 && !fits(best)) best--;

	if (best === 0 && ceiling > 0) {
		// One row, over budget, on purpose — see the docstring. `note` is what stops a caller
		// concluding the collection is empty, and what tells a human where to look.
		const bytes = wireBytes(render(1).text);
		return render(
			1,
			`The single item at offset ${offset} is ${bytes} bytes on its own, over this tool's ${budget}-byte budget,` +
				" so this page carries it alone and is larger than the budget. Continue from `nextOffset` as normal.",
		);
	}
	return render(best);
}
