/**
 * The apply bridge enforces the write policy itself (#957): which action class a call is, whether
 * its value is grounded, when it must stop for a person, and that a final submit happens only
 * under an enabled gate — once. The browser is faked; every rule under test is the bridge's code.
 */
import { describe, expect, it } from "vitest";
import { PREFERENCE_FIELD_PROBE_FN, projectPreferenceSources } from "../instance-preferences.js";
import type { InstancePreferences } from "../instance-preferences-contract.js";
import type { BrowserTools } from "../local-browser/bridge.js";
import { SIGN_IN_CONTROL_PROBE_FN } from "./sign-in-policy.js";
import { ApplyBridge, type ApplyBridgeHost, CREDENTIAL_NAME, groundingRefusal } from "./bridge.js";
import { type LocalApplyEvent, type LocalApplyPause, parseLocalApplyEvent } from "./contract.js";
import { APPLY_SHOT_CAP, type MaskablePage, ShotRecorder } from "../local-browser/replay.js";

interface PageFlags {
	title?: string;
	captcha?: boolean;
	login?: boolean;
	duplicate?: boolean;
	antiBot?: boolean;
	confirmed?: boolean;
	unavailable?: "expired" | "unavailable";
}

const FORM = "https://jobs.example.com/apply";
const SNAPSHOT = [
	'- textbox "Full name" [ref=e1]',
	'- textbox "Email" [ref=e2]',
	'- combobox "Work authorization" [ref=e3]',
	'- radio "No" [ref=e4]',
	'- radio "Yes" [ref=e5]',
	'- checkbox "I agree to the privacy policy" [ref=e6]',
	'- button "Upload resume" [ref=e7]',
	'- button "Submit application" [ref=e8]',
	'- button "Envoyer ma candidature" [ref=e9]',
	'- link "Company careers" [ref=e10]',
	'- textbox "Password" [ref=e11]',
	'- button "Share on LinkedIn" [ref=e12]',
	'- button "Resume" [ref=e13]',
	// The SEEK shape (#985): a job AD with the control that OPENS the application, and the
	// profile-apply control that can send it outright.
	'- link "Apply" [ref=e20]',
	'- button "Apply for this job" [ref=e21]',
	'- button "Quick apply" [ref=e22]',
	'- button "Save and continue" [ref=e23]',
	// #1014: an emailed one-time-code sign-in screen has no password field — only the code box.
	'- textbox "Enter the 6-digit code we emailed you" [ref=e30]',
	'- textbox "Sign-in code" [ref=e31]',
	'- option "Australian/New Zealand Citizen" [ref=e50]',
	'- option "New Zealand Citizen" [ref=e51]',
	'- option "$160,001 - $180,000" [ref=e52]',
	'- textbox "Postcode" [ref=e32]',
	// #1412: a sign-in page's own controls — the address box, the password submit, and the emailed-code request.
	'- textbox "Email address" [ref=e40]',
	'- button "Sign in" [ref=e41]',
	'- button "Email me a sign in code" [ref=e42]',
].join("\n");
/** What the commit-guard probe reads from the page for each ref. */
const FACTS: Record<string, { submits: boolean; method: string; name: string }> = {
	e7: { submits: false, method: "post", name: "Upload resume" },
	e8: { submits: true, method: "post", name: "Submit application" },
	e9: { submits: true, method: "post", name: "Envoyer ma candidature" },
	e10: { submits: false, method: "", name: "Company careers" },
	e12: { submits: false, method: "", name: "Share on LinkedIn" },
	e13: { submits: false, method: "post", name: "Resume", tag: "input", type: "file" } as never,
	e20: { submits: false, method: "", name: "Apply" },
	e21: { submits: true, method: "post", name: "Apply for this job" },
	e22: { submits: false, method: "", name: "Quick apply" },
	e23: { submits: true, method: "post", name: "Save and continue" },
	e41: { submits: true, method: "post", name: "Sign in" },
	e42: { submits: false, method: "", name: "Email me a sign in code" },
};

function fakeBrowser(
	pages: Record<string, PageFlags> = {},
	opts: { clicks?: Record<string, string>; uploadError?: string; postSubmit?: (looks: number) => PageFlags } = {},
) {
	const calls: Array<{ name: string; args: Record<string, unknown>; internal?: boolean }> = [];
	const internalCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const refusals: Array<{ tool: string; args: Record<string, unknown>; reason: string }> = [];
	const history: string[] = [];
	let submitPressed = false;
	let postSubmitLooks = 0;
	const tools: BrowserTools = {
		listTools: async () =>
			["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_click", "browser_type", "browser_select_option", "browser_press_key", "browser_evaluate", "browser_fill_form", "browser_file_upload", "browser_wait_for"].map((name) => ({
				name,
				inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
			})),
		refused: (tool, args, reason) => refusals.push({ tool, args, reason }),
		callTool: async (name, args = {}, callOpts) => {
			if (name === "browser_evaluate") {
				// Kept OUT of `calls`/`sent()`: every pre-existing test here reads those as "what the agent itself
				// drove", and the bridge's own navigation-inspection evaluate is never agent-reachable — it is
				// refused by name before `callTool` either way. Tracked separately for the #1409 `internal` tests.
				if (callOpts?.internal) internalCalls.push({ name, args });
				if (args.function === SIGN_IN_CONTROL_PROBE_FN) return { content: [{ text: `### Result\n${JSON.stringify({ origin: new URL(history.at(-1) ?? FORM).origin, visible: true, safeDestination: true, credential: args.target === "e11" ? "password" : args.target === "e40" ? "username" : args.target === "e30" || args.target === "e31" ? "code" : null, sessionControl: args.target === "e41" || args.target === "e42" })}` }] };
				if (typeof args.target === "string") return { content: [{ text: `### Result\n${JSON.stringify({ tag: "button", type: "", ...(FACTS[args.target] ?? { submits: false, method: "", name: "" }) })}` }] };
				const url = history[history.length - 1] ?? "about:blank";
				return { content: [{ text: `### Result\n${JSON.stringify({ url, title: "Apply", ...pages[url], ...(submitPressed ? opts.postSubmit?.(postSubmitLooks) : {}) })}\n### Ran Playwright code` }] };
			}
			calls.push({ name, args, ...(callOpts?.internal ? { internal: true } : {}) });
			if (name === "browser_navigate") history.push(String(args.url));
			if (name === "browser_click") {
				if (args.target === "e8") submitPressed = true;
				if (opts.clicks?.[String(args.target)]) history.push(opts.clicks[String(args.target)]);
			}
			if (name === "browser_wait_for" && submitPressed) postSubmitLooks++;
			if (name === "browser_navigate_back") history.pop();
			if (name === "browser_snapshot") return { content: [{ text: SNAPSHOT }] };
			if (name === "browser_file_upload" && opts.uploadError) return { content: [{ text: opts.uploadError }], isError: true };
			return { content: [{ text: `${name} ok` }] };
		},
	};
	return { tools, calls, internalCalls, refusals, history, sent: (n: string) => calls.filter((c) => c.name === n) };
}

const PROFILE = "Name: Jane Citizen\nEmail: jane@example.com\nWork authorization: Authorized to work in Australia\nRequires sponsorship: No\nNotice period: four weeks";

/** A real page is what makes a frame possible at all (#1419) — a working fake by default. */
function fakePage(opts: { shotThrows?: boolean } = {}): MaskablePage {
	return {
		locator: () => ({}) as ReturnType<MaskablePage["locator"]>,
		screenshot: async () => {
			if (opts.shotThrows) throw new Error("page closed");
			return Buffer.from("/9j/4AAQSkZJRgABAQ==", "base64");
		},
	};
}

function fakeHost(o: { mode?: "fill_and_review" | "auto_submit"; allow?: string[]; resume?: (p: LocalApplyPause) => "resumed" | "stopped" | "sign_in"; artifactError?: string; directive?: "continue" | "request_review" | "stop"; page?: MaskablePage | null } = {}) {
	const events: Array<Omit<LocalApplyEvent, "at">> = [];
	const pauses: LocalApplyPause[] = [];
	const allow = new Set(o.allow ?? ["jobs.example.com"]);
	const grounding = [PROFILE];
	const page = "page" in o ? o.page : fakePage();
	const host: ApplyBridgeHost & { allow: Set<string>; grounding_: string[] } = {
		allow,
		grounding_: grounding,
		emit: (e) => events.push(e),
		pause: async (p) => {
			pauses.push(p);
			return o.resume ? o.resume(p) : "stopped";
		},
		supervisorCheckpoint: async () => o.directive ?? "continue",
		isAllowed: (h) => [...allow].some((d) => h === d || h.endsWith(`.${d}`)),
		grounding: () => grounding.join("\n"),
		groundingSources: () => grounding.map((text) => ({ label: "profile", text })),
		artifactPath: (kind) => (o.artifactError ? { error: o.artifactError } : { path: `/home/jane/jobs/applications/lead-1/run-1/${kind}.md`, sha256: "a".repeat(64) }),
		overTime: () => false,
		now: () => Date.parse("2026-10-07T01:00:00Z"),
		limits: { maxMinutes: 20, maxPages: 30, maxActions: 300 },
		mode: o.mode ?? "fill_and_review",
		page: () => page ?? null,
		...(o.mode === "auto_submit" ? { gateId: "gate-1" } : {}),
	};
	return { host, events, pauses };
}

async function onForm(pages: Record<string, PageFlags> = {}, hostOpts: Parameters<typeof fakeHost>[0] = {}, browserOpts: Parameters<typeof fakeBrowser>[1] = {}) {
	const b = fakeBrowser(pages, browserOpts);
	const h = fakeHost(hostOpts);
	const bridge = new ApplyBridge(b.tools, h.host);
	await bridge.callTool("browser_navigate", { url: FORM });
	await bridge.callTool("browser_snapshot", {});
	await bridge.callTool("supervisor_checkpoint", { checkpointId: "initial:1", phase: "initial" });
	return { bridge, ...b, ...h };
}

