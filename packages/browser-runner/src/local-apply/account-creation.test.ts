import { describe, expect, it } from "vitest";
import type { BrowserTools } from "../local-browser/bridge.js";
import { checkedRefs, isSignUpForm, runAccountCreationStep, termsBoxes } from "./account-creation.js";
import type { LocalApplyEvent } from "./contract.js";
import { controlsOf } from "./email-code.js";

const PASSWORD = "Gx7!q-vault-generated-secret";
const PROFILE = { firstName: "Serge", lastName: "Ivochkin", email: "serge.pro.job@gmail.com", phone: "0400 000 000", location: "Melbourne" };
const SIGN_IN_URL = "https://www.glassdoor.com/profile/login_input.htm";
const SIGN_UP_URL = "https://www.glassdoor.com/member/signup";
const WELCOME_URL = "https://www.glassdoor.com/member/home";

const SIGN_IN_PAGE = ['- heading "Sign in" [ref=h1]', '- textbox "Email address" [ref=u1]', '- textbox "Password" [ref=p1]', '- button "Sign in" [ref=si]', '- button "Continue with Google" [ref=g0]', '- link "Create account" [ref=ca]'].join("\n");
const SIGN_UP_PAGE = [
	'- heading "Create your account" [ref=h2]',
	'- textbox "First name *" [ref=f1]',
	'- textbox "Last name *" [ref=f2]',
	'- textbox "Email address *" [ref=f3]',
	'- textbox "Mobile phone" [ref=f4]',
	'- textbox "Password *" [ref=f5]',
	'- textbox "Confirm password *" [ref=f6]',
	'- checkbox "I agree to the Terms of Use and Privacy Policy" [ref=t1]',
	'- checkbox "Email me job alerts and offers" [ref=m1]',
	'- button "Sign up with Google" [ref=g1]',
	'- button "Create account" [ref=s1]',
].join("\n");
const EMAIL_ONLY_PAGE = ['- heading "Create your account" [ref=h2]', '- textbox "Email address" [ref=f3]', '- button "Continue" [ref=s2]'].join("\n");
const CODE_PAGE = ['- heading "Check your email" [ref=k1]', '- text "We sent a verification code" [ref=k2]', '- textbox "Verification code" [ref=k3]', '- button "Verify" [ref=k4]'].join("\n");

interface Opts {
	url?: string;
	page?: string;
	/** What pressing the form's button does. */
	after?: "created" | "code" | "taken" | "captcha" | "same" | "password_page";
	/** What typing the code does. */
	codeWorks?: boolean;
	/** The sign-up page, when it differs from the default. */
	signUp?: string;
}

