/**
 * The apply bridge (#957): the only way an application CLI reaches the page, and where the write
 * policy is enforced. Like the research bridge (`local-browser/bridge.ts`), the CLI gets no web
 * access of its own and exactly one MCP server, whose calls land HERE, in the runner.
 *
 * Every call is put in an action class (see contract.ts) and allowed or refused by code:
 *
 *  - read: navigate / back / snapshot / wait, and clicks on links, tabs and pagination — on the
 *    allowed sites only. Leaving them pauses the run (`external_redirect`).
 *  - fill: `browser_type`, `browser_select_option`, and clicks on checkboxes, radios and options.
 *    Each carries a `source_quote` that must be verbatim text from the owner's profile, answers or
 *    approved materials, and the value must appear in that quote — a form answer not grounded in
 *    the profile is refused, and the CLI is told to ask (`request_answer`). Uploads go through
 *    `upload_artifact`, which can only attach an approved artifact whose hash still matches, once.
 *  - submit: any click on a control that submits a POST form (a DOM fact, read from the page by
 *    the commit-guard probe) or whose own accessible name commits, in any of the guard's
 *    languages. Under `fill_and_review` it is NEVER performed: the run stops `awaiting_review`.
 *    Under `auto_submit` it is performed at most once, after a fresh blocker check, between a
 *    `submit.attempted` and a `submit.confirmed` / `submit.unconfirmed` trace event.
 *
 * Enter, Space, typed characters by key, scripts, drag, dialogs, `browser_fill_form` and raw
 * `browser_file_upload` are refused by name. A captcha, a sign-in, a consent box, a duplicate
 * application or an anti-bot wall pauses the run for a person; nothing here works around one.
 *
 * The trace carries classes, domains, decisions and artifact handles — never a typed value.
 */
import { classifyApplyClick } from "./contract.js";
import { ELEMENT_PROBE_FN, type ElementFacts } from "../commit-guard.js";
import { normalize } from "../local-artifact/engine.js";
import { type BrowserTools, evaluateResult, hostOf, refRole } from "../local-browser/bridge.js";
import type { LocalApplyArtifactKind, LocalApplyBlockReason, LocalApplyEvent, LocalApplyLimits, LocalApplyMode, LocalApplyPause, LocalApplyPauseReason, LocalApplySupervisorBlocker, LocalApplySupervisorCheckpoint, LocalApplySupervisorDirective, LocalApplySupervisorPhase, LocalApplyUnavailableEvidence, LocalApplyUnavailableReason } from "./contract.js";