describe("groundingRefusal — an answer must come from the owner's own sources", () => {
	it("accepts a value that appears in a verbatim quote", () => {
		expect(groundingRefusal("Jane Citizen", "Name: Jane Citizen", PROFILE)).toBeNull();
	});
	it("refuses a missing quote, an invented quote and a value outside the quote", () => {
		expect(groundingRefusal("Jane", undefined, PROFILE)).toMatch(/source_quote/);
		expect(groundingRefusal("Jane", "Name: Jane Doe", PROFILE)).toMatch(/not text from the owner's/);
		expect(groundingRefusal("jane@other.com", "Email: jane@example.com", PROFILE)).toMatch(/does not appear/);
	});
	it("matches whole phrases only: 'No' is not found inside 'Notice'", () => {
		expect(groundingRefusal("No", "Notice period: four weeks", PROFILE)).toMatch(/does not appear/);
		expect(groundingRefusal("No", "Requires sponsorship: No", PROFILE)).toBeNull();
	});
});

describe("the action classes", () => {
	it("maps a verified Australian citizenship fact to the observed combined citizenship option", async () => {
		const h = await onForm();
		const source = "Work authorization: Australian citizen with Australian work authorization";
		h.host.grounding_.push(source);
		expect((await h.bridge.callTool("browser_click", { target: "e50", source_quote: source })).isError).toBeFalsy();
		expect(h.sent("browser_click").map((c) => c.args.target)).toEqual(["e50"]);
	});
	it.each([
		["Citizenship: not an Australian citizen", "Australian citizen"],
		["Citizenship: Australian citizen (unconfirmed)", "Australian citizen"],
		["Citizenship: Australian citizen?", "Australian citizen"],
		["Citizenship: Canadian citizen", "Citizenship: Canadian citizen"],
		["Australian working rights: permanent resident", "Australian working rights: permanent resident"],
		["Country: Australia", "Country: Australia"],
		["Australian citizen", "Citizenship: Australian citizen"],
		["Citizenship: Australian citizen\nCitizenship: unknown", "Citizenship: Australian citizen"],
		["Citizenship: Australian citizen\nI am not an Australian citizen", "Citizenship: Australian citizen"],
		["Citizenship: Australian citizen\nI don’t have Australian citizenship", "Australian citizen"],
		["Citizenship: Australian citizen\nAustralian citizenship: to be confirmed", "Australian citizen"],
		["Not:\nAustralian citizen", "Australian citizen"],
		["Not an\nAustralian citizen", "Australian citizen"],
	])("refuses unsupported citizenship mapping from %s", async (source, quote) => {
		const h = await onForm();
		h.host.grounding_.push(source);
		expect((await h.bridge.callTool("browser_click", { target: "e50", source_quote: quote })).isError).toBe(true);
		expect(h.sent("browser_click")).toHaveLength(0);
	});
	it("keeps salary, other citizenship categories, free text and unobserved refs strict", async () => {
		const h = await onForm();
		const source = "Australian working rights: Australian citizen";
		h.host.grounding_.push(source, "Salary expectation: AUD 180,000");
		for (const target of ["e51", "unobserved"]) expect((await h.bridge.callTool("browser_click", { target, source_quote: source })).isError).toBe(true);
		expect((await h.bridge.callTool("browser_click", { target: "e52", source_quote: "Salary expectation: AUD 180,000" })).isError).toBe(true);
		expect((await h.bridge.callTool("browser_type", { target: "e1", text: "Australian/New Zealand Citizen", source_quote: source })).isError).toBe(true);
		expect(h.sent("browser_click")).toHaveLength(0);
		expect(h.sent("browser_type")).toHaveLength(0);
	});
	it("does not promote a generated résumé statement into an authoritative profile fact", async () => {
		const h = await onForm();
		const source = "Citizenship: Australian citizen";
		h.host.grounding_.push(source);
		h.host.groundingSources = () => [{ label: "profile", text: PROFILE }, { label: "resume", text: source }];
		expect((await h.bridge.callTool("browser_click", { target: "e50", source_quote: source })).isError).toBe(true);
		expect(h.sent("browser_click")).toHaveLength(0);
	});
	it("grounds the observed option from the profile despite positive résumé and cover-letter formatting", async () => {
		const h = await onForm();
		const quote = "Work authorization: Australian citizen with Australian work authorization";
		const sources = [
			{ label: "profile", text: `City: Adelaide\nState/Region: SA\nCountry: Australia\n${quote}\nAustralian working rights: Australian citizen\n\nProvenance: User-confirmed corrections are Australian citizenship and Adelaide/Perth targeting.` },
			{ label: "resume", text: "📞 +61 400 000 000 | 📧 candidate@example.test | 🔗 example.test/profile\nAdelaide, SA, Australia | Australian Citizen | Open to hybrid" },
			{ label: "cover_letter", text: "I am an Australian citizen based in Adelaide and happy to work hybrid. I would welcome the chance to discuss how I can help Example's teams deliver on a reliable cadence." },
		];
		h.host.grounding_.push(...sources.map((source) => source.text));
		h.host.groundingSources = () => sources;
		expect((await h.bridge.callTool("browser_click", { target: "e50", source_quote: quote })).isError).toBeFalsy();
		expect(h.sent("browser_click").map((call) => call.args.target)).toEqual(["e50"]);
	});
	it.each([
		["owner answers", "I am not a citizen of Australia."],
		["cover_letter", "I am an Australian citizen. Correction: this is false."],
		["profile", "Not:\n\nCitizenship: Australian citizen"],
		["profile", "Not: confirmed\nCitizenship: Australian citizen"],
		["profile", "The following information is incorrect.\n\nCitizenship: Australian citizen"],
		["cover_letter", "I am an Australian citizen.\n\nCorrection: the previous statement is false."],
	])("refuses an ambiguous or conflicting %s paragraph", async (label, text) => {
		const h = await onForm();
		const quote = "Citizenship: Australian citizen";
		h.host.grounding_.push(quote, text);
		h.host.groundingSources = () => [{ label: "profile", text: quote }, { label, text }];
		expect((await h.bridge.callTool("browser_click", { target: "e50", source_quote: quote })).isError).toBe(true);
		expect(h.sent("browser_click")).toHaveLength(0);
	});
	it("never treats a citizenship option quoted in an owner question as the owner's answer", async () => {
		const h = await onForm();
		const question = "Q: Select Australian/New Zealand Citizen or visa holder";
		h.host.grounding_.push(question);
		h.host.groundingSources = () => [{ label: "profile", text: PROFILE }, { label: "owner answers", text: `${question}\nA: visa holder` }];
		expect((await h.bridge.callTool("browser_click", { target: "e50", source_quote: question })).isError).toBe(true);
		expect(h.sent("browser_click")).toHaveLength(0);
	});
	it.each(["Australian citizen", "New Zealand citizen", "Australian/New Zealand Citizen"])("accepts the owner's actual affirmative answer: %s", async (answerText) => {
		const h = await onForm();
		const text = `Q: Which citizenship option applies?\nA: ${answerText}`;
		h.host.grounding_.push(text);
		h.host.groundingSources = () => [{ label: "profile", text: PROFILE }, { label: "owner answers", text, answerText }];
		expect((await h.bridge.callTool("browser_click", { target: "e50", source_quote: `A: ${answerText}` })).isError).toBeFalsy();
		expect(h.sent("browser_click").map((call) => call.args.target)).toEqual(["e50"]);
	});
	it.each(["New Zealand citizen", "Australian/New Zealand Citizen"])("accepts an explicit affirmative profile category: %s", async (value) => {
		const h = await onForm();
		const text = `Citizenship: ${value}`;
		h.host.grounding_.push(text);
		h.host.groundingSources = () => [{ label: "profile", text }];
		expect((await h.bridge.callTool("browser_click", { target: "e50", source_quote: text })).isError).toBeFalsy();
	});
	it("keeps an explicit contradictory owner answer ahead of an older positive profile fact", async () => {
		const h = await onForm();
		const source = "Citizenship: Australian citizen";
		const answer = "Q: Are you an Australian citizen?\nA: No";
		h.host.grounding_.push(source, answer);
		h.host.groundingSources = () => [{ label: "profile", text: source }, { label: "owner answers", text: answer }];
		expect((await h.bridge.callTool("browser_click", { target: "e50", source_quote: source })).isError).toBe(true);
		expect(h.sent("browser_click")).toHaveLength(0);
	});
	it("lists only read, fill and the bridge's own tools — every fill tool demands source_quote", async () => {
		const { bridge } = await onForm();
		const tools = await bridge.listTools();
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual(["browser_click", "browser_navigate", "browser_navigate_back", "browser_press_key", "browser_select_option", "browser_snapshot", "browser_type", "browser_wait_for", "ready_for_review", "report_job_unavailable", "request_answer", "request_sign_in_code", "supervisor_checkpoint", "upload_artifact"]);
		const typeTool = tools.find((t) => t.name === "browser_type") as { inputSchema: { required: string[] } };
		expect(typeTool.inputSchema.required).toContain("source_quote");
	});

	it.each(["browser_fill_form", "browser_file_upload", "browser_evaluate", "browser_run_code", "browser_run_code_unsafe", "browser_handle_dialog", "browser_drag"])("refuses %s by name, and never forwards it", async (name) => {
		const { bridge, sent } = await onForm();
		const res = await bridge.callTool(name, { function: "() => document.forms[0].submit()" });
		expect(res.isError).toBe(true);
		expect(sent(name)).toHaveLength(0);
	});

	it("refuses Enter, Space and typed characters by key; allows Tab", async () => {
		const { bridge, sent } = await onForm();
		for (const key of ["Enter", "NumpadEnter", " ", "Space", "a"]) expect((await bridge.callTool("browser_press_key", { key })).isError).toBe(true);
		expect((await bridge.callTool("browser_press_key", { key: "Tab" })).isError).toBeFalsy();
		expect(sent("browser_press_key").map((c) => c.args.key)).toEqual(["Tab"]);
	});

	it("types a grounded value, and refuses an ungrounded one or a submitting one", async () => {
		const { bridge, sent, events } = await onForm();
		expect((await bridge.callTool("browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" })).isError).toBeFalsy();
		expect((await bridge.callTool("browser_type", { target: "e2", text: "jane@guess.com", source_quote: "Email: jane@example.com" })).isError).toBe(true);
		expect((await bridge.callTool("browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen", submit: true })).isError).toBe(true);
		expect(sent("browser_type")).toHaveLength(1);
		expect(bridge.filled).toBe(1);
		// The trace names the class and the role, never the value typed.
		expect(JSON.stringify(events)).not.toContain("Jane Citizen");
	});

	it("requires a persisted supervisor continuation for writes, and resets it after navigation", async () => {
		const b = fakeBrowser();
		const h = fakeHost();
		const bridge = new ApplyBridge(b.tools, h.host);
		await bridge.callTool("browser_navigate", { url: FORM });
		await bridge.callTool("browser_snapshot", {});
		expect((await bridge.callTool("browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" })).content[0].text).toMatch(/supervisor_checkpoint/);
		expect(b.sent("browser_type")).toHaveLength(0);
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "initial:1", phase: "initial" });
		expect((await bridge.callTool("browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" })).isError).toBeFalsy();
		await bridge.callTool("browser_navigate", { url: `${FORM}?step=2` });
		expect((await bridge.callTool("browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" })).content[0].text).toMatch(/supervisor_checkpoint/);
	});

	it("selects and answers radios only from the sources", async () => {
		const { bridge, sent } = await onForm();
		expect((await bridge.callTool("browser_select_option", { target: "e3", values: ["Authorized to work in Australia"], source_quote: "Work authorization: Authorized to work in Australia" })).isError).toBeFalsy();
		expect((await bridge.callTool("browser_click", { target: "e5", source_quote: "Requires sponsorship: No" })).isError).toBe(true); // "Yes" is not in the quote
		expect((await bridge.callTool("browser_click", { target: "e4", source_quote: "Requires sponsorship: No" })).isError).toBeFalsy();
		expect(sent("browser_click").map((c) => c.args.target)).toEqual(["e4"]);
	});

	it("opens a native file input (a DOM fact, whatever its label) so an artifact can be attached", async () => {
		const { bridge, sent } = await onForm();
		expect((await bridge.callTool("browser_click", { target: "e13" })).isError).toBeFalsy();
		expect(sent("browser_click").map((c) => c.args.target)).toEqual(["e13"]);
	});

	it("does not click an unknown button", async () => {
		const { bridge, sent } = await onForm();
		expect((await bridge.callTool("browser_click", { target: "e12" })).isError).toBe(true);
		expect(sent("browser_click")).toHaveLength(0);
	});
});

