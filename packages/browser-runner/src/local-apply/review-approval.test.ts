import { describe, expect, it } from "vitest";
import { reviewApprovalFailure, type ReviewApprovalLease } from "./review-approval.js";

const page = (url: string, closed = false) => ({ url: () => url, isClosed: () => closed });
const lease = (p: ReturnType<typeof page>): ReviewApprovalLease => ({ checkpointId: "c", expiresAt: 1000, budgetMs: 1000, page: p, url: p.url() });

describe("reviewApprovalFailure (#1579)", () => {
	const p = page("https://jobs.example.com/apply/screening?token=secret");
	it("is quiet while the exact page is intact", () => expect(reviewApprovalFailure(lease(p), p, 10)).toBeNull());
	it("names expiry", () => expect(reviewApprovalFailure(lease(p), p, 1000)).toMatch(/expired/));
	it("names a closed page", () => expect(reviewApprovalFailure(lease(p), page(p.url(), true), 10)).toMatch(/closed/));
	it("names a different active tab", () => expect(reviewApprovalFailure(lease(p), page(p.url()), 10)).toMatch(/Another browser tab/));
	it("names a navigation without leaking the query", () => {
		let url = p.url();
		const live = { url: () => url, isClosed: () => false };
		const l = lease(live);
		url = "https://jobs.example.com/login?state=abc";
		const msg = reviewApprovalFailure(l, live, 10)!;
		expect(msg).toContain("https://jobs.example.com/apply/screening");
		expect(msg).toContain("https://jobs.example.com/login");
		expect(msg).not.toMatch(/secret|state=/);
	});
	it("does not apply once authorized", () => expect(reviewApprovalFailure({ ...lease(p), authorization: {} as never }, null, 5000)).toBeNull());
});
