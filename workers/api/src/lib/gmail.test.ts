import { describe, expect, it } from "vitest";
import { buildQuery, extractLinks, rankConfirmationLinks } from "./gmail.js";

describe("extractLinks", () => {
	it("pulls href and bare links from an html body", () => {
		const body = `
			<p>Welcome! <a href="https://coles.com.au/confirm?token=abc123def456ghi789">Confirm</a></p>
			Visit https://coles.com.au/help for help.
		`;
		const links = extractLinks(body);
		expect(links).toContain("https://coles.com.au/confirm?token=abc123def456ghi789");
		expect(links).toContain("https://coles.com.au/help");
	});

	it("returns no links when there are none", () => {
		expect(extractLinks("just text, no urls")).toEqual([]);
	});
});

describe("rankConfirmationLinks", () => {
	it("ranks the confirmation link above noise", () => {
		const links = [
			"https://coles.com.au/unsubscribe?u=1",
			"https://coles.com.au/privacy",
			"https://coles.com.au/verify?token=abcdef0123456789abcdef",
			"https://coles.com.au/help",
		];
		const ranked = rankConfirmationLinks(links, "coles");
		expect(ranked[0]).toBe("https://coles.com.au/verify?token=abcdef0123456789abcdef");
	});

	it("deprioritises unsubscribe/privacy links", () => {
		const ranked = rankConfirmationLinks([
			"https://x.com/unsubscribe",
			"https://x.com/activate/aaaaaaaaaaaaaaaaaaaa",
		]);
		expect(ranked[0]).toContain("activate");
	});
});

describe("buildQuery", () => {
	it("composes from + subject + recency", () => {
		expect(buildQuery({ from: "coles", subject: "confirm your account", withinDays: 2 })).toBe(
			"from:coles subject:(confirm your account) newer_than:2d",
		);
	});

	it("defaults recency to 1 day and clamps to 7", () => {
		expect(buildQuery({})).toBe("newer_than:1d");
		expect(buildQuery({ withinDays: 99 })).toBe("newer_than:7d");
	});
});
