/**
 * The pure half of in-session feedback (#514): what a valid capture is, what gets clamped, and
 * which enums are closed.
 *
 * The decisions worth pinning are the refusals and the fallbacks, and they point in OPPOSITE
 * directions on purpose: an unknown surface must not lose the complaint, and an empty body must
 * not be stored as one. A row with nothing said is not evidence — it is the bare thumbs-down the
 * issue rejected as unfilable.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFeedbackRow, FEEDBACK_LIMITS } from "./feedback.js";

const base = { userId: "u1", instanceId: "i1", body: "you said you filed it and you did not" };

describe("buildFeedbackRow", () => {
	it("keeps the words, the anchors and the snapshot", () => {
		const built = buildFeedbackRow(
			{
				...base,
				surface: "chat",
				sentiment: "bad",
				traceId: "t-1",
				messageId: "m-1",
				targetRole: "assistant",
				targetText: "I have filed the issue.",
				targetAt: "2026-08-11T01:57:59.126Z",
				promptText: "did you file it?",
				context: { audioKey: "a1", dictation: "did you file it" },
			},
			1_700_000_000_000,
		);
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		expect(built.row).toMatchObject({
			user_id: "u1",
			instance_id: "i1",
			author: "user",
			surface: "chat",
			sentiment: "bad",
			body: base.body,
			trace_id: "t-1",
			message_id: "m-1",
			target_role: "assistant",
			target_text: "I have filed the issue.",
			prompt_text: "did you file it?",
			status: "open",
			issue_url: null,
			ts: 1_700_000_000_000,
		});
		// Voice provenance rides in `context` — without it, feedback on a misheard turn is a report
		// about the agent rather than about the recognizer (#510–#512).
		expect(JSON.parse(built.row.context ?? "{}")).toEqual({ audioKey: "a1", dictation: "did you file it" });
	});

	it("refuses an empty or whitespace body — a complaint with no words is not evidence", () => {
		for (const body of ["", "   ", "\n\t"]) {
			const built = buildFeedbackRow({ ...base, body });
			expect(built.ok).toBe(false);
			if (!built.ok) expect(built.error).toBe("body required");
		}
	});

	it("refuses a capture with no instance to anchor it to", () => {
		expect(buildFeedbackRow({ ...base, instanceId: "" }).ok).toBe(false);
	});

	it("falls back rather than refusing on an unknown surface, author or sentiment", () => {
		const built = buildFeedbackRow({ ...base, surface: "telepathy", author: "ghost", sentiment: "furious" });
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		// The complaint survives an enum the caller invented; losing it would be the worse failure.
		expect(built.row.surface).toBe("chat");
		expect(built.row.author).toBe("user");
		expect(built.row.sentiment).toBeNull();
	});

	it("accepts the agent as an author — record_feedback stamps the same row shape", () => {
		const built = buildFeedbackRow({ ...base, author: "agent", surface: "coding", sessionId: "s1", timelineSeq: 42 });
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		expect(built.row).toMatchObject({ author: "agent", surface: "coding", session_id: "s1", timeline_seq: 42 });
	});

	it("clamps every free-text field to its cap", () => {
		const built = buildFeedbackRow({
			...base,
			body: "b".repeat(9000),
			targetText: "t".repeat(9000),
			promptText: "p".repeat(9000),
		});
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		expect(built.row.body.length).toBe(FEEDBACK_LIMITS.body);
		expect(built.row.target_text?.length).toBe(FEEDBACK_LIMITS.targetText);
		expect(built.row.prompt_text?.length).toBe(FEEDBACK_LIMITS.promptText);
	});

	it("drops an oversized context whole rather than storing half a JSON object", () => {
		const built = buildFeedbackRow({ ...base, context: { blob: "x".repeat(FEEDBACK_LIMITS.context) } });
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		// Truncated JSON read back by the console is worse than no context at all.
		expect(built.row.context).toBeNull();
	});

	/**
	 * The boundary, held structurally rather than by inspection of one rendered prompt.
	 *
	 * An agent that reads complaints about itself starts ANSWERING them — apologising,
	 * over-correcting, treating a bug report as a standing instruction. That is the same failure
	 * memory already produced twice (#226, #495), and it is cheaper to make unreachable than to
	 * detect. The prompt builders must not know this module exists.
	 */
	it("is unreachable from every prompt builder — feedback is never read back as instruction", () => {
		for (const file of ["../agent-think.ts", "../agent-do-prompt.ts", "../lib/memory-prompt.ts"]) {
			const src = readFileSync(new URL(file, import.meta.url), "utf8");
			expect(src, `${file} must not read feedback`).not.toContain("feedback.js");
			expect(src, `${file} must not read feedback`).not.toContain("agent_feedback");
		}
	});

	it("never carries a status or issue_url the caller supplied — triage is a separate act", () => {
		const built = buildFeedbackRow({ ...base, ...({ status: "filed", issueUrl: "http://x" } as object) });
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		expect(built.row.status).toBe("open");
		expect(built.row.issue_url).toBeNull();
	});
});
