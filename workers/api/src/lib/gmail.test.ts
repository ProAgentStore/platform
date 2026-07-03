import { describe, expect, it } from "vitest";
import { buildQuery, extractCode, extractLinks, rankConfirmationLinks } from "./gmail.js";

describe("extractCode", () => {
	it("prefers a context-anchored code", () => {
		expect(extractCode("Your verification code is 483920. It expires soon.")).toBe("483920");
	});
	it("finds a bare 6-digit code", () => {
		expect(extractCode("<p>Use 728104 to sign in</p>")).toBe("728104");
	});
	it("returns null when there is nothing code-like", () => {
		expect(extractCode("Welcome to Coles careers, thanks for applying.")).toBeNull();
	});
});

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

describe("extractLinks drops assets", () => {
	it("skips image/css URLs, keeps the real link", () => {
		const body = `<img src="https://mail.coles.com.au/logo.png"><a href="https://colescareers.com.au/onetime-login?token=abcdef0123456789abcdef">Sign in</a>`;
		const links = extractLinks(body);
		expect(links).toContain("https://colescareers.com.au/onetime-login?token=abcdef0123456789abcdef");
		expect(links.some((l) => l.endsWith(".png"))).toBe(false);
	});
});

describe("rankConfirmationLinks prefers the sign-in link", () => {
	it("ranks a one-time login link above an image and unsubscribe", () => {
		const links = [
			"https://mail.colescareers.com.au/banner.jpg",
			"https://colescareers.com.au/unsubscribe?u=1",
			"https://colescareers.com.au/onetime-login?token=abcdef0123456789abcdef",
		];
		expect(rankConfirmationLinks(links, "colescareers")[0]).toBe("https://colescareers.com.au/onetime-login?token=abcdef0123456789abcdef");
	});
});
