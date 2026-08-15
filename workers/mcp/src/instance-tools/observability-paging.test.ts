import { afterEach, describe, expect, it, vi } from "vitest";
import { registerObservabilityTools } from "./observability.js";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
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
