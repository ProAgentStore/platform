import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { WIRE_BUDGET_BYTES, WIRE_LIMIT_BYTES, wireBytes } from "../wire-budget.js";
import { registerBoardTools } from "./board.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * `instance_board` paging (#614), and a correction to the measurement that motivated it.
 *
 * #595 recorded this tool at **128,692 B** in `wire-size.test.ts`'s `KNOWN_OVER`, 2.0x a calling
 * host's limit. Re-measured on the live account on 2026-08-16, on the same instance (Small
 * Business Website Lead Finder, 118 cards — still the largest board on the account):
 *
 *   | call                       | live bytes | vs 65,536 |
 *   |----------------------------|-----------|-----------|
 *   | default (`reasoning` off)  | **33,363** | 0.51x — it FITS |
 *   | `reasoning: true`          | **108,190**| 1.65x — over    |
 *
 * **The default read was never over the limit, and this file says so rather than inheriting the
 * number.** 128,692 B is the raw API `/board` body, which carries `reasoning` for every card;
 * the TOOL has made that field opt-in since #574, which landed hours before the sweep. What was
 * recorded as a tool serving 128,692 B is a tool serving 33,363 B from a body of that size.
 *
 * Paging is still the right fix and is still needed, for two reasons that survive the correction:
 * `reasoning:true` is a supported call and IS over the limit, and the card count is bounded by
 * nothing at all.
 *
 * Attributed live, per #595's method — and the dominant field is not the one the old fixture
 * blamed:
 *
 *   · with `reasoning:true`: **`reasoning` 69.4%**. It is the payload.
 *   · by default: **`latestTaskId` 19.1%**, `jobKey` 17.0%, `label` 14.7%, `updatedAt` 13.8%,
 *     and `detail` only 8.9% — five distinct values across all 118 cards.
 *   · `latestTaskId` is **byte-identical to `jobKey` on 118/118 cards**, so a fifth of the
 *     default reply is a second copy of the field printed immediately before it. Same shape as
 *     the `name`/`sourceId` duplicate #595 found on `vector_stats`, and left alone here for the
 *     same reason: a trim moves the cliff, the bound belongs on the collection.
 *
 * ── Why paging this tool is harder than paging a list, and what that risks
 *
 * The other paged tools return a flat array. This one returns cards GROUPED into the agent's
 * columns, so the page is fitted over the flat card list and the grouping is rebuilt from
 * whatever slice fits. Two things can go wrong in that rebuild and neither is visible from a size
 * assertion:
 *
 *   · a card lands in the wrong column, because the column was resolved against the page rather
 *     than the whole board;
 *   · a column with no card in THIS page reads as an empty column rather than an absent one.
 *
 * The first is asserted directly below (every card's column is compared to the column it had when
 * the whole board was rendered in one reply). The second is answered in the head: `columns` and
 * `jobCount` are computed from every item and are never reduced, so "what columns exist" and "how
 * much work is on this board" survive any page — #503's rule that the count must never live in
 * the part that gets cut.
 */

/** 118 cards over 7 columns, at the field distribution measured live — NOT a mean, and not the
 *  prose-heavy `description` the first fixture invented. `reasoning` ~628 B, `detail` ~15 B. */
const CARDS = 118;
const COLUMNS = ["Waiting", "Applying", "Needs you", "Failed", "Blocked", "Submitted", "Done"];
const STATUSES = ["queued", "running", "needs_approval", "failed", "blocked", "submitted", "done"];
/** What the deployed tool served, live, for each of the two calls. */
const MEASURED_LIVE = { default: 33_363, reasoning: 108_190 };
/** The card's key — and, live, its `latestTaskId` too. */
const KEY = (i: number) => `task_${String(i).padStart(30, "0")}`;

