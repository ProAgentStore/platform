/**
 * What a capture carries (#514).
 *
 * The property under test is the one a component would get wrong by accident: a complaint is
 * about a message, but the EVIDENCE is a pair — the message and the turn that provoked it. #505
 * was filed entirely from two owner turns bracketing a claim; a capture that grabbed only the
 * clicked bubble would have been unfilable.
 */
import { describe, expect, it } from "vitest";
import { buildCapture, previewOf } from "./feedback";
import type { Message } from "./types";

const thread: Message[] = [
	{ id: "m1", role: "user", content: "why did you skip the tests?", createdAt: "t1", traceId: "tr-1", audioKey: "a1", dictation: "why did you skip the test" },
	{ id: "m2", role: "assistant", content: "As you chose, I skipped them.", createdAt: "t2", traceId: "tr-1" },
	{ id: "m3", role: "user", content: "I never said that", createdAt: "t3", traceId: "tr-2" },
];

describe("buildCapture", () => {
	it("anchors an assistant message to its trace, its own text and the turn that provoked it", () => {
		const cap = buildCapture({ instanceId: "i1", messages: thread, index: 1, body: " it never asked me  " });
		expect(cap).toMatchObject({
			instanceId: "i1",
			body: "it never asked me",
			surface: "chat",
			traceId: "tr-1",
			messageId: "m2",
			targetRole: "assistant",
			targetText: "As you chose, I skipped them.",
			targetAt: "t2",
			promptText: "why did you skip the tests?",
		});
	});

	it("takes the voice provenance from the prompting turn when the target has none", () => {
		// The mishearing is one turn earlier than the answer it produced — #510–#512's exact shape.
		// Without `voiceFrom` a reader would not know whose recording they were about to play.
		const cap = buildCapture({ instanceId: "i1", messages: thread, index: 1, body: "wrong" });
		expect(cap.context).toMatchObject({ audioKey: "a1", dictation: "why did you skip the test", voiceFrom: "prompt" });
	});

	it("prefers the target's OWN voice when it has it", () => {
		const cap = buildCapture({ instanceId: "i1", messages: thread, index: 0, body: "it heard me wrong" });
		expect(cap.context).toMatchObject({ audioKey: "a1", voiceFrom: "target" });
	});

	it("on a user turn, the prompt is the user turn BEFORE it, never itself", () => {
		const cap = buildCapture({ instanceId: "i1", messages: thread, index: 2, body: "x" });
		expect(cap.targetText).toBe("I never said that");
		expect(cap.promptText).toBe("why did you skip the tests?");
	});

	it("omits a trace id rather than faking one when the message predates them", () => {
		const old: Message[] = [{ id: "old", role: "assistant", content: "hi" }];
		const cap = buildCapture({ instanceId: "i1", messages: old, index: 0, body: "wrong" });
		expect("traceId" in cap).toBe(false);
		// The snapshot still carries the evidence, which is why a degraded record is still a record.
		expect(cap.targetText).toBe("hi");
	});

	it("carries the sentiment only when one was chosen", () => {
		expect(buildCapture({ instanceId: "i1", messages: thread, index: 1, body: "x" }).sentiment).toBeUndefined();
		expect(buildCapture({ instanceId: "i1", messages: thread, index: 1, body: "x", sentiment: "bad" }).sentiment).toBe("bad");
	});
});

describe("previewOf", () => {
	it("flattens whitespace and ellipsises at the cap", () => {
		expect(previewOf("a\n\n  b")).toBe("a b");
		expect(previewOf("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
		expect(previewOf(null)).toBe("");
	});
});
