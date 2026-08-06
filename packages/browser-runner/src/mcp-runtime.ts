import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { sweepStalePlaywrightProfiles } from "./reaper.js";

export interface McpRuntimeOptions {
	/** Attach to an already-running Chrome over CDP (version-agnostic). Preferred:
	 *  the runner launches the real-profile browser, @playwright/mcp drives it. */
	cdpEndpoint?: string;
	/** Or let @playwright/mcp launch a persistent profile itself. */
	userDataDir?: string;
	headless?: boolean;
	isolated?: boolean;
}

export interface McpToolResult {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

/**
 * Throwaway profile dirs created by this module and not yet removed (#274).
 *
 * `stop()` cannot reliably win this race on its own: the MCP server releases the
 * browser, but Chrome's exit is asynchronous and it rewrites `Local State` on the
 * way out — measurably AFTER `stop()` has returned, so an rmSync there leaves a
 * re-created directory behind. The browser is only certainly gone once Playwright's
 * own `exit` handler has run, so the last pass belongs at process exit.
 *
 * This also covers the dir being stranded when `stop()` is never called at all —
 * a throw between `start()` and `stop()`, which no `try/finally` in the caller
 * would catch either.
 */
const ownedProfileDirs = new Set<string>();
let exitHookInstalled = false;

/**
 * Try to remove a profile dir now. It stays registered unless it is really gone,
 * so a dir Chrome re-creates while shutting down gets another pass at exit rather
 * than being forgotten after one failed attempt.
 */
function removeProfileDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best effort; the dir is disk, not correctness
	}
	if (!existsSync(dir)) ownedProfileDirs.delete(dir);
}

function rememberProfileDir(dir: string): void {
	ownedProfileDirs.add(dir);
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	// Registered AFTER Playwright's own launch-time exit handler, so by the time
	// this runs Playwright has already killed the browsers it started.
	process.on("exit", () => {
		for (const d of ownedProfileDirs) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				// exiting anyway
			}
		}
	});
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
	/** A profile dir this instance created and is therefore responsible for deleting. */
	private ownedProfileDir?: string;

	async start(opts: McpRuntimeOptions): Promise<void> {
		if (this.client) return;
		let browser: Record<string, unknown>;
		if (opts.cdpEndpoint) {
			// Production: attach to the browser the runner already launched. Nothing
			// is created here, so nothing can leak here.
			browser = { cdpEndpoint: opts.cdpEndpoint };
		} else {
			// This is the ONE path in this package that produced the `#274` orphans.
			//
			// `isolated: true` makes @playwright/mcp call the non-persistent
			// `chromium.launch()`, and Playwright then mkdtemps
			// `$TMPDIR/playwright_chromiumdev_profile-XXXXXX` and deletes it only on a
			// clean close — so every SIGKILLed parent left both a running browser AND a
			// few hundred MB of profile behind, under a name we did not know and could
			// not clean up afterwards.
			//
			// Asking for a directory WE created gets the same isolation (it is fresh
			// every start) while making the leak addressable: we know the path, we
			// delete it in `stop()`, and it is named so a human can see where it came
			// from. It also keeps the throwaway-profile pattern out of our own output,
			// so the reaper's matches are unambiguously other people's abandonment.
			// Self-heal before adding one more. Chrome writes its final state as it
			// dies — after `stop()`, and after our own `exit` hook — so the last
			// skeleton of a directory can outlive the process that owned it no matter
			// when we try to delete it. Sweeping here means a stale one never survives
			// a second run, without needing the runner to be restarted. Only touches
			// dirs no live process holds; see reaper.ts for the safety argument.
			try {
				sweepStalePlaywrightProfiles();
			} catch {
				// cleanup must never stop a browser from starting
			}
			const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), "pags-mcp-profile-"));
			if (!opts.userDataDir) {
				this.ownedProfileDir = userDataDir;
				rememberProfileDir(userDataDir);
			}
			browser = { userDataDir, isolated: false, launchOptions: { headless: opts.headless ?? false } };
		}
		// The runner is a trusted local process uploading the user's OWN résumé, which
		// lives under the runner's data dir (outside the CWD). Lift the file-root guard
		// (meant to stop an LLM reading arbitrary host files) so browser_file_upload can
		// attach it — the runner, not the model, chooses the path.
		this.server = await createConnection({ browser, allowUnrestrictedFileAccess: true });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await this.server.connect(serverTransport);
		this.client = new Client({ name: "pags-runner", version: "1.0.0" });
		await this.client.connect(clientTransport);
	}

	/** The standard Playwright MCP tool schemas — advertised to the cloud brain verbatim. */
	async listTools(): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
		const res = await this.client!.listTools();
		return res.tools as Array<{ name: string; description?: string; inputSchema: unknown }>;
	}

	async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
		return (await this.client!.callTool({ name, arguments: args })) as McpToolResult;
	}

	/** Text of the last tool result (the standard tools return their output as text content). */
	textOf(res: McpToolResult): string {
		return (res.content || []).map((c) => c.text ?? "").join("\n");
	}

	async stop(): Promise<void> {
		await this.client?.close().catch(() => undefined);
		await this.server?.close().catch(() => undefined);
		this.client = undefined;
		this.server = undefined;
		// Remove the profile only if we made it — a caller-supplied dir belongs to
		// the caller. A best-effort pass now, ordered after the closes so the browser
		// has released its locks; the `exit` hook above is the pass that always runs,
		// and reaper.ts's startup sweep covers a process that was killed outright.
		if (this.ownedProfileDir) {
			removeProfileDir(this.ownedProfileDir);
			this.ownedProfileDir = undefined;
		}
	}
}