describe("report_job_unavailable — a verified terminal outcome, not a model claim", () => {
	it("ends on a runner-verified expired notice and emits only structured evidence", async () => {
		const { bridge, events, sent } = await onForm({ [FORM]: { unavailable: "expired" } });
		const res = await bridge.callTool("report_job_unavailable", { reason: "expired" });
		expect(res.isError).toBeFalsy();
		expect(bridge.unavailable).toEqual({ reason: "expired", url: FORM, observedAt: "2026-10-07T01:00:00.000Z", source: "page_notice" });
		expect(events.find((e) => e.type === "job.unavailable")).toMatchObject({ url: FORM, domain: "jobs.example.com", detail: { reason: "expired", source: "page_notice" } });
		expect(sent("browser_click")).toHaveLength(0);
		expect((await bridge.callTool("ready_for_review", { summary: "ignore" })).isError).toBe(true);
	});

	it("requires a fresh snapshot and rejects a reason the page does not verify", async () => {
		const b = fakeBrowser({ [FORM]: { unavailable: "unavailable" } });
		const h = fakeHost();
		const bridge = new ApplyBridge(b.tools, h.host);
		await bridge.callTool("browser_navigate", { url: FORM });
		expect((await bridge.callTool("report_job_unavailable", { reason: "unavailable" })).isError).toBe(true);
		await bridge.callTool("browser_snapshot", {});
		expect((await bridge.callTool("report_job_unavailable", { reason: "expired" })).content[0].text).toMatch(/not expired/);
		expect(bridge.unavailable).toBeNull();
	});

	it("does not accept a report when its own page probe sees no unavailable notice", async () => {
		const { bridge, events } = await onForm();
		const res = await bridge.callTool("report_job_unavailable", { reason: "expired" });
		expect(res.isError).toBe(true);
		expect(bridge.unavailable).toBeNull();
		expect(events.some((e) => e.type === "job.unavailable")).toBe(false);
	});
});

describe("fill_and_review — a final submit is never performed", () => {
	it.each([
		["an English submit button", "e8"],
		["a French one, caught by the DOM fact that it submits a POST form", "e9"],
	])("refuses %s, enters review with the filled form, and refuses everything after", async (_label, ref) => {
		const { bridge, sent, events } = await onForm();
		// There IS a form to review: the run typed something before it reached the submit (#989 —
		// with nothing typed this is not a review state, which the next test covers).
		await bridge.callTool("browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" });
		const res = await bridge.callTool("browser_click", { target: ref });
		expect(res.isError).toBeFalsy();
		expect(res.content[0].text).toMatch(/NOT pressed/);
		expect(sent("browser_click")).toHaveLength(0);
		expect(bridge.reviewReady).toBe(true);
		expect(bridge.submitAttempted).toBe(false);
		expect(events.some((e) => e.type === "policy.decision" && e.detail?.class === "submit" && e.detail.decision === "refused")).toBe(true);
		expect(events.some((e) => e.type === "submit.attempted")).toBe(false);
		expect((await bridge.callTool("browser_click", { target: ref })).isError).toBe(true);
	});

	it("refuses submit even when the host claims auto_submit without a gate", async () => {
		const b = fakeBrowser();
		const h = fakeHost({ mode: "fill_and_review" });
		const bridge = new ApplyBridge(b.tools, { ...h.host, mode: "auto_submit", gateId: undefined });
		await bridge.callTool("browser_navigate", { url: FORM });
		await bridge.callTool("browser_snapshot", {});
		await bridge.callTool("browser_click", { target: "e8" });
		expect(b.sent("browser_click")).toHaveLength(0);
	});
});

/**
 * #985: four live fill-and-review runs on one SEEK posting ended `awaiting_review` with
 * `filled: 0`, seconds after the cloud had decided `continue` at their initial checkpoint and the
 * CLI had resumed. The press that OPENS the application was being read as the final submit.
 */
describe("the control that OPENS an application is pressed, not refused (#985)", () => {
	it.each([
		["a link labelled Apply on a job ad", "e20"],
		["a button labelled Apply for this job, inside a POST form", "e21"],
		["a page-advance labelled Save and continue, inside a POST form", "e23"],
	])("presses %s and stays in the run", async (_label, ref) => {
		const { bridge, sent, events } = await onForm({}, {}, { clicks: { [ref]: "https://jobs.example.com/apply/step-1" } });
		const res = await bridge.callTool("browser_click", { target: ref });
		expect(res.isError).toBeFalsy();
		// The click REACHED the page, which is the whole capability the live runs never got to use.
		expect(sent("browser_click")).toHaveLength(1);
		// Not a review, not a submit attempt, and the owner is not waiting for anything.
		expect(bridge.reviewReady).toBe(false);
		expect(bridge.submitAttempted).toBe(false);
		expect(events.some((e) => e.type === "policy.decision" && e.detail?.class === "submit")).toBe(false);
		// And it is traced as what it is, with the rule that classified it.
		expect(events.some((e) => e.type === "policy.decision" && e.detail?.class === "entry" && e.detail.decision === "allowed")).toBe(true);
	});

	it("needs the supervisor's live continue, exactly as a fill does", async () => {
		// A page change on an unapproved page is the thing the checkpoint exists to gate.
		const b = fakeBrowser({}, { clicks: { e20: "https://jobs.example.com/apply/step-1" } });
		const h = fakeHost();
		const bridge = new ApplyBridge(b.tools, h.host);
		await bridge.callTool("browser_navigate", { url: FORM });
		await bridge.callTool("browser_snapshot", {});
		const res = await bridge.callTool("browser_click", { target: "e20" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/supervisor_checkpoint must return continue/);
		expect(b.sent("browser_click")).toHaveLength(0);
	});

	it("clears the approval after the page moves, so the form that opens gets its OWN checkpoint", async () => {
		const { bridge, sent } = await onForm({}, {}, { clicks: { e20: "https://jobs.example.com/apply/step-1" } });
		await bridge.callTool("browser_click", { target: "e20" });
		// The next fill on the new page is refused until the cloud approves that page.
		const fill = await bridge.callTool("browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" });
		expect(fill.isError).toBe(true);
		expect(fill.content[0].text).toMatch(/supervisor_checkpoint must return continue/);
		expect(sent("browser_type")).toHaveLength(0);
	});

	it("a ONE-CLICK apply is still refused, and now says so in the words an owner needs", async () => {
		const { bridge, sent, events } = await onForm();
		const res = await bridge.callTool("browser_click", { target: "e22" });
		expect(res.isError).toBeFalsy();
		expect(sent("browser_click")).toHaveLength(0);
		expect(res.content[0].text).toMatch(/can send the application in one click/);
		expect(res.content[0].text).toMatch(/Approve this application/);
		// #989: nothing was entered, so this is NOT a review state — it is a recorded blocker with
		// the owner's remedy on it. `awaiting_review` with `filled: 0` is the outcome the issue
		// forbids, and it was produced here.
		expect(bridge.reviewReady).toBe(false);
		expect(bridge.blocked).toMatchObject({ reason: "incomplete" });
		expect(bridge.blocked?.questions?.[0]).toMatch(/can send the application in one click/);
		expect(bridge.blocked?.questions?.[0]).toMatch(/Approve this application|apply on the site yourself/);
		// The trace names the RULE and the control, so "stopped at filled: 0" is explicable.
		const refusal = events.find((e) => e.type === "policy.decision" && e.detail?.class === "submit" && e.detail.decision === "refused");
		expect(refusal?.detail).toMatchObject({ reason: "fill_and_review", rule: "one_click_apply" });
	});

	it("once a field is filled, the APPLY-family control is the submit again", async () => {
		const { bridge, sent, events } = await onForm();
		await bridge.callTool("browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" });
		expect(sent("browser_type")).toHaveLength(1);
		const res = await bridge.callTool("browser_click", { target: "e21" });
		expect(res.content[0].text).toMatch(/NOT pressed/);
		expect(sent("browser_click")).toHaveLength(0);
		expect(bridge.reviewReady).toBe(true);
		expect(events.find((e) => e.type === "policy.decision" && e.detail?.class === "submit")?.detail).toMatchObject({ rule: "post_submit_after_fill" });
	});
});

