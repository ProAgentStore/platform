// Engine presets and sign-in for a coding session — which CLI a session launches, and how it
// authenticates.
//
// Extracted from routes/coding.ts (#136-adjacent). The workflow imported `resolveEngineEnv`
// FROM the routes module, which lib/delegation.ts explicitly documents the codebase avoiding
// ("kept in lib/ so the workflow doesn't import a routes module"). That was not just a style
// point: it dragged the entire 1500-line Hono router, and everything it imports, into the
// workflow's dependency graph.
//
// Pure move — no behaviour changed.

import { getUserProviderKey } from "./user-ai.js";
import type { CodingClientType, CodingSessionRecord } from "./coding-types.js";
import type { Env } from "../types.js";

/**
 * Build the env the runner injects into the engine process from the preset's
 * sign-in method (see {@link EngineAuth}). "auto" NEVER injects an API key — a
 * key stored for other features (e.g. the openai key powering Whisper voice)
 * must not silently switch an engine from subscription to per-token billing.
 */
export async function resolveEngineEnv(
	env: Env,
	instanceId: string,
	uid: string,
	session: CodingSessionRecord,
): Promise<Record<string, string> | undefined> {
	const { engines } = await readEngines(env, instanceId, uid);
	const auth = engineAuthFor(engines, session.launchCommand);
	if (auth === "machine") return undefined;
	if (auth === "api-key") {
		const spec = ENGINE_API_KEYS[session.clientType];
		const key = spec ? await getUserProviderKey(env, uid, spec.provider) : null;
		return key ? { [spec.envVar]: key } : undefined;
	}
	// "subscription" | "auto" — the stored `claude setup-token`. Only Claude has a
	// subscription token env; for other engines these modes mean the machine login.
	if (session.clientType !== "claude") return undefined;
	const token = await getUserProviderKey(env, uid, "claude-code");
	return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : undefined;
}

const CLIENTS: CodingClientType[] = ["claude", "gemini", "codex", "grok"];
export function asClient(v: unknown): CodingClientType {
	return CLIENTS.includes(v as CodingClientType) ? (v as CodingClientType) : "claude";
}

/** Command wrappers to skip when finding the real engine binary in a launch command. */
const COMMAND_LAUNCHERS = new Set(["npx", "bunx", "pnpm", "yarn", "npm", "bun", "env", "exec", "dlx", "run", "sudo", "time"]);

/**
 * Derive the engine client type from a launch command's real binary — skipping
 * `FOO=bar` env prefixes and wrappers like `npx`/`bunx`/`env`. This decides whether
 * the runner uses the structured Claude engine (claude) or runs the CLI raw (else).
 * An unknown binary maps to "codex" so it runs RAW, not mis-driven as Claude.
 */
export function deriveClientType(command: string): CodingClientType {
	for (const t of command.trim().split(/\s+/)) {
		if (!t || t.includes("=") || t.startsWith("-")) continue;
		const base = (t.split("/").pop() || "").toLowerCase();
		if (COMMAND_LAUNCHERS.has(base)) continue;
		if (base === "claude" || base.startsWith("claude")) return "claude";
		if (base.startsWith("gemini")) return "gemini";
		if (base.startsWith("grok")) return "grok";
		if (base.startsWith("codex")) return "codex";
		return "codex"; // an unknown binary → run it raw (NOT as Claude stream-json)
	}
	return "claude";
}

/**
 * How a session's engine signs in, chosen per engine preset:
 *  - "auto"         — the stored `claude setup-token` when saved (Claude only), else the machine's own login
 *  - "machine"      — never inject anything; the CLI uses the runner machine's login
 *  - "subscription" — the stored `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN; Claude only)
 *  - "api-key"      — the engine's provider API key from the vault (ANTHROPIC/OPENAI/GEMINI/XAI_API_KEY)
 */
export type EngineAuth = "auto" | "machine" | "subscription" | "api-key";
export const ENGINE_AUTHS = new Set<EngineAuth>(["auto", "machine", "subscription", "api-key"]);

/** An engine preset = a named CLI launch command the user can pick per session. */
export interface CodingEngine {
	id: string;
	label: string;
	command: string;
	auth?: EngineAuth;
}

/** The env var + vault provider an engine's "api-key" auth mode injects. */
const ENGINE_API_KEYS: Record<CodingClientType, { envVar: string; provider: string }> = {
	claude: { envVar: "ANTHROPIC_API_KEY", provider: "anthropic" },
	gemini: { envVar: "GEMINI_API_KEY", provider: "google" },
	codex: { envVar: "OPENAI_API_KEY", provider: "openai" },
	grok: { envVar: "XAI_API_KEY", provider: "xai" },
};

/**
 * The sign-in method for a session — sessions persist the launch command, not the
 * preset id, so match it back to a preset. An edited preset applies on the next
 * start/Restart; a command with no matching preset falls back to "auto".
 */
export function engineAuthFor(engines: CodingEngine[], launchCommand: string | null | undefined): EngineAuth {
	const eng = launchCommand ? engines.find((e) => e.command === launchCommand) : undefined;
	return eng?.auth && ENGINE_AUTHS.has(eng.auth) ? eng.auth : "auto";
}

/**
 * The default engine presets, seeded when an instance has none. Claude is the
 * first-class engine (structured stream-json); the others run as a real CLI the
 * user configures. Users edit these (add flags, keys, models, more engines) and
 * the per-session choice picks one.
 */
const DEFAULT_ENGINES: CodingEngine[] = [
	{ id: "claude", label: "Claude Code", command: "claude --dangerously-skip-permissions" },
	{ id: "gemini", label: "Gemini CLI", command: "gemini" },
	{ id: "codex", label: "Codex", command: "codex" },
	{ id: "grok", label: "Grok", command: "grok" },
];

/** Read the instance's engine presets (seeded defaults when unset). */
export async function readEngines(env: Env, instanceId: string, userId: string): Promise<{ engines: CodingEngine[]; defaultEngineId: string }> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ config: string }>();
	let cfg: { codingEngines?: CodingEngine[]; defaultEngineId?: string } = {};
	try {
		cfg = JSON.parse(row?.config || "{}");
	} catch {
		/* fall through to defaults */
	}
	// Only keep well-formed presets (a hand-edited config must not crash resolveEngine).
	const valid = Array.isArray(cfg.codingEngines)
		? cfg.codingEngines.filter((e) => e && typeof e.id === "string" && typeof e.label === "string" && typeof e.command === "string")
		: [];
	const engines = valid.length ? valid : DEFAULT_ENGINES;
	const defaultEngineId = cfg.defaultEngineId && engines.some((e) => e.id === cfg.defaultEngineId) ? cfg.defaultEngineId : engines[0].id;
	return { engines, defaultEngineId };
}

/** The launch command + derived client type for an engine id (falls back to the default engine). */
export async function resolveEngine(env: Env, instanceId: string, userId: string, engineId: unknown): Promise<{ command: string; clientType: CodingClientType }> {
	const { engines, defaultEngineId } = await readEngines(env, instanceId, userId);
	const eng = engines.find((e) => e.id === engineId) ?? engines.find((e) => e.id === defaultEngineId) ?? engines[0];
	// Derive the client type from the command's real binary, so the runner knows
	// whether to use the structured Claude engine or run the CLI raw.
	return { command: eng.command, clientType: deriveClientType(eng.command) };
}
