import { describe, expect, it } from "vitest";
import {
	announceSwitch,
	isOnConversationRoute,
	nothingWaitingLine,
	parkedOnSwitch,
	resolveConversationIndicator,
	resolveParkedIndicator,
	type ConversationSnapshot,
} from "./conversation";

const conv = (over: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({
	instanceId: "i-coder",
	name: "FWS platform",
	emoji: "🛠",
	bg: "#123",
	mode: "handsfree",
	live: false,
	runActive: false,
	...over,
});

describe("isOnConversationRoute", () => {
	it("matches the instance's own pages, including its tabs", () => {
		expect(isOnConversationRoute("/instances/i-coder", "i-coder")).toBe(true);
		expect(isOnConversationRoute("/instances/i-coder/coding/csess_1", "i-coder")).toBe(true);
		expect(isOnConversationRoute("/instances/i-other/chat", "i-coder")).toBe(false);
		expect(isOnConversationRoute("/usage", "i-coder")).toBe(false);
	});
});

describe("resolveConversationIndicator", () => {
	// The ticket's "with no active conversation, the top bar is unchanged".
	it("shows nothing without a conversation", () => {
		expect(resolveConversationIndicator(null, "/usage")).toBeNull();
	});

	// A pill for every chat ever opened trains people to ignore the pill.
	it("shows nothing for a plain typed chat with nothing running", () => {
		expect(resolveConversationIndicator(conv({ mode: "text" }), "/usage")).toBeNull();
	});

	// The instance header already carries the name and state; a second copy in the same 40px
	// bar is pure noise on a phone.
	it("shows nothing while you are on that agent's own page", () => {
		expect(resolveConversationIndicator(conv(), "/instances/i-coder/chat")).toBeNull();
	});

	it("shows the agent, and returns to its Assistant tab", () => {
		const v = resolveConversationIndicator(conv(), "/usage");
		expect(v?.label).toBe("FWS platform");
		expect(v?.href).toBe("/instances/i-coder/chat");
	});

	// THE invariant this module exists for. Leaving the page unmounts useVoice, which closes
	// the recognizer and the mic stream — so the indicator must never imply a live microphone
	// on a screen with no chat on it.
	it("never claims to be listening once the page that owned the mic is gone", () => {
		const v = resolveConversationIndicator(conv({ mode: "handsfree", live: false }), "/terminals");
		expect(v?.title).toContain("Mic paused");
		expect(v?.title).not.toMatch(/listening/i);
		expect(v?.tone).toBe("idle");
	});

	// #252 established that a run outlives the tab; this is what makes that visible from
	// anywhere, which is half of why the indicator is worth having.
	it("reports work still running, even for a conversation that was only typed", () => {
		const v = resolveConversationIndicator(conv({ mode: "text", runActive: true }), "/usage");
		expect(v?.tone).toBe("work");
		expect(v?.title).toContain("still working");
	});

	// Clicking is a user gesture — the one moment iOS will reopen a mic — but it must only
	// resume the mode the user actually chose. Restoring hands-free for a typist would open a
	// live mic they never asked for.
	it("carries back the voice mode, and only when there was one", () => {
		expect(resolveConversationIndicator(conv({ mode: "handsfree" }), "/usage")?.resumeMode).toBe("handsfree");
		expect(resolveConversationIndicator(conv({ mode: "ptt" }), "/usage")?.resumeMode).toBe("ptt");
		expect(resolveConversationIndicator(conv({ mode: "text", runActive: true }), "/usage")?.resumeMode).toBeNull();
	});
});

describe("parkedOnSwitch — leaving a BUSY agent does not delete it (#450)", () => {
	const busy = conv({ instanceId: "i-busy", name: "Repo Coder", runActive: true });
	const idle = conv({ instanceId: "i-idle", name: "Doc Chat" });

	it("holds the agent you left running", () => {
		expect(parkedOnSwitch(null, busy, "i-other")).toBe(busy);
	});

	it("holds nothing when what you left was idle — that is not information", () => {
		// The same judgement `resolveConversationIndicator` already makes about a typed chat with
		// nothing running: a pill for every agent you ever opened trains people to ignore pills.
		expect(parkedOnSwitch(null, idle, "i-other")).toBeNull();
		// …and an idle departure does not evict what IS still running.
		expect(parkedOnSwitch(busy, idle, "i-other")).toBe(busy);
	});

	it("retires the held agent when you arrive back at it", () => {
		expect(parkedOnSwitch(busy, idle, "i-busy")).toBeNull();
	});

	it("keeps two pills the ceiling: the newest running one replaces the last", () => {
		const other = conv({ instanceId: "i-2", name: "FWS platform", runActive: true });
		expect(parkedOnSwitch(busy, other, "i-3")).toBe(other);
	});

	// THE regression risk named on the ticket. This runs from a render effect on every poll tick;
	// a fresh object per tick re-renders the whole Layout for nothing.
	it("returns the SAME reference when nothing changed", () => {
		// Re-reporting the same conversation (the ordinary tick) touches nothing.
		expect(parkedOnSwitch(busy, idle, idle.instanceId)).toBe(busy);
		expect(parkedOnSwitch(null, null, "i-first")).toBeNull();
	});
});

describe("resolveParkedIndicator", () => {
	const busy = conv({ instanceId: "i-busy", name: "Repo Coder", runActive: true, mode: "handsfree" });

	it("shows the agent that is still working, and returns to it", () => {
		const v = resolveParkedIndicator(busy, "/instances/i-other/chat");
		expect(v?.label).toBe("Repo Coder");
		expect(v?.tone).toBe("work");
		expect(v?.title).toContain("still working");
		expect(v?.href).toBe("/instances/i-busy/chat");
	});

	it("shows nothing without a parked agent, or once its work is done", () => {
		expect(resolveParkedIndicator(null, "/usage")).toBeNull();
		expect(resolveParkedIndicator(conv({ instanceId: "i-busy", runActive: false }), "/usage")).toBeNull();
	});

	it("shows nothing while you are on that agent's own page", () => {
		// Its own header is already saying it; a second copy in the same 40px bar is noise.
		expect(resolveParkedIndicator(busy, "/instances/i-busy/coding/csess_1")).toBeNull();
	});

	it("carries back the voice mode, and only when there was one", () => {
		expect(resolveParkedIndicator(busy, "/usage")?.resumeMode).toBe("handsfree");
		expect(resolveParkedIndicator(conv({ instanceId: "i-busy", mode: "text", runActive: true }), "/usage")?.resumeMode).toBeNull();
	});
});

describe("announceSwitch / nothingWaitingLine", () => {
	// In hands-free the user is not looking. A silent switch means the next sentence goes to an
	// agent they did not know they were talking to — this is the requirement that makes the
	// whole feature safe rather than alarming.
	it("always names the agent, and passes on the platform's own reason", () => {
		expect(announceSwitch("Repo Chat", "🙋 Coder needs you")).toBe("Switching to Repo Chat. 🙋 Coder needs you");
		expect(announceSwitch("Repo Chat")).toBe("Switching to Repo Chat.");
		expect(announceSwitch("Repo Chat", "   ")).toBe("Switching to Repo Chat.");
	});

	// Staying put is the right behaviour; saying so is what stops it reading as "the command
	// was not heard", which would have the user repeat it into a mic that is working fine.
	it("says nothing is waiting, and where you still are", () => {
		expect(nothingWaitingLine("FWS platform")).toBe("Nothing is waiting. Still with FWS platform.");
		expect(nothingWaitingLine()).toBe("Nothing is waiting for you.");
	});
});