const boardBody = () => ({
	view: "board",
	columns: COLUMNS.map((title, i) => ({ id: `col${i}`, title, statuses: [STATUSES[i]] })),
	items: Array.from({ length: CARDS }, (_, i) => {
		// The live duplicate, reproduced rather than described: identical on 118/118 cards.
		const taskId = KEY(i);
		return {
			jobKey: taskId,
			latestTaskId: taskId,
			title: `Business Number ${i} — Newtown NSW`,
			subtitle: "",
			// 8.9% of the default reply. Five distinct values across the whole live board.
			description: i % 5 === 0 ? "Broken/unreachable site" : "No website",
			url: "",
			status: STATUSES[i % STATUSES.length],
			runStatus: STATUSES[i % STATUSES.length],
			updatedAt: "2026-08-14T22:03:51.000Z",
		};
	}),
});

/** The same board with the opt-in field — the call that IS over the limit, at its live size. */
const boardBodyWithReasoning = () => {
	const b = boardBody();
	return { ...b, items: b.items.map((it) => ({ ...it, reasoning: "The listing has no website field and the phone number resolves to a mobile. ".repeat(8).slice(0, 628) })) };
};

interface Harness {
	call: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
	schema: Record<string, unknown>;
}

function setup(body: () => unknown = boardBody): Harness {
	vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body()), { status: 200, headers: { "Content-Type": "application/json" } }));
	const env: McpEnv = { API_BASE: "https://api.test" };
	type CapturedTool = { schema: Record<string, unknown>; handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };
	// A holder OBJECT rather than a bare `let`: TS does not track assignments made inside the fake
	// server's callback, so a `let` stays narrowed to `null` across the register call. Same reason
	// as `observability-paging.test.ts`, and the reason #599 put that one in front of tsc.
	const box: { current: CapturedTool | null } = { current: null };
	const server = {
		tool(name: string, _d: string, schema: Record<string, unknown>, handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) {
			if (name === "instance_board") box.current = { schema, handler };
		},
	};
	const ctx: InstanceToolsCtx = {
		env,
		tokenFor: (provided?: string) => provided || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read", "write", "runtime", "destructive"] }),
		groups: new Set<string>(),
	};
	// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, same shape as instance-tools.test.ts
	registerBoardTools(server as any, ctx);
	const tool = box.current;
	if (!tool) throw new Error("instance_board was not registered — the guard has stopped measuring");
	return {
		schema: tool.schema,
		async call(args) {
			const res = await tool.handler(args);
			return JSON.parse(res.content[0].text) as Record<string, unknown>;
		},
	};
}

