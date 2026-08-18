/**
 * What `coding_terminal` puts ON THE WIRE at its DEFAULT limit (#699 AC4).
 *
 * ── Why the default, and why the fixture is a production-sized pane
 *
 * This tool exists to return a snapshot UNCUT, so it is the one tool in the coding surface whose
 * payload is a single row's true length. That makes the row cap the only bound there is, and the
 * default value of `limit` the only bound a model will ever actually hit — a caller that names no
 * limit is the caller a host refuses.
 *
 * #569 is the standing reason to assert it that way round. Its guard passed at ~54,000 B while
 * production served 66,042 B, because the assertion measured a convenient page rather than the one
 * the tool really emits. #578 is the same tool still 653 B over on the path nobody measured. So the
 * fixture here is a snapshot at `TERMINAL_SNAPSHOT_CHARS` — 8,000 characters, the cap
 * `snapshotForStore` applies at write time and the size production's mean (8,068) reflects — and
 * the tool is driven with NO arguments beyond the instance, which is the default call.
 *
 * ── What the arms prove, in order
 *
 *   1. the denominator: the reply carries a whole 8,000-char pane, not a tail. Without this the
 *      size assertion passes on an empty page, which is ADR 0002's "certifying ground it never
 *      walked" — and is exactly the failure this tool was written to fix.
 *   2. the default fits `WIRE_LIMIT_BYTES`, with the margin stated rather than implied.
 *   3. `max` — 4 snapshots, the ceiling the schema allows — fits, and fits on the 12,000-char rows
 *      written before the cap existed too. That is the arm that catches a later raise of the cap.
 *   4. the ground: #699's whole eight-snapshot session in one reply is OVER the limit, so the row
 *      cap is doing the work rather than the fixture being conveniently small.
 *
 * One correction to the issue, recorded because the number is quotable: it says "a `limit` above 4
 * puts a reply over 64 KiB". Measured here, a snapshot is 8,506 B on the wire, so five would be
 * ~42 KB and still fit — 4 is a margin, not a cliff. The cliff at today's row size is nearer eight,
 * which is exactly the session #699 measured, and arm 4 is that measurement.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { WIRE_LIMIT_BYTES, wireBytes } from "../wire-budget.js";
import { registerCodingTools } from "./coding.js";
import type { InstanceToolsCtx } from "./shared.js";

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

const env: McpEnv = { API_BASE: "https://api.test" };

/** `TERMINAL_SNAPSHOT_CHARS` in `workers/api/src/lib/terminal-snapshot.ts` — the write-time cap. */
const SNAPSHOT_CHARS = 8_000;

/** A pane the size the runner really stores, newlines and all (JSON-escaped to two bytes each). */
const pane = (seq: number) => `[seq ${seq}] ${"claude working on the thing\n".repeat(400)}`.slice(0, SNAPSHOT_CHARS);

/** The route's `?terminal=1` reply, at whatever `limit` the tool asked for. */
function terminalPage(limit: number): Record<string, unknown> {
	return {
		sessionId: "csess_613d1455-c882-4899-9117-1e3670e94027",
		sessionStatus: "ended",
		entries: Array.from({ length: limit }, (_, i) => ({
			seq: 9000 - i,
			type: "terminal",
			content: pane(9000 - i),
			createdAt: "2026-08-18 09:12:57",
		})),
		hasMore: true,
		oldestSeq: 9000 - (limit - 1),
		newestSeq: 9000,
	};
}

let tools: Map<string, { schema: Shape; handler: Handler }>;
let askedFor: number | null;

beforeEach(() => {
	askedFor = null;
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		if (!url.includes("/coding/timeline")) {
			return new Response(JSON.stringify({ instances: [{ id: "inst-1", agentSlug: "coder" }] }), { status: 200 });
		}
		// The route's own clamp, restated where the fixture can honour it: the tool's `limit` is what
		// decides how many rows come back, so a fixture with a fixed row count would measure the
		// fixture rather than the default.
		askedFor = Number(new URL(url).searchParams.get("limit"));
		return new Response(JSON.stringify(terminalPage(askedFor)), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	tools = new Map();
	const ctx: InstanceToolsCtx = {
		env,
		tokenFor: (provided?: string) => provided || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read", "write", "runtime", "destructive"] }),
		groups: new Set(["coding"]),
	} as InstanceToolsCtx;
	registerCodingTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server
		{ tool: (name: string, _d: string, schema: Shape, handler: Handler) => void tools.set(name, { schema, handler }) } as any,
		ctx,
	);
});

