/**
 * The policy-enforcing browser a local CLI researches through (#944, #947).
 *
 * The Codex / Claude Code CLI on the owner's machine gets NO built-in web access (engine.ts turns
 * its fetch, search and shell tools off) and exactly one MCP server: a thin stdio forwarder
 * (bridge-stdio.ts) whose every call lands HERE, inside the runner process. So every rule below is
 * enforced by the runner, not requested of the model:
 *
 *  - only `research_only` tools exist: navigate, go back, snapshot, wait, and clicks on links, tabs
 *    and pagination buttons. Typing, forms, selects, uploads, key presses and script evaluation are
 *    refused by name — a model cannot submit what it cannot fill;
 *  - every page it reaches is checked against the deny list, the allow list and the owner's
 *    consent; a new site pauses the run until the owner decides;
 *  - a captcha or a login wall pauses the run for a person; a paywall is reported, never bypassed;
 *  - pages, actions and time are counted here and refused past their limits;
 *  - findings are recorded through `record_finding`, which only accepts a URL on a site the run
 *    actually opened — a finding must cite a page, not the model's memory.
 *
 * The trace this writes carries domains, URLs, titles and decisions. Never page text, form values,
 * cookies or screenshots: every detail passes `redactDetail` before it is stored.
 */
import type { LocalBrowserEvent, LocalBrowserFinding, LocalBrowserLimits, LocalBrowserPauseReason, LocalBrowserSourceFailure, LocalBrowserSourceFailureReason } from "./contract.js";
import { LOCAL_BROWSER_SOURCE_FAILURE_REASONS, redactDetail } from "./contract.js";

/** The browser the bridge drives — `McpRuntime` in production, a fake in tests. */
export interface BrowserTools {
	listTools(): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>>;
	callTool(name: string, args?: Record<string, unknown>): Promise<{ content?: Array<{ type?: string; text?: string }>; isError?: boolean }>;
}

/** What the run gives the bridge: the trace, the pause machinery, and the live consent state. */
export interface BridgeHost {
	emit(event: Omit<LocalBrowserEvent, "at">): void;
	/** Pause the run until the owner resumes it; "stopped" when it was cancelled or timed out instead. */
	pause(reason: LocalBrowserPauseReason, detail: Record<string, unknown>): Promise<"resumed" | "stopped">;
	isDenied(host: string): boolean;
	/** Allowed without asking: on the allow list, or consented by the owner. */
	isPermitted(host: string): boolean;
	/** The id of the owner's decision covering this host, when one does (#947). */
	consentIdFor(host: string): string | undefined;
	/** Must every site be on the allow list (the creator or owner gave one)? */
	allowListOnly(): boolean;
	overTime(): boolean;
	limits: LocalBrowserLimits;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

/** The browser tools a research run may use. Everything else from the browser is not even listed. */
const READ_TOOLS = new Set(["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_wait_for", "browser_click"]);
/** The research tools the bridge adds; the CLI records its results through these. */
const RESEARCH_TOOL_NAMES = ["record_finding", "report_source_failure", "finish_research"] as const;
/** Refused BY NAME with the reason, so a CLI that guesses one is told why rather than "unknown tool". */
const WRITE_TOOLS = new Set([
	"browser_type",
	"browser_fill_form",
	"browser_select_option",
	"browser_file_upload",
	"browser_evaluate",
	"browser_run_code",
	"browser_press_key",
	"browser_drag",
	"browser_hover",
	"browser_handle_dialog",
	"browser_install",
]);
/** Roles a click may target in research mode: moving between pages, never acting on one. */
const CLICKABLE_ROLES = new Set(["link", "tab", "menuitem", "treeitem", "option"]);
const PAGINATION_NAME = /^(next|previous|prev|more|load more|show more|see more|view more|older|newer|page \d+|\d+|›|»|‹|«)( page| results| jobs)?$/i;

/**
 * Every tool name the bridge can ever list (#952) — the exact set a CLI may be told to trust
 * without asking. Write tools are not in it, so trusting this set cannot trust a write.
 */
export const BRIDGE_TOOL_NAMES: readonly string[] = [...READ_TOOLS, ...RESEARCH_TOOL_NAMES];

const RESEARCH_TOOLS = [
	{
		name: "record_finding",
		description: "Record one finding from a page you opened in this run. url must be on a site you navigated to; evidence is the exact text on that page the finding comes from.",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string" },
				url: { type: "string" },
				evidence: { type: "string" },
				fields: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } },
			},
			required: ["title", "url", "evidence"],
		},
	},
	{
		name: "report_source_failure",
		description: `Record a source you could not read, and why: ${LOCAL_BROWSER_SOURCE_FAILURE_REASONS.join(", ")}.`,
		inputSchema: {
			type: "object",
			properties: { url: { type: "string" }, reason: { type: "string", enum: [...LOCAL_BROWSER_SOURCE_FAILURE_REASONS] }, detail: { type: "string" } },
			required: ["url", "reason"],
		},
	},
	{
		name: "finish_research",
		description: "End the research with a short summary of what you found and what you could not reach. Call it once, last.",
		inputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
	},
];

