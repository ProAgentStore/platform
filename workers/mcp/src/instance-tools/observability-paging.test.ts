import { afterEach, describe, expect, it, vi } from "vitest";
import { registerObservabilityTools } from "./observability.js";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { WIRE_BUDGET_BYTES, WIRE_LIMIT_BYTES, wireBytes } from "../wire-budget.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * #566 — `instance_messages` advertised `nextCursor`/`hasMore: true` and had no cursor input, so
 * every message older than the newest page was unreachable over MCP. `#428` had already fixed the
 * same shape one layer down (the route → the DO); the MCP tool was never brought along.
 *
 * These guards WALK the pages rather than inspecting the schema, because a schema that declares
 * `before` and a handler that drops it look identical from the outside — that is precisely the
 * failure #428 shipped once already.
 *
 * ── ADR 0002 (a guard states the size of what it measured)
 *
 * The fixture's own size is asserted before anything is walked (G1): a paging test over a
 * conversation that fits in one page proves nothing, and would pass with the defect restored. The
 * denominator — messages in the fixture, page size, pages walked — is asserted and printed (G2).
 *
 * G4, recorded 2026-08-15: reverting `observability.ts` to interpolate `?limit=` alone (dropping
 * `before`) turns three of these five RED — "walks every page …" fails `expected 9 to be 3`, the
 * page budget exhausted re-serving the newest page forever; "sends the cursor url-encoded" fails
 * because no request after the first carries `before=`; and the bad-cursor guard fails because the
 * dropped cursor is answered with a page instead of the route's 400.
 */

// ── The fixture conversation, and a fake API that pages it the way the DO does ──────────────

/** Ids oldest→newest. Deliberately not a multiple of PAGE_SIZE so the last page is short. */
const CONVERSATION = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"];
const PAGE_SIZE = 3;

/** The DO's cursor format (`agent-do.ts` / `lib/message-page.ts`), including the colons that made
 *  #566's regression note call out `encodeURIComponent`. */
const cursorFor = (id: string) => `msg:2026-08-15T00:00:0${CONVERSATION.indexOf(id)}.000Z:${id}`;

interface Page {
	messages: { id: string }[];
	nextCursor: string | null;
	hasMore: boolean;
}

/** Serve one page NEWEST-first, strictly older than `before` when given. */
function pageOf(before: string | null, limit: number): Page | { status: number; body: unknown } {
	const newestFirst = [...CONVERSATION].reverse();
	let start = 0;
	if (before) {
		const id = before.split(":").pop() ?? "";
		const at = newestFirst.indexOf(id);
		// The property `instances-chat.ts:222` deliberately preserves: a cursor the DO refuses is
		// the caller's mistake and stays visible as one, never an empty 200.
		if (at < 0 || !before.startsWith("msg:")) return { status: 400, body: { error: `Invalid cursor: ${before}` } };
		start = at + 1;
	}
	const slice = newestFirst.slice(start, start + limit);
	const last = slice[slice.length - 1];
	return {
		messages: slice.map((id) => ({ id })),
		nextCursor: last ? cursorFor(last) : null,
		hasMore: start + limit < newestFirst.length,
	};
}

interface Harness {
	call: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
	schema: Record<string, unknown>;
	urls: string[];
}