describe("auto_submit — once, gated, traced, and only on a confirmation", () => {
	it("submits once and records the confirmed page with the gate", async () => {
		const { bridge, sent, events } = await onForm({ "https://jobs.example.com/thanks": { confirmed: true } }, { mode: "auto_submit" }, { clicks: { e8: "https://jobs.example.com/thanks" } });
		const res = await bridge.callTool("browser_click", { target: "e8" });
		expect(res.content[0].text).toMatch(/Submitted/);
		expect(sent("browser_click")).toHaveLength(1);
		expect(bridge.submitted).toEqual({ url: "https://jobs.example.com/thanks", at: "2026-10-07T01:00:00.000Z", gateId: "gate-1" });
		const types = events.map((e) => e.type);
		expect(types.indexOf("submit.attempted")).toBeLessThan(types.indexOf("submit.confirmed"));
		expect(events.find((e) => e.type === "submit.attempted")?.detail?.gateId).toBe("gate-1");
		expect(events.find((e) => e.type === "submit.confirmed")?.detail).toMatchObject({ gateId: "gate-1", marker: "page_text", looks: 1, urlChanged: true });
		// A second press is impossible.
		expect((await bridge.callTool("browser_click", { target: "e8" })).isError).toBe(true);
		expect(sent("browser_click")).toHaveLength(1);
	});

	it("serializes concurrent submit calls across their asynchronous probes and sends exactly once (#1438)", async () => {
		const { bridge, sent, events } = await onForm({ "https://jobs.example.com/thanks": { confirmed: true } }, { mode: "auto_submit" }, { clicks: { e8: "https://jobs.example.com/thanks" } });
		const results = await Promise.all([
			bridge.callTool("browser_click", { target: "e8" }),
			bridge.callTool("browser_click", { target: "e8" }),
		]);
		expect(results[0].content[0].text).toContain("Submitted");
		expect(results[1].isError).toBe(true);
		expect(results[1].content[0].text).toContain("finished for this run");
		expect(sent("browser_click")).toHaveLength(1);
		expect(events.filter(e => e.type === "submit.attempted")).toHaveLength(1);
		expect(events.filter(e => e.type === "submit.confirmed")).toHaveLength(1);
	});

	it("keeps looking for a delayed SEEK-style receipt, then confirms it exactly once", async () => {
		// `confirmed` is the browser's boolean result from CONFIRMATION_TEXT_RE; confirmation.test.ts
		// pins the realistic SEEK wording ("Your application has been sent") that produces it.
		const { bridge, sent, events } = await onForm({}, { mode: "auto_submit" }, { postSubmit: (looks) => (looks >= 2 ? { confirmed: true, title: "Application sent" } : {}) });
		const res = await bridge.callTool("browser_click", { target: "e8" });
		expect(res.content[0].text).toMatch(/Submitted/);
		expect(sent("browser_click")).toHaveLength(1);
		expect(sent("browser_wait_for")).toHaveLength(2);
		expect(bridge.confirmation).toMatchObject({ marker: "page_text", looks: 2, urlChanged: false, titleChanged: true });
		expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["submit.attempted", "submit.confirmed"]));
	});

	it("accepts a moved receipt URL, but only after the submit", async () => {
		const receipt = "https://jobs.example.com/application/sent";
		const { bridge, sent } = await onForm({}, { mode: "auto_submit" }, { clicks: { e8: receipt } });
		await bridge.callTool("browser_click", { target: "e8" });
		expect(bridge.submitted?.url).toBe(receipt);
		expect(bridge.confirmation).toMatchObject({ marker: "url_receipt", looks: 1, urlChanged: true });
		expect(sent("browser_click")).toHaveLength(1);
	});

	it("never reports success without the site's confirmation", async () => {
		const { bridge, events } = await onForm({}, { mode: "auto_submit" });
		const res = await bridge.callTool("browser_click", { target: "e8" });
		expect(res.isError).toBe(true);
		expect(bridge.submitted).toBeNull();
		expect(bridge.submitAttempted).toBe(true);
		expect(bridge.blocked?.reason).toBe("submit_unconfirmed");
		expect(events.some((e) => e.type === "submit.unconfirmed")).toBe(true);
	});

	it("does not submit over a blocker", async () => {
		const { bridge, sent } = await onForm({}, { mode: "auto_submit" });
		// The captcha appears after the form was read (e.g. on the submit attempt's page state).
		const b2 = fakeBrowser({ [FORM]: { captcha: true } });
		const h2 = fakeHost({ mode: "auto_submit", resume: () => "resumed" });
		const bridge2 = new ApplyBridge(b2.tools, h2.host);
		b2.history.push(FORM);
		await bridge2.callTool("browser_snapshot", {});
		const res = await bridge2.callTool("browser_click", { target: "e8" });
		expect(res.isError).toBe(true);
		expect(b2.sent("browser_click")).toHaveLength(0);
		expect(bridge2.submitAttempted).toBe(false);
		expect(sent("browser_click")).toHaveLength(0);
		expect(bridge.submitAttempted).toBe(false);
	});
});

