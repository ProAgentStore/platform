/**
 * The console half of agent-mediated transfer (#279).
 *
 * The last describe is the one that matters. Everything else here is ordinary parsing; that block
 * asserts the property the whole design rests on — a transfer can only arrive on the awaited chat
 * response, so there is no path from a poll, a socket or the transcript to a switch. That is a
 * fact about the call graph rather than about a function, so it is asserted over the page's
 * source, the way `mute-invariant.test.ts` asserts its half of ADR 0001.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backFromLine, noWayBackLine, parseChatTransfer, resolveGoBack } from "./transfer";

describe("parseChatTransfer", () => {
	it("reads a well-formed destination off the chat response", () => {
		const out = parseChatTransfer({ message: { role: "assistant", content: "ok" }, transfer: { instanceId: "i-2", name: "FWS platform", note: "about the bug" } });
		expect(out).toEqual({ instanceId: "i-2", name: "FWS platform", note: "about the bug" });
	});

	it("accepts a transfer with no note — the destination is the part that cannot be dropped", () => {
		expect(parseChatTransfer({ transfer: { instanceId: "i-2", name: "FWS platform" } })).toEqual({ instanceId: "i-2", name: "FWS platform", note: "" });
	});

	it("is null for an ordinary reply", () => {
		expect(parseChatTransfer({ message: { role: "assistant", content: "I can't move you there." } })).toBeNull();
	});

	it("refuses a half-formed destination rather than navigating to a dead route", () => {
		// `/instances/undefined/chat` loads nothing and reopens the mic into it, which is worse for
		// a user who is not looking than simply not moving.
		for (const bad of [null, undefined, "x", { transfer: null }, { transfer: {} }, { transfer: { instanceId: "  " } }, { transfer: { instanceId: "i-2" } }, { transfer: { instanceId: "i-2", name: "  " } }]) {
			expect(parseChatTransfer(bad)).toBeNull();
		}
	});

	it("does not read a transfer out of a MESSAGE — a transcript is a record, not a command bus", () => {
		// The shape a directive-in-the-transcript design would have had. It replays on every poll
		// and every reload, which is why it is not what was built; this pins that it is not read.
		expect(parseChatTransfer({ messages: [{ role: "system", content: "", transfer: { instanceId: "i-2", name: "FWS platform" } }] })).toBeNull();
	});
});

describe("resolveGoBack", () => {
	const roster = [{ id: "i-1", name: "Coder Lead" }, { id: "i-2", name: "FWS platform" }];

	it("returns the agent you were with before this one", () => {
		expect(resolveGoBack({ roster, lastEngagedId: "i-1", currentId: "i-2" })).toEqual({ instanceId: "i-1", name: "Coder Lead" });
	});

	it("is null when there is nowhere to go back to", () => {
		expect(resolveGoBack({ roster, lastEngagedId: null, currentId: "i-2" })).toBeNull();
		expect(resolveGoBack({ roster, lastEngagedId: "", currentId: "i-2" })).toBeNull();
	});

	it("never returns the agent you are already with", () => {
		expect(resolveGoBack({ roster, lastEngagedId: "i-2", currentId: "i-2" })).toBeNull();
	});

	it("is null when the previous agent has left the roster", () => {
		// Unsubscribed or cancelled since. Saying "there's nowhere to go back to" is honest;
		// navigating to a page that cannot load is not.
		expect(resolveGoBack({ roster, lastEngagedId: "i-9", currentId: "i-2" })).toBeNull();
	});
});

describe("what going back promises", () => {
	it("says only that you moved — never that anything was undone", () => {
		// Deleting a turn does not remove the summaries or the extracted facts derived from it, so
		// a sentence spoken into the wrong agent is in that instance's durable memory whatever
		// happens next. "Nothing was changed" would be a lie a user acts on by not going to clear it.
		const line = backFromLine("FWS platform");
		expect(line).toContain("FWS platform");
		expect(line).not.toMatch(/nothing was changed|undone|removed|deleted/i);
		expect(line).toMatch(/stays there/i);
	});

	it("says so rather than going silent when there is nowhere to return to", () => {
		// An unexplained non-response to a spoken command is indistinguishable from a dead mic.
		expect(noWayBackLine("Coder Lead")).toContain("Coder Lead");
		expect(noWayBackLine()).toMatch(/nowhere to go back/i);
	});
});

describe("a transfer can only arrive on the awaited chat response", () => {
	const PAGE = readFileSync(new URL("../pages/InstanceDetail.tsx", import.meta.url), "utf-8");

	it("is read exactly once, and inside the send path", () => {
		// The reason there is no "did the user ask for this?" check anywhere: the channel cannot
		// carry a spontaneous transfer, because there is no response to put one on unless the user
		// just spoke. A second reader — a poll, a socket handler, the message loader — would remove
		// that property silently, which is precisely the class `2532f00` (#386) closed by accident.
		const calls = PAGE.split("\n").filter((l) => /parseChatTransfer\(/.test(l));
		expect(calls, "parseChatTransfer is read in more than one place — see lib/transfer.ts").toHaveLength(1);

		const send = PAGE.slice(PAGE.indexOf("const doSend = useCallback("), PAGE.indexOf("// Wire the voice hook's auto-send to doSend"));
		expect(send, "the doSend slice moved — this guard is now looking at nothing").toContain("parseChatTransfer(");
		expect(send, "the transfer is no longer read off the awaited chat POST").toMatch(/`\/v1\/instances\/\$\{id\}\/chat`/);
	});

	it("never suppresses the announcement", () => {
		// `switchTo` takes `announce: false`, which is right for a tap on the indicator — the user is
		// looking at what they clicked. A move they did not touch anything to cause must not reach
		// it: the cost of a silent switch is the next sentence going to an agent nobody chose.
		expect(PAGE, "a transfer must always announce its destination").not.toMatch(/announce:\s*false/);
	});
});
