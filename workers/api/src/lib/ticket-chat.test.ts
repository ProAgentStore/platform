import { describe, expect, it } from "vitest";
import {
	TICKET_ANSWER_EVENT,
	TICKET_CHAT_SYSTEM,
	TICKET_QUESTION_EVENT,
	TICKET_THREAD_CONTEXT_TURNS,
	buildTicketChatMessages,
	normalizeTicketQuestion,
	ticketActivityBlock,
	ticketFactsBlock,
	ticketThreadFromEvents,
} from "./ticket-chat.js";

describe("ticketThreadFromEvents", () => {
	it("picks ONLY the conversation events out of the shared task-event stream", () => {
		// The failure this prevents: the thread reuses `instance_runtime_task_events`, which also
		// carries every screenshot, lifecycle and tool event for the ticket. A loose filter would
		// render the whole activity log as a conversation the owner never had.
		const turns = ticketThreadFromEvents([
			{ id: "e1", type: "task.created", message: "Started", createdAt: "2026-08-01T10:00:00Z" },
			{ id: "e2", type: TICKET_QUESTION_EVENT, message: "why?", createdAt: "2026-08-01T10:01:00Z" },
			{ id: "e3", type: "agent.shot", message: "step 1", createdAt: "2026-08-01T10:02:00Z" },
			{ id: "e4", type: TICKET_ANSWER_EVENT, message: "because X", createdAt: "2026-08-01T10:03:00Z" },
		]);
		expect(turns.map((t) => t.role)).toEqual(["user", "agent"]);
		expect(turns.map((t) => t.text)).toEqual(["why?", "because X"]);
	});

	it("orders oldest→newest regardless of the order rows arrive in", () => {
		// The instance-wide event reader is newest-first. Rendering that verbatim would show the
		// answer above the question it answers.
		const turns = ticketThreadFromEvents([
			{ id: "b", type: TICKET_ANSWER_EVENT, message: "second", createdAt: "2026-08-01T11:00:00Z" },
			{ id: "a", type: TICKET_QUESTION_EVENT, message: "first", createdAt: "2026-08-01T10:00:00Z" },
		]);
		expect(turns.map((t) => t.text)).toEqual(["first", "second"]);
	});

	it("drops empty-message turns and survives non-record rows", () => {
		// A malformed/blank event must not render an empty bubble or throw and blank the panel.
		const turns = ticketThreadFromEvents([null, "nope", { type: TICKET_QUESTION_EVENT, message: "   " }, { type: TICKET_ANSWER_EVENT, message: "ok" }]);
		expect(turns).toHaveLength(1);
		expect(turns[0].text).toBe("ok");
	});
});

describe("ticketFactsBlock", () => {
	it("carries the recorded reasoning — the WHY is the point of the thread", () => {
		// Without reasoning in the prompt the model answers "why did you do this" from the title
		// alone, i.e. invents a rationale, which is exactly what the audit trail must not do.
		const block = ticketFactsBlock({ title: "Palm Tree Kiosk", status: "completed", reasoning: "no website field → qualified lead" });
		expect(block).toContain("Palm Tree Kiosk");
		expect(block).toContain("no website field → qualified lead");
	});

	it("states when no reasoning was recorded rather than omitting the section", () => {
		// An absent section reads to the model as "not asked about"; an explicit "(none recorded)"
		// is what lets it answer honestly that the why was never written down.
		expect(ticketFactsBlock({ title: "Old card" })).toContain("(none recorded)");
	});

	it("includes the declared action, so 'what happens if I approve this?' is answerable", () => {
		// The action is the ticket's promise. Omitting it left the one question an approval gate
		// exists to support unanswerable from the ticket itself.
		const block = ticketFactsBlock({
			title: "Deploy the draft site",
			status: "needs_approval",
			action: { action: "run_pipeline", config: { pipeline: "site-deploy" }, params: {} },
		});
		expect(block).toContain("run_pipeline");
		expect(block).toContain("site-deploy");
	});

	it("renders a non-string result instead of dropping it", () => {
		// executeTriggerAction returns objects; a string-only check silently lost what approving
		// the ticket actually produced.
		expect(ticketFactsBlock({ title: "t", result: { runId: "r-9" } })).toContain("r-9");
	});

	it("does not throw on a missing ticket", () => {
		expect(ticketFactsBlock(null)).toContain("not found");
	});
});