export interface ApplyBridgeHost {
	emit(event: Omit<LocalApplyEvent, "at">): void;
	/** Pause until the owner resumes ("resumed") or the run is cancelled ("stopped"). */
	pause(p: LocalApplyPause): Promise<"resumed" | "stopped">;
	/** Wait for a durable cloud directive at this exact, runner-observed checkpoint. */
	supervisorCheckpoint(checkpoint: LocalApplySupervisorCheckpoint): Promise<LocalApplySupervisorDirective>;
	isAllowed(host: string): boolean;
	/** Everything a value may be grounded in: profile, answers, approved materials, the owner's answers so far. */
	grounding(): string;
	/** The verified absolute path of an approved artifact, or why it cannot be uploaded. */
	artifactPath(kind: LocalApplyArtifactKind): { path: string; sha256: string } | { error: string };
	overTime(): boolean;
	now(): number;
	limits: LocalApplyLimits;
	mode: LocalApplyMode;
	gateId?: string;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

const READ_TOOLS = new Set(["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_wait_for"]);
const FILL_TOOLS = new Set(["browser_type", "browser_select_option"]);
const BRIDGE_TOOLS = ["upload_artifact", "request_answer", "ready_for_review", "supervisor_checkpoint"] as const;
const REFUSED = new Set([
	"browser_fill_form",
	"browser_file_upload",
	"browser_evaluate",
	"browser_run_code",
	"browser_drag",
	"browser_hover",
	"browser_handle_dialog",
	"browser_install",
	"browser_tabs",
	"browser_close",
]);

/** Every tool name the bridge can list — what a CLI may be told to trust without asking. */
export const APPLY_BRIDGE_TOOL_NAMES: readonly string[] = [...READ_TOOLS, "browser_click", ...FILL_TOOLS, "browser_press_key", ...BRIDGE_TOOLS];

/** Roles whose click is an ANSWER (a fill), never a navigation or a submit. */
const FIELD_ROLES = new Set(["checkbox", "radio", "option", "switch", "menuitemradio", "menuitemcheckbox"]);
const TYPE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const NAV_ROLES = new Set(["link", "tab", "menuitem", "treeitem"]);
const PAGINATION_NAME = /^(next|previous|prev|more|load more|show more|see more|view more|page \d+|\d+|›|»|‹|«)( page| results| jobs)?$/i;
/** Buttons that move within a form or open a file chooser — allowed when they do NOT submit. */
const STEP_NAME = /^(next|continue|back|previous|add( another)?|upload|attach|browse|choose( a)? file|select( a)? file|remove|edit|expand|collapse|show more)\b/i;
/** A tick that is a legal or privacy agreement: the owner's call, not the CLI's. */
const CONSENT_NAME = /\b(agree|consent|terms|privacy|acknowledge|certify|accept|declaration|gdpr)\b/i;
/** A field that is a credential: a sign-in, never an application answer. */
const CREDENTIAL_NAME = /password|passcode|one[- ]?time|\botp\b|verification code|security code|2fa|two[- ]factor/i;
/** Keys that move between fields without entering or activating anything. */
const SAFE_KEYS = /^(Tab|Shift\+Tab|Arrow(Up|Down|Left|Right)|Escape|Home|End|PageUp|PageDown)$/;

/** Runs inside the page, through the browser's own evaluate tool — never offered to the CLI. */
const INSPECT_PAGE = `() => {
	const text = (document.body ? document.body.innerText : "").slice(0, 20000).toLowerCase();
	const has = (s) => !!document.querySelector(s);
	return {
		url: location.href,
		title: document.title.slice(0, 200),
		captcha: has('iframe[src*="recaptcha"], .g-recaptcha, iframe[src*="hcaptcha.com"], .h-captcha, iframe[src*="challenges.cloudflare.com"], .cf-turnstile, iframe[src*="arkoselabs"], .geetest_holder')
			|| /confirm (that )?you('?re| are) not a robot|i'?m not a robot|verify (that )?you('?re| are) (a )?human/.test(text),
		login: has('input[type=password]'),
		duplicate: /you('ve| have) already applied|already applied (for|to) this|application (already exists|has already been (submitted|received))|duplicate application/.test(text),
		antiBot: /unusual traffic|access (is )?denied|request (has been )?blocked|bot detected|checking (if the site connection is secure|your browser)/.test(text),
		confirmed: /thank you for (your )?appl|application (has been |was )?(received|submitted)|we('ve| have) received your application|successfully (applied|submitted)/.test(text),
		unavailable: /(?:this |the )?(?:job|position|posting|role|opportunity).{0,120}(?:has )?(?:expired|closed|been filled|is no longer available|is no longer accepting applications)|(?:expired|closed|no longer available|no longer accepting applications).{0,120}(?:job|position|posting|role|opportunity)/.test(text)
			? (/expired/.test(text) ? "expired" : "unavailable")
			: null,
	};
}`;

interface PageState {
	url: string;
	title: string;
	captcha: boolean;
	login: boolean;
	duplicate: boolean;
	antiBot: boolean;
	confirmed: boolean;
	unavailable: LocalApplyUnavailableReason | null;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const textOf = (r: { content?: Array<{ text?: string }> }) => (r.content ?? []).map((c) => c.text ?? "").join("\n");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Is `value` grounded? The quote must be verbatim text from the owner's sources, and the value must
 * appear in the quote as a whole phrase ("No" is not found inside "Notice"). Returns the refusal,
 * or null. Pure, so the rule is tested as a rule.
 */
export function groundingRefusal(value: string, quote: unknown, grounding: string): string | null {
	const q = typeof quote === "string" ? normalize(quote) : "";
	if (q.length < 2) return "Every answer needs a source_quote: the exact text from the owner's profile, answers or materials that this value comes from.";
	if (!normalize(grounding).includes(q)) return "The source_quote is not text from the owner's profile, answers or materials. Quote them exactly, or call request_answer.";
	const v = normalize(value);
	if (!v) return "The value is empty.";
	if (!new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(v)}(?![\\p{L}\\p{N}])`, "u").test(q)) return `"${value.slice(0, 80)}" does not appear in the source_quote. Use the owner's value as written, or call request_answer.`;
	return null;
}

const QUOTE_PROP = { type: "string", description: "The exact text from the owner's profile, answers or materials that this answer comes from. Required; the value must appear in it." };

/** A browser tool's schema with `source_quote` added — the CLI must say where an answer comes from. */
function withQuote(schema: unknown, required: boolean): unknown {
	const s = (schema && typeof schema === "object" ? schema : { type: "object" }) as { properties?: Record<string, unknown>; required?: string[] };
	return { ...s, type: "object", properties: { ...(s.properties ?? {}), source_quote: QUOTE_PROP }, ...(required ? { required: [...(s.required ?? []), "source_quote"] } : {}) };
}

export class ApplyBridge {
	/** Read by the runtime for the #975 diagnostic: 0 calls is the finding, not an internal detail. */
	actions = 0;
	pages = 0;
	private lastSnapshot = "";
	private readonly admitted = new Set<string>();
	/** Fill and submit are disabled until the cloud supervisor releases the current page checkpoint. */
	private supervisorApproved = false;
	filled = 0;
	readonly uploaded = new Set<LocalApplyArtifactKind>();
	reviewReady = false;
	summary: string | null = null;
	/** Present only after the CLI explicitly reports a notice that the runner independently saw. */
	unavailable: LocalApplyUnavailableEvidence | null = null;
	submitAttempted = false;
	submitted: { url: string; at: string; gateId: string } | null = null;
	/** The last thing that stopped the work and was not resolved — the block reason if the run ends here. */
	blocked: { reason: LocalApplyBlockReason; questions: string[] } | null = null;

