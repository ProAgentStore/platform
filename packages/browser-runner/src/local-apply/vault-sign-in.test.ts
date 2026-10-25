import { describe, expect, it } from "vitest";
import type { BrowserTools } from "../local-browser/bridge.js";
import type { LocalApplyEvent } from "./contract.js";
import { obstacleOn, runVaultSignIn } from "./vault-sign-in.js";
import { controlsOf } from "./email-code.js";

const USERNAME = "serge.pro.job@gmail.com";
const PASSWORD = "Tr0ub4dor&3-vault-secret";
const JOB = "https://www.indeed.com/viewjob?jk=abc";
const LOGIN = "https://secure.indeed.com/auth?hl=en";

/** One-page sign-in: email box, password box, button. */
const ONE_PAGE = ['- heading "Sign in" [ref=h1]', '- textbox "Email address" [ref=u1]', '- textbox "Password" [ref=p1]', '- button "Sign in with Google" [ref=g1]', '- button "Sign in" [ref=s1]', '- link "Forgot password?" [ref=f1]'].join("\n");
/** Two-step sign-in: email and Continue first, the password after. */
const STEP_ONE = ['- heading "Sign in" [ref=h1]', '- textbox "Email" [ref=u1]', '- button "Continue with Google" [ref=g1]', '- button "Continue" [ref=c1]'].join("\n");
const STEP_TWO = ['- heading "Welcome back" [ref=h2]', '- textbox "Password" [ref=p1]', '- button "Sign in" [ref=s1]'].join("\n");
const LOGGED_IN = '- button "Apply now" [ref=a1]';

interface Opts {
	start?: string;
	first?: string;
	/** What the page becomes after the final press: signed in, still signed out with an error, or a challenge. */
	after?: "in" | "wrong" | "captcha" | "code" | "same";
	acceptPassword?: string;
}