/** Flatten a page's grouped board back to `[jobKey, column]`, in page order. */
function cardsOf(body: Record<string, unknown>): { jobKey: string; column: string }[] {
	const board = body.board as Record<string, { jobKey: string }[]>;
	const out: { jobKey: string; column: string }[] = [];
	for (const [column, cards] of Object.entries(board)) for (const c of cards) out.push({ jobKey: c.jobKey, column });
	return out;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("instance_board paging (#614)", () => {
	it("is calibrated to what the deployed tool served, in BOTH of its two modes", async () => {
		// G1, and the arm that carries the correction. The default read is asserted to FIT, because
		// live it does (33,363 B) — asserting it over the limit would re-import the very number
		// this file exists to correct. The opt-in read is asserted OVER, because live it is
		// (108,190 B), and that is the call paging has to rescue.
		//
		// 5% either way: the standard #615 sets, and the one #569's guard failed when it asserted
		// ~54 KB against a production response of 66,042 B.
		const h = setup();
		const plain = wireBytes(JSON.stringify(await h.call({ instance_id: "inst-1", limit: CARDS })));
		expect(plain).toBeLessThan(WIRE_LIMIT_BYTES);
		expect(Math.abs(plain - MEASURED_LIVE.default) / MEASURED_LIVE.default, `default ${plain} B vs ${MEASURED_LIVE.default} B live`).toBeLessThanOrEqual(0.05);

		// The opt-in body, unbudgeted, is what a host refuses.
		const raw = wireBytes(JSON.stringify(boardBodyWithReasoning()));
		expect(raw).toBeGreaterThan(WIRE_LIMIT_BYTES);
		expect(CARDS).toBe(118);
	});

	it("declares the cursor alongside the reasoning opt-in", async () => {
		const { schema } = setup();
		expect(Object.keys(schema)).toEqual(expect.arrayContaining(["instance_id", "reasoning", "offset", "limit"]));
	});

	it("walks every card with no overlap and no gap, every page inside the budget", async () => {
		// THE acceptance criterion: silent truncation is the defect, not the size. A board that fit
		// by dropping 70 cards would pass every size assertion in this repo and be worse than the bug.
		// Walked on the OPT-IN body, because that is the one that does not fit in a single reply.
		const h = setup(boardBodyWithReasoning);
		const seen: { jobKey: string; column: string }[] = [];
		const sizes: number[] = [];
		let offset: number | undefined;
		let pages = 0;
		const budget = CARDS + 2;
		while (pages < budget) {
			const body = await h.call({ instance_id: "inst-1", reasoning: true, ...(offset === undefined ? {} : { offset }) });
			pages++;
			sizes.push(wireBytes(JSON.stringify(body)));
			// The whole board's size and shape ride in front of the page and are never reduced.
			expect(body.jobCount).toBe(CARDS);
			expect(body.columns).toEqual(COLUMNS);
			const page = body.page as { of: number; nextOffset: number | null; hasMore: boolean };
			expect(page.of).toBe(CARDS);
			const cards = cardsOf(body);
			expect(cards.length).toBeGreaterThan(0);
			seen.push(...cards);
			if (!page.hasMore) {
				expect(page.nextOffset).toBeNull();
				break;
			}
			offset = Number(page.nextOffset);
		}
		// Every card exactly once. A SET, not a sequence: within a page the cards are regrouped
		// into columns, so the flat reading order is a permutation of the API's — which is the
		// grouping doing its job, not a paging fault. What must hold is that no card is served
		// twice and none is unreachable.
		const keys = seen.map((c) => c.jobKey);
		expect(new Set(keys).size, "a card was served twice").toBe(keys.length);
		expect([...keys].sort()).toEqual(Array.from({ length: CARDS }, (_, i) => KEY(i)).sort());
		expect(Math.max(...sizes)).toBeLessThanOrEqual(WIRE_BUDGET_BYTES);
		expect(pages).toBeGreaterThan(1);
		console.log(
			`✓ instance_board(reasoning:true): ${seen.length}/${CARDS} cards over ${pages} pages, 0 duplicates, ` +
				`largest page ${Math.max(...sizes)} B against a ${WIRE_BUDGET_BYTES} B budget (was ${MEASURED_LIVE.reasoning} B live in one reply)`,
		);
	});

	it("puts every card in the column it belongs to, not the column its page happened to start in", async () => {
		// The failure mode paging introduced and a size assertion cannot see. The grouping is
		// rebuilt per page; if the rebuild resolved a column against the SLICE rather than the whole
		// board, cards would drift between columns as the offset moved and every card would still
		// be present exactly once.
		const h = setup();
		const whole = await h.call({ instance_id: "inst-1", limit: CARDS, offset: 0 });
		// The expected column for every card, computed from the fixture rather than from the tool.
		const expected = new Map(Array.from({ length: CARDS }, (_, i) => [KEY(i), COLUMNS[i % STATUSES.length]]));
		let offset: number | undefined;
		let pages = 0;
		const drift: string[] = [];
		while (pages < CARDS + 2) {
			const body = await h.call({ instance_id: "inst-1", ...(offset === undefined ? {} : { offset }) });
			pages++;
			for (const { jobKey, column } of cardsOf(body)) {
				if (expected.get(jobKey) !== column) drift.push(`${jobKey}: ${column} (expected ${expected.get(jobKey)})`);
			}
			const page = body.page as { nextOffset: number | null; hasMore: boolean };
			if (!page.hasMore) break;
			offset = Number(page.nextOffset);
		}
		expect(drift, "cards changed column depending on which page they landed in").toEqual([]);
		// And a column absent from a page is absent, never present-and-empty: an empty column is a
		// claim ("nothing is waiting") that a page has no standing to make.
		expect(Object.values(whole.board as Record<string, unknown[]>).every((c) => c.length > 0)).toBe(true);
	});

	it("counts the withheld reasoning over the WHOLE board, not over the page", async () => {
		// `reasoningAvailable` is the pointer to a field the default response omits (#574). Counted
		// over one page it would under-report the moment the board outgrew a single reply — the
		// note would say "3 cards carry reasoning" on a board where 118 do.
		const h = setup(boardBodyWithReasoning);
		// `limit` forces a partial page deliberately: at the live field sizes the DEFAULT read fits
		// all 118 cards in one reply, so without it this arm would assert the count over a page
		// that happens to be the whole board — which proves nothing and is how the claim rots.
		const first = await h.call({ instance_id: "inst-1", limit: 10 });
		const page = first.page as { count: number };
		expect(page.count).toBe(10);
		expect(page.count).toBeLessThan(CARDS);
		// The pointer counts every card that HAS the field, not the ten in front of the reader.
		expect(first.reasoningAvailable).toBe(CARDS);
		expect(String(first.reasoningNote)).toContain(`${CARDS} card(s)`);
	});

	it("still fits when `reasoning:true` makes every card bigger", async () => {
		// The opt-in does not get its own budget: it makes each card larger, and the page answers
		// with FEWER cards rather than a larger reply. Without this, `reasoning:true` would walk
		// straight back over the limit the rest of this file just brought it under.
		const h = setup(boardBodyWithReasoning);
		const plain = await h.call({ instance_id: "inst-1" });
		const verbose = await h.call({ instance_id: "inst-1", reasoning: true });
		expect(wireBytes(JSON.stringify(verbose))).toBeLessThanOrEqual(WIRE_BUDGET_BYTES);
		expect((verbose.page as { count: number }).count).toBeLessThan((plain.page as { count: number }).count);
		// And every card in the verbose page actually carries the field that shrank the page.
		expect(cardsOf(verbose).length).toBeGreaterThan(0);
		const board = verbose.board as Record<string, { reasoning?: string }[]>;
		expect(Object.values(board).flat().every((c) => typeof c.reasoning === "string")).toBe(true);
	});

	it("accepts a STRING offset, because a host with a stale tool list cannot send a number", async () => {
		// Measured in production the hour #614 shipped, not anticipated. A client caches the tool
		// list; one whose cache predates `offset` has no type to cast to and sends `"52"`. A bare
		// `z.number()` answers `-32602 invalid_type`, so page 1 arrives looking fixed and every
		// page after it hard-errors — 66 of this board's 118 cards unreachable, with no error a
		// caller would attribute to caching. That is worse than the payload bug it replaced,
		// because it fails silently in the direction of "the fix works".
		//
		// The schema must therefore COERCE. Asserted through the real zod parse rather than by
		// reading the source, since it is the parse that refuses.
		const h = setup();
		const schema = h.schema as { offset: { parse: (v: unknown) => unknown }; limit: { parse: (v: unknown) => unknown } };
		expect(schema.offset.parse("52")).toBe(52);
		expect(schema.limit.parse("10")).toBe(10);
		// And a bad string is still a refusal — coercion must not become "accept anything".
		expect(() => schema.offset.parse("not-a-number")).toThrow();
		expect(() => schema.offset.parse("-1")).toThrow();
	});

	it("passes an error body through instead of reshaping it into an empty board", async () => {
		// An unreadable board and an empty one are different answers — the reason `instance_board`
		// has caught its own API failure since it was written.
		const h = setup(() => ({ error: "instance not found" }));
		const body = await h.call({ instance_id: "inst-1" });
		expect(body.error).toBe("instance not found");
		expect(body.board).toBeUndefined();
	});
});
