/**
 * The four-lane board as the console renders it (#1698). The server classifies (`classifyCard`); the console only groups by the lane it
 * is given, so these tests feed cards a server could send and check what is shown, not how a lane is derived.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { EXECUTION_LANES, type ExecutionCard, cardHref, groupExecutionCards, kindLabel, triageChips } from "../lib/executionLanes";
import { ExecutionLanesBoard } from "./ExecutionLanes";

const card = (over: Partial<ExecutionCard> & Pick<ExecutionCard, "cardId" | "kind" | "lane">): ExecutionCard => ({
	needsYou: false,
	waitingToResume: false,
	nativeStatus: "running",
	title: `title of ${over.cardId}`,
	updatedAt: 1,
	native: { status: "running" },
	...over,
});
const render = (cards: ExecutionCard[]) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ExecutionLanesBoard, { instanceId: "inst 1", cards })));
const laneHtml = (html: string, lane: string) => {
	const start = html.indexOf(`data-testid="lane-${lane}"`);
	const next = EXECUTION_LANES.map((l) => html.indexOf(`data-testid="lane-${l.id}"`)).filter((i) => i > start).sort((a, b) => a - b)[0] ?? html.length;
	return html.slice(start, next);
};

describe("the four lanes", () => {
	it("are Queued, In Progress, Blocked and Done, in that order, with a count each", () => {
		const html = render([]);
		const order = EXECUTION_LANES.map((l) => html.indexOf(l.title));
		expect(EXECUTION_LANES.map((l) => l.title)).toEqual(["Queued", "In Progress", "Blocked", "Done"]);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(order.every((i) => i >= 0)).toBe(true);
		expect((html.match(/>None</g) ?? []).length).toBe(4);
	});

	it("places each card in the lane the server gave it, and never moves one", () => {
		const cards = [
			card({ cardId: "objective:e1", kind: "queued-objective", lane: "queued" }),
			card({ cardId: "csess-s1", kind: "coding-session", lane: "in_progress" }),
			card({ cardId: "scan-r1", kind: "scan", lane: "blocked", needsYou: true }),
			card({ cardId: "app-attempt-fill-f1", kind: "application-attempt", lane: "done", outcome: "failed" }),
		];
		const html = render(cards);
		expect(laneHtml(html, "queued")).toContain('data-card-id="objective:e1"');
		expect(laneHtml(html, "in_progress")).toContain('data-card-id="csess-s1"');
		expect(laneHtml(html, "blocked")).toContain('data-card-id="scan-r1"');
		expect(laneHtml(html, "done")).toContain('data-card-id="app-attempt-fill-f1"');
		expect(groupExecutionCards(cards).blocked.map((c) => c.cardId)).toEqual(["scan-r1"]);
	});

	it("Needs you is a badge on a card, not a lane", () => {
		const html = render([card({ cardId: "csess-a", kind: "coding-session", lane: "blocked", needsYou: true, blocker: { what: "Waiting for your answer: Which branch?", nextOwner: "owner" } })]);
		expect(html).toContain('data-testid="badge-needs-you"');
		expect(EXECUTION_LANES.map((l) => l.title)).not.toContain("Needs you");
		expect(html.toLowerCase()).not.toContain('data-testid="lane-needs');
	});

	it("shows what blocks a card and who acts next", () => {
		const owner = render([card({ cardId: "a", kind: "coding-session", lane: "blocked", needsYou: true, blocker: { what: "Waiting for you", nextOwner: "owner" } })]);
		expect(owner).toContain("Waiting for you · Next: you");
		const platform = render([card({ cardId: "b", kind: "coding-session", lane: "blocked", blocker: { what: "Waiting for the engine&#x27;s usage limit to reset", nextOwner: "platform" } })]);
		expect(platform).toContain("Next: ProAgentStore");
		expect(platform).not.toContain('data-testid="badge-needs-you"'); // blocked, but not on the owner
	});

	it("Waiting to Resume is its own state: queued, with no Needs you badge and no blocker", () => {
		const html = render([card({ cardId: "csess-s1", kind: "coding-session", lane: "queued", waitingToResume: true })]);
		expect(laneHtml(html, "queued")).toContain('data-testid="badge-waiting-to-resume"');
		expect(html).toContain("waiting for the run to apply it");
		expect(html).not.toContain('data-testid="badge-needs-you"');
		expect(html).not.toContain('data-testid="blocker"');
	});

	it("a terminal outcome is shown apart from the Done lane, for every outcome", () => {
		const html = render([
			card({ cardId: "a", kind: "coding-session", lane: "done", outcome: "succeeded" }),
			card({ cardId: "b", kind: "scan", lane: "done", outcome: "failed" }),
			card({ cardId: "c", kind: "scan", lane: "done", outcome: "stopped" }),
		]);
		expect(laneHtml(html, "done")).toContain(">Succeeded<");
		expect(laneHtml(html, "done")).toContain(">Failed<");
		expect(laneHtml(html, "done")).toContain(">Stopped<");
		expect((html.match(/data-testid="badge-outcome"/g) ?? []).length).toBe(3);
	});

	it("queued is not blocked: a pending objective and a waiting attempt sit in Queued with no blocker line", () => {
		const html = render([card({ cardId: "objective:e1", kind: "queued-objective", lane: "queued" }), card({ cardId: "app-attempt-fill-f1", kind: "application-attempt", lane: "queued" })]);
		expect(laneHtml(html, "queued")).toContain("objective:e1");
		expect(laneHtml(html, "blocked")).not.toContain("data-card-id");
		expect(html).not.toContain('data-testid="blocker"');
	});

	it("groups identically however the cards arrive, newest first within a lane", () => {
		const a = card({ cardId: "a", kind: "scan", lane: "done", updatedAt: 1 });
		const b = card({ cardId: "b", kind: "scan", lane: "done", updatedAt: 5 });
		expect(groupExecutionCards([a, b]).done.map((c) => c.cardId)).toEqual(["b", "a"]);
		expect(groupExecutionCards([b, a])).toEqual(groupExecutionCards([a, b]));
	});

	it("uses Session for a resumable coding session and Run for the rest", () => {
		expect(kindLabel({ kind: "coding-session", native: { status: "" } })).toBe("Session");
		expect(kindLabel({ kind: "scan", native: { status: "" } })).toBe("Scan run");
		expect(kindLabel({ kind: "application-attempt", native: { status: "", runKind: "fill" } })).toBe("Application run");
		expect(kindLabel({ kind: "application-attempt", native: { status: "", runKind: "tailor" } })).toBe("Tailor run");
	});
});

describe("unstarted work, runs and the owner's triage (#1698 approved design)", () => {
	it("the Queued lane reads in the order work will start: ranked tickets first (next, then the line), the rest newest first", () => {
		const html = render([
			card({ cardId: "task:new", kind: "task", lane: "queued", updatedAt: 90 }),
			card({ cardId: "ticket:b", kind: "queued-ticket", lane: "queued", queueRank: 1, updatedAt: 1, native: { status: "unstarted", ticketId: "b", pickup: "agent" } }),
			card({ cardId: "ticket:a", kind: "queued-ticket", lane: "queued", queueRank: 0, updatedAt: 5, native: { status: "unstarted", ticketId: "a", pickup: "agent" } }),
		]);
		const at = (id: string) => html.indexOf(`data-card-id="${id}"`);
		expect(at("ticket:a")).toBeGreaterThan(-1);
		expect(at("ticket:a")).toBeLessThan(at("ticket:b"));
		expect(at("ticket:b")).toBeLessThan(at("task:new"));
		expect(html).toContain(">Next to run<");
		expect(html).toContain(">#2 in line<");
	});

	it("a ticket the owner has to release says so, and a ticket with a rank does not", () => {
		const human = render([card({ cardId: "ticket:h", kind: "queued-ticket", lane: "queued", native: { status: "unstarted", ticketId: "h", pickup: "human" } })]);
		expect(human).toContain('data-testid="release-line"');
		expect(human).not.toContain('data-testid="badge-queue-rank"');
		const agent = render([card({ cardId: "ticket:a", kind: "queued-ticket", lane: "queued", queueRank: 0, native: { status: "unstarted", ticketId: "a", pickup: "agent" } })]);
		expect(agent).not.toContain('data-testid="release-line"');
	});

	it("a task is a Run with its own page, and a ticket or objective has none", () => {
		expect(kindLabel({ kind: "task", native: { status: "" } })).toBe("Run");
		expect(kindLabel({ kind: "queued-ticket", native: { status: "" } })).toBe("Ticket");
		expect(cardHref("i", { kind: "task", native: { status: "", taskId: "t 1" } })).toBe("/instances/i/tasks/t%201");
		expect(cardHref("i", { kind: "queued-ticket", native: { status: "", ticketId: "t" } })).toBeNull();
	});

	it("shows the owner's triage as quiet chips: nothing for New, Deferred / Discussed / Needs computer otherwise; the card is the same one", () => {
		const base = card({ cardId: "csess-s1", kind: "coding-session", lane: "blocked", needsYou: true, blocker: { what: "Waiting for your answer: q?", nextOwner: "owner" } });
		const plain = render([{ ...base, ownerAction: { itemId: "coder_question:q1", triage: { status: "new", needsComputer: false, deferUntil: null } } }]);
		expect(plain).not.toContain('data-testid="badge-triage"');
		const deferred = render([{ ...base, ownerAction: { itemId: "coder_question:q1", triage: { status: "deferred", needsComputer: true, deferUntil: "2026-12-01T00:00:00Z" } } }]);
		expect(deferred).toContain(">Deferred<");
		expect(deferred).toContain(">Needs computer<");
		// Deferring changes a chip, never the lane, the badge or the number of cards:
		expect(deferred).toContain('data-testid="badge-needs-you"');
		expect(laneHtml(deferred, "blocked")).toContain('data-card-id="csess-s1"');
		expect((deferred.match(/data-card-id=/g) ?? []).length).toBe(1);
		expect(triageChips({ ownerAction: { itemId: "x", triage: { status: "discussed", needsComputer: false, deferUntil: null } } })).toEqual(["Discussed"]);
		expect(triageChips({})).toEqual([]);
	});
});

describe("the one inline action the default board keeps: Approve (#1698)", () => {
	const approving = card({ cardId: "task:t1", kind: "task", lane: "blocked", needsYou: true, blocker: { what: "Waiting for your approval", nextOwner: "owner" }, native: { status: "needs_approval", taskId: "t1" } });
	const html = (cards: ExecutionCard[], withHandler: boolean) =>
		renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ExecutionLanesBoard, { instanceId: "i", cards, ...(withHandler ? { onApprove: () => {} } : {}) })));

	it("a task held for approval shows Approve, in Blocked with the Needs you badge", () => {
		const out = html([approving], true);
		expect(out).toContain('data-testid="approve"');
		expect(laneHtml(out, "blocked")).toContain('data-testid="approve"');
		expect(out).toContain('data-testid="badge-needs-you"');
		expect(out).toContain("Waiting for your approval · Next: you");
	});

	it("no Approve for any other card or status, nor when nothing can handle it", () => {
		expect(html([card({ cardId: "task:t2", kind: "task", lane: "in_progress", native: { status: "running", taskId: "t2" } })], true)).not.toContain('data-testid="approve"');
		expect(html([card({ cardId: "csess-s1", kind: "coding-session", lane: "blocked", native: { status: "needs_approval", sessionId: "s1" } })], true)).not.toContain('data-testid="approve"');
		expect(html([approving], false)).not.toContain('data-testid="approve"');
	});
});

describe("deep links are kept", () => {
	it("a session, an application and a scan open their own pages; a queued objective has none", () => {
		expect(cardHref("inst 1", { kind: "coding-session", native: { status: "", sessionId: "s1" } })).toBe("/instances/inst%201/coding/s1");
		expect(cardHref("i", { kind: "application-attempt", native: { status: "", applicationId: "app-1" } })).toBe("/instances/i/applications/app-1");
		expect(cardHref("i", { kind: "scan", native: { status: "", runId: "r1" } })).toBe("/instances/i/research/r1");
		expect(cardHref("i", { kind: "queued-objective", native: { status: "pending" } })).toBeNull();
	});

	it("renders an Open link only where there is a page to open", () => {
		const html = render([
			card({ cardId: "csess-s1", kind: "coding-session", lane: "in_progress", native: { status: "active", sessionId: "s1" } }),
			card({ cardId: "objective:e1", kind: "queued-objective", lane: "queued" }),
		]);
		expect((html.match(/>Open</g) ?? []).length).toBe(1);
		expect(html).toContain('href="/instances/inst%201/coding/s1"');
	});
});