/** A scripted site: a URL, a page, and what each click does given what was typed. */
function fakeSite(o: Opts = {}) {
	let url = o.start ?? LOGIN;
	let page = o.first ?? ONE_PAGE;
	const typed: Array<{ target: string; text: string }> = [];
	const calls: string[] = [];
	const tools: BrowserTools = {
		listTools: async () => [],
		callTool: async (name, args = {}) => {
			calls.push(name);
			if (name === "browser_evaluate") return { content: [{ type: "text", text: `### Result\n${JSON.stringify(url)}\n` }] };
			if (name === "browser_snapshot") return { content: [{ type: "text", text: page }] };
			if (name === "browser_type") typed.push({ target: String(args.target), text: String(args.text) });
			if (name === "browser_click") {
				if (args.target === "c1") page = STEP_TWO;
				if (args.target === "s1") {
					const ok = typed.some((t) => t.text === (o.acceptPassword ?? PASSWORD));
					const outcome = o.after ?? (ok ? "in" : "wrong");
					if (outcome === "in") {
						url = JOB;
						page = LOGGED_IN;
					} else if (outcome === "wrong") page = `${ONE_PAGE}\n- alert "Incorrect email or password. Please try again." [ref=e1]`;
					else if (outcome === "captcha") page = `${ONE_PAGE}\n- text "Please complete the security check" [ref=cx]\n- iframe "reCAPTCHA" [ref=cy]`;
					else if (outcome === "code") page = '- heading "Check your email" [ref=k1]\n- text "We\'ve sent you a verification code" [ref=k2]\n- textbox "Verification code" [ref=k3]';
				}
			}
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
	const events: Array<Omit<LocalApplyEvent, "at">> = [];
	let resumed = 0;
	const target = { tools, emit: (e: Omit<LocalApplyEvent, "at">) => events.push(e), resume: () => resumed++, wait: async () => {} };
	return { target, typed, calls, events, resumed: () => resumed, url: () => url };
}

const ask = { host: "indeed.com", username: USERNAME, password: PASSWORD };
const nothingLeaked = (f: ReturnType<typeof fakeSite>, result: unknown) => {
	const out = JSON.stringify([f.events, result]);
	expect(out).not.toContain(PASSWORD);
	expect(out).not.toContain(USERNAME);
};

describe("the vault sign-in (#1229)", () => {
	it("types the stored login into the paused sign-in page, presses Sign in (not Sign in with Google), and releases the pause", async () => {
		const f = fakeSite();
		const result = await runVaultSignIn(f.target, ask);
		expect(result).toEqual({ state: "signed_in" });
		expect(f.typed).toEqual([{ target: "u1", text: USERNAME }, { target: "p1", text: PASSWORD }]);
		expect(f.calls.filter((c) => c === "browser_click")).toHaveLength(1);
		expect(f.resumed()).toBe(1);
		expect(f.events.at(-1)?.detail).toMatchObject({ tool: "vault_sign_in", decision: "signed_in", site: "indeed.com" });
		nothingLeaked(f, result);
	});

	it("a two-step form: username, Continue, then the password", async () => {
		const f = fakeSite({ first: STEP_ONE });
		expect(await runVaultSignIn(f.target, ask)).toEqual({ state: "signed_in" });
		expect(f.typed).toEqual([{ target: "u1", text: USERNAME }, { target: "p1", text: PASSWORD }]);
		expect(f.resumed()).toBe(1);
	});

	it("a refused password ends the attempt with its reason — typed once, never retried, the pause left for the owner", async () => {
		const f = fakeSite({ acceptPassword: "something-else" });
		const result = await runVaultSignIn(f.target, ask);
		expect(result).toEqual({ state: "failed", reason: "wrong_password" });
		expect(f.typed.filter((t) => t.text === PASSWORD)).toHaveLength(1);
		expect(f.calls.filter((c) => c === "browser_click")).toHaveLength(1);
		expect(f.resumed()).toBe(0);
		nothingLeaked(f, result);
	});

	it("a CAPTCHA after the press, or on the page before it, is never worked around", async () => {
		const after = fakeSite({ after: "captcha" });
		expect(await runVaultSignIn(after.target, ask)).toEqual({ state: "failed", reason: "captcha" });
		expect(after.resumed()).toBe(0);
		const before = fakeSite({ first: `${ONE_PAGE}\n- iframe "reCAPTCHA challenge" [ref=cy]` });
		expect(await runVaultSignIn(before.target, ask)).toEqual({ state: "failed", reason: "captcha" });
		expect(before.typed).toEqual([]); // nothing typed into a page that is asking for proof of a human
	});

	it("a second-factor prompt ends it as such", async () => {
		const f = fakeSite({ after: "code" });
		expect(await runVaultSignIn(f.target, ask)).toEqual({ state: "failed", reason: "two_factor" });
		expect(f.resumed()).toBe(0);
	});

	it("a page that never leaves the sign-in is 'not_signed_in', not a success", async () => {
		const f = fakeSite({ after: "same" });
		expect(await runVaultSignIn(f.target, ask)).toEqual({ state: "failed", reason: "not_signed_in" });
		expect(f.resumed()).toBe(0);
	});

	it("only the credential's own site: a page anywhere else gets nothing typed", async () => {
		const f = fakeSite({ start: "https://accounts.google.com/signin/v2" });
		const result = await runVaultSignIn(f.target, ask);
		expect(result).toEqual({ state: "failed", reason: "host_mismatch" });
		expect(f.typed).toEqual([]);
		expect(f.calls).not.toContain("browser_click");
		nothingLeaked(f, result);
	});

	it("a subdomain of the credential's site is the same site", async () => {
		const f = fakeSite({ start: "https://secure.indeed.com/auth" });
		expect(await runVaultSignIn(f.target, { ...ask, host: "www.indeed.com" })).toEqual({ state: "signed_in" });
	});

	it("says what is missing instead of guessing: no username box, no password step, no button", async () => {
		expect(await runVaultSignIn(fakeSite({ first: '- heading "Hi" [ref=h]' }).target, ask)).toEqual({ state: "failed", reason: "no_username_field" });
		expect(await runVaultSignIn(fakeSite({ first: '- textbox "Email" [ref=u1]\n- button "Continue" [ref=c9]' }).target, ask)).toEqual({ state: "failed", reason: "no_password_field" });
		expect(await runVaultSignIn(fakeSite({ first: '- textbox "Email" [ref=u1]\n- textbox "Password" [ref=p1]\n- button "Sign in with Google" [ref=g1]' }).target, ask)).toEqual({ state: "failed", reason: "no_submit_button" });
	});

	it("refuses a malformed request rather than typing it", async () => {
		const f = fakeSite();
		await expect(runVaultSignIn(f.target, { host: "indeed.com", username: "", password: "x" })).rejects.toThrow(/needs host, username and password/);
		await expect(runVaultSignIn(f.target, { host: "not a host", username: "a", password: "b" })).rejects.toThrow(/needs host/);
		await expect(runVaultSignIn(f.target, { host: "indeed.com", username: "a", password: "b".repeat(2000) })).rejects.toThrow(/needs host/);
		expect(f.typed).toEqual([]);
	});
});

describe("obstacleOn", () => {
	it("tells a challenge, a second factor and a refused password apart — and a clean page from all three", () => {
		const c = (t: string) => controlsOf(t);
		expect(obstacleOn(ONE_PAGE, c(ONE_PAGE))).toBeNull();
		expect(obstacleOn(`${ONE_PAGE}\n- iframe "hCaptcha" [ref=z]`, c(ONE_PAGE))).toBe("captcha");
		const code = '- textbox "Verification code" [ref=k3]\n- text "Enter the verification code" [ref=k2]';
		expect(obstacleOn(code, c(code))).toBe("two_factor");
		const wrong = `${ONE_PAGE}\n- alert "That password is incorrect" [ref=e]`;
		expect(obstacleOn(wrong, c(wrong))).toBe("wrong_password");
	});

	it("'Forgot password?' on a clean sign-in page is not a refusal", () => {
		expect(obstacleOn(ONE_PAGE, controlsOf(ONE_PAGE))).toBeNull();
	});
});
