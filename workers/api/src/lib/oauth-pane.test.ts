/**
 * #967 — stale and concurrent interactive sign-ins on a tmux pane, read off the pane itself.
 */
import { describe, expect, it } from "vitest";
import { oauthPaneNotice, readOAuthPane, VERIFIER_MISMATCH_EXPLANATION } from "./oauth-pane.js";

/** A `gcloud auth login --no-launch-browser` link for one attempt (PKCE: state + code_challenge). */
const link = (state: string) =>
	`https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fsdk.cloud.google.com%2Fauthcode.html&scope=openid&state=${state}&prompt=consent&code_challenge=ch-${state}&code_challenge_method=S256`;
const attempt = (state: string) =>
	`$ gcloud auth login --no-launch-browser\nGo to the following link in your browser, and complete the sign-in prompts:\n\n    ${link(state)}\n\nOnce finished, enter the verification code provided in your browser: `;

describe("readOAuthPane", () => {
	it("one login: one attempt, its link is the live one, no notice", () => {
		const pane = attempt("AAA");
		const r = readOAuthPane(pane);
		expect(r.attempts.map((a) => a.key)).toEqual(["AAA"]);
		expect(r.latestUrl).toBe(link("AAA"));
		expect(r.verifierMismatch).toBe(false);
		expect(oauthPaneNotice(pane)).toBe("");
	});

	it("two logins started in the same pane: both seen, the NEWEST is live, and the notice hands over only it", () => {
		const pane = `${attempt("AAA")}^C\n\nCommand killed by keyboard interrupt\n\n${attempt("BBB")}`;
		const r = readOAuthPane(pane);
		expect(r.attempts.map((a) => a.key)).toEqual(["AAA", "BBB"]);
		expect(r.latestUrl).toBe(link("BBB"));
		const notice = oauthPaneNotice(pane);
		expect(notice).toMatch(/2 different sign-in links/);
		expect(notice).toContain(link("BBB"));
		expect(notice).not.toContain(link("AAA"));
	});

	it("the same link reprinted (a re-capture, a redraw) is ONE attempt, not two", () => {
		const pane = `${attempt("AAA")}\n${link("AAA")}`;
		expect(readOAuthPane(pane).attempts).toHaveLength(1);
		expect(oauthPaneNotice(pane)).toBe("");
	});

	it("ordering is by where a link LAST appears, so a re-shown older link becomes the newest", () => {
		const pane = `${attempt("AAA")}\n${attempt("BBB")}\n${attempt("AAA")}`;
		expect(readOAuthPane(pane).latestUrl).toBe(link("AAA"));
	});

	it("ordinary URLs are not sign-in attempts", () => {
		const pane = "Downloading https://dl.google.com/dl/cloudsdk/release/google-cloud-sdk.tar.gz?client_id=x\nSee https://cloud.google.com/sdk/docs";
		expect(readOAuthPane(pane).attempts).toEqual([]);
		expect(oauthPaneNotice(pane)).toBe("");
	});
});

describe("Invalid code verifier → a plain retry explanation", () => {
	it("an error after the newest link is the superseded-link failure, explained — not a raw invalid_grant", () => {
		const pane = `${attempt("AAA")}\n${attempt("BBB")}4/0AVG-code-from-AAA\nERROR: (gcloud.auth.login) (invalid_grant) Invalid code verifier.\n$ `;
		expect(readOAuthPane(pane).verifierMismatch).toBe(true);
		const notice = oauthPaneNotice(pane);
		expect(notice).toBe(VERIFIER_MISMATCH_EXPLANATION);
		expect(notice).toMatch(/superseded/);
		expect(notice).toMatch(/not mistyped/);
		expect(notice).toMatch(/ONE clean login/);
	});

	it("an error from an EARLIER attempt, followed by a fresh login, is history: the fresh link is what matters", () => {
		const pane = `${attempt("AAA")}x\nERROR: (gcloud.auth.login) (invalid_grant) Invalid code verifier.\n${attempt("CCC")}`;
		const r = readOAuthPane(pane);
		expect(r.verifierMismatch).toBe(false);
		expect(oauthPaneNotice(pane)).toContain(link("CCC"));
	});

	it("nothing to read: no notice", () => {
		expect(oauthPaneNotice("")).toBe("");
		expect(oauthPaneNotice(undefined)).toBe("");
	});
});
