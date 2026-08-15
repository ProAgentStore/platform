/**
 * A ticket's `reasoning` can be READ back over MCP, and costs nothing when not asked for (#574).
 *
 * `write-readback.test.ts` next door proves the QUESTION was asked of all 346 write-tool
 * arguments; it cannot prove an answer is true, because its table is declared. This file is the
 * second proof for the one entry that matters: it drives the real `instance_board` handler
 * against a board payload shaped like the measured one and reads the field back off the wire.
 *
 * The fixture's sizes are the real ones from the issue — the delegation card for session
 * `csess_e80b6a21` on instance `bd43f4de-…`: `description` 375 chars, `reasoning` 691. That is
 * what makes the payload delta below a measurement rather than an illustration.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerBoardTools } from "./board.js";
import type { InstanceToolsCtx } from "./shared.js";

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

const env: McpEnv = { API_BASE: "https://api.test" };

/** 375 and 691 characters — the two lengths measured on the real card. */
const DESCRIPTION = "d".repeat(375);
const REASONING = "r".repeat(691);

const BOARD = {
	columns: [
		{ id: "needs_you", title: "Needs you", statuses: ["needs_human"] },
		{ id: "done", title: "Submitted", statuses: ["completed"], catchAll: true },
	],
	items: [
		{
			jobKey: "csess_e80b6a21",
			title: "Delegation run",
			status: "needs_human",
			description: DESCRIPTION,
			reasoning: REASONING,
			latestTaskId: "task-1",
		},
		{ jobKey: "job-2", title: "Second", status: "completed", description: "short", reasoning: REASONING },
		// A card with NO reasoning: the withheld-count must be a measurement of the cards that
		// actually have one, not of the board size.
		{ jobKey: "job-3", title: "Third", status: "completed", description: "short" },
	],
};

let tools: Map<string, { schema: Shape; handler: Handler }>;

beforeEach(() => {
	vi.stubGlobal("fetch", async () =>
		new Response(JSON.stringify(BOARD), { status: 200, headers: { "Content-Type": "application/json" } }),
	);
	tools = new Map();
	const ctx: InstanceToolsCtx = {
		env,
		tokenFor: (provided?: string) => provided || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read", "write", "runtime", "destructive"] }),
	} as InstanceToolsCtx;
	registerBoardTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server
		{ tool: (name: string, _d: string, schema: Shape, handler: Handler) => void tools.set(name, { schema, handler }) } as any,
		ctx,
	);
});

async function board(args: Record<string, unknown> = {}): Promise<{ text: string; json: Record<string, unknown> }> {
	const t = tools.get("instance_board");
	if (!t) throw new Error("instance_board not registered");
	const text = (await t.handler({ instance_id: "inst-1", ...args })).content[0].text;
	return { text, json: JSON.parse(text) };
}

/** Every card in the response, across all columns. */
function cards(json: Record<string, unknown>): Record<string, unknown>[] {
	const b = json.board as Record<string, Record<string, unknown>[]>;
	return Object.values(b).flat();
}

describe("instance_board reasoning (#574)", () => {
	it("declares `reasoning` as an input, so the field the writer accepts can be asked for", () => {
		// The defect was not that the data was missing — the API sends it. It was that no argument
		// existed to ask for it, exactly as #566's `before` did not exist.
		expect(Object.keys(tools.get("instance_board")?.schema ?? {})).toContain("reasoning");
	});

	it("omits reasoning by default, and SAYS it is withholding it, counting the cards that have one", async () => {
		const { json } = await board();
		const all = cards(json);
		expect(all).toHaveLength(3);
		expect(all.every((c) => c.reasoning === undefined)).toBe(true);
		// The measurement, not the board size: 2 of the 3 cards carry reasoning.
		expect(json.reasoningAvailable).toBe(2);
		expect(String(json.reasoningNote)).toContain("reasoning:true");
		// `detail` is untouched — this fix adds a field, it does not move one.
		expect(all.find((c) => c.jobKey === "csess_e80b6a21")?.detail).toBe(DESCRIPTION);
	});

	it("returns the FULL reasoning when asked, uncut", async () => {
		const { json } = await board({ reasoning: true });
		const card = cards(json).find((c) => c.jobKey === "csess_e80b6a21");
		expect(card?.reasoning).toBe(REASONING);
		expect(String(card?.reasoning)).toHaveLength(691);
		// A card with no reasoning stays absent rather than gaining an empty string.
		expect(cards(json).find((c) => c.jobKey === "job-3")?.reasoning).toBeUndefined();
		// Nothing is withheld, so nothing claims to be.
		expect(json.reasoningAvailable).toBeUndefined();
	});

	it("the size decision is backed by a measured delta on this board", async () => {
		const withoutBytes = new TextEncoder().encode((await board()).text).length;
		const withBytes = new TextEncoder().encode((await board({ reasoning: true })).text).length;
		const added = withBytes - withoutBytes;

		// The accounting, stated rather than approximated: opting in ADDS two reasoning strings
		// (2 × 691 chars) and REMOVES the withheld-note that only appears when they are absent. So
		// the net delta is smaller than the prose itself, and asserting `> 2 × 691` would have been
		// wrong for a reason worth naming here — it measured 1206 against an expected 1243.
		const noteBytes = new TextEncoder().encode(JSON.stringify({ reasoningAvailable: 2, reasoningNote: String(JSON.parse((await board()).text).reasoningNote) })).length;
		expect(added).toBeGreaterThan(2 * 691 - noteBytes);

		// This is the whole argument for opt-in rather than "just add the field": on a 3-card
		// board it is already a >50% increase, and a real board is not 3 cards.
		expect(added / withoutBytes).toBeGreaterThan(0.5);

		console.log(
			`✓ instance_board payload: 3 cards (2 with reasoning) — ${withoutBytes} B default, ` +
				`${withBytes} B with reasoning:true (+${added} B, +${Math.round((added / withoutBytes) * 100)}%; ` +
				`+${2 * 691} B of prose less the ${noteBytes} B withheld-note it replaces)`,
		);
	});
});
