import { BrowserStateSampler } from "./browser-state.js";
import type { BrowserStateObservation, BrowserStateSnapshot } from "./browser-state-contract.js";
import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { BrowserContext, FileChooser, Page } from "playwright";
import { type BrowserCallOutcome, type BrowserCallsPage, type BrowserCallSubject, BrowserCallRecorder } from "./browser-call-recorder.js";
import { domainAdmissionUrl, guardedToolRefusal, navigationRefusal, type McpCallPolicy } from "./mcp-call-policy.js";
import { UploadVerifier, type PreparedUpload } from "./upload-verification.js";
import { websiteAccessBlock, type WebsiteAccessBlock } from "./browser-website-access.js";

/** The caller owns the browser in either case. Native contexts work across all engines (#1431). */
export type McpRuntimeOptions = (
	| { context: BrowserContext; cdpEndpoint?: never }
	| { cdpEndpoint: string; context?: never }
) & { activePage?: () => Page | null; onPageSelected?: (page: Page) => void };

const REFUSED_CALL = Symbol("runner refused call");
export interface McpToolResult {
	[REFUSED_CALL]?: true;
	/** `text` blocks, or an `image` block (base64 `data` + `mimeType`) from `browser_take_screenshot` (#1063). */
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	isError?: boolean;
	websiteAccess?: WebsiteAccessBlock;
}

