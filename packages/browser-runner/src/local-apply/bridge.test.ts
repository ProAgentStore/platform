/**
 * The apply bridge enforces the write policy itself (#957): which action class a call is, whether
 * its value is grounded, when it must stop for a person, and that a final submit happens only
 * under an enabled gate — once. The browser is faked; every rule under test is the bridge's code.
 */
import { describe, expect, it } from "vitest";
import type { BrowserTools } from "../local-browser/bridge.js";
import { ApplyBridge, type ApplyBridgeHost, groundingRefusal } from "./bridge.js";
import type { LocalApplyEvent, LocalApplyPause } from "./contract.js";

interface PageFlags {
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
};

function fakeBrowser(pages: Record<string, PageFlags> = {}, opts: { clicks?: Record<string, string>; uploadError?: string } = {}) {
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const history: string[] = [];
	const tools: BrowserTools = {
		listTools: async () =>
			["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_click", "browser_type", "browser_select_option", "browser_press_key", "browser_evaluate", "browser_fill_form", "browser_file_upload", "browser_wait_for"].map((name) => ({
				name,
				inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
			})),
		callTool: async (name, args = {}) => {
			if (name === "browser_evaluate") {
				if (typeof args.target === "string") return { content: [{ text: `### Result\n${JSON.stringify({ tag: "button", type: "", ...(FACTS[args.target] ?? { submits: false, method: "", name: "" }) })}` }] };
				const url = history[history.length - 1] ?? "about:blank";
				return { content: [{ text: `### Result\n${JSON.stringify({ url, title: "Apply", ...pages[url] })}\n### Ran Playwright code` }] };
			}
			calls.push({ name, args });
			if (name === "browser_navigate") history.push(String(args.url));
			if (name === "browser_click" && opts.clicks?.[String(args.target)]) history.push(opts.clicks[String(args.target)]);
			if (name === "browser_navigate_back") history.pop();
			if (name === "browser_snapshot") return { content: [{ text: SNAPSHOT }] };
			if (name === "browser_file_upload" && opts.uploadError) return { content: [{ text: opts.uploadError }], isError: true };
			return { content: [{ text: `${name} ok` }] };
		},
	};
	return { tools, calls, history, sent: (n: string) => calls.filter((c) => c.name === n) };
}

const PROFILE = "Name: Jane Citizen\nEmail: jane@example.com\nWork authorization: Authorized to work in Australia\nRequires sponsorship: No\nNotice period: four weeks";

function fakeHost(o: { mode?: "fill_and_review" | "auto_submit"; allow?: string[]; resume?: (p: LocalApplyPause) => "resumed" | "stopped"; artifactError?: string; directive?: "continue" | "request_review" | "stop" } = {}) {
	const events: Array<Omit<LocalApplyEvent, "at">> = [];
	const pauses: LocalApplyPause[] = [];
	const allow = new Set(o.allow ?? ["jobs.example.com"]);
	const grounding = [PROFILE];
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
		artifactPath: (kind) => (o.artifactError ? { error: o.artifactError } : { path: `/home/jane/jobs/applications/lead-1/run-1/${kind}.md`, sha256: "a".repeat(64) }),
		overTime: () => false,
		now: () => Date.parse("2026-10-07T01:00:00Z"),
		limits: { maxMinutes: 20, maxPages: 30, maxActions: 300 },
		mode: o.mode ?? "fill_and_review",
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
	it("lists only read, fill and the bridge's own tools — every fill tool demands source_quote", async () => {
		const { bridge } = await onForm();
		const tools = await bridge.listTools();
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual(["browser_click", "browser_navigate", "browser_navigate_back", "browser_press_key", "browser_select_option", "browser_snapshot", "browser_type", "browser_wait_for", "ready_for_review", "report_job_unavailable", "request_answer", "supervisor_checkpoint", "upload_artifact"]);
		const typeTool = tools.find((t) => t.name === "browser_type") as { inputSchema: { required: string[] } };
		expect(typeTool.inputSchema.required).toContain("source_quote");
	});

	it.each(["browser_fill_form", "browser_file_upload", "browser_evaluate", "browser_run_code", "browser_handle_dialog", "browser_drag"])("refuses %s by name, and never forwards it", async (name) => {
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
		// A second press is impossible.
		expect((await bridge.callTool("browser_click", { target: "e8" })).isError).toBe(true);
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

describe("upload_artifact — an approved file, once", () => {
	it("attaches each approved artifact once, by its verified path", async () => {
		const { bridge, sent, events } = await onForm();
		expect((await bridge.callTool("upload_artifact", { kind: "resume" })).isError).toBeFalsy();
		expect((await bridge.callTool("upload_artifact", { kind: "resume" })).isError).toBe(true);
		expect(sent("browser_file_upload")).toEqual([{ name: "browser_file_upload", args: { paths: ["/home/jane/jobs/applications/lead-1/run-1/resume.md"] } }]);
		expect(events.find((e) => e.type === "artifact.uploaded")?.detail).toMatchObject({ kind: "resume", sha256: "a".repeat(64) });
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