describe("pauses — a person handles it, the run never works around it", () => {
	it.each([
		["captcha", { captcha: true }],
		["login_required", { login: true }],
		["duplicate_application", { duplicate: true }],
		["anti_bot", { antiBot: true }],
	] as const)("%s pauses on landing", async (reason, flags) => {
		const { pauses } = await onForm({ [FORM]: flags });
		expect(pauses[0]?.reason).toBe(reason);
	});

	it("a site outside the application's pauses (external_redirect) and is admitted only when the owner allows it", async () => {
		const b = fakeBrowser();
		const h = fakeHost({ resume: () => "stopped" });
		const bridge = new ApplyBridge(b.tools, h.host);
		const res = await bridge.callTool("browser_navigate", { url: "https://elsewhere.example.org/form" });
		expect(res.isError).toBe(true);
		expect(h.pauses[0]).toMatchObject({ reason: "external_redirect", domain: "elsewhere.example.org" });
		expect(b.sent("browser_navigate")).toHaveLength(0);

		const h2 = fakeHost({
			resume: () => {
				h2.host.allow.add("elsewhere.example.org");
				return "resumed";
			},
		});
		const bridge2 = new ApplyBridge(b.tools, h2.host);
		expect((await bridge2.callTool("browser_navigate", { url: "https://elsewhere.example.org/form" })).isError).toBeFalsy();
	});

	it("a link that leaves the sites is undone and paused", async () => {
		const { bridge, pauses, sent } = await onForm({}, {}, { clicks: { e10: "https://careers.other.org/" } });
		expect((await bridge.callTool("browser_click", { target: "e10" })).isError).toBe(true);
		expect(pauses[0]).toMatchObject({ reason: "external_redirect", domain: "careers.other.org" });
		expect(sent("browser_navigate_back")).toHaveLength(1);
	});

	it("a consent tick pauses and is never clicked by the CLI", async () => {
		const { bridge, pauses, sent } = await onForm({}, { resume: () => "resumed" });
		await bridge.callTool("browser_click", { target: "e6", source_quote: "Name: Jane Citizen" });
		expect(pauses[0].reason).toBe("consent_required");
		expect(sent("browser_click")).toHaveLength(0);
	});

	it("a credential field pauses as a sign-in, nothing is typed", async () => {
		const { bridge, pauses, sent } = await onForm();
		await bridge.callTool("browser_type", { target: "e11", text: "x", source_quote: "x" });
		expect(pauses[0].reason).toBe("login_required");
		expect(sent("browser_type")).toHaveLength(0);
	});

	it.each(["e30", "e31"])("an emailed one-time-code box (%s) pauses as a sign-in for the owner's takeover; the code is never typed or echoed (#1014)", async (target) => {
		const { bridge, pauses, sent } = await onForm();
		const res = await bridge.callTool("browser_type", { target, text: "482913", source_quote: "482913" });
		expect(pauses).toHaveLength(1);
		expect(pauses[0].reason).toBe("login_required");
		expect(JSON.stringify(pauses)).not.toContain("482913");
		expect(sent("browser_type")).toHaveLength(0);
		expect(res.isError).toBe(true); // nobody resumed it: the run stops rather than guessing
	});

	it("when the owner handles the sign-in in the exact session, the run continues from a fresh snapshot (#1013 fallback)", async () => {
		const { bridge, pauses, sent } = await onForm({}, { resume: () => "resumed" });
		const res = await bridge.callTool("browser_type", { target: "e30", text: "482913", source_quote: "482913" });
		expect(pauses[0].reason).toBe("login_required");
		expect(res.isError).toBeFalsy();
		expect(JSON.stringify(res)).toMatch(/owner handled the sign-in/);
		expect(sent("browser_type")).toHaveLength(0);
	});

	it("an ordinary code answer (a postcode, a promo code) is not a sign-in", () => {
		for (const name of ["Postcode", "Promo code", "Referral code", "Post code", "Country code"]) expect(CREDENTIAL_NAME.test(name), name).toBe(false);
		for (const name of ["Verification code", "Security code", "Login code", "Enter the code we sent to your email", "6 digit code", "One-time passcode", "Password"]) expect(CREDENTIAL_NAME.test(name), name).toBe(true);
	});

	it("rejects an oversized question intact, then sends a complete rewritten question (#1475)", async () => {
		const { bridge, pauses } = await onForm();
		const oversized = `Can you confirm ${"the complete context ".repeat(20)}and the final question?`;
		const rejected = await bridge.callTool("request_answer", { question: oversized });
		expect(rejected.isError).toBe(true);
		expect(rejected.content[0].text).toContain("Rewrite a concise, complete question");
		expect(pauses).toHaveLength(0);
		const question = "What is your notice period, in weeks?";
		await bridge.callTool("request_answer", { question: `  ${question}  ` });
		expect(pauses).toEqual([{ reason: "missing_answer", question }]);
		const tool = (await bridge.listTools()).find(t => t.name === "request_answer")!;
		expect(tool.inputSchema).toMatchObject({ properties: { question: { maxLength: 300 } } });
	});

	it("request_answer pauses with the question; an unanswered one leaves the run blocked", async () => {
		const { bridge, pauses } = await onForm();
		const res = await bridge.callTool("request_answer", { question: "Salary expectation?" });
		expect(res.isError).toBe(true);
		expect(pauses[0]).toEqual({ reason: "missing_answer", question: "Salary expectation?" });
		expect(bridge.blocked).toEqual({ reason: "missing_answer", questions: ["Salary expectation?"] });
	});

	it("a resume without an answer means leave it blank — never a cue to guess", async () => {
		const { bridge } = await onForm({}, { resume: () => "resumed" });
		const res = await bridge.callTool("request_answer", { question: "LinkedIn URL?" });
		expect(res.content[0].text).toMatch(/leave that field empty/);
		expect(bridge.blocked).toBeNull();
	});

	it("an answered question becomes groundable", async () => {
		const h = fakeHost({
			resume: () => {
				h.host.grounding_.push("Q: Salary expectation?\nA: 150000 AUD");
				return "resumed";
			},
		});
		const b = fakeBrowser();
		const bridge = new ApplyBridge(b.tools, h.host);
		await bridge.callTool("browser_navigate", { url: FORM });
		await bridge.callTool("browser_snapshot", {});
		expect((await bridge.callTool("browser_type", { target: "e1", text: "150000 AUD", source_quote: "A: 150000 AUD" })).isError).toBe(true);
		await bridge.callTool("request_answer", { question: "Salary expectation?" });
		expect(bridge.blocked).toBeNull();
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "after-answer:1", phase: "uncertain" });
		expect((await bridge.callTool("browser_type", { target: "e1", text: "150000 AUD", source_quote: "A: 150000 AUD" })).isError).toBeFalsy();
	});
});

/**
 * #1100: a SEEK "Apply" that lands on SEEK's sign-in page. `login.seek.com/login` offers Google, Apple or
 * an emailed code — NO password field — so the page check (which looked only for one) never saw a sign-in.
 * Four live fills (abb37433, 804bed49, 7a923d6f, 7fb1e4f5 on dell-laptop, CLI 0.4.134) ended
 * `awaiting_review` with `filled: 0`, each summary saying "sign in to SEEK, then re-run" — and a card that
 * is not `login_required` offers the owner no sign-in (#1100 round 2 keys the post-run sign-in on it).
 */
describe("a sign-in page reached by the Apply click is a sign-in, not an empty review (#1100)", () => {
	const JOB = "https://au.seek.com/job/95195437";
	const SIGN_IN = "https://login.seek.com/login";
	const SEEK = { allow: ["au.seek.com", "seek.com"] };
	async function onSeekAd(hostOpts: Parameters<typeof fakeHost>[0] = {}, browserOpts: Parameters<typeof fakeBrowser>[1] = {}) {
		const b = fakeBrowser({}, browserOpts);
		const h = fakeHost({ ...SEEK, ...hostOpts });
		let asked = 0;
		const cloud = h.host.supervisorCheckpoint;
		h.host.supervisorCheckpoint = async (c) => {
			asked++;
			return cloud(c);
		};
		const bridge = new ApplyBridge(b.tools, h.host);
		await bridge.callTool("browser_navigate", { url: JOB });
		await bridge.callTool("browser_snapshot", {});
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "seek-95195437-initial", phase: "initial" });
		return { bridge, ...b, ...h, asked: () => asked };
	}

	it("run 804bed49: /apply redirects to the sign-in AFTER it landed — the next checkpoint holds for the owner, and an unanswered hold ends login_required", async () => {
		const { bridge, history, pauses, asked, events } = await onSeekAd();
		await bridge.callTool("browser_click", { target: "e20" }); // "Apply": opens nothing this tab can see
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "seek-95195437-signin-wall", phase: "post_navigation" });
		await bridge.callTool("browser_navigate", { url: `${JOB}/apply` }); // landed reads /apply, before the redirect
		expect(pauses).toHaveLength(0);
		history.push(SIGN_IN); // SEEK's redirect completes
		const cloudBefore = asked();
		const res = await bridge.callTool("supervisor_checkpoint", { checkpointId: "seek-95195437-login-required", phase: "post_navigation" });
		// The runner held for the owner itself — the sign-in the takeover exists for — instead of
		// asking the cloud, whose answer to a blocker is `stop` → `incomplete`.
		expect(pauses).toEqual([{ reason: "login_required", url: SIGN_IN, domain: "login.seek.com", question: "Sign in to seek.com on this machine's application browser, then retry. Nothing was submitted." }]);
		expect(asked()).toBe(cloudBefore);
		expect(res.isError).toBe(true);
		expect(bridge.blocked).toMatchObject({ reason: "login_required" });
		// What the CLI did next in the live run: ready_for_review. Not a review — the recorded sign-in.
		const review = await bridge.callTool("ready_for_review", { summary: "Blocked at sign-in" });
		expect(review.isError).toBe(true);
		expect(bridge.reviewReady).toBe(false);
		expect(events.some((e) => e.type === "review.ready")).toBe(false);
	});

	it("runs abb37433 / 7fb1e4f5: the Apply opened the sign-in where no landing saw it — ready_for_review records login_required, not awaiting_review count 0", async () => {
		const { bridge, history, events } = await onSeekAd();
		await bridge.callTool("browser_click", { target: "e20" });
		history.push(SIGN_IN); // the browser is now on the sign-in tab the CLI read
		const review = await bridge.callTool("ready_for_review", { summary: "Clicking Apply opened a SEEK Candidate Sign In page" });
		expect(review.isError).toBe(true);
		expect(review.content[0].text).toMatch(/recorded as login required/);
		expect(bridge.reviewReady).toBe(false);
		expect(bridge.blocked).toEqual({ reason: "login_required", questions: ["Sign in to seek.com on this machine's application browser, then retry. Nothing was submitted."] });
		expect(events.some((e) => e.type === "review.ready")).toBe(false);
		expect(events.find((e) => e.type === "browser.blocked")).toMatchObject({ url: SIGN_IN, domain: "login.seek.com", detail: { reason: "login_required" } });
	});

	it("a sign-in page with no password field pauses on landing, like one with a password does", async () => {
		const { pauses } = await onSeekAd({}, { clicks: { e20: SIGN_IN } }).then(async (r) => {
			await r.bridge.callTool("browser_click", { target: "e20" });
			return r;
		});
		expect(pauses[0]).toMatchObject({ reason: "login_required", domain: "login.seek.com" });
	});

	it("when the owner signs in at the hold, the run carries on — no blocker is left behind", async () => {
		const { bridge, history, pauses } = await onSeekAd({
			resume: () => {
				history.push(`${JOB}/apply`); // signed in: SEEK sends the browser back to the form
				return "resumed";
			},
		});
		history.push(SIGN_IN);
		const res = await bridge.callTool("supervisor_checkpoint", { checkpointId: "seek-login", phase: "post_navigation" });
		expect(pauses[0].reason).toBe("login_required");
		expect(res.isError).toBeFalsy();
		expect(res.content[0].text).toMatch(/owner signed in/);
		expect(bridge.blocked).toBeNull();
	});

	it("an ordinary page with nothing entered is not a review either — it is recorded as incomplete, not a sign-in (#1133)", async () => {
		const { bridge, events } = await onSeekAd();
		const res = await bridge.callTool("ready_for_review", { summary: "Nothing to fill" });
		expect(res.isError).toBe(true);
		expect(bridge.blocked).toMatchObject({ reason: "incomplete" });
		expect(bridge.reviewReady).toBe(false);
		expect(events.some((e) => e.type === "review.ready")).toBe(false);
	});
});

