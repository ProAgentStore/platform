// browser connector (#103) — a LOCAL connector reached over the runner relay (like tmux),
// bridging the runner's real-Chrome browser hands into the Tier-1 tool registry. A pure
// config/data agent can then drive a browser by DECLARING `capabilities.tools: [browser_*]`,
// instead of only via the Tier-0 workflow path (JobApplyWorkflow / BrowserTaskWorkflow). The
// runner hands are the SAME ones the apply workflow drives: POST /browser/snapshot (ARIA tree)
// + POST /browser/act (act by snapshot ref / ARIA role+name) — no CSS selectors.
//
// EXPERIMENTAL, first-party self-use ONLY. Gated behind env BROWSER_TOOLS_ENABLED (fail-closed
// when unset) per #103's trust requirement — this must NOT be opened to third-party creators
// (that stays blocked on the browser trust model, #75). Because a browser tool acts on the
// subscriber's real Chrome profile AS them, navigate + act are scope:"write", so runRegistryTool
// ALSO requires the instance's "browser" write-consent (#90); the read-only snapshot needs only
// the runner online.
//
// Known gap (documented in #103, deliberately NOT built here): this bounded chat-loop path has
// no captcha/stuck/needs_input handoff — that machinery lives on the durable workflow (#71).
// A snapshot that detects a challenge says so and stops rather than pretending to solve it. Long,
// handoff-heavy tasks belong on the workflow; this is for bounded, interactive ones.
import type { ToolDef, RegistryToolCtx } from "./types.js";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS, type RunnerConn } from "../runner-client.js";
import type { Env } from "../../types.js";
import { commitGuardSpec } from "../commit-guard.js";
import { requireSafeBrowserDispatch } from "../browser-action-dispatch.js";
import { browserWebsiteBlock, type BrowserWebsiteReply } from "../browser-website-access.js";
import { ensureWebsiteAccessRequest } from "../website-access.js";

/** Acting on a live page can take longer than a read (waits, navigation) — give it room. */
const ACT_TIMEOUT_MS = 30_000;

/** The action verbs the runner's /browser/act understands (mirror of BrowserAction.action). */
const ACTIONS = ["click", "type", "select", "check", "upload", "navigate", "scroll", "key", "wait"] as const;

/** Experimental gate: browser tools are inert unless the platform explicitly enables them. */
export function browserToolsEnabled(env: Env): boolean {
	return env.BROWSER_TOOLS_ENABLED === "1" || env.BROWSER_TOOLS_ENABLED === "true";
}

/** Resolve the live runner for this instance, or a helpful error string. */
async function resolveRunner(ctx: RegistryToolCtx): Promise<{ conn: RunnerConn } | { error: string }> {
	if (!browserToolsEnabled(ctx.env)) return { error: "Browser tools are experimental and not enabled on this platform." };
	if (!ctx.instanceId || !ctx.userId) return { error: "No instance context for the browser connector." };
	const conn = await getBoundRunnerConn(ctx.env, ctx.instanceId, ctx.userId).catch(() => null);
	if (!conn) return { error: "No runner is connected for this agent — run `pags up` on the machine whose browser you want to drive." };
	return { conn };
}

/** Chat uses the same declared agent policy as workflows, never a model-supplied override. */
async function actionPolicy(ctx: RegistryToolCtx, conn: RunnerConn): Promise<ReturnType<typeof commitGuardSpec> | undefined> {
	const row = await ctx.env.DB.prepare("SELECT a.config FROM agents a JOIN agent_instances i ON i.agent_id = a.id WHERE i.id = ?1 AND i.user_id = ?2")
		.bind(ctx.instanceId, ctx.userId).first<{ config: string }>();
	if (!row) throw new Error("The browser agent's policy is unavailable; no action was sent.");
	const config = JSON.parse(row.config || "{}") as { browserTask?: { readOnly?: boolean } };
	// This read also refuses access to a browser held by a workflow. Old runners must update
	// before chat can act; their old supported:true receipt did not cover alternate tools.
	const receipt = await callRunner(conn, "/browser/snapshot", {}, { timeoutMs: READ_TIMEOUT_MS });
	try { requireSafeBrowserDispatch(receipt as Parameters<typeof requireSafeBrowserDispatch>[0]); }
	catch { throw new Error("Browser actions require CLI 0.4.200 or newer. Update this runner before continuing."); }
	return config.browserTask?.readOnly === true ? commitGuardSpec("read_only") : undefined;
}

/** An owner question is a blocked tool result, not a successful navigation or model permission. */
async function websiteBlockResult(ctx: RegistryToolCtx, toolName: string, response: unknown) {
	const access = browserWebsiteBlock(response);
	if (!access) return null;
	if (access.decision === "deny") return { content: `Website access denied by this agent's settings: ${access.hostname}. No website permission was granted.`, success: false };
	const request = await ensureWebsiteAccessRequest(ctx.env, { userId: ctx.userId!, instanceId: ctx.instanceId!, subjectKind: "connector", subjectId: ctx.traceId ?? ctx.instanceId!, hostname: access.hostname, pauseKey: `${toolName}:${access.hostname}` });
	return { content: `Website access needs the owner's decision for ${access.hostname}: ${request.questionUrl}. The action did not complete successfully. After permission is granted, take a fresh snapshot and decide the next action; do not replay a previous click.`, success: false };
}