/** Await a promise, giving up (never throwing) after `ms`. */
async function withTimeout(p: Promise<unknown> | undefined, ms: number): Promise<void> {
	if (!p) return;
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			p.catch(() => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Hosts the INDUSTRY-STANDARD `@playwright/mcp` server in the runner and an in-process
 * MCP client to drive it. Every browser action goes through the standard Playwright MCP
 * tools (browser_snapshot, browser_click, browser_type, browser_select_option,
 * browser_fill_form, browser_file_upload, …) — no hand-rolled browser code. When the lib
 * updates, we get its fixes for free. The cloud brain calls these same tools over the relay.
 */
export class McpRuntime {
	private server?: Server;
	private client?: Client;
	private context?: BrowserContext;
	private selectedPage?: Page;
	private activePage?: () => Page | null;
	private onPageSelected?: (page: Page) => void;
	private policy: McpCallPolicy = {};
	private readonly uploads = new UploadVerifier();
	private readonly stateSampler = new BrowserStateSampler(() => Object.values(this.diagnosticSecrets));
	setCallPolicy(policy: McpCallPolicy): void { this.policy = policy; }
	/** A page-bound native chooser identity; tool text cannot manufacture it. */
	pendingUploadId(): string | null { return this.uploadContext()?.chooserId ?? null; }
	trackUploadPage(page: Page): void { this.uploads.track(page); }
	chooserId(chooser: FileChooser): string | null { return this.uploads.chooserId(chooser); }
	uploadContext(): { page: object; chooserId: string | null } | null {
		const page = this.activePage?.() ?? this.selectedPage ?? this.context?.pages().at(-1);
		return page && !page.isClosed() ? { page, chooserId: this.uploads.pendingId(page) } : null;
	}

	/** Keep the native page used for policy/takeover identical to the MCP selected tab. */
	async selectPage(page: Page): Promise<void> {
		if (this.selectedPage === page && !page.isClosed()) return;
		// MCP attaches lazily on its first tool. Listing initializes its native tab registry.
		if (!this.selectedPage) {
			const listed = await this.callTool("browser_tabs", { action: "list" }, { internal: true });
			if (listed.isError) throw new Error("Could not initialize the browser's tab registry.");
		}
		const index = this.context?.pages().indexOf(page) ?? -1;
		if (index < 0) throw new Error("Browser page is no longer owned by this runtime.");
		const result = await this.callTool("browser_tabs", { action: "select", index }, { internal: true });
		if (result.isError) throw new Error("Could not select the browser's active page.");
		this.selectedPage = page;
	}
	/**
	 * Native secret placeholders (#1412). `@playwright/mcp` reads `config.secrets[name]` at call time
	 * (`browser_type` / `browser_fill_form` substitute the value, responses redact it to
	 * `<secret>NAME</secret>`), and its config merge keeps this very object, so a value added here
	 * while the browser is open is honoured by the next call. A model types the NAME; the value
	 * never reaches it, the trace, a frame or a log. Unknown names are typed literally by the
	 * library, which is why the apply bridge refuses a name that is not in {@link secretNames}.
	 */
	private readonly secrets: Record<string, string> = {};
	/** Redaction only: never supplied to MCP for typing; retained until teardown for live pages and late errors. */
	private readonly diagnosticSecrets: Record<string, string> = {};
	private subjectVersion = 0;
	/** One recorder at this chokepoint (#1409) — every `callTool`, every path, redacted before it is kept. */
	constructor(private readonly calls = new BrowserCallRecorder()) {}
	/** The run that currently holds this browser, set by whoever claimed it. Null until one does. */
	private subject: BrowserCallSubject | null = null;

	provideSecrets(map: Record<string, string>): void {
		for (const [name, value] of Object.entries(map)) if (value) {
			this.secrets[name] = value;
			if (!Object.values(this.diagnosticSecrets).includes(value)) this.diagnosticSecrets[this.diagnosticSecrets[name] ? `${name}_${Object.keys(this.diagnosticSecrets).length}` : name] = value;
		}
	}

	clearSecrets(): void {
		for (const name of Object.keys(this.secrets)) delete this.secrets[name];
	}

	secretNames(): string[] {
		return Object.keys(this.secrets);
	}

	/** The run claiming this browser sets its own subject (#1409); null leaves calls recorded as `subject: null`. */
	setSubject(subject: BrowserCallSubject | null): void {
		if (this.subject?.kind !== subject?.kind || this.subject?.id !== subject?.id) this.subjectVersion++;
		this.subject = subject;
	}

	async start(opts: McpRuntimeOptions): Promise<void> {
		if (this.client) return;
		if ((!opts.context && !opts.cdpEndpoint) || (opts.context && opts.cdpEndpoint)) throw new Error("MCP needs exactly one caller-owned browser context or CDP endpoint.");
		this.context = opts.context;
		this.activePage = opts.activePage;
		this.onPageSelected = opts.onPageSelected;
		// The runner is a trusted local process uploading the user's OWN résumé, which
		// lives under the runner's data dir (outside the CWD). Lift the file-root guard
		// (meant to stop an LLM reading arbitrary host files) so browser_file_upload can
		// attach it — the runner, not the model, chooses the path.
		this.server = await createConnection({
			...(opts.context ? {} : { browser: { cdpEndpoint: opts.cdpEndpoint } }),
			allowUnrestrictedFileAccess: true,
			secrets: this.secrets,
			// The caller controls browser lifetime, including a paused owner takeover.
			timeouts: { idle: 0 },
			// #1420 (0.0.82): a page could otherwise register its own WebMCP tools into the CLI's
			// tool list — enabled by default upstream. The tool surface is ours to declare, not a
			// page's to extend.
			webmcp: false,
			// #1420 (0.0.84): masks OAuth/session query params in tool TEXT the model reads live —
			// `traceUrl` (local-apply/contract.ts) already strips every query param from a URL once
			// it reaches PAGS's own trace/store, but that's a different layer: this is what the
			// model sees mid-run, before anything is recorded. Same vocabulary as the Worker's own
			// `SECRET_PARAM` (workers/api/src/lib/remote-auth.ts) — params that only ever carry a
			// credential or an OAuth leg.
			redactUrlParams: ["code", "token", "access_token", "id_token", "refresh_token", "code_verifier", "machine_proof", "session", "secret", "password", "jwt", "auth"],
		}, opts.context ? async () => opts.context : undefined);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await this.server.connect(serverTransport);
		this.client = new Client({ name: "pags-runner", version: "1.0.0" });
		await this.client.connect(clientTransport);
	}

	/**
	 * The connected client, or a diagnosis. `client` is unset before `start()` AND cleared by
	 * `stop()`, so both call sites below are reachable with it missing — a use-after-stop is the
	 * likely one, since `stop()` runs on teardown while a slow in-flight action is still landing.
	 * A bare `this.client!` turned that into "Cannot read properties of undefined (reading
	 * 'callTool')" at the relay boundary, which names neither the runtime nor the lifecycle.
	 */
	private connected(): Client {
		if (!this.client) throw new Error("MCP runtime is not running — call start() first (or it was already stopped).");
		return this.client;
	}

	/** The standard Playwright MCP tool schemas — advertised to the cloud brain verbatim. */
	async listTools(): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
		const res = await this.connected().listTools();
		return res.tools.filter((tool) => tool.name !== "browser_evaluate" && tool.name !== "browser_run_code") as Array<{ name: string; description?: string; inputSchema: unknown }>;
	}

	private async probe<T>(args: Record<string, unknown>): Promise<T | null> {
		const result = await this.callTool("browser_evaluate", args, { internal: true });
		if (result.isError) return null;
		const block = this.textOf(result).split("### Result")[1]?.split("\n###")[0]?.trim();
		try { return block ? JSON.parse(block) as T : null; } catch { return null; }
	}

	/**
	 * `opts.internal` marks a probe the RUNNER made of the page for its own purposes (a read-back, a
	 * dialog auto-clear, the bridges' own page inspection) — never set by an agent-driven call. Every
	 * call is recorded regardless; `internal` only tells a reader which ones were the agent's own.
	 */
	async callTool(name: string, args: Record<string, unknown> = {}, opts: { internal?: boolean; expectedOrigin?: string; expectedUploadId?: string; isUploadAuthorized?: () => boolean } = {}): Promise<McpToolResult> {
		const startedAt = Date.now(), subject = this.subject, version = this.subjectVersion;
		// Snapshot before awaiting: teardown may clear the live store while this call is in flight.
		const initialSecrets = { ...this.diagnosticSecrets };
		const secrets = () => ({ ...this.diagnosticSecrets, ...initialSecrets });
		const state = () => version === this.subjectVersion ? this.captureState(subject) : undefined;
		try {
			const result = await this.dispatchTool(name, args, opts);
			try { if (version === this.subjectVersion) this.stateSampler.observe(this.textOf(result), this.context, this.selectedPage); } catch { /* Observability cannot fail the browser action. */ }
			this.calls.record({ subject, tool: name, args, secrets: secrets(), startedAt, outcome: result[REFUSED_CALL] ? "refused" : result.isError ? "tool_error" : "ok", ...(result.isError ? { errorHead: this.textOf(result) } : {}), internal: opts.internal ?? false, browserState: state() });
			return result;
		} catch (error) {
			this.calls.record({ subject, tool: name, args, secrets: secrets(), startedAt, outcome: "thrown", errorHead: error instanceof Error ? error.message : String(error), internal: opts.internal ?? false, browserState: state() });
			throw error;
		}
	}
	private captureState(subject: BrowserCallSubject | null): BrowserStateSnapshot | undefined {
		if (!subject || this.subject?.kind !== subject.kind || this.subject.id !== subject.id || !this.client || !this.context) return undefined;
		try {
		const active = this.activePage ? this.activePage() : this.selectedPage;
		const state = this.stateSampler.sample(this.context, active, this.selectedPage, this.uploads.pendingId(active ?? undefined));
		this.calls.rememberState(subject, state);
		return state;
		} catch { return undefined; }
	}
	browserState(subject: BrowserCallSubject, live = true): BrowserStateObservation {
		const current = live && !!this.captureState(subject);
		return this.calls.state(subject, current);
	}
	private async dispatchTool(name: string, args: Record<string, unknown>, opts: { internal?: boolean; expectedOrigin?: string; expectedUploadId?: string; isUploadAuthorized?: () => boolean }): Promise<McpToolResult> {
		const client = this.connected();
		const cancelled = () => this.policy.isCancelled?.() ? "BLOCKED by the runner — this task was stopped; no further browser action is permitted." : null;
		let refusal = cancelled();
		const currentPage = () => this.activePage?.() ?? this.selectedPage ?? this.context?.pages().at(-1);
		const pageBefore = currentPage();
		if (pageBefore) this.uploads.track(pageBefore);
		if (!refusal && name !== "browser_navigate" && name !== "browser_tabs" && pageBefore) refusal = navigationRefusal(pageBefore.url());
		if (!refusal && name !== "browser_tabs" && this.activePage) {
			const page = this.activePage();
			if (!page || page.isClosed()) refusal = "BLOCKED by the runner — the run's active page is no longer available.";
			else await this.selectPage(page);
		}
		if (!refusal) refusal = await guardedToolRefusal(name, args, this.policy.guard, (probeArgs) => this.probe(probeArgs), opts.internal ?? false);
		const fields = name === "browser_fill_form" && Array.isArray(args.fields) ? args.fields as Record<string, unknown>[] : [];
		const secretEntry = (name === "browser_type" && typeof args.text === "string" && !!this.secrets[args.text]) || fields.some((field) => typeof field.value === "string" && !!this.secrets[field.value]);
		if (!refusal && secretEntry && !opts.expectedOrigin) refusal = "BLOCKED by the runner — credential entry requires a runner-bound sign-in origin.";
		if (!refusal && opts.expectedOrigin) {
			// A secret target may be in a cross-origin iframe even when the top page stayed put.
			const targets = name === "browser_fill_form" ? fields.map((field) => field.ref ?? field.target) : [args.target ?? args.ref];
			for (const target of targets) {
				if (typeof target !== "string") continue;
				const targetOrigin = await this.probe<string>({ target, element: "sign-in control", function: "el => el.ownerDocument.location.origin" });
				if (targetOrigin !== opts.expectedOrigin) refusal = "BLOCKED by the runner — the sign-in control changed origin before credential entry.";
			}
			const page = this.selectedPage ?? this.context?.pages().at(-1);
			let origin: string | undefined;
			try { origin = page && !page.isClosed() ? new URL(page.url()).origin : undefined; } catch { /* Unknown means refused. */ }
			if (origin !== opts.expectedOrigin) refusal = "BLOCKED by the runner — the sign-in page changed origin before credential entry.";
		}
		let upload: PreparedUpload | undefined;
		if (!refusal && name === "browser_file_upload") {
			if (Array.isArray(args.paths) && args.paths.length && args.paths.every((path) => typeof path === "string")) {
				upload = await this.uploads.prepare(currentPage(), args.paths as string[]);
				refusal = upload.error ?? null;
			} else if (pageBefore) this.uploads.clear(pageBefore);
		}
		if (!refusal && name === "browser_navigate" && this.pendingUploadId()) refusal = "A verified file chooser is still open. No navigation was dispatched. Upload the approved artifact first, or explicitly cancel the chooser with browser_file_upload and no paths before navigating.";
		// Redirects can land after a click or supervisor checkpoint, or during an awaited probe.
		// The current native URL and live per-run allowlist decide at the actual dispatch boundary.
		let websiteBlock: WebsiteAccessBlock | null = null;
		const websitePolicy = this.policy.websiteAccess?.();
		const websiteUrl = () => name === "browser_navigate" || (name === "browser_tabs" && args.action === "new" && args.url !== undefined) ? String(args.url ?? "") : name === "browser_tabs" && args.action === "select" && typeof args.index === "number" ? this.context?.pages()[args.index]?.url() ?? "" : currentPage()?.url() ?? "";
		const inspectWebsite = !opts.internal && (name !== "browser_tabs" || args.action === "new" || args.action === "select");
		if (!refusal && websitePolicy && inspectWebsite) {
			websiteBlock = websiteAccessBlock(websitePolicy, websiteUrl());
			if (websiteBlock) {
				if (websiteBlock.decision === "ask") await this.policy.requestWebsiteApproval?.(websiteBlock);
				refusal = websiteBlock.decision === "ask" ? "Website approval is required. No action was dispatched. After the owner decides, inspect the page and make a fresh decision." : "This website is denied by this agent's website access policy. No action was dispatched.";
			}
		}
		if (!refusal && !websitePolicy && this.policy.isDomainAllowed) {
			const candidate = () => domainAdmissionUrl(name, args, currentPage()?.url(), opts.internal ?? false);
			const allowed = (url: string | null) => {
				if (url === null) return true;
				try { const parsed = new URL(url); return (parsed.protocol === "https:" || parsed.protocol === "http:") && this.policy.isDomainAllowed?.(parsed.hostname) === true; } catch { return false; }
			};
			const url = candidate();
			if (!allowed(url)) {
				if (url) await this.policy.requestDomainApproval?.(url);
				refusal = allowed(candidate())
					? "No action was dispatched while site approval was pending. Inspect the current page and request a fresh supervisor checkpoint before retrying."
					: "BLOCKED by the runner — the current browser site has not been approved for this application. No action was dispatched; explicit owner domain approval is required.";
			}
		}
		// Stop can arrive while a DOM/origin/upload/admission check was in flight. Check again at dispatch.
		refusal ??= cancelled();
		if (!refusal && name === "browser_file_upload" && (opts.expectedUploadId || upload?.chooserId)) {
			const pending = this.uploads.pendingId(currentPage());
			if ((opts.expectedUploadId && pending !== opts.expectedUploadId) || (upload?.chooserId && pending !== upload.chooserId) || opts.isUploadAuthorized?.() === false) refusal = "The upload's chooser or task authorization changed before dispatch. No file was attached; inspect the intended upload control again.";
		}
		if (refusal) {
			return { [REFUSED_CALL]: true, isError: true, content: [{ type: "text", text: refusal }], ...(websiteBlock ? { websiteAccess: websiteBlock } : {}) };
		}
		try {
			let res = (await client.callTool({ name, arguments: args })) as McpToolResult;
			if (!res.isError && upload?.verify) {
				const checked = await upload.verify();
				res = { ...res, ...(checked.error ? { isError: true } : {}), content: [...res.content, { type: "text", text: checked.error ?? "Approved file selected in the intended upload field. Website acceptance remains unconfirmed; inspect the site's upload feedback." }] };
			}
			if (!res.isError && name === "browser_tabs") {
				if (args.action === "select" && typeof args.index === "number") this.selectedPage = this.context?.pages()[args.index];
				else if (args.action === "new") this.selectedPage = this.context?.pages().at(-1);
				else if (args.action === "close" && this.selectedPage?.isClosed()) this.selectedPage = undefined;
				if (this.selectedPage && (args.action === "select" || args.action === "new")) this.onPageSelected?.(this.selectedPage);
			}
			// Back, a link or a popup can navigate without browser_navigate. Never return a
			// snapshot from a local/internal page even if an already-open tab reached one.
			const pageAfter = currentPage();
			const forbiddenPage = pageAfter && navigationRefusal(pageAfter.url());
			if (forbiddenPage) res = { isError: true, content: [{ type: "text", text: forbiddenPage }] };
			if (!forbiddenPage && websitePolicy && inspectWebsite && pageAfter) {
				const blockedAfter = websiteAccessBlock(websitePolicy, pageAfter.url(), !["browser_snapshot", "browser_wait_for", "browser_take_screenshot", "browser_console_messages", "browser_network_requests"].includes(name));
				if (blockedAfter) {
					if (blockedAfter.decision === "ask") await this.policy.requestWebsiteApproval?.(blockedAfter);
					res = { isError: true, websiteAccess: blockedAfter, content: [{ type: "text", text: "The browser reached a website that this agent has not been permitted to access. The previous action may already have run; do not replay it. After an owner decision, inspect the page and decide again." }] };
				}
			}
			return res;
		} catch (error) { throw error; }
	}

	/** A refusal that never reached Playwright at all (a policy/commit-guard refusal) — recorded in the same ordered stream. */
	refused(tool: string, args: Record<string, unknown>, reason: string): void {
		this.calls.record({ subject: this.subject, tool, args, secrets: this.diagnosticSecrets, startedAt: Date.now(), outcome: "refused", errorHead: reason, internal: false, browserState: this.captureState(this.subject) });
	}

	/**
	 * A call that drove the page WITHOUT going through `callTool` at all (the raw-mouse scroll, which
	 * has no standard tool). `startedAt` is the caller's own, so the duration reflects the real wait.
	 */
	recordExternal(tool: string, args: Record<string, unknown>, outcome: BrowserCallOutcome, opts: { startedAt?: number; errorHead?: string; internal?: boolean } = {}): void {
		this.calls.record({ subject: this.subject, tool, args, secrets: this.diagnosticSecrets, startedAt: opts.startedAt ?? Date.now(), outcome, ...(opts.errorHead ? { errorHead: opts.errorHead } : {}), internal: opts.internal ?? false, browserState: this.captureState(this.subject) });
	}

	/** The recorded calls for one subject after `afterSeq`, paged — the runner's `/browser-calls` pull route. */
	pullCalls(subject: BrowserCallSubject | null, afterSeq: number, limit?: number): BrowserCallsPage {
		return this.calls.page(subject, afterSeq, limit);
	}

	/** Text of the last tool result (the standard tools return their output as text content). */
	textOf(res: McpToolResult): string {
		return (res.content || []).map((c) => c.text ?? "").join("\n");
	}

	async stop(): Promise<void> {
		this.subjectVersion++;
		this.uploads.stop();
		// Bounded. Closing a persistent context flushes the whole profile to disk and
		// on a cold/slow machine that measurably exceeds 10s — and a browser wedged
		// mid-close would otherwise block teardown with no upper limit at all. The
		// browser itself (and its profile dir, if any) is the CALLER's to close (#1419);
		// this only ever tears down the MCP server/client pair it owns.
		await withTimeout(this.client?.close(), 20_000);
		await withTimeout(this.server?.close(), 20_000);
		this.client = undefined;
		this.server = undefined;
		this.context = undefined;
		this.selectedPage = undefined;
		this.activePage = undefined;
		this.onPageSelected = undefined;
		this.policy = {};
		for (const name of Object.keys(this.diagnosticSecrets)) delete this.diagnosticSecrets[name];
	}
}