/** Runs inside the page, through the browser's own evaluate tool — privileged, never offered to the CLI. */
const INSPECT_PAGE = `() => {
	const text = (document.body ? document.body.innerText : "").slice(0, 20000).toLowerCase();
	const has = (s) => !!document.querySelector(s);
	const captcha = has('iframe[src*="hcaptcha.com"], .h-captcha, iframe[src*="challenges.cloudflare.com"], .cf-turnstile, iframe[src*="arkoselabs"], .geetest_holder')
		|| /confirm (that )?you('?re| are) not a robot|i'?m not a robot|verify (that )?you('?re| are) (a )?human|checking (if the site connection is secure|your browser)/.test(text);
	const login = has('input[type=password]');
	const paywall = /subscribe to (continue|read)|you('ve| have) reached your (free )?(article )?limit|sign in to (continue|read)/.test(text);
	return { url: location.href, title: document.title.slice(0, 200), captcha, login, paywall };
}`;

interface PageState {
	url: string;
	title: string;
	captcha: boolean;
	login: boolean;
	paywall: boolean;
}

/** A bare lowercase hostname, or null — the same rule the API applies to the lists it sends. */
export function hostOf(raw: string): string | null {
	try {
		const u = new URL(raw);
		if (u.protocol !== "https:" && u.protocol !== "http:") return null;
		return u.hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		return null;
	}
}

