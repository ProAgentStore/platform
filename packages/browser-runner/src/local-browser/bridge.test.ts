/**
 * The research bridge enforces policy itself (#944/#947): what a CLI may call, where it may go,
 * when it must stop for a person, and what a finding must cite. The browser is faked; every rule
 * under test is the bridge's own code.
 */
import { describe, expect, it } from "vitest";
import type { LocalBrowserEvent, LocalBrowserLimits } from "./contract.js";
import { type BridgeHost, BrowserBridge, type BrowserTools, evaluateResult, refHref, refRole } from "./bridge.js";

interface PageFlags {
	captcha?: boolean;
	login?: boolean;
	paywall?: boolean;
	accessBlocked?: boolean;
	writeForm?: boolean;
	title?: string;
}

/** A browser whose pages are a map of URL → flags, with redirects and click targets. */
function fakeBrowser(pages: Record<string, PageFlags> = {}, opts: { redirect?: Record<string, string>; clicks?: Record<string, string>; snapshot?: string } = {}) {
	const calls: Array<{ name: string; args: Record<string, unknown>; internal?: boolean }> = [];
	const refusals: Array<{ tool: string; args: Record<string, unknown>; reason: string }> = [];
	const history: string[] = [];
	const tools: BrowserTools = {
		listTools: async () =>
			["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_click", "browser_type", "browser_evaluate", "browser_fill_form", "browser_take_screenshot"].map((name) => ({ name, inputSchema: {} })),
		callTool: async (name, args = {}, callOpts) => {
			calls.push({ name, args, ...(callOpts?.internal ? { internal: true } : {}) });
			if (name === "browser_navigate") history.push(opts.redirect?.[String(args.url)] ?? String(args.url));
			if (name === "browser_click") history.push(opts.clicks?.[String(args.target)] ?? history[history.length - 1]);
			if (name === "browser_navigate_back") history.pop();
			if (name === "browser_evaluate") {
				const url = history[history.length - 1] ?? "about:blank";
				const f = pages[url] ?? {};
				return { content: [{ type: "text", text: `### Result\n${JSON.stringify({ url, title: f.title ?? "Page", captcha: !!f.captcha, login: !!f.login, paywall: !!f.paywall, accessBlocked: !!f.accessBlocked, writeForm: !!f.writeForm })}\n### Ran Playwright code` }] };
			}
			if (name === "browser_snapshot") return { content: [{ type: "text", text: opts.snapshot ?? '- link "Job 1" [ref=e1]\n- button "Next" [ref=e2]\n- button "Apply now" [ref=e3]\n- textbox "Search" [ref=e4]' }] };
			return { content: [{ type: "text", text: `${name} ok` }] };
		},
		refused: (tool, args, reason) => refusals.push({ tool, args, reason }),
	};
	return { tools, calls, refusals, history };
}

const LIMITS: LocalBrowserLimits = { maxMinutes: 15, maxPages: 30, maxActions: 200, maxConcurrent: 1 };

function fakeHost(o: { allow?: string[]; deny?: string[]; consented?: string[]; consentIds?: Record<string, string>; pause?: (reason: string) => "resumed" | "stopped"; onPause?: () => void; limits?: Partial<LocalBrowserLimits>; overTime?: boolean } = {}) {
	const events: Array<Omit<LocalBrowserEvent, "at">> = [];
	const consented = new Set(o.consented ?? []);
	const within = (h: string, d: string) => h === d || h.endsWith(`.${d}`);
	const host: BridgeHost & { consented: Set<string> } = {
		consented,
		emit: (e) => events.push(e),
		pause: async (reason) => {
			events.push({ type: "run.paused", pauseReason: reason as never });
			o.onPause?.();
			return o.pause ? o.pause(reason) : "stopped";
		},
		consentIdFor: (h) => Object.entries(o.consentIds ?? {}).find(([d]) => within(h, d))?.[1],
		isDenied: (h) => (o.deny ?? []).some((d) => within(h, d)),
		isPermitted: (h) => [...(o.allow ?? []), ...consented].some((d) => within(h, d)),
		allowListOnly: () => (o.allow ?? []).length > 0,
		overTime: () => !!o.overTime,
		limits: { ...LIMITS, ...o.limits },
	};
	return { host, events };
}

