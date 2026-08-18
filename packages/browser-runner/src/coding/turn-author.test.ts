import { describe, expect, it } from "vitest";
import { asTurnAuthor, authoredTurn, authorTag } from "./turn-author.js";

/**
 * #505 criterion 3. The engine sees every turn as `role: "user"`, so "the user" in its transcript
 * means whoever drove it — and on 2026-08-11 that got relayed to the owner as a decision HE had
 * "explicitly chosen". These pin the naming, and the promise that goes with it: the instruction is
 * annotated, never rewritten.
 */
describe("authoredTurn — the Engine is told who wrote the turn", () => {
	it("prepends the Pilot's identity and leaves the instruction byte-for-byte intact", () => {
		const instruction = 'Add a "Testing" section to README.md. The section should read exactly: ## Testing';
		const sent = authoredTurn(instruction, "pilot");

		expect(sent).toContain("written by the Pilot");
		expect(sent).toContain("not typed by a person");
		// The instruction is the EVIDENCE of what was sent (#505: annotate, never rewrite).
		expect(sent.endsWith(`\n\n${instruction}`)).toBe(true);
		expect(sent.slice(sent.length - instruction.length)).toBe(instruction);
	});

	it('says what "the user" means, because that is the word the protocol forced', () => {
		expect(authoredTurn("go", "pilot")).toContain('"The user" in this conversation means the Pilot');
	});

	it("leaves an unauthored turn byte-identical — an unstated author is not a claim", () => {
		// Every other door into `/coding/act` (the console's manual `/message`, MCP, the Overseer)
		// declares nothing. Rendering silence as a label would make an unlabelled machine turn and
		// an unlabelled human turn look different when they are not.
		expect(authoredTurn("ship it")).toBe("ship it");
		expect(authoredTurn("ship it", undefined)).toBe("ship it");
	});

	it("costs one line, not a preamble that evicts the Pilot's own pane window", () => {
		// The preamble rides on EVERY Pilot turn, on every engine, forever. Its length is a
		// per-turn token cost and — via the transcript — a claim on the fixed pane budget the
		// Pilot reads back, so it is bounded here rather than by whoever edits the string next.
		const preamble = authoredTurn("x", "pilot").slice(0, -"\n\nx".length);
		expect(preamble.split("\n")).toHaveLength(1);
		expect(preamble.length).toBeLessThanOrEqual(200);
	});
});

describe("authorTag — what the owner reads in the Terminal view", () => {
	it("marks a Pilot turn, so the pane distinguishes it from one a person typed", () => {
		expect(authorTag("pilot")).toBe("(pilot) ");
	});

	it("marks nothing when nobody said", () => {
		expect(authorTag()).toBe("");
		expect(authorTag(undefined)).toBe("");
	});
});

describe("asTurnAuthor — the wire value is narrowed, not trusted", () => {
	it("accepts the one member of the closed vocabulary", () => {
		expect(asTurnAuthor("pilot")).toBe("pilot");
	});

	it("treats anything else as unstated rather than as a label", () => {
		// The runner is a published npm package that any caller can POST to. `"human"`, `"owner"`
		// and `"the project owner"` are exactly the strings a caller would invent, and inventing
		// them must not produce a label the platform cannot stand behind.
		for (const v of ["human", "owner", "the project owner", "Pilot", "", 1, null, undefined, {}]) {
			expect(asTurnAuthor(v)).toBeUndefined();
		}
	});
});
