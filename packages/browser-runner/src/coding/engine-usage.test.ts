import { describe, expect, it } from "vitest";
import { parseEngineUsage } from "./engine-usage.js";

/**
 * A real `result` event, captured from `claude -p --output-format stream-json` (2.1.223),
 * trimmed to the fields that matter. Kept verbatim rather than idealised: the field names are
 * snake_case in `usage` and camelCase in `modelUsage`, and getting that wrong is exactly how
 * this silently reports zeros.
 */
const RESULT = {
	type: "result",
	subtype: "success",
	is_error: false,
	session_id: "b81e7aa7-e976-4740-a517-8d0d709eed5f",
	uuid: "c23b4613-9e55-4e6f-9e85-5847aa0c1aad",
	total_cost_usd: 0.1347565,
	usage: {
		input_tokens: 2,
		cache_creation_input_tokens: 12701,
		cache_read_input_tokens: 15273,
		output_tokens: 4,
	},
	modelUsage: {
		"claude-opus-5[1m]": { inputTokens: 2, outputTokens: 4, costUSD: 0.1347565 },
	},
	result: "OK",
};

describe("parseEngineUsage", () => {
	it("reads tokens + the CLI's own cost off a real result event", () => {
		const u = parseEngineUsage(RESULT, "fallback");
		expect(u).toMatchObject({
			id: "c23b4613-9e55-4e6f-9e85-5847aa0c1aad",
			provider: "anthropic",
			model: "claude-opus-5[1m]",
			inputTokens: 2,
			outputTokens: 4,
			cacheReadTokens: 15273,
			cacheWriteTokens: 12701,
			costUsd: 0.1347565,
		});
	});

	it("keeps cache reads and writes apart from input", () => {
		// Summing them into `input` is the bug #212 fixed on the cloud side: a cache read bills at
		// a tenth of a fresh input token, so folding them together both overstates cost and hides
		// whether prompt caching works at all — the number a coding session lives or dies on.
		const u = parseEngineUsage(RESULT, "fallback");
		expect(u?.inputTokens).toBe(2);
		expect(u?.cacheReadTokens).toBe(15273);
	});

	it("ignores anything that is not a result event", () => {
		// The turn's stream carries system/assistant/user events too; each of them going through
		// here would append a bogus record per line.
		expect(parseEngineUsage({ type: "assistant", message: { content: [] } }, "f")).toBeNull();
		expect(parseEngineUsage({ type: "system", subtype: "init" }, "f")).toBeNull();
		expect(parseEngineUsage("not json", "f")).toBeNull();
		expect(parseEngineUsage(null, "f")).toBeNull();
	});

	it("returns null for a result event with no measurement — never a zeroed record", () => {
		// An engine or CLI version that does not report usage must leave a GAP in the ledger. A
		// zero row would read as "this turn was free", which is a stronger claim than silence and
		// a wrong one (#267).
		expect(parseEngineUsage({ type: "result", is_error: false, result: "done" }, "f")).toBeNull();
		expect(parseEngineUsage({ type: "result", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } }, "f")).toBeNull();
	});

	it("records an ERRORED turn — a failure still burned tokens", () => {
		const u = parseEngineUsage({ ...RESULT, is_error: true, subtype: "error_during_execution" }, "f");
		expect(u?.costUsd).toBe(0.1347565);
	});

	it("falls back to the supplied id when the CLI emits no uuid", () => {
		// Older Claude Code builds have no `uuid` on the result event. Without a fallback the
		// record would have no dedup key and the cloud would drop it.
		const { uuid: _omitted, ...noUuid } = RESULT;
		expect(parseEngineUsage(noUuid, "sess-1:ab12cd34:0")?.id).toBe("sess-1:ab12cd34:0");
	});

	it("attributes a multi-model turn to the most expensive model", () => {
		// A subagent can run on a cheaper model in the same turn, and the ledger has one model per
		// row. Labelling the row with the cheap helper would make an expensive session disappear
		// from the by-model breakdown that exists to find it.
		const u = parseEngineUsage(
			{
				...RESULT,
				modelUsage: {
					"claude-haiku-4": { costUSD: 0.0001 },
					"claude-opus-5": { costUSD: 0.13 },
				},
			},
			"f",
		);
		expect(u?.model).toBe("claude-opus-5");
	});

	it("says 'unknown' rather than throwing when modelUsage is missing", () => {
		const { modelUsage: _omitted, ...noModels } = RESULT;
		expect(parseEngineUsage(noModels, "f")?.model).toBe("unknown");
	});

	it("reads Codex token usage from turn.completed without inventing a cost", () => {
		const u = parseEngineUsage(
			{
				type: "turn.completed",
				usage: {
					input_tokens: 10,
					cached_input_tokens: 20,
					cache_write_input_tokens: 3,
					output_tokens: 4,
					reasoning_output_tokens: 2,
				},
			},
			"codex-turn-1",
		);
		expect(u).toMatchObject({
			id: "codex-turn-1",
			provider: "openai",
			model: "codex",
			inputTokens: 10,
			cacheReadTokens: 20,
			cacheWriteTokens: 3,
			outputTokens: 4,
			costUsd: 0,
		});
	});
});