const textOf = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("\n");

describe("what the CLI is offered", () => {
	it("lists nothing outside BRIDGE_TOOL_NAMES — the set Codex is told to trust (#952)", async () => {
		const { BRIDGE_TOOL_NAMES } = await import("./bridge.js");
		const listed = (await new BrowserBridge(fakeBrowser().tools, fakeHost().host).listTools()).map((t) => t.name);
		for (const name of listed) expect(BRIDGE_TOOL_NAMES).toContain(name);
	});

	it("lists only the read-only browser tools plus the research tools", async () => {
		const b = new BrowserBridge(fakeBrowser().tools, fakeHost().host);
		expect((await b.listTools()).map((t) => t.name).sort()).toEqual(["browser_click", "browser_navigate", "browser_navigate_back", "browser_snapshot", "finish_research", "record_finding", "report_source_failure"]);
	});

	it.each(["browser_type", "browser_fill_form", "browser_evaluate", "browser_file_upload", "browser_press_key", "browser_select_option"])("refuses %s by name, and never calls the browser", async (tool) => {
		const f = fakeBrowser();
		const { host, events } = fakeHost();
		const r = await new BrowserBridge(f.tools, host).callTool(tool, { text: "x" });
		expect(r.isError).toBe(true);
		expect(textOf(r)).toMatch(/research only/);
		expect(f.calls).toEqual([]);
		expect(events).toContainEqual(expect.objectContaining({ type: "policy.decision", detail: expect.objectContaining({ decision: "refused" }) }));
	});

	it("refuses a tool it does not know, including a screenshot", async () => {
		expect((await new BrowserBridge(fakeBrowser().tools, fakeHost().host).callTool("browser_take_screenshot")).isError).toBe(true);
	});
});

