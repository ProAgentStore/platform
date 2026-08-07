import { describe, expect, it } from "vitest";
import { turnSpanFor } from "./chat-turns.js";

const log = (...pairs: [string, string][]) => pairs.map(([id, role]) => ({ id, role }));

/** The shape a real exchange has in the DO: ask → tool log → reply. */
const conversation = log(
	["u1", "user"],
	["t1", "system"],
	["a1", "assistant"],
	["u2", "user"],
	["a2", "assistant"],
	["u3", "user"],
	["a3", "assistant"],
);

describe("turnSpanFor", () => {
	it("takes the whole exchange when the user message is the target", () => {
		expect(turnSpanFor(conversation, "u2").map((m) => m.id)).toEqual(["u2", "a2"]);
	});

	it("resolves an assistant message back to the ask it answered", () => {
		expect(turnSpanFor(conversation, "a1").map((m) => m.id)).toEqual(["u1", "t1", "a1"]);
	});

	it("resolves the tool log to the same turn as the reply beside it", () => {
		expect(turnSpanFor(conversation, "t1")).toEqual(turnSpanFor(conversation, "a1"));
	});

	it("stops at the next user message — never eats the exchange after it", () => {
		const ids = turnSpanFor(conversation, "u1").map((m) => m.id);
		expect(ids).not.toContain("u2");
		expect(ids).not.toContain("a2");
	});

	it("runs to the end of the log for the last turn", () => {
		expect(turnSpanFor(conversation, "u3").map((m) => m.id)).toEqual(["u3", "a3"]);
	});

	it("returns nothing for an id that is not in the log, so the caller can 404", () => {
		expect(turnSpanFor(conversation, "nope")).toEqual([]);
	});

	it("treats a system notice with no ask before it as a span of one", () => {
		// A loop-status pill or the #251 interrupted-turn notice written before the user has said
		// anything. Swallowing the messages after it would delete a turn nobody pointed at.
		const withNotice = log(["s0", "system"], ["u1", "user"], ["a1", "assistant"]);
		expect(turnSpanFor(withNotice, "s0").map((m) => m.id)).toEqual(["s0"]);
	});

	it("keeps a mid-conversation system notice with the exchange it interrupted", () => {
		// Once there IS an ask before it, the notice belongs to that ask — it is the record of what
		// happened to that turn, and leaving it behind would strand an explanation of a message
		// that is gone.
		const ids = turnSpanFor(conversation, "u1").map((m) => m.id);
		expect(ids).toContain("t1");
	});

	it("is a no-op on an empty log", () => {
		expect(turnSpanFor([], "u1")).toEqual([]);
	});
});
