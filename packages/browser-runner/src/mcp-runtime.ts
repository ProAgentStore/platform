import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { BrowserContext } from "playwright";
import { type BrowserCallOutcome, type BrowserCallsPage, type BrowserCallSubject, BrowserCallRecorder } from "./browser-call-recorder.js";

/** The caller owns the browser in either case. Native contexts work across all engines (#1431). */
export type McpRuntimeOptions =
	| { context: BrowserContext; cdpEndpoint?: never }
	| { cdpEndpoint: string; context?: never };

export interface McpToolResult {
	/** `text` blocks, or an `image` block (base64 `data` + `mimeType`) from `browser_take_screenshot` (#1063). */
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	isError?: boolean;
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
	/**
	 * Native secret placeholders (#1412). `@playwright/mcp` reads `config.secrets[name]` at call time
	 * (`browser_type` / `browser_fill_form` substitute the value, responses redact it to
	 * `<secret>NAME</secret>`), and its config merge keeps this very object, so a value added here
	 * while the browser is open is honoured by the next call. A model types the NAME; the value
	 * never reaches it, the trace, a frame or a log. Unknown names are typed literally by the
	 * library, which is why the apply bridge refuses a name that is not in {@link secretNames}.
	 */
	private readonly secrets: Record<string, string> = {};
	/** One recorder at this chokepoint (#1409) — every `callTool`, every path, redacted before it is kept. */
	constructor(private readonly calls = new BrowserCallRecorder()) {}
	/** The run that currently holds this browser, set by whoever claimed it. Null until one does. */
	private subject: BrowserCallSubject | null = null;

	provideSecrets(map: Record<string, string>): void {
		for (const [name, value] of Object.entries(map)) if (value) this.secrets[name] = value;
	}

	clearSecrets(): void {
		for (const name of Object.keys(this.secrets)) delete this.secrets[name];
	}

	secretNames(): string[] {
		return Object.keys(this.secrets);
	}

	/** The run claiming this browser sets its own subject (#1409); null leaves calls recorded as `subject: null`. */
	setSubject(subject: BrowserCallSubject | null): void {
		this.subject = subject;
	}

	async start(opts: McpRuntimeOptions): Promise<void> {
		if (this.client) return;
		if ((!opts.context && !opts.cdpEndpoint) || (opts.context && opts.cdpEndpoint)) throw new Error("MCP needs exactly one caller-owned browser context or CDP endpoint.");
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
		return res.tools as Array<{ name: string; description?: string; inputSchema: unknown }>;
	}

	/**
	 * `opts.internal` marks a probe the RUNNER made of the page for its own purposes (a read-back, a
	 * dialog auto-clear, the bridges' own page inspection) — never set by an agent-driven call. Every
	 * call is recorded regardless; `internal` only tells a reader which ones were the agent's own.
	 */
	async callTool(name: string, args: Record<string, unknown> = {}, opts: { internal?: boolean } = {}): Promise<McpToolResult> {
		const startedAt = Date.now();
		try {
			const res = (await this.connected().callTool({ name, arguments: args })) as McpToolResult;
			this.calls.record({
				subject: this.subject,
				tool: name,
				args,
				secrets: this.secrets,
				startedAt,
				outcome: res.isError ? "tool_error" : "ok",
				...(res.isError ? { errorHead: this.textOf(res).slice(0, 200) } : {}),
				internal: opts.internal ?? false,
			});
			return res;
		} catch (err) {
			this.calls.record({
				subject: this.subject,
				tool: name,
				args,
				secrets: this.secrets,
				startedAt,
				outcome: "thrown",
				errorHead: (err instanceof Error ? err.message : String(err)).slice(0, 200),
				internal: opts.internal ?? false,
			});
			throw err;
		}
	}

	/** A refusal that never reached Playwright at all (a policy/commit-guard refusal) — recorded in the same ordered stream. */
	refused(tool: string, args: Record<string, unknown>, reason: string): void {
		this.calls.record({ subject: this.subject, tool, args, secrets: this.secrets, startedAt: Date.now(), outcome: "refused", errorHead: reason, internal: false });
	}

	/**
	 * A call that drove the page WITHOUT going through `callTool` at all (the raw-mouse scroll, which
	 * has no standard tool). `startedAt` is the caller's own, so the duration reflects the real wait.
	 */
	recordExternal(tool: string, args: Record<string, unknown>, outcome: BrowserCallOutcome, opts: { startedAt?: number; errorHead?: string; internal?: boolean } = {}): void {
		this.calls.record({ subject: this.subject, tool, args, secrets: this.secrets, startedAt: opts.startedAt ?? Date.now(), outcome, ...(opts.errorHead ? { errorHead: opts.errorHead } : {}), internal: opts.internal ?? false });
	}

	/** The recorded calls for one subject after `afterSeq`, paged — the runner's `/browser-calls` pull route. */
	pullCalls(subject: BrowserCallSubject | null, afterSeq: number): BrowserCallsPage {
		return this.calls.page(subject, afterSeq);
	}

	/** Text of the last tool result (the standard tools return their output as text content). */
	textOf(res: McpToolResult): string {
		return (res.content || []).map((c) => c.text ?? "").join("\n");
	}

	async stop(): Promise<void> {
		// Bounded. Closing a persistent context flushes the whole profile to disk and
		// on a cold/slow machine that measurably exceeds 10s — and a browser wedged
		// mid-close would otherwise block teardown with no upper limit at all. The
		// browser itself (and its profile dir, if any) is the CALLER's to close (#1419);
		// this only ever tears down the MCP server/client pair it owns.
		await withTimeout(this.client?.close(), 20_000);
		await withTimeout(this.server?.close(), 20_000);
		this.client = undefined;
		this.server = undefined;
	}
}