function setup(): Harness {
	const urls: string[] = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		urls.push(url);
		const q = new URL(url).searchParams;
		const out = pageOf(q.get("before"), Number(q.get("limit")) || 50);
		const failed = "status" in out;
		return new Response(JSON.stringify(failed ? out.body : out), {
			status: failed ? out.status : 200,
			headers: { "Content-Type": "application/json" },
		});
	});

	const env: McpEnv = { API_BASE: "https://api.test" };
	type CapturedTool = { schema: Record<string, unknown>; handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };
	// A holder OBJECT rather than a bare `let`. TS's control-flow analysis does not track assignments
	// made inside the fake server's callback, so a `let` stays narrowed to `null` across the
	// `registerObservabilityTools` call and `NonNullable<typeof captured>` collapses to `never` — which
	// is exactly what this file did the moment #599 put it in front of tsc. A property read is
	// invalidated by an intervening call, so `box.current` recovers its declared type honestly
	// instead of being cast back into one.
	const box: { current: CapturedTool | null } = { current: null };
	const server = {
		tool(name: string, _d: string, schema: Record<string, unknown>, handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) {
			if (name === "instance_messages") box.current = { schema, handler };
		},
	};
	const ctx: InstanceToolsCtx = {
		env,
		tokenFor: (provided?: string) => provided || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read", "write", "runtime", "destructive"] }),
		groups: new Set<string>(),
	};
	// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, same shape as instance-tools.test.ts
	registerObservabilityTools(server as any, ctx);
	const tool = box.current;
	if (!tool) throw new Error("instance_messages was not registered — the guard has stopped measuring");
	return {
		schema: tool.schema,
		urls,
		async call(args) {
			const res = await tool.handler(args);
			return JSON.parse(res.content[0].text) as Record<string, unknown>;
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("instance_messages paging (#566)", () => {
	it("the fixture is big enough for paging to mean anything", () => {
		// G1. Without this, every assertion below passes on a one-page conversation — which is the
		// state the defect produced and the reason it survived.
		expect(CONVERSATION.length).toBeGreaterThan(PAGE_SIZE);
		expect(new Set(CONVERSATION).size).toBe(CONVERSATION.length);
		expect(Math.ceil(CONVERSATION.length / PAGE_SIZE)).toBe(3);
	});

	it("declares the cursor input the response has always advertised", async () => {
		const { schema } = setup();
		expect(Object.keys(schema)).toEqual(expect.arrayContaining(["token", "instance_id", "limit", "before"]));
	});

	it("walks every page of a conversation with no overlap and no gap", async () => {
		const h = setup();
		const seen: string[] = [];
		let before: string | undefined;
		let pages = 0;
		// A hard budget rather than an assertion inside the loop: a cursor that never advances must
		// fail on the DUPLICATES it collected (which names the defect) rather than on a spin guard.
		const budget = CONVERSATION.length + 2;
		while (pages < budget) {
			const body = await h.call({ instance_id: "inst-1", limit: PAGE_SIZE, ...(before ? { before } : {}) });
			pages++;
			expect(body.error).toBeUndefined();
			const msgs = body.messages as { id: string }[];
			expect(msgs.length).toBeGreaterThan(0);
			seen.push(...msgs.map((m) => m.id));
			if (!body.hasMore) break;
			before = String(body.nextCursor);
		}
		// The denominator, asserted rather than assumed (G1/G2): as many pages as the fixture
		// requires, and EVERY message exactly once, newest→oldest.
		expect(pages).toBe(Math.ceil(CONVERSATION.length / PAGE_SIZE));
		expect(seen).toEqual([...CONVERSATION].reverse());
		expect(new Set(seen).size).toBe(CONVERSATION.length);
		expect(h.urls).toHaveLength(pages);
		console.log(`✓ instance_messages: ${seen.length}/${CONVERSATION.length} messages over ${pages} pages of ${PAGE_SIZE}, 0 duplicates`);
	});

	it("sends the cursor url-encoded, and only when given one", async () => {
		const h = setup();
		await h.call({ instance_id: "inst-1", limit: PAGE_SIZE });
		await h.call({ instance_id: "inst-1", limit: PAGE_SIZE, before: cursorFor("m5") });
		expect(h.urls).toHaveLength(2);
		expect(h.urls[0]).not.toContain("before=");
		// `msg:<iso>:<id>` — encoded, not interpolated raw.
		expect(h.urls[1]).toContain(`before=${encodeURIComponent(cursorFor("m5"))}`);
		expect(h.urls[1]).not.toContain(`before=${cursorFor("m5")}`);
	});

	it("surfaces the route's 400 for a bad cursor instead of an empty page", async () => {
		const h = setup();
		const body = await h.call({ instance_id: "inst-1", before: "not-a-cursor" });
		expect(String(body.error)).toContain("Invalid cursor");
		expect(body.messages).toBeUndefined();
	});
});

// ── agent_trace (#614) ───────────────────────────────────────────────────────────────────────

/**
 * `agent_trace` served **163,437 bytes** on the live account — 2.5x a calling host's 64 KiB limit,
 * and the largest offender the #595 sweep found. It is also the tool the server's own
 * `instructions` string tells a client to reach for FIRST when debugging an agent, so a host that
 * enforces the limit could not perform the documented first step of debugging.
 *
 * The window it reads is bounded (`limit`, default 200); the BYTES in that window never were.
 *
 * Attributed on the LIVE body before the remedy, per #595 — 163,240 B over 200 events on the
 * worst of 17 swept instances, 2.49x the limit and within 0.2% of the 163,437 B #595 recorded:
 *
 *   · `context` **57.5%** (93,896 B). Inside it one sub-key dominates: the model's `thought`
 *     prose is ~39.6% of the ENTIRE wire, on 186 of 200 rows.
 *   · `trace_id` 6.8%, `instance_id` 6.5%, `id` 5.4%, `user_id` 5.0%, `message` only 4.9%.
 *
 * That distribution is worth stating because the obvious guess is wrong twice over: `message`
 * reads like the payload and is a twentieth of it, and 21.2% of every reply is the request
 * restated per row — `instance_id` holds ONE distinct value across all 200 rows (and equals the
 * top-level `instanceId` and the argument the caller just passed), `user_id` likewise, and
 * `created_at` is `ts` truncated to the second on 173 of 200 rows.
 *
 * Those are recorded, NOT trimmed. #595's finding is that a trim moves the cliff instead of
 * removing it: deleting all four redundant columns leaves ~129 KB, still twice the ceiling, and
 * `limit`'s own max of 1000 projects to ~815 KB on the same rows. The collection is unbounded, so
 * the bound belongs on the collection.
 *
 * These guards WALK the pages. A schema that declares `offset` and a handler that ignores it look
 * identical from the outside — #566 shipped exactly that shape one tool up in this same file.
 */

/** 200 events, the tool's own default window, at the row shape production served. */
const TRACE_EVENTS = 200;
/** What the deployed handler served for this window, re-measured live on 2026-08-16 on the worst
 *  of 17 swept instances ("Facebook Friends"). #595 recorded 163,437 B for the same call the day
 *  before; the two agree to 0.2%, which is what makes both trustworthy. */
const TRACE_MEASURED_LIVE = 163_240;
const traceBody = () => ({
	instanceId: "inst-1",
	count: TRACE_EVENTS,
	events: Array.from({ length: TRACE_EVENTS }, (_, i) => ({
		id: `evt_${String(i).padStart(28, "0")}`,
		trace_id: `trace_${String(i >> 3).padStart(28, "0")}`,
		// 186 of the live 200 rows were this event type, and they carried 95% of all row bytes.
		source: "apply",
		event: "agent.decision",
		level: "info",
		// Sized from the LIVE rows, not invented: `context` a ~458-byte escaped JSON string (57.5%
		// of the body, the model's `thought` prose inside it) against a ~29-byte `message`. A
		// fixture with those two the other way round would page correctly and prove nothing about
		// the payload production actually serves.
		message: "clicked button \"Next\"",
		context: JSON.stringify({ thought: "I need to find the field that asks for the notice period before I can answer it. ".repeat(5), action: "click", name: "Next" }),
		// The request, restated per row: one distinct value across all 200 rows, live.
		instance_id: "6d2d9401-9b67-4a0d-89ff-0f43ef73b3b0",
		user_id: "user_9f2c1b7e4a3d",
		// `ts` truncated to the second — 173 of 200 rows carried exactly this pair.
		created_at: "2026-08-14 22:03:51",
		ts: "2026-08-14T22:03:51.000Z",
	})),
});

function setupTrace(): Harness {
	const urls: string[] = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		urls.push(typeof input === "string" ? input : input.toString());
		return new Response(JSON.stringify(traceBody()), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	const env: McpEnv = { API_BASE: "https://api.test" };
	type CapturedTool = { schema: Record<string, unknown>; handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };
	const box: { current: CapturedTool | null } = { current: null };
	const server = {
		tool(name: string, _d: string, schema: Record<string, unknown>, handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) {
			if (name === "agent_trace") box.current = { schema, handler };
		},
	};
	const ctx: InstanceToolsCtx = {
		env,
		tokenFor: (provided?: string) => provided || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read", "write", "runtime", "destructive"] }),
		groups: new Set<string>(),
	};
	// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, same shape as above
	registerObservabilityTools(server as any, ctx);
	const tool = box.current;
	if (!tool) throw new Error("agent_trace was not registered — the guard has stopped measuring");
	return {
		schema: tool.schema,
		urls,
		async call(args) {
			const res = await tool.handler(args);
			return JSON.parse(res.content[0].text) as Record<string, unknown>;
		},
	};
}

describe("agent_trace paging (#614)", () => {
	it("the fixture is over the host limit AND the size production served", () => {
		// G1, and the arm that stops this whole suite passing on a body that never needed paging.
		// The unbudgeted window must exceed what the host refuses — that is the defect's ground.
		const raw = wireBytes(JSON.stringify(traceBody()));
		expect(raw).toBeGreaterThan(WIRE_LIMIT_BYTES);
		expect(TRACE_EVENTS).toBe(200);
		// Calibrated, not merely "large" — the standard #615 sets and the one #569 failed: its
		// guard asserted ~54 KB against a production response of 66,042 B and passed. 5% absorbs
		// the wording of filler prose and nothing more, so a fixture trimmed to make a size
		// assertion pass fails HERE instead of quietly measuring a payload nobody is served.
		const off = Math.abs(raw - TRACE_MEASURED_LIVE) / TRACE_MEASURED_LIVE;
		expect(off, `fixture ${raw} B vs ${TRACE_MEASURED_LIVE} B measured live`).toBeLessThanOrEqual(0.05);
	});

	it("declares the cursor, and keeps `limit` meaning the WINDOW it always meant", async () => {
		const { schema } = setupTrace();
		expect(Object.keys(schema)).toEqual(expect.arrayContaining(["instance_id", "trace_id", "source", "level", "limit", "offset"]));
	});

	it("walks every event with no overlap and no gap, every page inside the budget", async () => {
		// THE acceptance criterion of #614: silent truncation is the defect, not the size. A tool
		// that fits by dropping the other 145 events would pass every size assertion in the repo
		// and be worse than the bug.
		const h = setupTrace();
		const seen: string[] = [];
		const sizes: number[] = [];
		let offset: number | undefined;
		let pages = 0;
		const budget = TRACE_EVENTS + 2;
		while (pages < budget) {
			const body = await h.call({ instance_id: "inst-1", ...(offset === undefined ? {} : { offset }) });
			pages++;
			sizes.push(wireBytes(JSON.stringify(body)));
			// The whole window's size rides in front of the page and is never reduced (#503).
			expect(body.count).toBe(TRACE_EVENTS);
			const page = body.page as { of: number; count: number; nextOffset: number | null; hasMore: boolean };
			expect(page.of).toBe(TRACE_EVENTS);
			const events = body.events as { id: string }[];
			expect(events.length).toBeGreaterThan(0);
			seen.push(...events.map((e) => e.id));
			if (!page.hasMore) {
				expect(page.nextOffset).toBeNull();
				break;
			}
			offset = Number(page.nextOffset);
		}
		// Every event exactly once, in order, and nothing invented.
		expect(seen).toEqual(Array.from({ length: TRACE_EVENTS }, (_, i) => `evt_${String(i).padStart(28, "0")}`));
		expect(new Set(seen).size).toBe(TRACE_EVENTS);
		// And every page is deliverable — the point of the exercise.
		expect(Math.max(...sizes)).toBeLessThanOrEqual(WIRE_BUDGET_BYTES);
		expect(pages).toBeGreaterThan(1);
		console.log(
			`✓ agent_trace: ${seen.length}/${TRACE_EVENTS} events over ${pages} pages, 0 duplicates, ` +
				`largest page ${Math.max(...sizes)} B against a ${WIRE_BUDGET_BYTES} B budget (was 163,437 B in one reply)`,
		);
	});

	it("passes an error body through instead of reshaping it into an empty timeline", async () => {
		// An unreadable trace and an empty one are different answers. Reshaping the first into the
		// second is how "the agent did nothing" gets reported for an instance nobody could read.
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "instance not found" }), { status: 200, headers: { "Content-Type": "application/json" } }));
		const env: McpEnv = { API_BASE: "https://api.test" };
		type CapturedTool = { handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };
		const box: { current: CapturedTool | null } = { current: null };
		const server = {
			tool(name: string, _d: string, _s: Record<string, unknown>, handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) {
				if (name === "agent_trace") box.current = { handler };
			},
		};
		const ctx: InstanceToolsCtx = {
			env,
			tokenFor: () => "session-token",
			safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read"] }),
			groups: new Set<string>(),
		};
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server
		registerObservabilityTools(server as any, ctx);
		const tool = box.current;
		if (!tool) throw new Error("agent_trace was not registered");
		const body = JSON.parse((await tool.handler({ instance_id: "inst-1" })).content[0].text) as Record<string, unknown>;
		expect(body.error).toBe("instance not found");
		expect(body.page).toBeUndefined();
		expect(body.events).toBeUndefined();
	});
});
