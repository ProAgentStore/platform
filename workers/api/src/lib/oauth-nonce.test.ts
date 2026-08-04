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
		expect(oauthBindMatches(attackerState, readOauthBindCookie(null))).toBe(false);
		expect(oauthBindMatches(attackerState, readOauthBindCookie(""))).toBe(false);
		expect(oauthBindMatches(attackerState, readOauthBindCookie("other=1; unrelated=2"))).toBe(false);
	});

	it("accepts only the browser that started the flow", () => {
		const nonce = newOauthNonce();
		const cookie = oauthBindCookie(nonce);
		expect(oauthBindMatches(nonce, readOauthBindCookie(`${cookie.split(";")[0]}`))).toBe(true);
		expect(oauthBindMatches(newOauthNonce(), readOauthBindCookie(`${cookie.split(";")[0]}`))).toBe(false);
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
		expect(readOauthBindCookie(`a=1; pags_oauth_bind=${n}; b=2`)).toBe(n);
		expect(readOauthBindCookie(`x_pags_oauth_bind=nope`)).toBe(null);
		expect(readOauthBindCookie(`pags_oauth_bind=`)).toBe(null);
	});

	it("marks the cookie HttpOnly + Secure + SameSite=Lax, and clears with Max-Age=0", () => {
		// Lax (not Strict): the callback IS a top-level cross-site GET navigation from the
		// provider, and Strict would withhold the cookie exactly there, breaking every flow.
		const c = oauthBindCookie("abc");
		expect(c).toContain("HttpOnly");
		expect(c).toContain("Secure");
		expect(c).toContain("SameSite=Lax");
		expect(c).toContain("Path=/");
		expect(clearOauthBindCookie()).toContain("Max-Age=0");
	});

	it("mints a fresh nonce each time", () => {
		expect(newOauthNonce()).not.toBe(newOauthNonce());
		expect(newOauthNonce()).toMatch(/^[0-9a-f]{32}$/);
	});
});