	constructor(
		private readonly browser: BrowserTools,
		private readonly host: ApplyBridgeHost,
	) {}

	private get done(): boolean {
		return this.reviewReady || this.submitAttempted || this.unavailable !== null;
	}

	async listTools(): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
		const own = (await this.browser.listTools()).filter((t) => READ_TOOLS.has(t.name) || FILL_TOOLS.has(t.name) || t.name === "browser_click" || t.name === "browser_press_key");
		const tools = own.map((t) => {
			if (t.name === "browser_click")
				return { ...t, description: "Click a link, tab, pagination or form-step button, or answer a checkbox / radio / option (answers need source_quote). A control that submits the application is governed by the run's policy.", inputSchema: withQuote(t.inputSchema, false) };
			if (t.name === "browser_press_key") return { ...t, description: "Press Tab, Shift+Tab, an arrow key, Escape, Home/End or PageUp/PageDown. Nothing that types or submits." };
			if (FILL_TOOLS.has(t.name)) return { ...t, inputSchema: withQuote(t.inputSchema, true) };
			return t;
		});
		return [
			...tools,
			{
				name: "upload_artifact",
				description: "Attach an approved document. First click the field's upload control (it opens a file chooser), then call this. Each document can be attached once.",
				inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["resume", "cover_letter"] } }, required: ["kind"] },
			},
			{
				name: "request_answer",
				description: "Ask the owner for an answer the sources do not give (missing_answer), or when a question is ambiguous (screening_ambiguity). The run waits for them.",
				inputSchema: { type: "object", properties: { question: { type: "string" }, kind: { type: "string", enum: ["missing_answer", "screening_ambiguity"] } }, required: ["question"] },
			},
			{
				name: "ready_for_review",
				description: "The form is filled as far as the sources allow. Stop here; the owner reviews it. Call once, last.",
				inputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
			},
			{
				name: "supervisor_checkpoint",
				description: "Pause safely for the cloud supervisor. Use the exact checkpointId supplied in your task; do not continue until this returns continue. request_review and stop are terminally handled by the runner.",
				inputSchema: { type: "object", properties: { checkpointId: { type: "string", minLength: 1, maxLength: 300 }, phase: { type: "string", enum: ["initial", "post_navigation", "before_submit", "uncertain"] } }, required: ["checkpointId", "phase"], additionalProperties: false },
			},
			{
				name: "report_job_unavailable",
				description: "End the run when a fresh browser snapshot shows that this job is expired, closed or unavailable. The runner independently verifies the page notice; it refuses unsupported reports.",
				inputSchema: { type: "object", properties: { reason: { type: "string", enum: ["expired", "unavailable"] } }, required: ["reason"] },
			},
		];
	}

	async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
		if (this.done) return text("The application is finished for this run. Stop now.", true);
		if (name === "ready_for_review") return this.review(typeof args.summary === "string" ? args.summary : "");
		if (name === "request_answer") return this.requestAnswer(args);
		if (name === "supervisor_checkpoint") return this.supervisorCheckpoint(args);
		if (name === "report_job_unavailable") return this.reportUnavailable(args);
		if (REFUSED.has(name)) return this.refuse(name, "read", `${name} is not available to an application run.`);
		if (!READ_TOOLS.has(name) && !FILL_TOOLS.has(name) && name !== "browser_click" && name !== "browser_press_key" && name !== "upload_artifact") return this.refuse(name, "read", `${name} is not available.`);
		if (this.host.overTime()) return this.refuse(name, "read", "The run's time limit is reached. Call ready_for_review now.");
		if (++this.actions > this.host.limits.maxActions) return this.refuse(name, "read", `The run's limit of ${this.host.limits.maxActions} browser actions is reached. Call ready_for_review now.`);

		if (name === "browser_navigate") return this.navigate(String(args.url ?? ""));
		if (name === "browser_click") return this.click(args);
		if (name === "browser_type") return this.type(args);
		if (name === "browser_select_option") return this.select(args);
		if (name === "browser_press_key") return this.pressKey(args);
		if (name === "upload_artifact") return this.upload(args);
		const res = await this.browser.callTool(name, args);
		if (name === "browser_snapshot") this.lastSnapshot = textOf(res);
		if (name === "browser_navigate_back") {
			const state = await this.inspect();
			if (state) return this.landed(textOf(res), state);
		}
		return { content: [{ type: "text", text: textOf(res) }], ...(res.isError ? { isError: true } : {}) };
	}

	private refuse(tool: string, cls: string, reason: string, domain?: string): ToolResult {
		this.host.emit({ type: "policy.decision", ...(domain ? { domain } : {}), detail: { tool, class: cls, decision: "refused", reason: reason.slice(0, 200) } });
		return text(reason, true);
	}

	private allow(tool: string, cls: string): void {
		this.host.emit({ type: "policy.decision", detail: { tool, class: cls, decision: "allowed" } });
	}

	private async inspect(): Promise<PageState | null> {
		const res = await this.browser.callTool("browser_evaluate", { function: INSPECT_PAGE }).catch(() => null);
		const v = res && !res.isError ? (evaluateResult(textOf(res)) as Partial<PageState> | null) : null;
		if (!v || typeof v.url !== "string") return null;
		const unavailable = v.unavailable === "expired" || v.unavailable === "unavailable" ? v.unavailable : null;
		return { url: v.url, title: String(v.title ?? ""), captcha: !!v.captcha, login: !!v.login, duplicate: !!v.duplicate, antiBot: !!v.antiBot, confirmed: !!v.confirmed, unavailable };
	}

	private blockerOf(s: PageState): LocalApplyPauseReason | null {
		return s.captcha ? "captcha" : s.antiBot ? "anti_bot" : s.duplicate ? "duplicate_application" : s.login ? "login_required" : null;
	}

	/** Pause for the owner; true when they resolved it and work may continue. */
	private async pauseFor(p: LocalApplyPause, recheck?: () => Promise<boolean>): Promise<boolean> {
		this.blocked = { reason: p.reason, questions: p.question ? [p.question] : [] };
		const outcome = await this.host.pause(p);
		if (outcome !== "resumed") return false;
		if (recheck && !(await recheck())) return false;
		// A person may have changed the page or its answers while handling the pause.
		this.supervisorApproved = false;
		this.blocked = null;
		return true;
	}

	/** After a page change: count it, trace it, and stop for a person when the page needs one. */
	private async landed(toolText: string, known?: PageState | null): Promise<ToolResult> {
		const state = known ?? (await this.inspect());
		// A navigation can put the CLI on a materially different form, even on the same origin.
		this.supervisorApproved = false;
		if (!state) return text(toolText);
		this.pages++;
		const host = hostOf(state.url) ?? "";
		this.host.emit({ type: "browser.navigated", url: state.url, domain: host });
		const blocker = this.blockerOf(state);
		if (!blocker) return text(toolText);
		this.host.emit({ type: "browser.blocked", url: state.url, domain: host, detail: { reason: blocker } });
		const ok = await this.pauseFor({ reason: blocker, url: state.url, domain: host }, async () => {
			const after = await this.inspect();
			return !!after && this.blockerOf(after) === null;
		});
		if (!ok) return text(`${host} needs a person (${blocker.replace(/_/g, " ")}) and it was not resolved. Do not work around it. Stop now.`, true);
		return text("Resumed after the owner handled it. Take a browser_snapshot to read the page.");
	}

	/** May the run be on this host? Asks the owner (external_redirect) when it is not an allowed site. */
	private async admit(host: string, url: string): Promise<boolean> {
		if (this.host.isAllowed(host)) {
			if (!this.admitted.has(host)) {
				this.admitted.add(host);
				this.host.emit({ type: "policy.decision", domain: host, detail: { class: "read", decision: "allowed", basis: "allow_list" } });
			}
			return true;
		}
		return this.pauseFor({ reason: "external_redirect", url, domain: host }, async () => this.host.isAllowed(host));
	}

	private async navigate(url: string): Promise<ToolResult> {
		const host = hostOf(url);
		if (!host) return this.refuse("browser_navigate", "read", "Only http(s) URLs can be opened.");
		if (this.pages >= this.host.limits.maxPages) return this.refuse("browser_navigate", "read", `The run's limit of ${this.host.limits.maxPages} pages is reached. Call ready_for_review now.`);
		if (!(await this.admit(host, url))) return this.refuse("browser_navigate", "read", `${host} is not one of this application's sites and the owner did not allow it. Stop now.`, host);
		const res = await this.browser.callTool("browser_navigate", { url });
		if (res.isError) return { content: [{ type: "text", text: textOf(res) }], isError: true };
		return this.afterMove("browser_navigate", textOf(res));
	}

	/** A page change the CLI did not fully choose (a redirect, a link): leaving the allowed sites is undone and paused. */
	private async afterMove(tool: string, toolText: string): Promise<ToolResult> {
		const state = await this.inspect();
		const landedOn = state ? hostOf(state.url) : null;
		if (state && landedOn && !this.host.isAllowed(landedOn)) {
			await this.browser.callTool("browser_navigate_back", {}).catch(() => undefined);
			if (!(await this.pauseFor({ reason: "external_redirect", url: state.url, domain: landedOn }, async () => this.host.isAllowed(landedOn)))) {
				return this.refuse(tool, "read", `That led to ${landedOn}, which is not one of this application's sites. It was undone. Stop now.`, landedOn);
			}
			return text(`The owner allowed ${landedOn}. Open it with browser_navigate.`);
		}
		return this.landed(toolText, state);
	}

	private target(args: Record<string, unknown>): { ref: string; role: string; name: string } | null {
		const ref = typeof args.target === "string" ? args.target : typeof args.ref === "string" ? args.ref : "";
		const found = ref ? refRole(this.lastSnapshot, ref) : null;
		return found ? { ref, ...found } : null;
	}

	private async probe(ref: string, label: string): Promise<ElementFacts | null> {
		const res = await this.browser.callTool("browser_evaluate", { element: label || "control", target: ref, function: ELEMENT_PROBE_FN }).catch(() => null);
		const v = res && !res.isError ? (evaluateResult(textOf(res)) as ElementFacts | null) : null;
		return v && typeof v.submits === "boolean" ? v : null;
	}

	private async click(args: Record<string, unknown>): Promise<ToolResult> {
		const t = this.target(args);
		if (!t) return this.refuse("browser_click", "read", "Click only elements from the latest browser_snapshot, by their ref.");
		const forward = { element: typeof args.element === "string" ? args.element : t.name, target: t.ref };

		if (FIELD_ROLES.has(t.role)) {
			if ((t.role === "checkbox" || t.role === "switch") && CONSENT_NAME.test(t.name)) {
				this.host.emit({ type: "policy.decision", detail: { tool: "browser_click", class: "fill", decision: "paused", reason: "consent_required" } });
				const ok = await this.pauseFor({ reason: "consent_required", question: `Agree to: ${t.name.slice(0, 200)}` });
				return ok ? text("The owner handled that agreement in the browser. Do not click it yourself; take a browser_snapshot and continue.") : text("The owner did not handle that agreement. Stop now.", true);
			}
			const refusal = groundingRefusal(t.name, args.source_quote, this.host.grounding());
			if (refusal) return this.refuse("browser_click", "fill", refusal);
			return this.fill("browser_click", t.role, forward);
		}

		const facts = await this.probe(t.ref, t.name);
		if (!facts) return this.refuse("browser_click", "read", "That element could not be read from the page, so the click cannot be shown to be safe. Take a fresh browser_snapshot.");
		// WHICH control is this? (#985) The rule is in the shared contract, which states the three
		// families and why the order of the tests is the safety property. It replaced a test against
		// `FALLBACK_COMMIT_RE` — the READ-ONLY floor, which matches bare `apply` on purpose — under
		// which the press that OPENS a SEEK application was the final submit, and four live
		// fill-and-review runs ended `awaiting_review` with `filled: 0` seconds after the cloud had
		// let them through their initial checkpoint.
		const klass = classifyApplyClick({
			role: t.role,
			names: [facts.name, t.name, String(forward.element)],
			submits: facts.submits,
			method: facts.method,
			filled: this.filled,
			uploaded: this.uploaded.size,
		});
		if (klass.klass === "submit") return this.submit(forward, klass.reason);
		if (klass.klass === "entry") return this.entry(forward, t, klass.reason);
		if (NAV_ROLES.has(t.role) || (t.role === "button" && PAGINATION_NAME.test(t.name.trim()))) {
			if (this.pages >= this.host.limits.maxPages) return this.refuse("browser_click", "read", `The run's limit of ${this.host.limits.maxPages} pages is reached. Call ready_for_review now.`);
			const res = await this.browser.callTool("browser_click", forward);
			if (res.isError) return { content: [{ type: "text", text: textOf(res) }], isError: true };
			return this.afterMove("browser_click", textOf(res));
		}
		// A native file input opens the file chooser for upload_artifact — a DOM fact, whatever its label.
		const fileInput = facts.tag === "input" && facts.type === "file";
		if (fileInput || klass.klass === "step" || (t.role === "button" && STEP_NAME.test(t.name.trim()) && !facts.submits)) {
			const checkpoint = this.requireSupervisor("browser_click", "fill");
			if (checkpoint) return checkpoint;
			this.allow("browser_click", "fill");
			const res = await this.browser.callTool("browser_click", forward);
			if (!res.isError && !fileInput) this.supervisorApproved = false;
			return { content: [{ type: "text", text: textOf(res) }], ...(res.isError ? { isError: true } : {}) };
		}
		return this.refuse("browser_click", "read", `"${t.name || t.role}" is not a control an application run may press. Links, form-step buttons (Next, Upload, Add) and answers are allowed.`);
	}

	private async fill(tool: string, role: string, forward: Record<string, unknown>): Promise<ToolResult> {
		const checkpoint = this.requireSupervisor(tool, "fill");
		if (checkpoint) return checkpoint;
		const res = await this.browser.callTool(tool, forward);
		if (res.isError) return { content: [{ type: "text", text: textOf(res) }], isError: true };
		this.filled++;
		this.host.emit({ type: "field.filled", detail: { tool, class: "fill", role } });
		return text(textOf(res));
	}

	private async type(args: Record<string, unknown>): Promise<ToolResult> {
		const t = this.target(args);
		if (!t || !TYPE_ROLES.has(t.role)) return this.refuse("browser_type", "fill", "Type only into a text field from the latest browser_snapshot, by its ref.");
		if (args.submit === true) return this.refuse("browser_type", "submit", "Typing may not submit the form (submit: true is refused).");
		if (CREDENTIAL_NAME.test(t.name)) {
			const ok = await this.pauseFor({ reason: "login_required", question: `Sign in: ${t.name.slice(0, 200)}` });
			return ok ? text("The owner handled the sign-in. Take a browser_snapshot and continue.") : text("A sign-in needs the owner and was not handled. Stop now.", true);
		}
		const value = typeof args.text === "string" ? args.text : "";
		const refusal = groundingRefusal(value, args.source_quote, this.host.grounding());
		if (refusal) return this.refuse("browser_type", "fill", refusal);
		return this.fill("browser_type", t.role, { element: typeof args.element === "string" ? args.element : t.name, target: t.ref, text: value });
	}

	private async select(args: Record<string, unknown>): Promise<ToolResult> {
		const t = this.target(args);
		if (!t) return this.refuse("browser_select_option", "fill", "Select only in a field from the latest browser_snapshot, by its ref.");
		const values = Array.isArray(args.values) ? args.values.filter((v): v is string => typeof v === "string") : [];
		if (!values.length) return this.refuse("browser_select_option", "fill", "values is required.");
		for (const v of values) {
			const refusal = groundingRefusal(v, args.source_quote, this.host.grounding());
			if (refusal) return this.refuse("browser_select_option", "fill", refusal);
		}
		return this.fill("browser_select_option", t.role, { element: typeof args.element === "string" ? args.element : t.name, target: t.ref, values });
	}

	private async pressKey(args: Record<string, unknown>): Promise<ToolResult> {
		const key = typeof args.key === "string" ? args.key : "";
		if (!SAFE_KEYS.test(key)) return this.refuse("browser_press_key", "submit", `${key || "That key"} is refused: only Tab, arrows, Escape, Home/End and PageUp/PageDown move between fields. Enter and Space can submit.`);
		const res = await this.browser.callTool("browser_press_key", { key });
		return { content: [{ type: "text", text: textOf(res) }], ...(res.isError ? { isError: true } : {}) };
	}

	private async upload(args: Record<string, unknown>): Promise<ToolResult> {
		const checkpoint = this.requireSupervisor("upload_artifact", "fill");
		if (checkpoint) return checkpoint;
		const kind = args.kind === "resume" || args.kind === "cover_letter" ? args.kind : null;
		if (!kind) return this.refuse("upload_artifact", "fill", "kind must be resume or cover_letter.");
		if (this.uploaded.has(kind)) return this.refuse("upload_artifact", "fill", `The ${kind.replace("_", " ")} is already attached; it is never attached twice.`);
		const file = this.host.artifactPath(kind);
		if ("error" in file) {
			this.blocked = { reason: "artifact_changed", questions: [file.error] };
			return this.refuse("upload_artifact", "fill", `${file.error} Stop now.`);
		}
		const res = await this.browser.callTool("browser_file_upload", { paths: [file.path] });
		if (res.isError) {
			const msg = textOf(res);
			return text(/modal state|file chooser/i.test(msg) ? "No file chooser is open. Click the field's upload control first, then call upload_artifact." : msg, true);
		}
		this.uploaded.add(kind);
		this.host.emit({ type: "artifact.uploaded", detail: { kind, sha256: file.sha256, class: "fill" } });
		return text(`Attached the approved ${kind.replace("_", " ")}.`);
	}

	private async requestAnswer(args: Record<string, unknown>): Promise<ToolResult> {
		const question = typeof args.question === "string" ? args.question.trim().slice(0, 300) : "";
		if (!question) return text("request_answer needs the question.", true);
		const reason: LocalApplyPauseReason = args.kind === "screening_ambiguity" ? "screening_ambiguity" : "missing_answer";
		const before = this.host.grounding().length;
		const ok = await this.pauseFor({ reason, question });
		if (!ok) return text("Nobody answered. Do not guess. Stop now.", true);
		// Resumed without an answer: the owner chose to leave it — never a cue to guess.
		if (this.host.grounding().length === before) return text("The owner resumed without answering: leave that field empty and continue with the others.");
		return text("The owner answered. Their answer is now part of your sources — quote it as source_quote. Take a browser_snapshot and continue.");
	}

	/**
	 * The CLI may ask to stop at a named checkpoint, but it cannot smuggle a decision through this
	 * tool. The runner waits for a separately persisted, typed directive and terminal directives are
	 * resolved by the runtime before this call returns.
	 */
	private async supervisorCheckpoint(args: Record<string, unknown>): Promise<ToolResult> {
		const checkpointId = typeof args.checkpointId === "string" ? args.checkpointId.trim() : "";
		if (!/^[A-Za-z0-9_.:-]{1,300}$/.test(checkpointId)) return text("supervisor_checkpoint needs a safe checkpointId (letters, numbers, dot, underscore, colon or hyphen).", true);
		const phase: LocalApplySupervisorPhase | null = args.phase === "initial" || args.phase === "post_navigation" || args.phase === "before_submit" || args.phase === "uncertain" ? args.phase : null;
		if (!phase) return text("supervisor_checkpoint needs phase initial, post_navigation, before_submit or uncertain.", true);
		const state = await this.inspect();
		const blockers = new Set<LocalApplySupervisorBlocker>();
		if (state?.captcha) blockers.add("captcha");
		if (state?.login) blockers.add("login_required");
		if (state?.antiBot) blockers.add("anti_bot");
		if (state?.duplicate) blockers.add("duplicate_application");
		if (this.blocked && ["missing_answer", "screening_ambiguity", "external_redirect", "duplicate_application", "anti_bot", "login_required", "captcha"].includes(this.blocked.reason)) blockers.add(this.blocked.reason as LocalApplySupervisorBlocker);
		const url = state?.url;
		const domain = url ? hostOf(url) ?? undefined : undefined;
		const directive = await this.host.supervisorCheckpoint({
			schemaVersion: 1,
			checkpointId,
			facts: {
				phase,
				actions: this.actions,
				filled: this.filled,
				uploaded: this.uploaded.size,
				blockers: [...blockers],
				...(url ? { url } : {}),
				...(domain ? { domain } : {}),
				...(state?.title ? { title: state.title.slice(0, 300) } : {}),
			},
		});
		if (directive === "continue") {
			this.supervisorApproved = true;
			return text("The persisted supervisor directive is continue. You may continue using only the application bridge tools.");
		}
		return text(`The persisted supervisor directive is ${directive}. The runner has ended this application run locally; do not take any further action.`, true);
	}

	/**
	 * A terminal result needs the runner's own fresh observation, not the CLI's reading of a page.
	 * The snapshot requirement makes the notice visible to the CLI; the static page probe verifies
	 * its category and current URL before any evidence is retained.
	 */
	private async reportUnavailable(args: Record<string, unknown>): Promise<ToolResult> {
		const reason = args.reason === "expired" || args.reason === "unavailable" ? args.reason : null;
		if (!reason) return text("reason must be expired or unavailable.", true);
		if (!this.lastSnapshot) return text("Take a fresh browser_snapshot that shows the listing notice before reporting it unavailable.", true);
		const state = await this.inspect();
		if (!state?.unavailable) return text("The runner could not verify an expired or unavailable listing notice on the current page. Continue only if the page is still actionable, or take a fresh snapshot.", true);
		if (state.unavailable !== reason) return text(`The runner verified this listing as ${state.unavailable}, not ${reason}. Report that reason or take a fresh snapshot.`, true);
		const url = state.url;
		const domain = hostOf(url) ?? "";
		this.unavailable = { reason, url, observedAt: new Date(this.host.now()).toISOString(), source: "page_notice" };
		this.host.emit({ type: "job.unavailable", url, domain, detail: { reason, source: "page_notice" } });
		return text(`Recorded the runner-verified ${reason} listing notice. Stop now.`);
	}

	private review(summary: string): ToolResult {
		this.reviewReady = true;
		this.summary = summary; // bounded where the result is built (runtime.ts `end`)
		this.host.emit({ type: "review.ready", detail: { class: "review", count: this.filled } });
		return text("Recorded. The application waits for the owner's review; nothing was submitted. Stop now.");
	}

	/**
	 * The control that OPENS the application (#985) — pressed, never submitted.
	 *
	 * It needs the supervisor's live `continue` exactly as a fill does: it changes the page, and the
	 * cloud is the party that decides whether this page may be worked on. `afterMove` then counts the
	 * page, traces it and clears the approval, so the form that opens gets its own checkpoint — which
	 * is what keeps a multi-page ATS supervised page by page rather than once at the start.
	 */
	private async entry(forward: Record<string, unknown>, t: { role: string; name: string }, reason: string): Promise<ToolResult> {
		const checkpoint = this.requireSupervisor("browser_click", "fill");
		if (checkpoint) return checkpoint;
		if (this.pages >= this.host.limits.maxPages) return this.refuse("browser_click", "read", `The run's limit of ${this.host.limits.maxPages} pages is reached. Call ready_for_review now.`);
		this.host.emit({ type: "policy.decision", detail: { tool: "browser_click", class: "entry", decision: "allowed", reason, role: t.role } });
		const res = await this.browser.callTool("browser_click", forward);
		if (res.isError) return { content: [{ type: "text", text: textOf(res) }], isError: true };
		return this.afterMove("browser_click", textOf(res));
	}

	/** The final Submit. Never under fill_and_review; once, gated and traced, under auto_submit. */
	private async submit(forward: Record<string, unknown>, why = "terminal_label"): Promise<ToolResult> {
		const checkpoint = this.requireSupervisor("browser_click", "submit");
		if (checkpoint) return checkpoint;
		if (this.host.mode !== "auto_submit" || !this.host.gateId) {
			// `reason` carries WHICH rule classified this as the submit (#985). "fill_and_review"
			// alone left an owner with a run that stopped at `filled: 0` and no way to tell whether it
			// had reached the end of the form or refused the button that opens it.
			// The RULE, not the control's label: the label is the page's own prose and belongs to the
			// machine (the contract keeps page text off the cloud trace). The rule is what an owner
			// needs — "this was the one-click control", not "this was a submit".
			this.host.emit({ type: "policy.decision", detail: { tool: "browser_click", class: "submit", decision: "refused", reason: "fill_and_review", rule: why } });
			const oneClick = why === "one_click_apply";
			this.review(oneClick ? "Stopped at a one-click apply control: it can send the application outright, and this run fills and waits for review." : "Stopped at the final submit: this run fills and waits for review.");
			return text(
				oneClick
					? 'That control ("' + String(forward.element ?? "") + '") can send the application in one click, and this run is fill-and-review: it was NOT pressed. Approve this application if you want it sent. Stop now.'
					: "That control submits the application, and this run is fill-and-review: it was NOT pressed. The application waits for the owner's review. Stop now.",
			);
		}
		const before = await this.inspect();
		if (!before) return this.refuse("browser_click", "submit", "The page could not be read, so the submit cannot be shown to be safe. Take a fresh browser_snapshot.");
		const blocker = this.blockerOf(before);
		if (blocker) {
			this.blocked = { reason: blocker, questions: [] };
			return this.refuse("browser_click", "submit", `The page shows a blocker (${blocker.replace(/_/g, " ")}); nothing was submitted. Stop now.`, hostOf(before.url) ?? undefined);
		}
		const domain = hostOf(before.url) ?? "";
		if (!this.host.isAllowed(domain)) return this.refuse("browser_click", "submit", `${domain} is not one of this application's sites; nothing was submitted.`, domain);
		this.submitAttempted = true;
		this.host.emit({ type: "submit.attempted", url: before.url, domain, detail: { class: "submit", gateId: this.host.gateId } });
		const res = await this.browser.callTool("browser_click", forward);
		await this.browser.callTool("browser_wait_for", { time: 2 }).catch(() => undefined);
		const after = res.isError ? null : await this.inspect();
		if (after?.confirmed) {
			this.submitted = { url: after.url, at: new Date(this.host.now()).toISOString(), gateId: this.host.gateId };
			this.host.emit({ type: "submit.confirmed", url: after.url, domain: hostOf(after.url) ?? domain, detail: { gateId: this.host.gateId } });
			return text("Submitted, and the site confirmed it. Stop now.");
		}
		this.blocked = { reason: "submit_unconfirmed", questions: ["The application was submitted but the site did not confirm it. Check the employer's site or your email before anything is retried."] };
		this.host.emit({ type: "submit.unconfirmed", ...(after ? { url: after.url } : {}), domain, detail: { gateId: this.host.gateId } });
		return text("The submit was pressed but no confirmation was seen. Do not press it again. Stop now.", true);
	}

	/** A cloud-persisted checkpoint, not a prompt instruction, authorizes each page's writes. */
	private requireSupervisor(tool: string, actionClass: "fill" | "submit"): ToolResult | null {
		if (this.supervisorApproved) return null;
		this.host.emit({ type: "policy.decision", detail: { tool, class: actionClass, decision: "refused", reason: "supervisor_checkpoint" } });
		return text(`A persisted supervisor_checkpoint must return continue before ${actionClass === "submit" ? "the final submit" : "any fill or upload"}. Take a browser_snapshot if needed, then call supervisor_checkpoint.`, true);
	}
}
