import { describe, expect, it } from "vitest";
import {
	AnthropicStreamAssembler,
	AnthropicStreamError,
	assembleAnthropicStream,
	parseSseEvents,
} from "./anthropic-stream.js";

/** The frames a real reply produces, in the order the API sends them. */
function textReply(text: string, stopReason = "end_turn"): Record<string, unknown>[] {
	return [
		{ type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 900 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 41 } },
		{ type: "message_stop" },
	];
}

describe("parseSseEvents", () => {
	it("carries a half-arrived frame forward instead of parsing or dropping it", () => {
		// The failure this prevents is invisible: a chunk boundary lands mid-JSON on any reply long
		// enough to matter, and a parser that discarded the remainder would lose whole sentences from
		// exactly the long replies #427 is about.
		const whole = 'event: x\ndata: {"type":"a"}\n\nevent: y\ndata: {"type":"b"}\n\n';
		const cut = whole.length - 12;
		const first = parseSseEvents(whole.slice(0, cut));
		expect(first.events).toEqual([{ type: "a" }]);
		const second = parseSseEvents(first.rest + whole.slice(cut));
		expect(second.events).toEqual([{ type: "b" }]);
		expect(second.rest).toBe("");
	});

	it("ignores the event: line, comment keep-alives and [DONE]", () => {
		const { events } = parseSseEvents(': keep-alive\n\nevent: ping\ndata: {"type":"ping"}\n\ndata: [DONE]\n\n');
		expect(events).toEqual([{ type: "ping" }]);
	});

	it("tolerates CRLF framing", () => {
		const { events } = parseSseEvents('event: a\r\ndata: {"type":"a"}\r\n\r\n');
		expect(events).toEqual([{ type: "a" }]);
	});

	it("refuses a frame that is not JSON rather than skipping it silently", () => {
		expect(() => parseSseEvents("data: not json\n\n")).toThrow(AnthropicStreamError);
	});
});

describe("AnthropicStreamAssembler", () => {
	it("rebuilds exactly the body the non-streaming endpoint would have returned", () => {
		// The whole premise of #427's regression note: callers see no change at all, because this is
		// byte-for-byte the shape runAnthropic already reads.
		expect(assembleAnthropicStream(textReply("Issue #112 is live."))).toEqual({
			content: [{ type: "text", text: "Issue #112 is live." }],
			usage: { input_tokens: 12, cache_read_input_tokens: 900, output_tokens: 41 },
			stop_reason: "end_turn",
		});
	});

	it("keeps cache usage separate from input usage across the two frames that carry it", () => {
		// #212: a cache read bills at 0.1x and a write at 1.25x. `message_start` carries input and the
		// cache counts, `message_delta` carries output — merging rather than replacing is what keeps
		// all four alive for the ledger.
		const body = assembleAnthropicStream([
			{
				type: "message_start",
				message: { usage: { input_tokens: 3, cache_read_input_tokens: 5000, cache_creation_input_tokens: 20 } },
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: {}, usage: { output_tokens: 7 } },
			{ type: "message_stop" },
		]);
		expect(body.usage).toEqual({
			input_tokens: 3,
			cache_read_input_tokens: 5000,
			cache_creation_input_tokens: 20,
			output_tokens: 7,
		});
	});

	it("reassembles a tool call from its argument fragments", () => {
		const body = assembleAnthropicStream([
			{ type: "message_start", message: { usage: {} } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "reading" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "github_read_issue", input: {} } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"num' } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'ber": 111}' } },
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} },
			{ type: "message_stop" },
		]);
		expect(body.content[1]).toEqual({ type: "tool_use", id: "tu_1", name: "github_read_issue", input: { number: 111 } });
		expect(body.stop_reason).toBe("tool_use");
	});

	it("gives a tool call with no argument deltas an empty object, not a broken one", () => {
		const body = assembleAnthropicStream([
			{ type: "message_start", message: { usage: {} } },
			{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "get_tasks", input: {} } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_stop" },
		]);
		expect(body.content[0].input).toEqual({});
	});

	it("refuses a tool call whose arguments arrived incomplete", () => {
		// A half-built call is worse than no call: the tool loop would execute it, and a mutating tool
		// with the wrong arguments commits a side effect nobody asked for.
		expect(() =>
			assembleAnthropicStream([
				{ type: "message_start", message: { usage: {} } },
				{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "github_create_issue", input: {} } },
				{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"title": "half' } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_stop" },
			]),
		).toThrow(/github_create_issue/);
	});

	it("refuses to return a message that never reached message_stop", () => {
		// #397 with a new cause: a reply cut off mid-sentence, stored and displayed as the whole answer.
		// The platform knows it is partial, so it says so.
		expect(() => assembleAnthropicStream(textReply("half an ans").slice(0, -1))).toThrow(/mid-stream/);
	});

	it("surfaces a mid-stream provider error instead of returning what arrived before it", () => {
		const assembler = new AnthropicStreamAssembler();
		assembler.push({ type: "message_start", message: { usage: {} } });
		expect(() => assembler.push({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })).toThrow(
			/Overloaded/,
		);
	});

	it("refuses a delta for a block that never started, rather than dropping the text", () => {
		const assembler = new AnthropicStreamAssembler();
		assembler.push({ type: "message_start", message: { usage: {} } });
		expect(() => assembler.push({ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "x" } })).toThrow(
			AnthropicStreamError,
		);
	});

	it("ignores block types the platform never asked for", () => {
		// `thinking_delta` arrives only if extended thinking is requested, which it never is. Dropping
		// it must not be able to fail the turn.
		const assembler = new AnthropicStreamAssembler();
		for (const event of [
			{ type: "message_start", message: { usage: {} } },
			{ type: "ping" },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_stop" },
		]) {
			assembler.push(event);
		}
		expect(assembler.finish().content).toEqual([{ type: "text", text: "ok" }]);
	});

	it("reports done only once message_stop has arrived", () => {
		const assembler = new AnthropicStreamAssembler();
		assembler.push({ type: "message_start", message: { usage: {} } });
		expect(assembler.done).toBe(false);
		assembler.push({ type: "message_stop" });
		expect(assembler.done).toBe(true);
	});

	it("returns blocks in index order whatever order the frames closed in", () => {
		const assembler = new AnthropicStreamAssembler();
		assembler.push({ type: "message_start", message: { usage: {} } });
		assembler.push({ type: "content_block_start", index: 1, content_block: { type: "text", text: "second" } });
		assembler.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "first" } });
		assembler.push({ type: "message_stop" });
		expect(assembler.finish().content.map((b) => b.text)).toEqual(["first", "second"]);
	});

	it("omits stop_reason entirely when the provider never sent one", () => {
		// Not "end_turn" by default: `hitOutputCap` reads this field, and inventing a verdict is how a
		// truncated reply would start looking finished again (#397).
		const body = assembleAnthropicStream([
			{ type: "message_start", message: { usage: {} } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } },
			{ type: "message_stop" },
		]);
		expect(body.stop_reason).toBeUndefined();
	});
});
