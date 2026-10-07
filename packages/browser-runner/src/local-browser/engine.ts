/**
 * How a research run launches its CLI (#944): arguments, environment and prompt, per engine.
 *
 * The opposite of a coding session's launch. Coder starts its engines with every permission
 * (`--dangerously-skip-permissions`, `--sandbox danger-full-access`, `coding/handlers.ts`) because
 * it edits a repository; a research run must not be able to reach the web any way except through
 * the runner's policy bridge. So:
 *
 *  - Claude Code: `--tools ""` removes EVERY built-in tool (WebFetch, WebSearch, Bash, file edits),
 *    `--strict-mcp-config` loads only the bridge, `--allowedTools mcp__pags_browser` pre-approves
 *    it, and `--permission-mode dontAsk` refuses anything else without stopping to ask.
 *  - Codex: `--sandbox read-only` (its shell cannot write, and per Codex's sandbox design has no
 *    network), `--ignore-user-config` (no MCP servers or providers from the user's own config — auth
 *    still comes from the login), web search switched off, and the bridge as its only MCP server.
 *    `codex exec` runs with approval policy `never`, so an MCP tool that needs approval is simply
 *    refused — a live run on 2026-10-07 opened no page for exactly that reason (#952). The bridge is
 *    therefore pre-approved, and ONLY it: `default_tools_approval_mode="approve"` on the
 *    `pags_browser` server, and `enabled_tools` pinned to the bridge's own tool names
 *    (`BRIDGE_TOOL_NAMES`). Nothing else is approved — the shell stays read-only with no network,
 *    there is no other server — and the bridge still enforces sites, consent, limits and the
 *    research-only tool set in the runner, whatever the CLI is allowed to call.
 *    NOT VERIFIED END TO END on a live machine: that read-only shell commands get no network, and
 *    which of the two web-search keys a given Codex version honours. #947 holds that test.
 *
 * Neither ever gets a provider API key unless the owner chose `api-key`: subscription and machine
 * sign-in remove ANTHROPIC_API_KEY and OPENAI_API_KEY from the inherited environment (an empty
 * overlay value means remove — `mergeEnv`), because a key left in a developer's shell silently
 * turns a subscription run into per-token billing.
 */
import { mergeEnv } from "../coding/engine-env.js";
import { BRIDGE_TOOL_NAMES } from "./bridge.js";
import { resolveEngineAuth } from "../coding/engine-auth.js";
import type { LocalBrowserAuthMode, LocalBrowserEngine, LocalBrowserEngineAuth, LocalBrowserTaskEnvelope } from "./contract.js";

/** The bridge's MCP server name — and so the prefix of its tools inside the CLI. */
export const BRIDGE_SERVER_NAME = "pags_browser";

export interface BridgeLaunch {
	command: string;
	args: string[];
	env: Record<string, string>;
}

export interface EngineSpec {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	/** Claude reads its MCP config from this file; written by the runtime before the spawn. */
	mcpConfig?: { path: string; json: string };
}

const PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

/** The engine's environment: the machine's, minus provider keys unless the owner chose api-key. */
export function engineEnv(authMode: LocalBrowserAuthMode, engine: LocalBrowserEngine, toolTimeoutMs: number, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const overlay: Record<string, string> = {};
	if (authMode !== "api-key") for (const k of PROVIDER_KEYS) overlay[k] = "";
	// A consent or captcha pause holds the tool call open until the owner acts. Claude Code's
	// default MCP tool timeout would end that call long before; give it the run's own budget.
	if (engine === "claude") overlay.MCP_TOOL_TIMEOUT = String(toolTimeoutMs);
	return mergeEnv(base, overlay);
}

/** What the engine authenticates with, read from the env it is spawned with. */
export function observedEngineAuth(engine: LocalBrowserEngine, env: NodeJS.ProcessEnv): LocalBrowserEngineAuth {
	return resolveEngineAuth(engine, env as Record<string, string | undefined>);
}

const toml = (v: string) => JSON.stringify(v); // a TOML basic string accepts JSON's escapes

