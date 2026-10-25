/**
 * #1348 — the delivery list renders the server's answer and offers exactly the actions the server says apply.
 * Rendered markup, no browser (there is no DOM in this suite): the request sequences are covered by the route tests.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReleaseDelivery } from "../lib/types";
import ReleaseDeliveriesList from "./ReleaseDeliveriesList";

const base: ReleaseDelivery = {
	id: "q1", repo: "acme/app", sha: "b".repeat(40), runId: "run-1", sessionId: "sess-1",
	destination: { provider: "slack", name: "#release-notes" }, status: "failed", state: "delivery_failed", reason: "The bot is not in that channel.", holdCode: null,
	permalink: null, createdAt: 1, updatedAt: 1, actions: { retry: true, reconcile: false },
	evidence: { workflowRuns: ["https://github.com/acme/app/actions/runs/1"], deployJob: "https://github.com/acme/app/actions/runs/2/job/9" },
	links: { codingRun: "/instances/i/coding", permalink: null, workflowRuns: ["https://github.com/acme/app/actions/runs/1"], deployJob: "https://github.com/acme/app/actions/runs/2/job/9" },
	attempts: [{ id: "a1", kind: "send", outcome: "failed", reason: "not_in_channel", permalink: null, at: 1700000000000 }],
};
const render = (deliveries: ReleaseDelivery[], over: Partial<Parameters<typeof ReleaseDeliveriesList>[0]> = {}) =>
	renderToStaticMarkup(createElement(ReleaseDeliveriesList, { deliveries, hasMore: false, busy: "", onRetry: () => undefined, onReconcile: () => undefined, onMore: () => undefined, ...over }));

describe("the delivery list", () => {
	it("says so when nothing has been queued", () => {
		expect(render([])).toContain("No release notes have been queued");
	});
	it("shows a failed send's reason, evidence and attempts, with Retry and no reconcile", () => {
		const html = render([base]);
		expect(html).toContain("Delivery failed · Slack #release-notes");
		expect(html).toContain("acme/app @ bbbbbbb");
		expect(html).toContain("The bot is not in that channel.");
		expect(html).toContain('href="/instances/i/coding"');
		expect(html).toContain("actions/runs/2/job/9");
		expect(html).toContain("send · failed");
		expect(html).toContain("Retry send");
		expect(html).not.toContain("Settle this send");
	});
	it("offers nothing on a delivered note but its message link", () => {
		const html = render([{ ...base, status: "sent", state: "sent", reason: null, permalink: "https://acme.slack.com/archives/C1/p1", links: { ...base.links, permalink: "https://acme.slack.com/archives/C1/p1" }, actions: { retry: false, reconcile: false } }]);
		expect(html).toContain("Delivered · Slack #release-notes");
		expect(html).toContain('href="https://acme.slack.com/archives/C1/p1"');
		expect(html).not.toContain("Retry send");
		expect(html).not.toContain("Settle this send");
	});
	it("an uncertain send offers settling, never Retry, and says nothing resends it automatically", () => {
		const html = render([{ ...base, status: "sending", state: "outcome_uncertain", reason: null, actions: { retry: false, reconcile: true } }]);
		expect(html).toContain("Outcome uncertain");
		expect(html).toContain("nothing resends it for you");
		expect(html).toContain("Settle this send");
		expect(html).not.toContain("Retry send");
	});
	it("the settle form leads with delivered, and the resend choice sits behind the duplicate-risk warning", () => {
		const html = render([{ ...base, status: "sending", state: "outcome_uncertain", reason: null, actions: { retry: false, reconcile: true } }], { defaultOpen: true });
		expect(html).toContain("It was delivered");
		expect(html).toContain("Give it up");
		expect(html).toContain("It never arrived — send it again");
		expect(html).not.toContain("Sending again can post the same announcement twice"); // only after choosing the resend
		expect(html).toMatch(/<button[^>]*disabled[^>]*>Confirm/); // nothing to confirm until a link is given
	});
	it("a cancelled note is shown as settings-changed, not as a failure, and offers no action", () => {
		const html = render([{ ...base, status: "cancelled", state: "configuration_changed", reason: "Release note setting or channel grant changed", actions: { retry: false, reconcile: false } }]);
		expect(html).toContain("Cancelled: settings changed");
		expect(html).not.toContain("Delivery failed");
		expect(html).not.toContain("Retry send");
	});
	it("a held note shows its typed code and no action; a note still reading its range says it continues by itself", () => {
		const held = render([{ ...base, status: "held", state: "evidence_held", holdCode: "commit_range_over_limit", reason: "The commit range has 300 commits, more than the 250 that can be verified.", actions: { retry: false, reconcile: false } }]);
		expect(held).toContain("Held: evidence incomplete");
		expect(held).toContain("commit_range_over_limit");
		expect(held).toContain("more than the 250");
		expect(held).not.toContain("Retry send");
		const waiting = render([{ ...base, status: "pending", state: "awaiting_commit_range", reason: "GitHub answered 429; will retry", actions: { retry: false, reconcile: false } }]);
		expect(waiting).toContain("Reading commit range");
		expect(waiting).toContain("continues by itself");
		expect(waiting).toContain("GitHub answered 429; will retry");
	});
	it("shows 'Show older' only when the server says there is more", () => {
		expect(render([base], { hasMore: true })).toContain("Show older");
		expect(render([base])).not.toContain("Show older");
	});
});