describe("ticketActivityBlock", () => {
	it("excludes screenshots and the conversation from the activity replay", () => {
		// Screenshots are binary noise in a text prompt, and replaying the thread here as well as
		// in the history section double-counted every turn and inflated the prompt.
		const block = ticketActivityBlock([
			{ type: "agent.shot", message: "shot 3", createdAt: "2026-08-01T10:00:00Z" },
			{ type: TICKET_QUESTION_EVENT, message: "why?", createdAt: "2026-08-01T10:01:00Z" },
			{ type: "task.completed", message: "Submitted the form", createdAt: "2026-08-01T10:02:00Z" },
		]);
		expect(block).toContain("Submitted the form");
		expect(block).not.toContain("shot 3");
		expect(block).not.toContain("why?");
	});

	it("keeps the NEWEST lines when truncating", () => {
		// Truncating from the end would hand the model the start of a long run and hide the
		// outcome — the part every question is actually about.
		const events = Array.from({ length: 10 }, (_, i) => ({ type: "step", message: `line ${i}`, createdAt: `2026-08-01T10:0${i}:00Z` }));
		const block = ticketActivityBlock(events, 3);
		expect(block).toContain("line 9");
		expect(block).not.toContain("line 5");
	});

	it("says so explicitly when a ticket has no activity", () => {
		// A cloud-only agent's ticket often has none. An empty section let the model narrate a run
		// that never happened; the explicit line makes "nothing was recorded" the honest answer.
		expect(ticketActivityBlock([])).toContain("nothing recorded");
	});
});

describe("buildTicketChatMessages", () => {
	it("puts the grounding + no-action rules in the system message", () => {
		// Both rules are load-bearing: the thread has no tools (so any unrecorded detail must come
		// back as "not recorded"), and it must not become a free-text bypass of the approval gate.
		const msgs = buildTicketChatMessages({ task: { title: "t" }, events: [], question: "why?" });
		expect(msgs[0].role).toBe("system");
		expect(msgs[0].content).toBe(TICKET_CHAT_SYSTEM);
		expect(msgs[0].content).toMatch(/not recorded/i);
		expect(msgs[0].content).toMatch(/cannot act|CANNOT act/i);
	});

	it("replays only the most recent turns, keeping the latest exchange", () => {
		// An unbounded replay grows every turn until the prompt is mostly its own history; cutting
		// the newest instead of the oldest would drop the exchange the follow-up refers to.
		const events = Array.from({ length: 40 }, (_, i) => ({
			id: `e${i}`,
			type: i % 2 === 0 ? TICKET_QUESTION_EVENT : TICKET_ANSWER_EVENT,
			message: `turn ${i}`,
			createdAt: `2026-08-01T10:${String(i).padStart(2, "0")}:00Z`,
		}));
		const content = buildTicketChatMessages({ task: { title: "t" }, events, question: "and now?" })[1].content;
		expect(content).toContain("turn 39");
		expect(content).not.toContain("turn 0\n");
		expect(TICKET_THREAD_CONTEXT_TURNS).toBeLessThan(40);
	});

	it("labels the two speakers so a follow-up is not read as the agent's own words", () => {
		const content = buildTicketChatMessages({
			task: { title: "t" },
			events: [
				{ id: "q", type: TICKET_QUESTION_EVENT, message: "why?", createdAt: "2026-08-01T10:00:00Z" },
				{ id: "a", type: TICKET_ANSWER_EVENT, message: "because X", createdAt: "2026-08-01T10:01:00Z" },
			],
			question: "and the cost?",
		})[1].content;
		expect(content).toContain("Owner: why?");
		expect(content).toContain("You: because X");
		expect(content).toContain("and the cost?");
	});

	it("carries the owner's standing rules when set, and omits the section when not", () => {
		// Rules & Tips already reach chat and workflow brains; a ticket answer that ignores them
		// contradicts every other surface.
		const withRules = buildTicketChatMessages({ task: {}, events: [], question: "q", specialInstructions: "Always answer in metric." })[1].content;
		expect(withRules).toContain("Always answer in metric.");
		const without = buildTicketChatMessages({ task: {}, events: [], question: "q", specialInstructions: "   " })[1].content;
		expect(without).not.toContain("STANDING RULES");
	});
});

describe("normalizeTicketQuestion", () => {
	it("rejects blank input rather than spending a model call on it", () => {
		expect(normalizeTicketQuestion("   ")).toEqual({ error: "message required" });
		expect(normalizeTicketQuestion(undefined)).toEqual({ error: "message required" });
		expect(normalizeTicketQuestion(42)).toEqual({ error: "message required" });
	});

	it("trims and caps, so one paste cannot blow the prompt budget", () => {
		const long = "x".repeat(9000);
		const out = normalizeTicketQuestion(`  ${long}  `);
		expect("question" in out && out.question.length).toBe(4000);
	});
});