export function domainWithin(host: string, base: string): boolean {
	return host === base || host.endsWith(`.${base}`);
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const textOf = (r: { content?: Array<{ text?: string }> }) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

/** Pull the JSON value out of an evaluate result (`### Result\n<json>\n### …`). */
export function evaluateResult(raw: string): unknown {
	const i = raw.indexOf("### Result");
	const after = (i >= 0 ? raw.slice(i + "### Result".length) : raw).trim();
	const end = after.indexOf("\n###");
	const block = (end >= 0 ? after.slice(0, end) : after).trim().replace(/^```[a-z]*\n?|```$/g, "").trim();
	try {
		return JSON.parse(block);
	} catch {
		return null;
	}
}

/** The role and accessible name of a snapshot line holding this ref, e.g. `- link "Next" [ref=e12]`. */
export function refRole(snapshot: string, ref: string): { role: string; name: string } | null {
	for (const line of snapshot.split("\n")) {
		if (!line.includes(`[ref=${ref}]`)) continue;
		const m = line.match(/^\s*-\s*([a-z]+)(?:\s+"([^"]*)")?/i);
		return m ? { role: m[1].toLowerCase(), name: m[2] ?? "" } : null;
	}
	return null;
}

export class BrowserBridge {
	private actions = 0;
	private pages = 0;
	private lastSnapshot = "";
	private readonly visited = new Set<string>();
	readonly findings: LocalBrowserFinding[] = [];
	readonly sourceFailures: LocalBrowserSourceFailure[] = [];
	summary: string | null = null;

	constructor(
		private readonly browser: BrowserTools,
		private readonly host: BridgeHost,
	) {}

	/** What the CLI sees: the read-only browser tools that exist, plus the research tools. */
	async listTools(): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
		const tools = (await this.browser.listTools()).filter((t) => READ_TOOLS.has(t.name));
		return [
			...tools.map((t) => (t.name === "browser_click" ? { ...t, description: "Click a link, tab or pagination button (Next, More, a page number) from the latest snapshot. Nothing else can be clicked in research mode." } : t)),
			...RESEARCH_TOOLS,
		];
	}

	async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
		if (name === "record_finding") return this.recordFinding(args);
		if (name === "report_source_failure") return this.reportFailure(args);
		if (name === "finish_research") {
			this.summary = typeof args.summary === "string" ? args.summary.slice(0, 4000) : "";
			return text("Recorded. The research is finished; stop now.");
		}
		if (WRITE_TOOLS.has(name)) return this.refuse(name, `${name} is not available: this run is research only — no typing, forms, uploads, key presses or scripts.`);
		if (!READ_TOOLS.has(name)) return this.refuse(name, `${name} is not available in research mode.`);
		if (this.host.overTime()) return this.refuse(name, "The run's time limit is reached. Call finish_research now.");
		if (++this.actions > this.host.limits.maxActions) return this.refuse(name, `The run's limit of ${this.host.limits.maxActions} browser actions is reached. Call finish_research now.`);

		if (name === "browser_navigate") return this.navigate(String(args.url ?? ""));
		if (name === "browser_click") return this.click(args);
		const res = await this.browser.callTool(name, args);
		if (name === "browser_snapshot") {
			this.lastSnapshot = textOf(res);
			this.host.emit({ type: "browser.snapshot", ...this.currentHost() });
		}
		if (name === "browser_navigate_back") {
			const state = await this.inspect();
			if (state) this.noteNavigation(state);
		}
		return { content: [{ type: "text", text: textOf(res) }], ...(res.isError ? { isError: true } : {}) };
	}

	private currentHost(): { domain?: string } {
		const last = [...this.visited].pop();
		return last ? { domain: last } : {};
	}

	/** Refuse, on the trace — naming the site and the owner's decision behind it when there is one. */
	private refuse(tool: string, reason: string, host?: string): ToolResult {
		const consentId = host ? this.host.consentIdFor(host) : undefined;
		this.host.emit({ type: "policy.decision", ...(host ? { domain: host } : {}), ...(consentId ? { consentId } : {}), detail: { tool, decision: "refused", reason } });
		return text(reason, true);
	}

	/** Hosts already admitted on this run — a site is recorded as allowed once, not on every page. */
	private readonly admitted = new Set<string>();

	private allowed(host: string, basis: "allow_list" | "consent"): void {
		if (this.admitted.has(host)) return;
		this.admitted.add(host);
		const consentId = basis === "consent" ? this.host.consentIdFor(host) : undefined;
		this.host.emit({ type: "policy.decision", domain: host, ...(consentId ? { consentId } : {}), detail: { decision: "allowed", basis } });
	}

	/** May the run be on this host — asking the owner, and waiting, when it is a new one. */
	private async admit(host: string, url: string): Promise<string | null> {
		if (this.host.isDenied(host)) return `${host} is on this run's deny list.`;
		if (this.host.isPermitted(host)) {
			this.allowed(host, this.host.consentIdFor(host) ? "consent" : "allow_list");
			return null;
		}
		if (this.host.allowListOnly()) return `${host} is not on this run's list of allowed sites.`;
		this.host.emit({ type: "consent.requested", url, domain: host, detail: { scope: "navigate" } });
		const outcome = await this.host.pause("consent_required", { domain: host });
		if (outcome === "resumed" && this.host.isPermitted(host) && !this.host.isDenied(host)) {
			this.allowed(host, "consent");
			return null;
		}
		return `The owner did not allow ${host}. Skip it and record it with report_source_failure (access_denied).`;
	}

	private async navigate(url: string): Promise<ToolResult> {
		const host = hostOf(url);
		if (!host) return this.refuse("browser_navigate", "Only http(s) URLs can be opened.");
		if (this.pages >= this.host.limits.maxPages) return this.refuse("browser_navigate", `The run's limit of ${this.host.limits.maxPages} pages is reached. Call finish_research now.`);
		const refusal = await this.admit(host, url);
		if (refusal) return this.refuse("browser_navigate", refusal, host);
		const res = await this.browser.callTool("browser_navigate", { url });
		if (res.isError) return { content: [{ type: "text", text: textOf(res) }], isError: true };
		// A redirect is a second navigation the CLI did not choose. Following one within the same
		// site (www., a jobs. subdomain) is fine; landing somewhere unrelated and unpermitted is not.
		const state = await this.inspect();
		const landedOn = state ? hostOf(state.url) : null;
		const related = (a: string, b: string) => domainWithin(a, b) || domainWithin(b, a);
		if (landedOn && !related(landedOn, host) && (this.host.isDenied(landedOn) || !this.host.isPermitted(landedOn))) {
			await this.browser.callTool("browser_navigate_back", {}).catch(() => undefined);
			return this.refuse("browser_navigate", `${host} redirected to ${landedOn}, a site this run has not been allowed on. Open ${landedOn} with browser_navigate to ask the owner, or skip it.`);
		}
		return this.landed(textOf(res), state);
	}

	private async click(args: Record<string, unknown>): Promise<ToolResult> {
		const ref = typeof args.target === "string" ? args.target : typeof args.ref === "string" ? args.ref : "";
		const target = ref ? refRole(this.lastSnapshot, ref) : null;
		const allowed = target && (CLICKABLE_ROLES.has(target.role) || (target.role === "button" && PAGINATION_NAME.test(target.name.trim())));
		if (!allowed) return this.refuse("browser_click", "In research mode only links, tabs and pagination buttons (Next, More, a page number) from the latest browser_snapshot can be clicked.");
		if (this.pages >= this.host.limits.maxPages) return this.refuse("browser_click", `The run's limit of ${this.host.limits.maxPages} pages is reached. Call finish_research now.`);
		const res = await this.browser.callTool("browser_click", { element: typeof args.element === "string" ? args.element : target.name, target: ref });
		if (res.isError) return { content: [{ type: "text", text: textOf(res) }], isError: true };
		const state = await this.inspect();
		const host = state ? hostOf(state.url) : null;
		// A click that lands on a site this run may not be on is undone, and the CLI is told to
		// navigate there instead — which is the path that asks the owner.
		if (host && !this.visited.has(host) && (this.host.isDenied(host) || !this.host.isPermitted(host))) {
			await this.browser.callTool("browser_navigate_back", {}).catch(() => undefined);
			return this.refuse("browser_click", `That link leads to ${host}, a site this run has not been allowed on. Open it with browser_navigate to ask the owner.`);
		}
		return this.landed(textOf(res), state);
	}

	/** After a page change: count it, trace it, and stop for a person when the page needs one. */
	private async landed(toolText: string, known?: PageState | null): Promise<ToolResult> {
		const state = known ?? (await this.inspect());
		if (!state) return text(toolText);
		this.pages++;
		this.noteNavigation(state);
		const host = hostOf(state.url) ?? "";
		const blocker: LocalBrowserPauseReason | null = state.captcha ? "captcha" : state.login ? "login_required" : null;
		if (blocker) {
			this.host.emit({ type: "browser.blocked", url: state.url, domain: host, detail: { reason: blocker } });
			const outcome = await this.host.pause(blocker, { domain: host });
			if (outcome !== "resumed") return text(`${host} needs a person (${blocker === "captcha" ? "a captcha" : "a sign-in"}) and nobody resolved it. Record it with report_source_failure (${blocker}) and move on.`, true);
			const after = await this.inspect();
			if (after && (after.captcha || after.login)) return text(`${host} still shows ${blocker === "captcha" ? "a captcha" : "a sign-in"}. Record it with report_source_failure (${blocker}) and move on.`, true);
			return text(`Resumed after the owner handled ${host}. Take a browser_snapshot to read the page.`);
		}
		if (state.paywall) {
			this.host.emit({ type: "browser.blocked", url: state.url, domain: host, detail: { reason: "paywall" } });
			return text(`${host} is behind a paywall. Do not try to get around it: record it with report_source_failure (paywall) and move on.`, true);
		}
		return text(toolText);
	}

	private noteNavigation(state: PageState): void {
		const host = hostOf(state.url);
		if (!host) return;
		this.visited.add(host);
		this.host.emit({ type: "browser.navigated", url: state.url, domain: host, detail: redactDetail({ title: state.title }) });
	}

	private async inspect(): Promise<PageState | null> {
		const res = await this.browser.callTool("browser_evaluate", { function: INSPECT_PAGE }).catch(() => null);
		const v = res && !res.isError ? (evaluateResult(textOf(res)) as Partial<PageState> | null) : null;
		if (!v || typeof v.url !== "string") return null;
		return { url: v.url, title: typeof v.title === "string" ? v.title : "", captcha: !!v.captcha, login: !!v.login, paywall: !!v.paywall };
	}

	private recordFinding(args: Record<string, unknown>): ToolResult {
		const title = typeof args.title === "string" ? args.title.trim() : "";
		const url = typeof args.url === "string" ? args.url.trim() : "";
		const evidence = typeof args.evidence === "string" ? args.evidence.trim() : "";
		const host = hostOf(url);
		if (!title || !evidence || !host) return text("A finding needs a title, an http(s) url and evidence text.", true);
		if (![...this.visited].some((v) => domainWithin(host, v) || domainWithin(v, host))) {
			return text(`${host} was not opened in this run. A finding must cite a page you navigated to.`, true);
		}
		if (this.findings.some((f) => f.url === url && f.title === title)) return text("Already recorded.");
		if (this.findings.length >= 200) return text("This run holds at most 200 findings. Call finish_research.", true);
		const fields: LocalBrowserFinding["fields"] = {};
		const raw = args.fields && typeof args.fields === "object" && !Array.isArray(args.fields) ? (args.fields as Record<string, unknown>) : {};
		for (const [k, v] of Object.entries(redactDetail(raw) ?? {})) {
			if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) fields[k] = v;
		}
		const finding = { title: title.slice(0, 500), url: url.slice(0, 2000), evidence: evidence.slice(0, 4000), fields };
		this.findings.push(finding);
		this.host.emit({ type: "finding.parsed", url: finding.url, domain: host, detail: { title: finding.title } });
		return text(`Recorded finding ${this.findings.length}.`);
	}

	private reportFailure(args: Record<string, unknown>): ToolResult {
		const url = typeof args.url === "string" ? args.url.trim() : "";
		const reason = LOCAL_BROWSER_SOURCE_FAILURE_REASONS.includes(args.reason as LocalBrowserSourceFailureReason) ? (args.reason as LocalBrowserSourceFailureReason) : null;
		if (!url || !reason) return text(`A source failure needs a url and a reason: ${LOCAL_BROWSER_SOURCE_FAILURE_REASONS.join(", ")}.`, true);
		if (this.sourceFailures.length >= 200) return text("This run holds at most 200 source failures.", true);
		const detail = typeof args.detail === "string" ? args.detail.slice(0, 1000) : undefined;
		this.sourceFailures.push(detail ? { url: url.slice(0, 2000), reason, detail } : { url: url.slice(0, 2000), reason });
		return text("Recorded.");
	}
}