describe("where it may go", () => {
	it("opens a permitted site and traces the domain and title, never the page text", async () => {
		const f = fakeBrowser({ "https://seek.com.au/jobs": { title: "Jobs" } });
		const { host, events } = fakeHost({ allow: ["seek.com.au"] });
		const r = await new BrowserBridge(f.tools, host).callTool("browser_navigate", { url: "https://seek.com.au/jobs" });
		expect(r.isError).toBeUndefined();
		expect(events).toContainEqual({ type: "browser.navigated", url: "https://seek.com.au/jobs", domain: "seek.com.au", detail: { title: "Jobs" } });
	});

	it("attributes a snapshot to the site the browser is on, after returning to an earlier one (Codex run bc185571)", async () => {
		const f = fakeBrowser();
		const { host, events } = fakeHost({ allow: ["seek.com.au", "indeed.com"] });
		const b = new BrowserBridge(f.tools, host);
		await b.callTool("browser_navigate", { url: "https://au.seek.com.au/jobs" });
		await b.callTool("browser_navigate", { url: "https://au.indeed.com/jobs" });
		await b.callTool("browser_navigate", { url: "https://au.seek.com.au/job/1" });
		await b.callTool("browser_snapshot");
		expect(events.filter((e) => e.type === "browser.snapshot")).toEqual([{ type: "browser.snapshot", domain: "au.seek.com.au" }]);
	});

	it("refuses a denied site, a site off the allow list, and a non-http URL — without navigating", async () => {
		const f = fakeBrowser();
		const b = new BrowserBridge(f.tools, fakeHost({ allow: ["seek.com.au"], deny: ["ads.seek.com.au"] }).host);
		expect(textOf(await b.callTool("browser_navigate", { url: "https://ads.seek.com.au/" }))).toMatch(/deny list/);
		expect(textOf(await b.callTool("browser_navigate", { url: "https://indeed.com/" }))).toMatch(/not on this run's list/);
		expect(textOf(await b.callTool("browser_navigate", { url: "file:///etc/passwd" }))).toMatch(/Only http/);
		expect(f.calls.filter((c) => c.name === "browser_navigate")).toEqual([]);
	});

	it("pauses for consent on a new site, and goes there once the owner allows it", async () => {
		const f = fakeBrowser();
		const { host, events } = fakeHost({ pause: () => "resumed", onPause: () => host.consented.add("indeed.com") });
		const r = await new BrowserBridge(f.tools, host).callTool("browser_navigate", { url: "https://au.indeed.com/jobs" });
		expect(r.isError).toBeUndefined();
		expect(events.map((e) => e.type)).toEqual(["consent.requested", "run.paused", "policy.decision", "browser.navigated"]);
		expect(events[1]).toMatchObject({ pauseReason: "consent_required" });
	});

	it("does not go there when the owner does not decide, and says how to report it", async () => {
		const f = fakeBrowser();
		const r = await new BrowserBridge(f.tools, fakeHost().host).callTool("browser_navigate", { url: "https://indeed.com/" });
		expect(textOf(r)).toMatch(/did not allow indeed.com.*report_source_failure/);
		expect(f.calls.filter((c) => c.name === "browser_navigate")).toEqual([]);
	});

	it("undoes a redirect to an unrelated site it may not be on, and allows one within the same site", async () => {
		const f = fakeBrowser({}, { redirect: { "https://seek.com.au/": "https://www.seek.com.au/", "https://seek.com.au/out": "https://tracker.example/" } });
		const b = new BrowserBridge(f.tools, fakeHost({ allow: ["seek.com.au"] }).host);
		expect((await b.callTool("browser_navigate", { url: "https://seek.com.au/" })).isError).toBeUndefined();
		const r = await b.callTool("browser_navigate", { url: "https://seek.com.au/out" });
		expect(textOf(r)).toMatch(/redirected to tracker.example/);
		expect(f.history.at(-1)).toBe("https://www.seek.com.au/");
	});
});

describe("clicks", () => {
	async function snapped(clicks: Record<string, string> = {}, allow = ["seek.com.au"]) {
		const f = fakeBrowser({}, { clicks });
		const b = new BrowserBridge(f.tools, fakeHost({ allow }).host);
		await b.callTool("browser_navigate", { url: "https://seek.com.au/" });
		await b.callTool("browser_snapshot");
		return { f, b };
	}

	it("allows links and pagination buttons, and refuses any other button or field", async () => {
		const { b } = await snapped({ e1: "https://seek.com.au/job/1", e2: "https://seek.com.au/?page=2" });
		expect((await b.callTool("browser_click", { element: "Job 1", target: "e1" })).isError).toBeUndefined();
		expect((await b.callTool("browser_click", { element: "Next", target: "e2" })).isError).toBeUndefined();
		expect(textOf(await b.callTool("browser_click", { element: "Apply now", target: "e3" }))).toMatch(/only links, tabs and pagination/);
		expect((await b.callTool("browser_click", { element: "Search", target: "e4" })).isError).toBe(true);
		expect((await b.callTool("browser_click", { element: "?", target: "e99" })).isError).toBe(true);
	});

	it("undoes a click that leaves for a site the run may not be on", async () => {
		const { b, f } = await snapped({ e1: "https://evil.example/" });
		expect(textOf(await b.callTool("browser_click", { element: "Job 1", target: "e1" }))).toMatch(/leads to evil.example/);
		expect(f.calls.at(-1)?.name).toBe("browser_navigate_back");
	});
});

describe("stopping for a person", () => {
	it("pauses on a captcha, and reports it when nobody solves it", async () => {
		const f = fakeBrowser({ "https://seek.com.au/": { captcha: true } });
		const { host, events } = fakeHost({ allow: ["seek.com.au"] });
		const r = await new BrowserBridge(f.tools, host).callTool("browser_navigate", { url: "https://seek.com.au/" });
		expect(textOf(r)).toMatch(/needs a person \(a captcha\)/);
		expect(events).toContainEqual(expect.objectContaining({ type: "browser.blocked", detail: { reason: "captcha" } }));
		expect(events).toContainEqual(expect.objectContaining({ type: "run.paused", pauseReason: "captcha" }));
	});

	it("pauses on a sign-in wall", async () => {
		const { host, events } = fakeHost({ allow: ["linkedin.com"] });
		await new BrowserBridge(fakeBrowser({ "https://linkedin.com/jobs": { login: true } }).tools, host).callTool("browser_navigate", { url: "https://linkedin.com/jobs" });
		expect(events).toContainEqual(expect.objectContaining({ type: "run.paused", pauseReason: "login_required" }));
	});

	it("pauses on a bot check or access block for a person — never an obstacle to get past (#947)", async () => {
		const { host, events } = fakeHost({ allow: ["indeed.com"] });
		const r = await new BrowserBridge(fakeBrowser({ "https://indeed.com/jobs": { accessBlocked: true } }).tools, host).callTool("browser_navigate", { url: "https://indeed.com/jobs" });
		expect(events).toContainEqual(expect.objectContaining({ type: "browser.blocked", domain: "indeed.com", detail: { reason: "access_blocked" } }));
		expect(events).toContainEqual(expect.objectContaining({ type: "run.paused", pauseReason: "access_blocked" }));
		expect(textOf(r)).toMatch(/needs a person \(a bot check or access block\).*report_source_failure \(access_denied\)/);
		expect(r.isError).toBe(true);
	});

	it("an access block still there after the owner resumes is reported, not retried", async () => {
		const { host } = fakeHost({ allow: ["indeed.com"], pause: () => "resumed" });
		const r = await new BrowserBridge(fakeBrowser({ "https://indeed.com/jobs": { accessBlocked: true } }).tools, host).callTool("browser_navigate", { url: "https://indeed.com/jobs" });
		expect(textOf(r)).toMatch(/still shows a bot check or access block/);
	});

	it("stops before a page that submits, pays or uploads; without the owner's OK it goes back (#947)", async () => {
		const f = fakeBrowser({ "https://seek.com.au/apply/1": { writeForm: true } });
		const { host, events } = fakeHost({ allow: ["seek.com.au"] });
		const r = await new BrowserBridge(f.tools, host).callTool("browser_navigate", { url: "https://seek.com.au/apply/1" });
		expect(events).toContainEqual(expect.objectContaining({ type: "browser.blocked", detail: { reason: "write_affordance" } }));
		expect(events).toContainEqual(expect.objectContaining({ type: "run.paused", pauseReason: "write_affordance" }));
		expect(f.calls.at(-1)?.name).toBe("browser_navigate_back");
		expect(textOf(r)).toMatch(/do not return to it/);
		expect(r.isError).toBe(true);
	});

	it("with the owner's OK it may read that page — and still cannot fill or submit anything on it", async () => {
		const f = fakeBrowser({ "https://seek.com.au/apply/1": { writeForm: true } });
		const { host } = fakeHost({ consented: ["seek.com.au"], pause: () => "resumed" });
		const b = new BrowserBridge(f.tools, host);
		const r = await b.callTool("browser_navigate", { url: "https://seek.com.au/apply/1" });
		expect(textOf(r)).toMatch(/still research only/);
		expect(f.calls.some((c) => c.name === "browser_navigate_back")).toBe(false);
		const typed = await b.callTool("browser_type", { ref: "e4", text: "me@example.com" });
		expect(typed.isError).toBe(true);
		expect(f.calls.some((c) => c.name === "browser_type")).toBe(false);
	});

	it("pauses on a paywall for the owner, and reports it when nobody opens it — never works around it (#947)", async () => {
		const { host, events } = fakeHost({ allow: ["news.com"] });
		const r = await new BrowserBridge(fakeBrowser({ "https://news.com/a": { paywall: true } }).tools, host).callTool("browser_navigate", { url: "https://news.com/a" });
		expect(events).toContainEqual(expect.objectContaining({ type: "browser.blocked", domain: "news.com", detail: { reason: "paywall" } }));
		expect(events).toContainEqual(expect.objectContaining({ type: "run.paused", pauseReason: "paywall" }));
		expect(textOf(r)).toMatch(/needs a person \(a paywall\).*report_source_failure \(paywall\)/);
		expect(r.isError).toBe(true);
	});

	it("reads the page once the owner has got past the paywall themselves, and reports it if it is still there", async () => {
		let paywalled = true;
		const pages = { "https://news.com/a": { get paywall() { return paywalled; } } };
		const { host } = fakeHost({ allow: ["news.com"], pause: () => "resumed", onPause: () => { paywalled = false; } });
		expect(textOf(await new BrowserBridge(fakeBrowser(pages).tools, host).callTool("browser_navigate", { url: "https://news.com/a" }))).toMatch(/Resumed after the owner handled news\.com/);
		const still = fakeHost({ allow: ["news.com"], pause: () => "resumed" });
		expect(textOf(await new BrowserBridge(fakeBrowser({ "https://news.com/a": { paywall: true } }).tools, still.host).callTool("browser_navigate", { url: "https://news.com/a" }))).toMatch(/still shows a paywall/);
	});
});

describe("limits", () => {
	it("refuses past the page limit and the action limit, and once the time is up", async () => {
		const pages = new BrowserBridge(fakeBrowser().tools, fakeHost({ allow: ["a.com"], limits: { maxPages: 1 } }).host);
		await pages.callTool("browser_navigate", { url: "https://a.com/1" });
		expect(textOf(await pages.callTool("browser_navigate", { url: "https://a.com/2" }))).toMatch(/limit of 1 pages/);
		const actions = new BrowserBridge(fakeBrowser().tools, fakeHost({ allow: ["a.com"], limits: { maxActions: 2 } }).host);
		await actions.callTool("browser_snapshot");
		await actions.callTool("browser_snapshot");
		expect(textOf(await actions.callTool("browser_snapshot"))).toMatch(/limit of 2 browser actions/);
		expect(textOf(await new BrowserBridge(fakeBrowser().tools, fakeHost({ overTime: true }).host).callTool("browser_snapshot"))).toMatch(/time limit/);
	});
});

describe("findings", () => {
	it("records a finding that cites a page the run opened, and refuses one that does not", async () => {
		const { host, events } = fakeHost({ allow: ["seek.com.au"] });
		const b = new BrowserBridge(fakeBrowser().tools, host);
		await b.callTool("browser_navigate", { url: "https://www.seek.com.au/jobs" });
		expect(textOf(await b.callTool("record_finding", { title: "Dev", url: "https://www.seek.com.au/job/1", evidence: "Dev — Sydney", fields: { salary: 1, password: "x" } }))).toMatch(/Recorded finding 1/);
		expect(textOf(await b.callTool("record_finding", { title: "Ghost", url: "https://indeed.com/1", evidence: "x" }))).toMatch(/was not opened in this run/);
		expect(b.findings).toEqual([{ title: "Dev", url: "https://www.seek.com.au/job/1", evidence: "Dev — Sydney", fields: { salary: 1 } }]);
		expect(events).toContainEqual(expect.objectContaining({ type: "finding.parsed", domain: "www.seek.com.au" }));
		expect(textOf(await b.callTool("record_finding", { title: "Dev", url: "https://www.seek.com.au/job/1", evidence: "again" }))).toBe("Already recorded.");
	});

	it("records source failures with a known reason, and the summary", async () => {
		const b = new BrowserBridge(fakeBrowser().tools, fakeHost().host);
		expect((await b.callTool("report_source_failure", { url: "https://x.com", reason: "bypassed" })).isError).toBe(true);
		await b.callTool("report_source_failure", { url: "https://x.com", reason: "login_required" });
		await b.callTool("finish_research", { summary: "Done" });
		expect(b.sourceFailures).toEqual([{ url: "https://x.com", reason: "login_required" }]);
		expect(b.summary).toBe("Done");
	});
});

describe("#1409: refusals and internal probes reach the call recorder", () => {
	it("a write-tool refusal is recorded via `refused`, never via `callTool`", async () => {
		const f = fakeBrowser();
		const b = new BrowserBridge(f.tools, fakeHost({ allow: ["a.com"] }).host);
		expect(textOf(await b.callTool("browser_type", { text: "x" }))).toMatch(/not available/);
		expect(f.refusals).toEqual([{ tool: "browser_type", args: { text: "x" }, reason: expect.stringContaining("not available") }]);
		expect(f.calls.some((c) => c.name === "browser_type")).toBe(false);
	});

	it("a disallowed-host refusal during navigate is recorded with the url", async () => {
		const f = fakeBrowser();
		const b = new BrowserBridge(f.tools, fakeHost({ allow: ["a.com"] }).host);
		await b.callTool("browser_navigate", { url: "https://b.com/x" });
		expect(f.refusals).toEqual([{ tool: "browser_navigate", args: { url: "https://b.com/x" }, reason: expect.stringContaining("not on this run's list of allowed sites") }]);
	});

	it("the bridge's own page inspection is marked internal, unlike the agent's own navigate", async () => {
		const f = fakeBrowser({ "https://a.com/x": {} });
		const b = new BrowserBridge(f.tools, fakeHost({ allow: ["a.com"] }).host);
		await b.callTool("browser_navigate", { url: "https://a.com/x" });
		const nav = f.calls.find((c) => c.name === "browser_navigate");
		const inspect = f.calls.find((c) => c.name === "browser_evaluate");
		expect(nav?.internal).toBeUndefined();
		expect(inspect?.internal).toBe(true);
	});
});

describe("parsers", () => {
	it("reads an evaluate result and a snapshot line's role", () => {
		expect(evaluateResult('### Result\n{"a":1}\n### Ran Playwright code')).toEqual({ a: 1 });
		expect(evaluateResult("no result")).toBeNull();
		expect(refRole('- generic [ref=e0]\n  - link "Jobs" [ref=e5] [cursor=pointer]', "e5")).toEqual({ role: "link", name: "Jobs" });
		expect(refRole("- link [ref=e1]", "e9")).toBeNull();
	});
});

describe("following a job board's Apply link to the original posting (#1607)", () => {
	const SEEK = "https://www.seek.com.au/job/12345678";
	const ATS = "https://careers.smartrecruiters.com/endeavour/12345";
	const seekPage = { [SEEK]: {}, [ATS]: { title: "Platform Engineer" } };
	const snapshot = (name: string) => `- heading "Platform Engineer" [ref=e0]\n- link "${name}" [ref=e5]`;
	const open = async (b: BrowserBridge) => {
		await b.callTool("browser_navigate", { url: SEEK });
		await b.callTool("browser_snapshot");
	};

	it("clicks an external Apply link, stops on the landing page, and refuses every further click or navigation", async () => {
		const fb = fakeBrowser(seekPage, { snapshot: snapshot("Apply") + '\n- link "Other job" [ref=e6]', clicks: { e5: ATS } });
		const { host } = fakeHost({ allow: ["seek.com.au", "smartrecruiters.com"] });
		const b = new BrowserBridge(fb.tools, host);
		await open(b);
		const landed = await b.callTool("browser_click", { target: "e5" });
		expect(landed.isError).toBeUndefined();
		expect(textOf(landed)).toMatch(/run stops here/);
		expect(textOf(await b.callTool("browser_click", { target: "e6" }))).toMatch(/stopped at the page the apply link led to/);
		expect(textOf(await b.callTool("browser_navigate", { url: SEEK }))).toMatch(/stopped at the page/);
		// Nothing but reads and the one click was dispatched to the page.
		expect(fb.calls.filter((c) => c.name === "browser_click")).toHaveLength(1);
	});

	it("does not pause for a sign-in or application form on the landing page", async () => {
		const fb = fakeBrowser({ [SEEK]: {}, [ATS]: { login: true, writeForm: true } }, { snapshot: snapshot("Apply now"), clicks: { e5: ATS } });
		const { host, events } = fakeHost({ allow: ["seek.com.au", "smartrecruiters.com"] });
		const b = new BrowserBridge(fb.tools, host);
		await open(b);
		await b.callTool("browser_click", { target: "e5" });
		expect(events.some((e) => e.type === "run.paused")).toBe(false);
	});

	it("never follows a Quick Apply or Easy Apply link", async () => {
		for (const name of ["Quick apply", "Easy Apply"]) {
			const fb = fakeBrowser(seekPage, { snapshot: snapshot(name), clicks: { e5: `${SEEK}/apply` } });
			const b = new BrowserBridge(fb.tools, fakeHost({ allow: ["seek.com.au"] }).host);
			await open(b);
			const r = await b.callTool("browser_click", { target: "e5" });
			expect(r.isError).toBe(true);
			expect(textOf(r)).toMatch(/Quick Apply/);
			expect(fb.calls.some((c) => c.name === "browser_click")).toBe(false);
		}
	});

	it("an apply link to a site not yet allowed is undone, naming the landing URL; navigating there asks the owner and then lands", async () => {
		const fb = fakeBrowser(seekPage, { snapshot: snapshot("Apply"), clicks: { e5: ATS } });
		const { host, events } = fakeHost({ consented: ["seek.com.au"], pause: () => "resumed", onPause: () => host.consented.add("smartrecruiters.com") });
		const b = new BrowserBridge(fb.tools, host);
		await open(b);
		const refused = await b.callTool("browser_click", { target: "e5" });
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain(ATS);
		const landed = await b.callTool("browser_navigate", { url: ATS });
		expect(textOf(landed)).toMatch(/run stops here/);
		expect(events.some((e) => e.type === "run.paused" && e.pauseReason === "login_required")).toBe(false);
	});

	it("records the observed landing URL as original_url, whatever the model claimed", async () => {
		const fb = fakeBrowser(seekPage, { snapshot: snapshot("Apply"), clicks: { e5: ATS } });
		const b = new BrowserBridge(fb.tools, fakeHost({ allow: ["seek.com.au", "smartrecruiters.com"] }).host);
		await open(b);
		await b.callTool("browser_click", { target: "e5" });
		await b.callTool("record_finding", { title: "Platform Engineer", url: ATS, evidence: "Platform Engineer at Endeavour", fields: { original: "external", original_url: "https://evil.example/x", original_host: "evil.example" } });
		expect(b.findings[0].fields).toMatchObject({ original: "external", original_url: ATS, original_host: "careers.smartrecruiters.com" });
	});

	it("refuses original=external when no apply link was followed, and strips an original_url on other findings", async () => {
		const b = new BrowserBridge(fakeBrowser(seekPage, { snapshot: snapshot("Quick apply") }).tools, fakeHost({ allow: ["seek.com.au"] }).host);
		await open(b);
		const refused = await b.callTool("record_finding", { title: "Platform Engineer", url: SEEK, evidence: "x", fields: { original: "external", original_url: ATS } });
		expect(refused.isError).toBe(true);
		await b.callTool("record_finding", { title: "Platform Engineer", url: SEEK, evidence: "x", fields: { original: "quick_apply", original_url: ATS } });
		expect(b.findings).toHaveLength(1);
		expect(b.findings[0].fields).toEqual({ original: "quick_apply" });
	});

	describe("an Apply anchor with target=_blank (opens a new tab the bridge would not inspect)", () => {
		const withHref = (name: string, href: string) => `- heading "Platform Engineer" [ref=e0]\n- link "${name}" [ref=e5] [cursor=pointer]:\n  - /url: ${href}\n- link "Other" [ref=e6]:\n  - /url: /job/9`;

		it("navigates the CURRENT tab to the anchor's href instead of clicking it, and stops on the landing page", async () => {
			const fb = fakeBrowser(seekPage, { snapshot: withHref("Apply", ATS) });
			const b = new BrowserBridge(fb.tools, fakeHost({ allow: ["seek.com.au", "smartrecruiters.com"] }).host);
			await open(b);
			const landed = await b.callTool("browser_click", { target: "e5" });
			expect(textOf(landed)).toMatch(/run stops here/);
			expect(fb.calls.some((c) => c.name === "browser_click")).toBe(false);
			expect(fb.calls.find((c) => c.name === "browser_navigate" && c.args.url === ATS)).toBeDefined();
			await b.callTool("record_finding", { title: "Platform Engineer", url: ATS, evidence: "x", fields: { original: "external" } });
			expect(b.findings[0].fields.original_url).toBe(ATS);
			expect(textOf(await b.callTool("browser_navigate", { url: SEEK }))).toMatch(/stopped at the page/);
		});

		it("resolves a relative href and follows its redirect off the board", async () => {
			const fb = fakeBrowser(seekPage, { snapshot: withHref("Apply on company site", "/job/12345678/apply/redirect"), redirect: { "https://www.seek.com.au/job/12345678/apply/redirect": ATS } });
			const b = new BrowserBridge(fb.tools, fakeHost({ allow: ["seek.com.au", "smartrecruiters.com"] }).host);
			await open(b);
			expect(textOf(await b.callTool("browser_click", { target: "e5" }))).toMatch(/run stops here/);
			expect(fb.calls.some((c) => c.name === "browser_click")).toBe(false);
			await b.callTool("record_finding", { title: "Platform Engineer", url: ATS, evidence: "x", fields: { original: "external" } });
			expect(b.findings[0].fields.original_host).toBe("careers.smartrecruiters.com");
		});

		it("an href to a site not yet allowed asks the owner, and the landing is still the stop", async () => {
			const fb = fakeBrowser(seekPage, { snapshot: withHref("Apply", ATS) });
			const { host, events } = fakeHost({ consented: ["seek.com.au"], pause: () => "resumed", onPause: () => host.consented.add("smartrecruiters.com") });
			const b = new BrowserBridge(fb.tools, host);
			await open(b);
			expect(textOf(await b.callTool("browser_click", { target: "e5" }))).toMatch(/run stops here/);
			expect(events.some((e) => e.type === "run.paused" && e.pauseReason === "consent_required")).toBe(true);
			expect(events.some((e) => e.type === "run.paused" && e.pauseReason === "login_required")).toBe(false);
		});

		it("an owner who declines the site leaves nothing pending: a later navigation is not mistaken for the landing", async () => {
			const fb = fakeBrowser(seekPage, { snapshot: withHref("Apply", ATS) });
			const b = new BrowserBridge(fb.tools, fakeHost({ consented: ["seek.com.au"], pause: () => "stopped" }).host);
			await open(b);
			expect((await b.callTool("browser_click", { target: "e5" })).isError).toBe(true);
			const next = await b.callTool("browser_navigate", { url: SEEK });
			expect(textOf(next)).not.toMatch(/run stops here/);
		});

		it("Quick apply with an href is still never followed", async () => {
			const fb = fakeBrowser(seekPage, { snapshot: withHref("Quick apply", "/job/12345678/apply") });
			const b = new BrowserBridge(fb.tools, fakeHost({ allow: ["seek.com.au"] }).host);
			await open(b);
			expect((await b.callTool("browser_click", { target: "e5" })).isError).toBe(true);
			expect(fb.calls.filter((c) => c.name === "browser_navigate")).toHaveLength(1);
		});

		it("refHref reads the url under the link, not a later link's", () => {
			const snap = withHref("Apply", ATS);
			expect(refHref(snap, "e5")).toBe(ATS);
			expect(refHref(snap, "e6")).toBe("/job/9");
			expect(refHref(snap, "e0")).toBeNull();
		});
	});
});

describe("the Original Finder's find must be a page the run opened (#1608)", () => {
	const ATS = "https://careers.smartrecruiters.com/endeavour/12345";
	const OTHER = "https://careers.smartrecruiters.com/endeavour/99999";
	const pages = { [ATS]: { title: "Platform Engineer" }, [OTHER]: { title: "Other" }, "https://www.google.com/search?q=x": {} };
	const find = (b: BrowserBridge, url: string, fields: Record<string, unknown>) => b.callTool("record_finding", { title: "Platform Engineer", url, evidence: "Platform Engineer. Build the platform.", fields });

	it("stamps original_url and original_host from the page it actually opened, whatever the model claimed", async () => {
		const b = new BrowserBridge(fakeBrowser(pages, { snapshot: "- heading \"x\" [ref=e0]" }).tools, fakeHost({ allow: ["smartrecruiters.com", "google.com"] }).host);
		await b.callTool("browser_navigate", { url: ATS });
		const r = await find(b, `${ATS}/#details`, { original: "found", original_url: "https://evil.example/x", original_host: "evil.example" });
		expect(r.isError).toBeUndefined();
		expect(b.findings[0].fields).toMatchObject({ original: "found", original_url: ATS, original_host: "careers.smartrecruiters.com" });
	});

	it("refuses a found original on a page that was never opened, even on a host that was", async () => {
		const b = new BrowserBridge(fakeBrowser(pages, { snapshot: "- heading \"x\" [ref=e0]" }).tools, fakeHost({ allow: ["smartrecruiters.com"] }).host);
		await b.callTool("browser_navigate", { url: ATS });
		const r = await find(b, OTHER, { original: "found" });
		expect(r.isError).toBe(true);
		expect(textOf(r)).toMatch(/opened in this run/);
		expect(b.findings).toHaveLength(0);
	});

	it("keeps no original_url on a not_found finding", async () => {
		const b = new BrowserBridge(fakeBrowser(pages, { snapshot: "- heading \"x\" [ref=e0]" }).tools, fakeHost({ allow: ["smartrecruiters.com"] }).host);
		await b.callTool("browser_navigate", { url: ATS });
		await find(b, ATS, { original: "not_found", original_url: OTHER });
		expect(b.findings[0].fields).toEqual({ original: "not_found" });
	});
});