export function buildEngineSpec(input: {
	engine: LocalBrowserEngine;
	authMode: LocalBrowserAuthMode;
	prompt: string;
	bridge: BridgeLaunch;
	mcpConfigPath: string;
	toolTimeoutMs: number;
	baseEnv?: NodeJS.ProcessEnv;
}): EngineSpec {
	const env = engineEnv(input.authMode, input.engine, input.toolTimeoutMs, input.baseEnv);
	if (input.engine === "claude") {
		const json = JSON.stringify({ mcpServers: { [BRIDGE_SERVER_NAME]: { command: input.bridge.command, args: input.bridge.args, env: input.bridge.env } } });
		return {
			command: "claude",
			args: [
				"-p",
				input.prompt,
				"--output-format",
				"stream-json",
				"--verbose",
				"--tools",
				"",
				"--strict-mcp-config",
				"--mcp-config",
				input.mcpConfigPath,
				"--allowedTools",
				`mcp__${BRIDGE_SERVER_NAME}`,
				"--permission-mode",
				"dontAsk",
			],
			env,
			mcpConfig: { path: input.mcpConfigPath, json },
		};
	}
	const envTable = `{ ${Object.entries(input.bridge.env)
		.map(([k, v]) => `${k} = ${toml(v)}`)
		.join(", ")} }`;
	const key = `mcp_servers.${BRIDGE_SERVER_NAME}`;
	return {
		command: "codex",
		args: [
			"exec",
			"--json",
			"--skip-git-repo-check",
			"--sandbox",
			"read-only",
			"--ignore-user-config",
			"-c",
			`${key}.command=${toml(input.bridge.command)}`,
			"-c",
			`${key}.args=[${input.bridge.args.map(toml).join(", ")}]`,
			"-c",
			`${key}.env=${envTable}`,
			"-c",
			`${key}.tool_timeout_sec=${Math.ceil(input.toolTimeoutMs / 1000)}`,
			// Pre-approve the bridge, and only its own tools (#952); see the note atop this file.
			"-c",
			`${key}.default_tools_approval_mode="approve"`,
			"-c",
			`${key}.enabled_tools=[${BRIDGE_TOOL_NAMES.map(toml).join(", ")}]`,
			// Two spellings across Codex versions; an unknown key is ignored, so both are set.
			"-c",
			'web_search="disabled"',
			"-c",
			"tools.web_search=false",
			input.prompt,
		],
		env,
	};
}

/** The brief the CLI is given. The rules are restated, but the bridge is what enforces them. */
export function researchPrompt(e: Pick<LocalBrowserTaskEnvelope, "objective" | "policy" | "limits">): string {
	const t = (name: string) => `mcp__${BRIDGE_SERVER_NAME}__${name}`;
	const sites = e.policy.allowDomains.length ? `Stay on these sites: ${e.policy.allowDomains.join(", ")}.` : "Any public site may be visited; a site the owner has not approved pauses the run until they decide.";
	return [
		"You are doing read-only web research for the owner of this machine.",
		"",
		`Objective: ${e.objective}`,
		"",
		"How to work:",
		`- Your only tools are the browser tools from the ${BRIDGE_SERVER_NAME} server. Use ${t("browser_navigate")} to open pages (build search URLs with query parameters — you cannot type into pages), ${t("browser_snapshot")} to read them, and ${t("browser_click")} only for links, tabs and pagination.`,
		"- Never try to sign in, submit, apply, buy, post or message anything. Never work around a captcha, a login wall, a paywall or a block — report it.",
		`- ${sites}${e.policy.denyDomains.length ? ` Never visit: ${e.policy.denyDomains.join(", ")}.` : ""}`,
		`- Limits: ${e.limits.maxPages} pages, ${e.limits.maxActions} browser actions, ${e.limits.maxMinutes} minutes.`,
		`- For every result, call ${t("record_finding")} with the page URL and the exact text that supports it. For every source you could not read, call ${t("report_source_failure")}.`,
		`- When done, call ${t("finish_research")} with a short summary of what you found and what you could not reach, then stop.`,
	].join("\n");
}

const LOGIN_MISSING: Record<LocalBrowserEngine, RegExp> = {
	claude: /not logged in|please run \/login|invalid api key|oauth token (has )?expired|authentication_error/i,
	codex: /not logged in|run `?codex login|401 unauthorized|please log ?in|token (is )?expired/i,
};

/** Is this output the CLI saying it is not signed in? */
export function missingLogin(engine: LocalBrowserEngine, output: string): boolean {
	return LOGIN_MISSING[engine].test(output);
}

export function signInHelp(engine: LocalBrowserEngine): string {
	return engine === "claude"
		? "The Claude Code CLI on this machine is not signed in. Run `claude`, then /login, on that machine and start the run again."
		: "The Codex CLI on this machine is not signed in. Run `codex login` on that machine and start the run again.";
}

/** The CLI's own closing text, from its structured output — the summary when it never called finish_research. */
export function finalText(engine: LocalBrowserEngine, lines: readonly string[]): string {
	for (let i = lines.length - 1; i >= 0; i--) {
		let ev: Record<string, unknown>;
		try {
			ev = JSON.parse(lines[i]) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (engine === "claude" && ev.type === "result" && typeof ev.result === "string") return ev.result;
		const item = ev.item as Record<string, unknown> | undefined;
		if (engine === "codex" && ev.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") return item.text;
	}
	return "";
}
