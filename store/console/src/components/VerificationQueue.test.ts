/** The shared verification queue (#1604), rendered for real. Clicking Verify now / Allow is Playwright's (e2e/activity-history.spec.ts, #282). */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { LeadVerification } from "../lib/gmailScout";
import VerificationQueue, { type VerificationQueueProps } from "./VerificationQueue";

const lead = (over: Partial<LeadVerification> = {}): LeadVerification => ({ leadId: "lead-1", canonicalUrl: "https://x.example/1", expectedTitle: "Platform Engineer", expectedCompany: "Acme", state: "awaiting", attempts: 0, nextAttemptAt: "", lastOutcome: null, lastDetail: null, ...over });
const render = (over: Partial<VerificationQueueProps> = {}) =>
	renderToStaticMarkup(createElement(MemoryRouter, null, createElement(VerificationQueue, { verifications: [lead()], busy: false, onVerify: () => undefined, ...over })));

describe("VerificationQueue", () => {
	it("one row per lead, with the sentence and Verify now / Verify again", () => {
		const html = render({ verifications: [lead(), lead({ leadId: "lead-2", state: "unverifiable", closedReason: "consent_expired" })] });
		expect(html.match(/data-testid="verification-row"/g)).toHaveLength(2);
		expect(html).toContain("Platform Engineer · Acme: waiting for the browser");
		expect(html).toContain("checked in this Scout&#x27;s browser");
		expect(html).toContain("Verify now");
		expect(html).toContain("Verify again");
	});
	it("empty: no rows", () => {
		expect(render({ verifications: [] })).not.toContain("verification-row");
	});
	it("Allow and Decline only on a row with an ask", () => {
		const props = { asks: { "lead-1": { host: "www.seek.com.au", takeoverId: "t1" } }, onAllow: () => undefined, onDecline: () => undefined };
		const html = render({ verifications: [lead(), lead({ leadId: "lead-2" })], ...props });
		expect(html.match(/Allow www\.seek\.com\.au/g)).toHaveLength(1);
		expect(html.match(/>Decline</g)).toHaveLength(1);
		expect(render()).not.toContain("Allow");
	});
});