describe("upload_artifact — an approved file, once", () => {
	it("attaches each approved artifact once, by its verified path", async () => {
		const { bridge, sent, events } = await onForm();
		expect((await bridge.callTool("upload_artifact", { kind: "resume" })).isError).toBeFalsy();
		expect((await bridge.callTool("upload_artifact", { kind: "resume" })).isError).toBe(true);
		expect(sent("browser_file_upload")).toEqual([{ name: "browser_file_upload", args: { paths: ["/home/jane/jobs/applications/lead-1/run-1/resume.md"] } }]);
		expect(events.find((e) => e.type === "artifact.uploaded")?.detail).toMatchObject({ kind: "resume", sha256: "a".repeat(64), status: "selected", reason: "site_acceptance_unconfirmed" });
	});
	it("refuses an artifact that changed since it was generated, and says why", async () => {
		const { bridge, sent } = await onForm({}, { artifactError: "The approved resume has changed since it was generated; it will not be uploaded." });
		expect((await bridge.callTool("upload_artifact", { kind: "resume" })).isError).toBe(true);
		expect(sent("browser_file_upload")).toHaveLength(0);
		expect(bridge.blocked?.reason).toBe("artifact_changed");
	});
	it("tells the CLI to open the file chooser first, and does not count a failed attach", async () => {
		const { bridge } = await onForm({}, {}, { uploadError: "Error: The tool can only be used when there is related modal state present." });
		expect((await bridge.callTool("upload_artifact", { kind: "resume" })).content[0].text).toMatch(/Click the field's upload control first/);
		expect(bridge.uploaded.size).toBe(0);
	});
});

describe("replay frames on an application page (#1063, #1419)", () => {
	const IMAGE = "/9j/4AAQSkZJRgABAQ==";
	async function recordedForm(page: MaskablePage | null = fakePage()) {
		const b = fakeBrowser({ [FORM]: {} });
		const h = fakeHost({ page });
		const shots = new ShotRecorder(APPLY_SHOT_CAP);
		const bridge = new ApplyBridge(b.tools, h.host, shots);
		await bridge.callTool("browser_navigate", { url: FORM });
		await bridge.callTool("browser_snapshot", {});
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "initial:1", phase: "initial" });
		return { bridge, shots, ...h };
	}

	it("frames navigation, reading, the checkpoint, a fill and review — every one a masked screenshot", async () => {
		const { bridge, shots } = await recordedForm();
		await bridge.callTool("browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" });
		await bridge.callTool("ready_for_review", { summary: "Filled the name." });
		expect(shots.shots.map((s) => s.point)).toEqual(["navigated", "snapshot", "checkpoint", "filled", "review"]);
	});

	it("privacy: the trace names each frame by seq and point; it never carries the image or a typed value, and survives the cloud's whitelist", async () => {
		const { bridge, events } = await recordedForm();
		await bridge.callTool("browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" });
		const captured = events.filter((e) => e.type === "screenshot.captured");
		expect(captured.length).toBeGreaterThan(0);
		for (const e of captured) {
			expect(Object.keys(e.detail ?? {}).sort()).toEqual(e.detail?.target ? ["point", "shot", "target", "tool"] : ["point", "shot", "tool"]);
			expect(parseLocalApplyEvent({ ...e, seq: 1, at: "2026-10-14T00:00:00Z" })?.detail).toEqual(e.detail);
		}
		const trace = JSON.stringify(events);
		expect(trace).not.toContain(IMAGE);
		expect(trace).not.toContain("Jane Citizen");
	});

	it("a refused call earns no frame — a model retrying a refused tool cannot fill the cap", async () => {
		const { bridge, shots } = await recordedForm();
		const before = shots.shots.length;
		expect((await bridge.callTool("browser_type", { target: "e2", text: "jane@guess.com", source_quote: "Email: jane@example.com" })).isError).toBe(true);
		expect(shots.shots.length).toBe(before);
	});

	it("fails closed: when the screenshot throws no frame is taken — and the fill itself still works", async () => {
		const { bridge, shots } = await recordedForm(fakePage({ shotThrows: true }));
		expect((await bridge.callTool("browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" })).isError).toBeFalsy();
		expect(shots.shots).toEqual([]);
	});

	it("fails closed: no real page at all (#1419) — no frame is attempted", async () => {
		const { bridge, shots } = await recordedForm(null);
		expect((await bridge.callTool("browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" })).isError).toBeFalsy();
		expect(shots.shots).toEqual([]);
	});

	it("the screenshot tool is never offered to the CLI", async () => {
		const { bridge } = await recordedForm();
		expect((await bridge.listTools()).map((t) => t.name)).not.toContain("browser_take_screenshot");
		expect((await bridge.callTool("browser_take_screenshot", {})).isError).toBe(true);
	});
});

/**
 * The agent-driven sign-in (#1412). A `login_required` pause the cloud answers with provisioned secret NAMES
 * becomes the CLI's own job: it types the names (the browser substitutes the values, which the bridge never
 * holds), presses the sign-in page's buttons, asks for an emailed code when the site sends one, and is handed
 * back to the application the moment the wall is gone. Everything else into a credential field is refused.
 */
