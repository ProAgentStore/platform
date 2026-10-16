import { describe, expect, it } from "vitest";
import type { BrowserTools } from "../local-browser/bridge.js";
import type { LocalApplyEvent } from "./contract.js";
import { codeBoxes, controlsOf, runEmailCodeStep } from "./email-code.js";

/** SEEK's sign-in page as read live for #1106 (`login.seek.com`, ARIA snapshot), with refs added. */
const SEEK_SIGN_IN = [
	'- heading "Sign in" [level=1] [ref=e3]',
	'- button "Continue with Google" [ref=e4]',
	'- textbox "Email address" [ref=e9]',
	'- button "Email me a sign in code" [ref=e10]',
	'- link "Register" [ref=e11]',
].join("\n");
const CODE_PAGE = ['- heading "Check your email" [ref=e20]', '- textbox "Sign in code" [ref=e21]', '- button "Sign in" [ref=e22]', '- button "Resend code" [ref=e23]'].join("\n");
const JOB = "https://au.seek.com/job/95289924?ref=search";

/** A fake browser: a URL, a page per URL, and what each click and keystroke does to them. */
function fakeSeek(opts: { start?: string; codePage?: string; acceptCode?: string | null } = {}) {
	let url = opts.start ?? JOB;
	let page = url.includes("login.seek.com") ? SEEK_SIGN_IN : '- link "Sign in" [ref=e1]\n- button "Quick apply" [ref=e2]';
	const typed: Array<{ target: string; text: string }> = [];
	const calls: string[] = [];
	const tools: BrowserTools = {
		listTools: async () => [],
		callTool: async (name, args = {}) => {
			calls.push(name);
			if (name === "browser_evaluate") return { content: [{ type: "text", text: `### Result\n${JSON.stringify(url)}\n` }] };
			if (name === "browser_snapshot") return { content: [{ type: "text", text: page }] };
			if (name === "browser_navigate") {
				url = String(args.url).includes("/oauth/login") ? "https://login.seek.com/login?state=x" : String(args.url);
				page = SEEK_SIGN_IN;
			}
			if (name === "browser_type") typed.push({ target: String(args.target), text: String(args.text) });
			if (name === "browser_click" && args.target === "e10") page = opts.codePage ?? CODE_PAGE;
			if (name === "browser_click" && args.target === "e22" && opts.acceptCode !== null && typed.some((t) => t.text === (opts.acceptCode ?? "482913"))) {
				url = JOB.split("?")[0];
				page = '- button "Quick apply" [ref=e2]';
			}
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
	const events: Array<Omit<LocalApplyEvent, "at">> = [];
	let resumed = 0;
	const target = { tools, emit: (e: Omit<LocalApplyEvent, "at">) => events.push(e), resume: () => resumed++, wait: async () => {} };
	return { target, typed, calls, events, resumed: () => resumed, url: () => url };
}

describe("controlsOf / codeBoxes", () => {
	it("reads role, name and ref from a snapshot line", () => {
		expect(controlsOf(SEEK_SIGN_IN)).toContainEqual({ role: "textbox", name: "Email address", ref: "e9" });
	});
	it("finds one named code box, or one box per digit — never the email box", () => {
		expect(codeBoxes(controlsOf(CODE_PAGE)).map((c) => c.ref)).toEqual(["e21"]);
		const digits = Array.from({ length: 6 }, (_, i) => `- textbox [ref=d${i}]`).join("\n");
		expect(codeBoxes(controlsOf(digits))).toHaveLength(6);
		expect(codeBoxes(controlsOf(SEEK_SIGN_IN))).toEqual([]);
	});
});

describe("the email-code sign-in on SEEK (#1106)", () => {
	it("request: from the job page it opens SEEK's sign-in, enters the account email and asks for a code", async () => {
		const f = fakeSeek();
		expect(await runEmailCodeStep(f.target, { step: "request", email: "serge.pro.job@gmail.com" })).toEqual({ state: "code_requested" });
		expect(f.calls).toContain("browser_navigate");
		expect(f.typed).toEqual([{ target: "e9", text: "serge.pro.job@gmail.com" }]);
		// The trace names the site and the decision; never the address.
		expect(JSON.stringify(f.events)).not.toContain("serge.pro.job");
		expect(f.events.at(-1)?.detail).toMatchObject({ tool: "email_code_sign_in", decision: "code_requested", site: "seek.com" });
		expect(f.resumed()).toBe(0);
	});

	it("enter: types the code, waits for SEEK to let the browser in, and releases the pause — the code is never traced", async () => {
		const f = fakeSeek({ start: "https://login.seek.com/login?state=x" });
		await runEmailCodeStep(f.target, { step: "request", email: "serge.pro.job@gmail.com" });
		expect(await runEmailCodeStep(f.target, { step: "enter", code: "482913" })).toEqual({ state: "signed_in" });
		expect(f.typed.at(-1)).toEqual({ target: "e21", text: "482913" });
		expect(f.resumed()).toBe(1);
		expect(JSON.stringify(f.events)).not.toContain("482913");
		expect(f.events.at(-1)?.detail).toMatchObject({ decision: "signed_in", site: "seek.com" });
	});

	it("a code SEEK does not accept leaves the run paused for the owner", async () => {
		const f = fakeSeek({ start: "https://login.seek.com/login?state=x", acceptCode: null });
		await runEmailCodeStep(f.target, { step: "request", email: "serge.pro.job@gmail.com" });
		expect(await runEmailCodeStep(f.target, { step: "enter", code: "000000" })).toEqual({ state: "failed", reason: "code_rejected" });
		expect(f.resumed()).toBe(0);
	});

	it("a page with no code box after the request fails plainly instead of waiting", async () => {
		const f = fakeSeek({ codePage: '- alert "Something went wrong" [ref=e30]' });
		expect(await runEmailCodeStep(f.target, { step: "request", email: "serge.pro.job@gmail.com" })).toEqual({ state: "failed", reason: "no_code_field" });
	});

	it("only SEEK: any other site is refused before anything is typed", async () => {
		const f = fakeSeek({ start: "https://boards.greenhouse.io/acme/jobs/1" });
		expect(await runEmailCodeStep(f.target, { step: "request", email: "serge.pro.job@gmail.com" })).toEqual({ state: "failed", reason: "unsupported_site" });
		expect(f.typed).toEqual([]);
	});

	it("refuses a malformed request rather than typing it", async () => {
		const f = fakeSeek();
		await expect(runEmailCodeStep(f.target, { step: "request", email: "not an email" })).rejects.toThrow(/sign-in email/);
		await expect(runEmailCodeStep(f.target, { step: "enter", code: "12; DROP" })).rejects.toThrow(/code/);
		expect(f.typed).toEqual([]);
	});
});