export const BROWSER_TOOLS: ToolDef[] = [
	{
		name: "browser_navigate",
		tier: "connector",
		connector: "browser",
		scope: "write",
		mutates: true,
		untrustedOutput: true,
		description:
			"Open a URL in the agent's real browser on the connected machine. WRITE: acts as the signed-in user. Follow with browser_snapshot to see the page.",
		jsonSchema: {
			type: "object",
			properties: { url: { type: "string", description: "The absolute URL to open." } },
			required: ["url"],
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const url = String(input.url ?? "").trim();
			if (!url) return { content: "A `url` is required.", success: false };
			const guard = await actionPolicy(ctx, r.conn);
			const res = await callRunner<BrowserWebsiteReply & { ok?: boolean; url?: string; title?: string }>(
				r.conn,
				"/browser/act",
				{ action: "navigate", url, ...(guard ? { guard } : {}) },
				{ timeoutMs: ACT_TIMEOUT_MS },
			);
			const websiteBlock = await websiteBlockResult(ctx, "browser_navigate", res);
			if (websiteBlock) return websiteBlock;
			if (res.ok === false) return { content: "The browser did not complete this navigation.", success: false };
			// `res.url` is where the page ACTUALLY landed (redirects follow the site's choice) and
			// `res.title` is written by the site. "Navigated to:" is ours and stays in the head.
			return {
				head: "Navigated to:",
				content: `${res.url ?? url}${res.title ? ` — ${res.title}` : ""}`,
				success: true,
				origin: `the page at ${res.url ?? url}`,
			};
		},
	},
	{
		name: "browser_snapshot",
		tier: "connector",
		connector: "browser",
		scope: "read",
		mutates: false,
		untrustedOutput: true,
		description:
			"Read the current page as an accessibility (ARIA) tree with stable element refs (e.g. [ref=e42]) — what the agent 'sees'. Use those refs with browser_act. Returns the url, title, and the snapshot; flags a captcha/login challenge when one is detected (which this bounded tool cannot solve).",
		jsonSchema: { type: "object", properties: {} },
		handler: async (ctx) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const res = await callRunner<BrowserWebsiteReply & { url: string; title: string; snapshot: string; challenge: string | null; truncated: boolean }>(
				r.conn,
				"/browser/snapshot",
				{},
				{ timeoutMs: READ_TIMEOUT_MS },
			);
			const websiteBlock = await websiteBlockResult(ctx, "browser_snapshot", res);
			if (websiteBlock) return websiteBlock;
			// The challenge warning and the truncation note are OURS — head, outside the fence. The
			// url/title/snapshot are the page's own bytes and go inside it.
			if (res.challenge) {
				return {
					head: `⚠️ A "${res.challenge}" challenge is on the page. This bounded browser tool can't solve captchas/2FA — that needs the workflow path.`,
					content: `URL: ${res.url}\n\n${res.snapshot}`,
					success: true,
					origin: `the page at ${res.url}`,
				};
			}
			return {
				...(res.truncated ? { head: "(snapshot truncated)" } : {}),
				content: `URL: ${res.url}\nTitle: ${res.title}\n\n${res.snapshot}`,
				success: true,
				origin: `the page at ${res.url}`,
			};
		},
	},
	{
		name: "browser_act",
		tier: "connector",
		connector: "browser",
		scope: "write",
		mutates: true,
		untrustedOutput: true,
		description:
			"Perform ONE action on the current page, targeting an element by its snapshot ref (preferred) or ARIA role + accessible name. WRITE: acts as the signed-in user. Take a browser_snapshot first to get refs, act, then snapshot again to see the result.",
		jsonSchema: {
			type: "object",
			properties: {
				action: { type: "string", description: "One of: click | type | select | check | upload | navigate | scroll | key | wait." },
				ref: { type: "string", description: 'Stable element ref from the snapshot (e.g. "e42"). Preferred over role+name.' },
				role: { type: "string", description: "ARIA role of the target (e.g. textbox, button, link, combobox) — used with name when no ref." },
				name: { type: "string", description: "Accessible name of the target element (from the snapshot)." },
				text: { type: "string", description: "Text to type (action: type) or option label (action: select)." },
				url: { type: "string", description: "Destination URL (action: navigate)." },
				key: { type: "string", description: "Key to press (action: key), e.g. Enter, Tab, Escape." },
				nth: { type: "number", description: "Disambiguate when role+name match several elements (default: first)." },
				dy: { type: "number", description: "Pixels to scroll vertically (action: scroll, default 600)." },
			},
			required: ["action"],
		},
		handler: async (ctx, input) => {
			const r = await resolveRunner(ctx);
			if ("error" in r) return { content: r.error, success: false };
			const action = String(input.action ?? "").trim();
			if (!(ACTIONS as readonly string[]).includes(action)) {
				return { content: `Unknown action "${action}". Use one of: ${ACTIONS.join(", ")}.`, success: false };
			}
			const guard = await actionPolicy(ctx, r.conn);
			const res = await callRunner<BrowserWebsiteReply & { ok: boolean; url: string; title: string; challenge: string | null; feedback?: string }>(
				r.conn,
				"/browser/act",
				{ action, ref: input.ref, role: input.role, name: input.name, text: input.text, url: input.url, key: input.key, nth: input.nth, dy: input.dy, ...(guard ? { guard } : {}) },
				{ timeoutMs: ACT_TIMEOUT_MS },
			);
			const websiteBlock = await websiteBlockResult(ctx, "browser_act", res);
			if (websiteBlock) return websiteBlock;
			// `res.feedback` is composed on the machine from what the PAGE reported back (element
			// names, error text), so it is not ours even though it reads like a status line. The
			// challenge warning IS ours.
			const parts = [res.feedback || `Did ${action}${input.name ? ` on "${input.name}"` : ""}.`];
			if (res.url) parts.push(`Now at ${res.url}.`);
			return {
				content: parts.join(" "),
				success: res.ok !== false,
				...(res.challenge ? { tail: `⚠️ challenge detected: ${res.challenge} — needs the workflow path to solve.` } : {}),
				origin: res.url ? `the page at ${res.url}` : "the page in the browser on your machine",
			};
		},
	},
];