describe("the agent-driven sign-in (#1412)", () => {
	const SIGN_IN = "https://login.seek.com/login";
	const BACK = "https://jobs.example.com/apply?signed=1";
	const PASSWORD = "hunter2-never-seen";

	function signInHost(names: string[], o: { code?: boolean | "late" } = {}) {
		const h = fakeHost({ allow: ["jobs.example.com", "seek.com"], resume: (p) => (p.reason === "login_required" ? "sign_in" : "stopped") });
		const done: number[] = [];
		h.host.signInSecrets = () => [...names];
		h.host.signInDone = () => done.push(1);
		h.host.requestSignInCode = async () => {
			if (o.code === "late") return false;
			if (o.code) names.push("PAGS_LOGIN_CODE");
			return !!o.code;
		};
		return { ...h, done, names };
	}

	async function atSignIn(names: string[], o: Parameters<typeof signInHost>[1] = {}, clicks: Record<string, string> = { e41: BACK }) {
		const pages: Record<string, PageFlags> = { [FORM]: {}, [SIGN_IN]: { login: true }, [BACK]: {} };
		const b = fakeBrowser(pages, { clicks });
		const h = signInHost(names, o);
		const bridge = new ApplyBridge(b.tools, h.host);
		await bridge.callTool("browser_navigate", { url: FORM });
		await bridge.callTool("browser_snapshot", {});
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "initial:1", phase: "initial" });
		const wall = await bridge.callTool("browser_navigate", { url: SIGN_IN });
		await bridge.callTool("browser_snapshot", {});
		return { bridge, wall, pages, ...b, ...h };
	}

	it("a login wall the cloud answers with secrets is handed to the CLI by NAME; names are forwarded, values and strangers are refused, and the session click lands it signed in", async () => {
		const { bridge, wall, calls, events, pauses, done } = await atSignIn(["PAGS_LOGIN_USERNAME", "PAGS_LOGIN_PASSWORD"]);
		expect(pauses).toHaveLength(1);
		expect(pauses[0]).toMatchObject({ reason: "login_required", domain: "login.seek.com" });
		expect(wall.isError).toBeUndefined();
		expect(wall.content[0].text).toMatch(/Sign in to seek\.com yourself now.*PAGS_LOGIN_USERNAME, PAGS_LOGIN_PASSWORD.*request_sign_in_code/s);
		expect(bridge.signIn).toEqual({ site: "seek.com", names: ["PAGS_LOGIN_USERNAME", "PAGS_LOGIN_PASSWORD"] });

		// The names go through as typed, with no source_quote: the browser substitutes them.
		expect((await bridge.callTool("browser_type", { target: "e40", text: "PAGS_LOGIN_USERNAME" })).isError).toBeUndefined();
		expect((await bridge.callTool("browser_type", { target: "e11", text: "PAGS_LOGIN_PASSWORD" })).isError).toBeUndefined();
		expect(calls.filter((c) => c.name === "browser_type").map((c) => c.args.text)).toEqual(["PAGS_LOGIN_USERNAME", "PAGS_LOGIN_PASSWORD"]);
		// A value into a credential field, and a name the cloud never provisioned, are refused and never typed.
		const literal = await bridge.callTool("browser_type", { target: "e11", text: PASSWORD });
		expect(literal.isError).toBe(true);
		expect(literal.content[0].text).toMatch(/only a provisioned secret name/);
		const stranger = await bridge.callTool("browser_type", { target: "e1", text: "PAGS_LOGIN_TOKEN" });
		expect(stranger.isError).toBe(true);
		expect(stranger.content[0].text).toMatch(/not a provisioned secret name/);
		expect(calls.filter((c) => c.name === "browser_type")).toHaveLength(2);
		expect(pauses).toHaveLength(1);

		// The sign-in page's button is a session action; the page past the wall ends the sign-in.
		const signedIn = await bridge.callTool("browser_click", { target: "e41" });
		expect(signedIn.isError).toBeUndefined();
		expect(signedIn.content[0].text).toMatch(/Signed in to seek\.com\. Take a browser_snapshot/);
		expect(bridge.signIn).toBeNull();
		expect(done).toEqual([1]);
		const decisions = events.filter((e) => e.type === "policy.decision").map((e) => e.detail as Record<string, unknown>);
		expect(decisions).toContainEqual(expect.objectContaining({ tool: "browser_click", class: "session", decision: "allowed", reason: "sign_in_step" }));
		expect(decisions).toContainEqual(expect.objectContaining({ tool: "browser_type", class: "session", decision: "allowed", reason: "secret:PAGS_LOGIN_PASSWORD", role: "textbox" }));
		expect(decisions).toContainEqual(expect.objectContaining({ tool: "agent_sign_in", decision: "signed_in", site: "seek.com" }));
		// Leak proof at this layer: the value exists only in the test. Nothing the bridge saw or said carries it.
		expect(JSON.stringify({ calls, events })).not.toContain(PASSWORD);

		// Back on the application, the ordinary rules apply: the page changed, so a checkpoint comes first; then a
		// grounded answer passes, and a bare name does not.
		expect((await bridge.callTool("browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" })).content[0].text).toMatch(/supervisor_checkpoint/);
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "post:1", phase: "post_navigation" });
		expect((await bridge.callTool("browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" })).isError).toBeUndefined();
		expect((await bridge.callTool("browser_type", { target: "e11", text: "PAGS_LOGIN_PASSWORD" })).isError).toBe(true);
	});

	it("an emailed code: the CLI asks, the cloud provisions PAGS_LOGIN_CODE, and only then may the name go into the code box", async () => {
		const { bridge, calls, events } = await atSignIn(["PAGS_LOGIN_USERNAME"], { code: true }, { e42: SIGN_IN, e41: BACK });
		const early = await bridge.callTool("browser_type", { target: "e30", text: "PAGS_LOGIN_CODE" });
		expect(early.isError).toBe(true);
		expect(early.content[0].text).toMatch(/not a provisioned secret name/);
		const sent = await bridge.callTool("browser_click", { target: "e42" });
		expect(sent.isError).toBeUndefined();
		expect(sent.content[0].text).toMatch(/Still on the sign-in page/);
		const code = await bridge.callTool("request_sign_in_code", {});
		expect(code.isError).toBeUndefined();
		expect(code.content[0].text).toMatch(/available as PAGS_LOGIN_CODE/);
		expect(bridge.signIn?.names).toContain("PAGS_LOGIN_CODE");
		expect((await bridge.callTool("browser_type", { target: "e30", text: "PAGS_LOGIN_CODE" })).isError).toBeUndefined();
		expect(calls.filter((c) => c.name === "browser_type").map((c) => c.args.text)).toEqual(["PAGS_LOGIN_CODE"]);
		expect(events.map((e) => (e.detail as Record<string, unknown> | undefined)?.decision)).toContain("code_requested");
	});

	it("preserves completed OTP evidence through an observed automatic callback and same-origin return to the job (#1474)", async () => {
		const { bridge, history, pages, done, sent, events } = await atSignIn(["PAGS_LOGIN_CODE"]);
		const callback = "https://au.seek.com/oauth/callback";
		const job = "https://au.seek.com/job/95534692";
		pages[callback] = {};
		pages[job] = {};
		await bridge.callTool("browser_type", { target: "e30", text: "PAGS_LOGIN_CODE" });
		history.push(callback); // A site-driven redirect, not a model navigation.
		// The old login control is refused on the callback, but that fresh read records the transition.
		expect((await bridge.callTool("browser_click", { target: "e41" })).isError).toBe(true);
		await bridge.callTool("browser_snapshot", {});
		expect(done).toEqual([]); // The callback itself is not authenticated-session proof.
		const returned = await bridge.callTool("browser_navigate", { url: job });
		expect(returned.content[0].text).toContain("Signed in to seek.com");
		expect(bridge.signIn).toBeNull();
		expect(done).toEqual([1]);
		expect(sent("browser_click")).toHaveLength(0);
		expect(events.filter(e => e.type === "policy.decision" && e.detail?.decision === "signed_in")).toHaveLength(1);
		expect((await bridge.callTool("supervisor_checkpoint", { checkpointId: "post-auth", phase: "post_navigation" })).content[0].text).toContain("directive is continue");
	});

	it("a fresh clean page after OTP completes sign-in before a stale Sign in click can act (#1474)", async () => {
		const { bridge, history, pages, sent, done } = await atSignIn(["PAGS_LOGIN_CODE"]);
		const job = "https://au.seek.com/job/95534692";
		pages[job] = {};
		await bridge.callTool("browser_type", { target: "e30", text: "PAGS_LOGIN_CODE" });
		history.push(job);
		const res = await bridge.callTool("browser_click", { target: "e41" });
		expect(res.content[0].text).toContain("Sign-in completed before this click");
		expect(sent("browser_click")).toHaveLength(0);
		expect(done).toEqual([1]);
	});

	it.each(["manual_callback", "callback_login_wall", "callback_error", "incorrect_code", "prewall"])("does not create sign-in evidence from %s (#1474)", async scenario => {
		const { bridge, history, pages, done } = await atSignIn(["PAGS_LOGIN_CODE"]);
		const callback = `https://au.seek.com/oauth/callback${scenario === "callback_error" ? "?error=access_denied" : ""}`;
		const job = "https://au.seek.com/job/95534692";
		pages[callback] = scenario === "callback_login_wall" ? { login: true } : {};
		pages[job] = {};
		if (scenario !== "prewall") await bridge.callTool("browser_type", { target: "e30", text: "PAGS_LOGIN_CODE" });
		if (scenario === "manual_callback") await bridge.callTool("browser_navigate", { url: callback });
		else if (scenario !== "incorrect_code") history.push(callback);
		await bridge.callTool("browser_snapshot", {});
		await bridge.callTool("browser_navigate", { url: job });
		await bridge.callTool("browser_snapshot", {});
		expect(bridge.signIn).not.toBeNull();
		expect(done).toEqual([]);
	});

	it.each(["callback", "job"])("an ordinary link to a %s cannot manufacture authentication-return evidence (#1474)", async target => {
		const callback = "https://au.seek.com/oauth/callback";
		const job = "https://au.seek.com/job/95534692";
		const { bridge, pages, done } = await atSignIn(["PAGS_LOGIN_CODE"], {}, { e10: target === "callback" ? callback : job });
		pages[callback] = {};
		pages[job] = {};
		await bridge.callTool("browser_type", { target: "e30", text: "PAGS_LOGIN_CODE" });
		await bridge.callTool("browser_click", { target: "e10" });
		await bridge.callTool("browser_snapshot", {});
		await bridge.callTool("browser_navigate", { url: job });
		expect(done).toEqual([]);
		expect(bridge.signIn).not.toBeNull();
	});

	it("does not turn an unresolved sign-in into a profile question (#1474)", async () => {
		const { bridge, pauses } = await atSignIn(["PAGS_LOGIN_CODE"]);
		const res = await bridge.callTool("request_answer", { question: "Can you confirm the browser is signed in?", kind: "screening_ambiguity" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("not a missing profile or screening answer");
		expect(pauses).toHaveLength(1); // Only the original authentication pause.
		expect(bridge.blocked?.reason).toBe("login_required");
	});

	it("a code that never arrives, and a code asked for outside a sign-in, are both refused honestly", async () => {
		const late = await atSignIn(["PAGS_LOGIN_USERNAME"], { code: "late" });
		const r = await late.bridge.callTool("request_sign_in_code", {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/No sign-in code arrived/);
		const { bridge } = await onForm();
		const outside = await bridge.callTool("request_sign_in_code", {});
		expect(outside.isError).toBe(true);
		expect(outside.content[0].text).toMatch(/no sign-in in progress/);
	});

	it("a credential field typed on the application page pauses as before, and the same secrets answer that pause", async () => {
		const b = fakeBrowser({ [FORM]: {} });
		const h = signInHost(["PAGS_LOGIN_PASSWORD"]);
		const bridge = new ApplyBridge(b.tools, h.host);
		await bridge.callTool("browser_navigate", { url: FORM });
		await bridge.callTool("browser_snapshot", {});
		const r = await bridge.callTool("browser_type", { target: "e11", text: "secret", source_quote: "Name: Jane Citizen" });
		expect(h.pauses).toEqual([{ reason: "login_required", question: "Sign in: Password" }]);
		expect(r.content[0].text).toMatch(/PAGS_LOGIN_PASSWORD/);
		expect(bridge.signIn).toEqual({ site: "example.com", names: ["PAGS_LOGIN_PASSWORD"] });
		expect(b.calls.filter((c) => c.name === "browser_type")).toHaveLength(0);
	});

	it("navigating away from a wall without an authentication action does not claim a signed-in session", async () => {
		const { bridge, calls, done } = await atSignIn(["PAGS_LOGIN_USERNAME"]);
		const back = await bridge.callTool("browser_navigate", { url: FORM });
		expect(back.content[0].text).not.toMatch(/Signed in to seek\.com/);
		expect(bridge.signIn).not.toBeNull();
		expect(done).toEqual([]);
		// "Sign in" is a submitting button on this page: the guard, not a session click, decides it.
		const r = await bridge.callTool("browser_click", { target: "e41" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/supervisor_checkpoint/);
		expect(calls.filter((c) => c.name === "browser_click")).toHaveLength(0);
	});

	it("a provisioning pause on a job page cannot turn a snapshot into signed-in evidence (#1438)", async () => {
		const b = fakeBrowser({ [FORM]: {} });
		const h = signInHost(["PAGS_LOGIN_PASSWORD"]);
		const bridge = new ApplyBridge(b.tools, h.host);
		await bridge.callTool("browser_navigate", { url: FORM });
		await bridge.callTool("browser_snapshot", {});
		await bridge.callTool("browser_type", { target: "e11", text: "not-a-secret" });
		const snapshot = await bridge.callTool("browser_snapshot", {});
		expect(snapshot.content[0].text).not.toContain("Signed in to");
		expect(bridge.signIn).not.toBeNull();
		expect(h.done).toEqual([]);
		const typed = await bridge.callTool("browser_type", { target: "e11", text: "PAGS_LOGIN_PASSWORD" });
		expect(typed.isError).toBe(true);
		expect(b.sent("browser_type")).toHaveLength(0);
	});

	it.each(["https://evil.example/login", "https://other.seek.com/login", "http://login.seek.com/login"])("refuses a provisioned password after redirect to %s (#1438)", async (url) => {
		const { bridge, history, sent } = await atSignIn(["PAGS_LOGIN_PASSWORD"]);
		history.push(url);
		const typed = await bridge.callTool("browser_type", { target: "e11", text: "PAGS_LOGIN_PASSWORD" });
		expect(typed.isError).toBe(true);
		expect(sent("browser_type")).toHaveLength(0);
	});

	it("a password cannot be typed into a username field on the correct origin (#1438)", async () => {
		const { bridge, sent } = await atSignIn(["PAGS_LOGIN_PASSWORD"]);
		expect((await bridge.callTool("browser_type", { target: "e40", text: "PAGS_LOGIN_PASSWORD" })).isError).toBe(true);
		expect(sent("browser_type")).toHaveLength(0);
	});

	it("a generic application submit does not borrow authority from the page's login wall (#1438)", async () => {
		const { bridge, sent } = await atSignIn(["PAGS_LOGIN_PASSWORD"]);
		expect((await bridge.callTool("browser_click", { target: "e8" })).isError).toBe(true);
		expect(sent("browser_click")).toHaveLength(0);
		expect(bridge.submitAttempted).toBe(false);
	});

	it("checkpoints keep an active agent sign-in instead of pausing it again (#1438)", async () => {
		const { bridge, pauses } = await atSignIn(["PAGS_LOGIN_PASSWORD"]);
		const checkpoint = await bridge.callTool("supervisor_checkpoint", { checkpointId: "login:2", phase: "post_navigation" });
		expect(checkpoint.content[0].text).toContain("Sign in to seek.com yourself");
		expect(pauses).toHaveLength(1);
	});

	it("a captcha appearing after navigation offers a takeover at the next checkpoint (#1438)", async () => {
		const pages: Record<string, PageFlags> = { [FORM]: {} };
		const { bridge, pauses } = await onForm(pages);
		pages[FORM] = { captcha: true };
		const checkpoint = await bridge.callTool("supervisor_checkpoint", { checkpointId: "late:2", phase: "uncertain" });
		expect(checkpoint.isError).toBe(true);
		expect(pauses).toEqual([expect.objectContaining({ reason: "captcha" })]);
		expect(bridge.blocked?.reason).toBe("captcha");
	});

	it("a code page that signs in as the code lands is noticed at the next snapshot", async () => {
		// A wall flagged by its password field alone (#1100 would flag `login.*` by address even once it is gone).
		const WALL = "https://www.seek.com/apply-gate";
		const pages: Record<string, PageFlags> = { [FORM]: {}, [WALL]: { login: true } };
		const b = fakeBrowser(pages, { clicks: { e42: WALL } });
		const h = signInHost(["PAGS_LOGIN_USERNAME"], { code: true });
		const bridge = new ApplyBridge(b.tools, h.host);
		await bridge.callTool("browser_navigate", { url: FORM });
		await bridge.callTool("browser_navigate", { url: WALL });
		await bridge.callTool("browser_snapshot", {});
		await bridge.callTool("browser_click", { target: "e42" });
		await bridge.callTool("request_sign_in_code", {});
		expect((await bridge.callTool("browser_type", { target: "e30", text: "PAGS_LOGIN_CODE" })).isError).toBeUndefined();
		expect(bridge.signIn).not.toBeNull();
		// The site let the browser in as the code landed: the wall is gone without a click to observe it.
		pages[WALL] = {};
		const snap = await bridge.callTool("browser_snapshot", {});
		expect(snap.content[0].text).toMatch(/Signed in to seek\.com/);
		expect(bridge.signIn).toBeNull();
		expect(h.done).toEqual([1]);
	});
});

describe("#1409: refusals and internal probes reach the call recorder", () => {
	it("a refused tool is recorded via `refused`, never via `callTool`", async () => {
		const { bridge, refusals, calls } = await onForm();
		expect((await bridge.callTool("browser_run_code", { code: "1" })).isError).toBe(true);
		expect(refusals).toEqual([{ tool: "browser_run_code", args: {}, reason: expect.stringContaining("not available") }]);
		expect(calls.some((c) => c.name === "browser_run_code")).toBe(false);
	});

	it("navigating off this application's sites is refused", async () => {
		const { bridge, refusals } = await onForm({}, { allow: ["jobs.example.com"] });
		await bridge.callTool("browser_navigate", { url: "https://other.example.com" });
		expect(refusals).toEqual([{ tool: "browser_navigate", args: {}, reason: expect.stringContaining("not one of this application's sites") }]);
	});

	it("the bridge's own page inspection is marked internal, unlike the agent's own navigate", async () => {
		const { calls, internalCalls } = await onForm();
		const nav = calls.find((c) => c.name === "browser_navigate");
		expect(nav?.internal).toBeUndefined();
		expect(internalCalls.some((c) => c.name === "browser_evaluate" && !c.args.target)).toBe(true);
	});
});


it("an Upload-labelled button without a newly observed native chooser still invalidates its checkpoint", async () => {
 const b = fakeBrowser(); const h = fakeHost();
 b.tools.uploadContext = () => null;
 const bridge = new ApplyBridge(b.tools, h.host);
 await bridge.callTool("browser_navigate", { url: FORM });
 await bridge.callTool("browser_snapshot");
 await bridge.callTool("supervisor_checkpoint", { checkpointId: "initial", phase: "initial" });
 expect((await bridge.callTool("browser_click", { target: "e7" })).isError).not.toBe(true);
 const upload = await bridge.callTool("upload_artifact", { kind: "resume" });
 expect(upload.isError).toBe(true);
 expect(upload.content[0].text).toContain("supervisor_checkpoint");
 expect(b.sent("browser_file_upload")).toHaveLength(0);
});

it("a chooser on a different page cannot inherit the previous page's checkpoint", async () => {
 const b = fakeBrowser(); const h = fakeHost();
 const original = {}; const popup = {}; let observations = 0;
 b.tools.uploadContext = () => ++observations === 1 ? { page: original, chooserId: null } : { page: popup, chooserId: "native-popup-chooser" };
 const bridge = new ApplyBridge(b.tools, h.host);
 await bridge.callTool("browser_navigate", { url: FORM });
 await bridge.callTool("browser_snapshot");
 await bridge.callTool("supervisor_checkpoint", { checkpointId: "initial", phase: "initial" });
 await bridge.callTool("browser_click", { target: "e7" });
 const upload = await bridge.callTool("upload_artifact", { kind: "resume" });
 expect(upload.isError).toBe(true);
 expect(upload.content[0].text).toContain("supervisor_checkpoint");
 expect(b.sent("browser_file_upload")).toHaveLength(0);
});


describe("fresh instance preferences in browser answers (#1508)", () => {
 const preferences: InstancePreferences = { version: 1, source: "user", instanceId: "runner-1", memoryKey: "job_application_preferences", memoryUpdatedAt: "2026-10-07T00:00:00Z", sha256: "a".repeat(64), facts: [
  { field: "salary_expectation", answer: "AUD 150,000", confirmedAt: "2026-10-07" },
  { field: "recruitment_adjustments_needed", answer: "No", confirmedAt: "2026-10-07" },
 ], pendingFields: ["salary_super_basis", "disclosures"] };
 async function preferenceForm(labels: string[], extraSources: Array<{label:string;text:string;answerText?:string;answerQuestion?:string}> = []) {
  const h = await onForm();
  const sources = [...projectPreferenceSources([{ label: "profile", text: "Salary expectation: AUD 180,000" }, { label: "resume", text: "Salary expectation: AUD 180,000; knowledge" }], preferences), ...extraSources];
  h.host.instancePreferences = () => preferences;
  h.host.groundingSources = () => sources;
  h.host.grounding = () => sources.map(x => x.text).join("\n");
  const original = h.tools.callTool;
  h.tools.callTool = async (name, args, opts) => {
   if (name === "browser_evaluate" && args?.function === PREFERENCE_FIELD_PROBE_FN) return { content: [{ text: `### Result\n${JSON.stringify({ labels })}` }] };
   if (name === "browser_snapshot") return { content: [{ text: SNAPSHOT + '\n- textbox "Salary expectation" [ref=e70]\n- combobox "Salary expectation including super" [ref=e71]' }] };
   return original(name, args, opts);
  };
  await h.bridge.callTool("browser_snapshot", {});
  return h;
 }
 it("rejects stale approved salary and permits the fresh exact preference", async () => {
  const h = await preferenceForm([]);
  expect((await h.bridge.callTool("browser_type", { target: "e70", text: "AUD 180,000", source_quote: "Salary expectation: AUD 180,000" })).isError).toBe(true);
  expect((await h.bridge.callTool("browser_type", { target: "e70", text: "AUD 150,000", source_quote: "AUD 150,000" })).isError).not.toBe(true);
  expect(h.calls.filter(x => x.name === "browser_type").map(x => x.args.text)).toEqual(["AUD 150,000"]);
 });
 it.each([{labels: []}, {labels: ["Disclosures"]}, {labels: ["Recruitment adjustments needed", "Planned holidays next 6 months"]}])("refuses ambiguous or different native group $labels", async ({labels}) => {
  const h = await preferenceForm(labels);
  expect((await h.bridge.callTool("browser_click", { target: "e4", source_quote: "No" })).isError).toBe(true);
  expect(h.calls.filter(x => x.name === "browser_click")).toHaveLength(0);
 });
 it("permits No only with the actual matching native question", async () => {
  const h = await preferenceForm(["Recruitment adjustments needed"]);
  expect((await h.bridge.callTool("browser_click", { target: "e4", source_quote: "No" })).isError).not.toBe(true);
  expect(h.calls.filter(x => x.name === "browser_click")).toHaveLength(1);
 });
 it("keeps inclusive-super unanswered and honors only an actual same-question answer", async () => {
  const h = await preferenceForm([]);
  expect((await h.bridge.callTool("browser_select_option", { target: "e71", values: ["AUD 150,000"], source_quote: "AUD 150,000" })).isError).toBe(true);
  const answered = await preferenceForm([], [{ label: "owner answers", text: "Q: Salary expectation including super\nA: AUD 170,000", answerText: "AUD 170,000", answerQuestion: "Salary expectation including super" }]);
  expect((await answered.bridge.callTool("browser_select_option", { target: "e71", values: ["AUD 170,000"], source_quote: "AUD 170,000" })).isError).not.toBe(true);
 });
});
