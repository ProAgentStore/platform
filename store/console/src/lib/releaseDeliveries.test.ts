/**
 * #1348 — what the panel offers for each release note, as a pure function of the server's delivery.
 * The server decides `state` and `actions`; these tests pin that the panel never offers more than that,
 * and that the dangerous choice (sending an uncertain note again) is unreachable without the warning's two steps.
 */
import { describe, expect, it } from "vitest";
import { appendPage, headline, needsAttention, RECONCILE_RETRY_PHRASE, type ReconcileForm, reconcileBody, reconcileReady, replaceDelivery, STATE_HINT, STATE_LABEL } from "./releaseDeliveries";
import type { ReleaseDelivery, ReleaseDeliveryState } from "./types";

const delivery = (id: string, state: ReleaseDeliveryState, over: Partial<ReleaseDelivery> = {}): ReleaseDelivery => ({
	id, repo: "acme/app", sha: "b".repeat(40), runId: "run-1", sessionId: "sess-1",
	destination: { provider: "slack", name: "#release-notes" }, status: state, state, reason: null, permalink: null,
	createdAt: 1, updatedAt: 1, actions: { retry: false, reconcile: false },
	evidence: { workflowRuns: [], deployJob: null }, links: { codingRun: "/c", permalink: null, workflowRuns: [], deployJob: null }, attempts: [], ...over, holdCode: over.holdCode ?? null,
});

describe("every state has its own words, and the four blockers are not conflated", () => {
	it("labels and hints each state distinctly", () => {
		const states = Object.keys(STATE_LABEL) as ReleaseDeliveryState[];
		expect(new Set(states.map((s) => STATE_LABEL[s])).size).toBe(states.length);
		expect(STATE_LABEL.waiting_for_checks).toMatch(/Waiting for checks/);
		expect(STATE_LABEL.configuration_changed).toMatch(/settings changed/);
		expect(STATE_LABEL.delivery_failed).toMatch(/failed/i);
		expect(STATE_LABEL.outcome_uncertain).toMatch(/uncertain/i);
		expect(STATE_HINT.outcome_uncertain).toMatch(/nothing resends it for you/);
		expect(STATE_HINT.configuration_changed).toMatch(/not reopened by Retry/);
	});
	it("names the destination in the headline, and survives a missing one", () => {
		expect(headline(delivery("a", "sent"))).toBe("Delivered · Slack #release-notes");
		expect(headline(delivery("a", "delivery_failed", { destination: null }))).toBe("Delivery failed");
	});
});

describe("settling an uncertain send", () => {
	const form = (over: Partial<ReconcileForm> = {}): ReconcileForm => ({ choice: "mark_delivered", permalink: "", channelChecked: false, typed: "", ...over });
	it("mark delivered needs a link; abandon needs nothing", () => {
		expect(reconcileReady(form())).toBe(false);
		expect(reconcileReady(form({ permalink: "yesterday" }))).toBe(false);
		expect(reconcileReady(form({ permalink: " https://acme.slack.com/archives/C1/p1700000000000001 " }))).toBe(true);
		expect(reconcileReady(form({ choice: "abandon" }))).toBe(true);
	});
	it("sending again needs BOTH the checked box and the exact phrase", () => {
		const base = form({ choice: "retry_after_channel_check" });
		expect(reconcileReady(base)).toBe(false);
		expect(reconcileReady({ ...base, channelChecked: true })).toBe(false);
		expect(reconcileReady({ ...base, typed: RECONCILE_RETRY_PHRASE })).toBe(false);
		expect(reconcileReady({ ...base, channelChecked: true, typed: "no post exists" })).toBe(false);
		expect(reconcileReady({ ...base, channelChecked: true, typed: RECONCILE_RETRY_PHRASE })).toBe(true);
	});
	it("sends only the fields the chosen action takes", () => {
		expect(reconcileBody(form({ permalink: " https://x.slack.com/archives/C1/p1 " }), "k")).toEqual({ action: "mark_delivered", permalink: "https://x.slack.com/archives/C1/p1", idempotencyKey: "k" });
		expect(reconcileBody(form({ choice: "abandon", permalink: "ignored" }), "k")).toEqual({ action: "abandon", idempotencyKey: "k" });
		expect(reconcileBody(form({ choice: "retry_after_channel_check", channelChecked: true, typed: RECONCILE_RETRY_PHRASE }), "k")).toEqual({ action: "retry_after_channel_check", channelChecked: true, confirm: RECONCILE_RETRY_PHRASE, idempotencyKey: "k" });
	});
});

describe("the list", () => {
	it("appends an older page without repeating a row, and replaces one in place", () => {
		const a = delivery("a", "sent"), b = delivery("b", "sent"), c = delivery("c", "sent");
		expect(appendPage([a, b], [b, c]).map((d) => d.id)).toEqual(["a", "b", "c"]);
		const fixed = delivery("b", "waiting_for_checks");
		expect(replaceDelivery([a, b, c], fixed).map((d) => d.state)).toEqual(["sent", "waiting_for_checks", "sent"]);
	});
	it("surfaces only the notes that wait on the owner", () => {
		const rows = [delivery("1", "sent"), delivery("2", "delivery_failed"), delivery("3", "outcome_uncertain"), delivery("4", "waiting_for_checks"), delivery("5", "configuration_required"), delivery("6", "expired"), delivery("7", "evidence_held", { holdCode: "commit_range_over_limit" }), delivery("8", "awaiting_commit_range")];
		expect(needsAttention(rows).map((d) => d.id)).toEqual(["2", "3", "5", "7"]);
	});
});
