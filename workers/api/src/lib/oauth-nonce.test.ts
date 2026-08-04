import { describe, expect, it } from "vitest";
import {
	clearOauthBindCookie,
	newOauthNonce,
	oauthBindCookie,
	oauthBindMatches,
	readOauthBindCookie,
} from "./oauth-nonce.js";

describe("oauth state binding", () => {
	it("refuses when the completing browser has no cookie — the whole attack", () => {
		// The attacker starts the flow (so THEY hold the cookie) and sends the URL to the victim.
		// The victim's browser completes the consent carrying no cookie at all. A signed state is
		// not evidence of anything here: the attacker is a legitimate holder of a valid one.
		const attackerState = newOauthNonce();
		expect(oauthBindMatches(attackerState, readOauthBindCookie(null, "gmail"))).toBe(false);
		expect(oauthBindMatches(attackerState, readOauthBindCookie("", "gmail"))).toBe(false);
		expect(oauthBindMatches(attackerState, readOauthBindCookie("other=1; unrelated=2", "gmail"))).toBe(false);
	});

	it("accepts only the browser that started the flow", () => {
		const nonce = newOauthNonce();
		const cookie = oauthBindCookie(nonce, "gmail");
		expect(oauthBindMatches(nonce, readOauthBindCookie(`${cookie.split(";")[0]}`, "gmail"))).toBe(true);
		expect(oauthBindMatches(newOauthNonce(), readOauthBindCookie(`${cookie.split(";")[0]}`, "gmail"))).toBe(false);
	});

	it("fails closed on a missing state nonce — an OLD unbound state must not pass", () => {
		// States minted before this shipped have no nonce. They have to stop working rather than
		// be grandfathered, or the hole stays open for the length of their TTL.
		expect(oauthBindMatches(undefined, "abc")).toBe(false);
		expect(oauthBindMatches(null, "abc")).toBe(false);
		expect(oauthBindMatches("", "")).toBe(false);
	});

	it("parses the cookie out of a realistic header, and ignores lookalikes", () => {
		const n = newOauthNonce();
		expect(readOauthBindCookie(`a=1; pags_oauth_bind_gmail=${n}; b=2`, "gmail")).toBe(n);
		expect(readOauthBindCookie("x_pags_oauth_bind_gmail=nope", "gmail")).toBe(null);
		expect(readOauthBindCookie("pags_oauth_bind_gmail=", "gmail")).toBe(null);
	});

	it("marks the cookie HttpOnly + Secure + SameSite=Lax, and clears with Max-Age=0", () => {
		// Lax (not Strict): the callback IS a top-level cross-site GET navigation from the
		// provider, and Strict would withhold the cookie exactly there, breaking every flow.
		const c = oauthBindCookie("abc", "gmail");
		expect(c).toContain("HttpOnly");
		expect(c).toContain("Secure");
		expect(c).toContain("SameSite=Lax");
		expect(c).toContain("Path=/");
		expect(clearOauthBindCookie("gmail")).toContain("Max-Age=0");
	});

	it("mints a fresh nonce each time", () => {
		expect(newOauthNonce()).not.toBe(newOauthNonce());
		expect(newOauthNonce()).toMatch(/^[0-9a-f]{32}$/);
	});
});

describe("oauth bind cookie — scoped per flow", () => {
	it("does not let a second connect flow evict the first", () => {
		// One shared cookie name meant starting a Drive connect while a Gmail connect was open
		// overwrote the nonce, so the Gmail callback failed CLOSED — and because every callback
		// clears the cookie whatever the outcome, finishing any flow invalidated all the others.
		const gmail = newOauthNonce();
		const drive = newOauthNonce();
		const jar = `${oauthBindCookie(gmail, "gmail").split(";")[0]}; ${oauthBindCookie(drive, "google_drive").split(";")[0]}`;
		expect(readOauthBindCookie(jar, "gmail")).toBe(gmail);
		expect(readOauthBindCookie(jar, "google_drive")).toBe(drive);
		// Finishing Drive must not disturb Gmail's.
		expect(clearOauthBindCookie("google_drive")).toContain("pags_oauth_bind_google_drive=;");
		expect(clearOauthBindCookie("google_drive")).not.toContain("pags_oauth_bind_gmail");
	});

	it("a nonce from one flow never satisfies another", () => {
		const gmail = newOauthNonce();
		const jar = oauthBindCookie(gmail, "gmail").split(";")[0];
		expect(oauthBindMatches(gmail, readOauthBindCookie(jar, "google_drive"))).toBe(false);
	});
});