/** A scripted site: pages, and what each click does. */
function fakeSite(o: Opts = {}) {
	let url = o.url ?? SIGN_IN_URL;
	let page = o.page ?? SIGN_IN_PAGE;
	const typed: Array<{ target: string; text: string }> = [];
	const clicked: string[] = [];
	const tools: BrowserTools = {
		listTools: async () => [],
		callTool: async (name, args = {}) => {
			if (name === "browser_evaluate") return { content: [{ type: "text", text: `### Result\n${JSON.stringify(url)}\n` }] };
			if (name === "browser_snapshot") return { content: [{ type: "text", text: page }] };
			if (name === "browser_type") typed.push({ target: String(args.target), text: String(args.text) });
			if (name === "browser_click") {
				const t = String(args.target);
				clicked.push(t);
				if (t === "ca") {
					url = SIGN_UP_URL;
					page = o.signUp ?? SIGN_UP_PAGE;
				}
				if (t === "s1" || t === "s2") {
					const outcome = o.after ?? "created";
					if (outcome === "created") {
						url = WELCOME_URL;
						page = '- heading "Welcome" [ref=w1]';
					} else if (outcome === "code") page = CODE_PAGE;
					else if (outcome === "taken") page = `${SIGN_UP_PAGE}\n- alert "An account with this email already exists." [ref=e1]`;
					else if (outcome === "captcha") page = `${SIGN_UP_PAGE}\n- text "Please complete the security check" [ref=cx]\n- iframe "reCAPTCHA" [ref=cy]`;
					else if (outcome === "password_page") page = ['- heading "Choose a password" [ref=h3]', '- textbox "Password" [ref=f5]', '- button "Create account" [ref=s1]'].join("\n");
				}
				if (t === "k4" && (o.codeWorks ?? true)) {
					url = WELCOME_URL;
					page = '- heading "Welcome" [ref=w1]';
				}
			}
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
	const events: Array<Omit<LocalApplyEvent, "at">> = [];
	let resumed = 0;
	const target = { tools, emit: (e: Omit<LocalApplyEvent, "at">) => events.push(e), resume: () => resumed++, wait: async () => {} };
	return { target, typed, clicked, events, resumed: () => resumed, url: () => url };
}

const prepare = { step: "prepare", host: "glassdoor.com", profile: PROFILE };
const submit = (extra: Record<string, unknown> = {}) => ({ step: "submit", host: "glassdoor.com", password: PASSWORD, acceptTerms: false, ...extra });
const nothingLeaked = (f: ReturnType<typeof fakeSite>, result: unknown) => {
	const out = JSON.stringify([f.events, result]);
	for (const secret of [PASSWORD, PROFILE.email, PROFILE.firstName, PROFILE.lastName, PROFILE.phone]) expect(out).not.toContain(secret);
};

describe("prepare: find the sign-up form and fill what is not secret", () => {
	it("follows the sign-in page's Create account link, fills the profile, reports a password is wanted, and submits nothing", async () => {
		const f = fakeSite();
		const result = await runAccountCreationStep(f.target, prepare);
		expect(result).toEqual({ state: "prepared", needsPassword: true });
		expect(f.clicked).toEqual(["ca"]);
		expect(f.typed).toEqual([
			{ target: "f1", text: "Serge" },
			{ target: "f2", text: "Ivochkin" },
			{ target: "f3", text: PROFILE.email },
			{ target: "f4", text: PROFILE.phone },
		]);
		// No password typed, no terms ticked, no button pressed: the cloud stores the password first.
		expect(f.typed.some((t) => t.target === "f5" || t.target === "f6")).toBe(false);
		expect(f.events.at(-1)?.detail).toMatchObject({ tool: "account_creation", decision: "prepared", site: "glassdoor.com", needsPassword: true });
		nothingLeaked(f, result);
	});

	it("already on the sign-up form: no link to follow", async () => {
		const f = fakeSite({ url: SIGN_UP_URL, page: SIGN_UP_PAGE });
		expect(await runAccountCreationStep(f.target, prepare)).toEqual({ state: "prepared", needsPassword: true });
		expect(f.clicked).toEqual([]);
	});

	it("a passwordless form (an email box and Continue) is prepared with needsPassword false", async () => {
		const f = fakeSite({ url: SIGN_UP_URL, page: EMAIL_ONLY_PAGE });
		expect(await runAccountCreationStep(f.target, prepare)).toEqual({ state: "prepared", needsPassword: false });
		expect(f.typed).toEqual([{ target: "f3", text: PROFILE.email }]);
	});

	it("a field with a required marker and nothing in the profile ends field_required — nothing is invented", async () => {
		const f = fakeSite({ url: SIGN_UP_URL, page: `${SIGN_UP_PAGE}\n- textbox "Date of birth *" [ref=f9]` });
		expect(await runAccountCreationStep(f.target, prepare)).toEqual({ state: "failed", reason: "field_required" });
		expect(f.typed.some((t) => t.target === "f9")).toBe(false);
	});

	it("fills a LinkedIn box from the profile when there is one, and leaves it empty when there is not", async () => {
		const page = `${SIGN_UP_PAGE}\n- textbox "LinkedIn profile URL" [ref=f8]`;
		const f = fakeSite({ url: SIGN_UP_URL, page });
		await runAccountCreationStep(f.target, { ...prepare, profile: { ...PROFILE, linkedin: "https://www.linkedin.com/in/serge" } });
		expect(f.typed.at(-1)).toEqual({ target: "f8", text: "https://www.linkedin.com/in/serge" });
		const g = fakeSite({ url: SIGN_UP_URL, page });
		expect(await runAccountCreationStep(g.target, prepare)).toEqual({ state: "prepared", needsPassword: true });
		expect(g.typed.some((t) => t.target === "f8")).toBe(false);
	});

	it("an optional field the profile lacks is simply left empty", async () => {
		const f = fakeSite({ url: SIGN_UP_URL, page: SIGN_UP_PAGE });
		const result = await runAccountCreationStep(f.target, { ...prepare, profile: { ...PROFILE, phone: undefined } });
		expect(result).toEqual({ state: "prepared", needsPassword: true });
		expect(f.typed.some((t) => t.target === "f4")).toBe(false);
	});

	it("no sign-up link on the sign-in page → no_signup_link, and nothing typed", async () => {
		const f = fakeSite({ page: SIGN_IN_PAGE.replace('- link "Create account" [ref=ca]', '- link "Forgot password" [ref=fp]') });
		expect(await runAccountCreationStep(f.target, prepare)).toEqual({ state: "failed", reason: "no_signup_link" });
		expect(f.typed).toEqual([]);
	});

	it("a link that does not lead to a form → no_signup_form", async () => {
		const f = fakeSite({ signUp: '- heading "Coming soon" [ref=x1]' });
		expect(await runAccountCreationStep(f.target, prepare)).toEqual({ state: "failed", reason: "no_signup_form" });
	});

	it("a CAPTCHA on the page is never worked around, before or after following the link", async () => {
		const wall = `${SIGN_IN_PAGE}\n- text "Verify you are human" [ref=c1]`;
		expect(await runAccountCreationStep(fakeSite({ page: wall }).target, prepare)).toEqual({ state: "failed", reason: "captcha" });
		const f = fakeSite({ signUp: `${SIGN_UP_PAGE}\n- iframe "reCAPTCHA" [ref=cy]` });
		expect(await runAccountCreationStep(f.target, prepare)).toEqual({ state: "failed", reason: "captcha" });
		expect(f.typed).toEqual([]);
	});

	it("a page on another host — an identity provider — gets nothing typed", async () => {
		const f = fakeSite({ url: "https://accounts.google.com/signin", page: SIGN_UP_PAGE });
		expect(await runAccountCreationStep(f.target, prepare)).toEqual({ state: "failed", reason: "host_mismatch" });
		expect(f.typed).toEqual([]);
		expect(f.clicked).toEqual([]);
	});

	it("rejects a request that is not one", async () => {
		const f = fakeSite();
		await expect(runAccountCreationStep(f.target, { step: "prepare", host: "glassdoor.com", profile: { firstName: "A" } })).rejects.toThrow(/first name, last name and email/);
		await expect(runAccountCreationStep(f.target, { step: "launch", host: "glassdoor.com" })).rejects.toThrow(/step must be/);
		await expect(runAccountCreationStep(f.target, { step: "prepare" })).rejects.toThrow(/needs the host/);
	});
});

describe("submit: the stored password, the owner's consent, the form's own button", () => {
	const onForm = (o: Opts = {}) => fakeSite({ url: SIGN_UP_URL, page: SIGN_UP_PAGE, ...o });

	it("types the password into both password boxes, presses Create account (not Sign up with Google), and releases the pause", async () => {
		const f = onForm();
		const result = await runAccountCreationStep(f.target, submit({ acceptTerms: true }));
		expect(result).toEqual({ state: "created" });
		expect(f.typed).toEqual([{ target: "f5", text: PASSWORD }, { target: "f6", text: PASSWORD }]);
		expect(f.clicked).toEqual(["t1", "s1"]);
		expect(f.resumed()).toBe(1);
		expect(f.events.at(-1)?.detail).toMatchObject({ tool: "account_creation", decision: "created", site: "glassdoor.com" });
		nothingLeaked(f, result);
	});

	it("never ticks a marketing box, even when terms are accepted", async () => {
		const f = onForm();
		await runAccountCreationStep(f.target, submit({ acceptTerms: true }));
		expect(f.clicked).not.toContain("m1");
	});

	it("terms the owner has not authorised end terms_required — the button is never pressed", async () => {
		const f = onForm();
		expect(await runAccountCreationStep(f.target, submit({ acceptTerms: false }))).toEqual({ state: "failed", reason: "terms_required" });
		expect(f.clicked).toEqual([]);
	});

	it("a terms box the page already shows ticked is left alone, not unticked", async () => {
		const f = onForm({ page: SIGN_UP_PAGE.replace('[ref=t1]', "[checked] [ref=t1]") });
		await runAccountCreationStep(f.target, submit({ acceptTerms: false }));
		expect(f.clicked).toEqual(["s1"]);
	});

	it("a verification code page → code_requested; entering the code creates the account and releases the pause", async () => {
		const f = onForm({ after: "code" });
		expect(await runAccountCreationStep(f.target, submit({ acceptTerms: true }))).toEqual({ state: "code_requested" });
		expect(f.resumed()).toBe(0);
		const entered = await runAccountCreationStep(f.target, { step: "enter", host: "glassdoor.com", code: "482913" });
		expect(entered).toEqual({ state: "created" });
		expect(f.typed.at(-1)).toEqual({ target: "k3", text: "482913" });
		expect(f.resumed()).toBe(1);
		expect(JSON.stringify(f.events)).not.toContain("482913");
	});

	it("a code the site does not accept → code_rejected", async () => {
		const f = onForm({ after: "code", codeWorks: false });
		await runAccountCreationStep(f.target, submit({ acceptTerms: true }));
		expect(await runAccountCreationStep(f.target, { step: "enter", host: "glassdoor.com", code: "000000" })).toEqual({ state: "failed", reason: "code_rejected" });
		expect(f.resumed()).toBe(0);
	});

	it("an email that already has an account → email_taken (no second account, the owner is told)", async () => {
		const f = onForm({ after: "taken" });
		expect(await runAccountCreationStep(f.target, submit({ acceptTerms: true }))).toEqual({ state: "failed", reason: "email_taken" });
		expect(f.resumed()).toBe(0);
	});

	it("a CAPTCHA after the press ends captcha and is not worked around", async () => {
		const f = onForm({ after: "captcha" });
		expect(await runAccountCreationStep(f.target, submit({ acceptTerms: true }))).toEqual({ state: "failed", reason: "captcha" });
		expect(f.resumed()).toBe(0);
	});

	it("a page that does nothing → not_created", async () => {
		const f = onForm({ after: "same" });
		expect(await runAccountCreationStep(f.target, submit({ acceptTerms: true }))).toEqual({ state: "failed", reason: "not_created" });
	});

	it("a form that asks for a password the cloud did not prepare → password_not_prepared, nothing typed or pressed", async () => {
		const f = onForm();
		expect(await runAccountCreationStep(f.target, { step: "submit", host: "glassdoor.com", acceptTerms: true })).toEqual({ state: "failed", reason: "password_not_prepared" });
		expect(f.typed).toEqual([]);
		expect(f.clicked).toEqual([]);
	});

	it("a passwordless form is submitted with no password typed", async () => {
		const f = fakeSite({ url: SIGN_UP_URL, page: EMAIL_ONLY_PAGE, after: "code" });
		expect(await runAccountCreationStep(f.target, { step: "submit", host: "glassdoor.com", acceptTerms: false })).toEqual({ state: "code_requested" });
		expect(f.typed).toEqual([]);
		expect(f.clicked).toEqual(["s2"]);
	});

	it("a two-step form: the password page appears after the first press and the stored password is typed there", async () => {
		const f = fakeSite({ url: SIGN_UP_URL, page: EMAIL_ONLY_PAGE, after: "password_page" });
		// The cloud was told there was no password at prepare, so a password page now is not something it stored for: refuse, don't invent.
		expect(await runAccountCreationStep(f.target, { step: "submit", host: "glassdoor.com", acceptTerms: false })).toEqual({ state: "failed", reason: "password_not_prepared" });
		const g = fakeSite({ url: SIGN_UP_URL, page: EMAIL_ONLY_PAGE, after: "password_page" });
		const second = await runAccountCreationStep(g.target, submit());
		expect(second.state === "created" || second.state === "failed").toBe(true);
		expect(g.typed.map((t) => t.text)).toContain(PASSWORD);
	});

	it("a page on another host gets nothing typed", async () => {
		const f = fakeSite({ url: "https://accounts.google.com/signup", page: SIGN_UP_PAGE });
		expect(await runAccountCreationStep(f.target, submit({ acceptTerms: true }))).toEqual({ state: "failed", reason: "host_mismatch" });
		expect(f.typed).toEqual([]);
	});

	it("a form with no button of its own ends no_submit_button", async () => {
		const f = onForm({ page: SIGN_UP_PAGE.replace('- button "Create account" [ref=s1]', "") });
		expect(await runAccountCreationStep(f.target, submit({ acceptTerms: true }))).toEqual({ state: "failed", reason: "no_submit_button" });
	});
});

describe("the page readers", () => {
	it("recognises a sign-up form by an email box beside a password or name box, or by the address", () => {
		expect(isSignUpForm(controlsOf(SIGN_UP_PAGE), "https://x.test/start")).toBe(true);
		expect(isSignUpForm(controlsOf(EMAIL_ONLY_PAGE), "https://x.test/start")).toBe(false);
		// A sign-in page has an email box and a password box too — that is not a sign-up form.
		expect(isSignUpForm(controlsOf(SIGN_IN_PAGE), SIGN_IN_URL)).toBe(false);
		expect(isSignUpForm(controlsOf(EMAIL_ONLY_PAGE), "https://x.test/signup")).toBe(true);
		expect(isSignUpForm(controlsOf(CODE_PAGE), "https://x.test/signup")).toBe(false);
	});
	it("terms boxes are about terms or privacy and never about being marketed to", () => {
		expect(termsBoxes(controlsOf(SIGN_UP_PAGE)).map((c) => c.ref)).toEqual(["t1"]);
		expect(termsBoxes(controlsOf('- checkbox "Send me offers and accept marketing" [ref=a]'))).toEqual([]);
	});
	it("reads which checkboxes are already ticked, in either attribute order", () => {
		expect([...checkedRefs('- checkbox "A" [checked] [ref=a1]\n- checkbox "B" [ref=b1] [checked]\n- checkbox "C" [ref=c1]')].sort()).toEqual(["a1", "b1"]);
	});
});