function tool() {
	const t = tools.get("coding_terminal");
	if (!t) throw new Error("coding_terminal not registered");
	return t;
}

describe("coding_terminal wire size (#699 AC4)", () => {
	it("fits the host limit at its DEFAULT limit, carrying a whole 8,000-character pane", async () => {
		const out = await tool().handler({ instance_id: "inst-1" });
		const bytes = wireBytes(out.content[0].text);

		// G1 — the denominator. This tool's entire purpose is the uncut pane, so a reply that had
		// dropped it, or served a tail, would satisfy any size assertion by measuring nothing.
		const parsed = JSON.parse(out.content[0].text) as { entries: { content: string }[]; sessionStatus: string };
		expect(askedFor).toBe(1);
		expect(parsed.entries).toHaveLength(1);
		expect(parsed.entries[0].content).toHaveLength(SNAPSHOT_CHARS);
		// The case the tool exists for: a session that has ENDED, whose live pane is empty.
		expect(parsed.sessionStatus).toBe("ended");

		expect(bytes).toBeLessThan(WIRE_LIMIT_BYTES);
		// Compact, like every result since #586 — asserted directly rather than trusted to the
		// helper, because "it happens to fit" is not the claim "it is sent the way the fix sends it".
		expect(out.content[0].text).toBe(JSON.stringify(parsed));

		console.log(`✓ coding_terminal default (limit 1): ${bytes} B of the ${WIRE_LIMIT_BYTES} B host limit`);
	});

	it("fits at the schema's ceiling of 4 even on the corpus's largest rows, where the whole session does not", async () => {
		const max = await tool().handler({ instance_id: "inst-1", limit: 4 });
		const atMax = wireBytes(max.content[0].text);
		expect(askedFor).toBe(4);
		expect((JSON.parse(max.content[0].text) as { entries: unknown[] }).entries).toHaveLength(4);
		expect(atMax).toBeLessThan(WIRE_LIMIT_BYTES);

		// The schema refuses a fifth. Asserted on the REGISTERED shape rather than described in a
		// comment, because the ceiling is the only bound this tool has.
		const limit = tool().schema.limit;
		expect(limit.safeParse(4).success).toBe(true);
		expect(limit.safeParse(5).success).toBe(false);

		// The worst row D1 actually holds is not the 8,000-char cap: `lib/coding-timeline.ts` records
		// a 12,000-char max from rows written before `snapshotForStore` capped them, and those rows
		// are still readable. Four of THOSE fit too, which is what makes 4 a safe ceiling rather than
		// one that happens to hold for today's writes.
		const legacy = wireBytes(
			JSON.stringify({ ...terminalPage(4), entries: Array.from({ length: 4 }, (_, i) => ({ seq: 9000 - i, type: "terminal", content: pane(i).repeat(2).slice(0, 12_000), createdAt: "2026-08-18 09:12:57" })) }),
		);
		expect(legacy).toBeLessThan(WIRE_LIMIT_BYTES);

		// And the ground this walks. #699's measured session holds EIGHT snapshots, 64,000 characters
		// — returning them in one reply, which is what "just send the whole thing" would mean, is over
		// the host limit. So the row cap is carrying real weight rather than the fixture being small,
		// and `before` walking back is the only way the whole 64,000 is reachable.
		const wholeSession = wireBytes(JSON.stringify(terminalPage(8)));
		expect(wholeSession).toBeGreaterThan(WIRE_LIMIT_BYTES);

		console.log(
			`✓ coding_terminal at limit 4: ${atMax} B (${legacy} B on 12,000-char legacy rows); ` +
				`all 8 of #699's snapshots in one reply would be ${wholeSession} B, over the ${WIRE_LIMIT_BYTES} B limit`,
		);
	});
});
