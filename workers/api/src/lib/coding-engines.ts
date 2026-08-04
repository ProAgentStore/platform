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
	// An inherited provider key is NOT "the machine's login" — it is per-token billing wearing
	// the machine's clothes. Every mode except "api-key" therefore REMOVES it (empty value =
	// remove, see the runner's mergeEnv), so a developer with ANTHROPIC_API_KEY exported in
	// their shell does not silently pay per token for an engine they asked to run on their
	// subscription. This is the whole point of the modes existing; before it, all four behaved
	// identically whenever the shell had a key.
	const providerKeyEnv = ENGINE_API_KEYS[session.clientType]?.envVar;
	const stripProviderKey = providerKeyEnv ? { [providerKeyEnv]: "" } : {};

	if (auth === "machine") return providerKeyEnv ? stripProviderKey : undefined;
	if (auth === "api-key") {
		const spec = ENGINE_API_KEYS[session.clientType];
		const key = spec ? await getUserProviderKey(env, uid, spec.provider) : null;
		return key ? { [spec.envVar]: key } : undefined;
	}
	// "subscription" | "auto" — the stored `claude setup-token`. Only Claude has a
	// subscription token env; for other engines these modes mean the machine login.
	if (session.clientType !== "claude") return providerKeyEnv ? stripProviderKey : undefined;
	const token = await getUserProviderKey(env, uid, "claude-code");
	// No stored setup-token → fall through to the machine's OWN login (the claude.ai session in
	// the keychain), which is what "auto" promises. Still strip the API key: inheriting it is
	// what turned "auto" into per-token billing.
	if (!token) return stripProviderKey;
	// The runner spawns the CLI with `{...process.env, ...thisEnv}`, so a machine that exports
	// ANTHROPIC_API_KEY hands the engine an API key — and Claude Code prefers it over the
	// subscription token. Injecting CLAUDE_CODE_OAUTH_TOKEN alone therefore did NOTHING: picking
	// "subscription" still billed per token, silently, which is the exact outcome the comment
	// above says must not happen. An empty value means REMOVE (see the runner), so the choice
	// the user made actually decides how their engine bills.
	return { CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_API_KEY: "" };
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
 *
 * Two rules every preset here has to satisfy:
 *
 * 1. **Non-interactive.** Everything but Claude runs ONE-SHOT: the command is a prefix and the
 *    turn text is appended as the final argument. A bare `codex`/`gemini`/`grok` launches a TUI,
 *    which dies instantly with "stdin is not a terminal" — headless mode has no PTY (that is what
 *    tmux used to provide).
 * 2. **Allowed to write.** Every one of these CLIs defaults to a read-only/ask-first posture when
 *    run non-interactively, and with no TTY there is nobody to ask. `codex exec` shipped without
 *    a `--sandbox` flag, so it inherited `sandbox: read-only`: the engine could explore a repo and
 *    answer questions but could not edit a file or even `git pull` (it failed on
 *    `cannot open '.git/FETCH_HEAD': Operation not permitted`). It looked like a thoughtful agent
 *    that just never got around to fixing anything. Claude's preset has carried
 *    `--dangerously-skip-permissions` from the start, so an engine WITHOUT its equivalent flag
 *    silently changes what the agent can do when you switch engines — the trust level has to match
 *    across presets or the choice is a trap. {@link ENGINE_WRITE_FLAGS} names the flag per engine.
 *
 * These are defaults, not policy: the presets are editable per instance (console → ⚙ CLI engines,
 * or `PUT /v1/instances/:id/coding/engines`), and every token here reaches the engine verbatim, so
 * narrowing to `--sandbox workspace-write` — or adding `--model`, `-c`, anything else — is a
 * config change, not a code change. See `docs/coding-engines.md`.
 */
export const DEFAULT_ENGINES: CodingEngine[] = [
	// Claude is the one PERSISTENT engine (structured stream-json, multi-turn).
	{ id: "claude", label: "Claude Code", command: "claude --dangerously-skip-permissions" },
	{ id: "codex", label: "Codex", command: "codex exec --sandbox danger-full-access" },
	// `--skip-trust` is not optional alongside yolo: without it Gemini prints
	// "Approval mode overridden to \"default\" because the current folder is not trusted" and
	// goes back to asking — in a headless run, with nobody to ask. Verified live.
	{ id: "gemini", label: "Gemini CLI", command: "gemini --approval-mode yolo --skip-trust --prompt", auth: "api-key" },
	// `-p/--single`, NOT `--prompt`: grok has `--prompt-file` and `--prompt-json` but no
	// `--prompt`, so the old preset died on an unknown/ambiguous flag before reaching the model.
	{ id: "grok", label: "Grok", command: "grok --permission-mode bypassPermissions -p" },
	// Bring your own — a local model costs nothing per token and needs no cloud key. The prompt
	// is appended, so anything prompt-in/text-out works by editing this command.
	{ id: "local", label: "Local model (Ollama)", command: "ollama run llama3", auth: "machine" },
];

/**
 * The flag that lets each engine actually change files, per CLI. Not used to BUILD a command —
 * a preset is free-text and the user owns it — but to assert that no shipped default forgets one,
 * and to explain the choice in one place.
 */
export const ENGINE_WRITE_FLAGS: Record<CodingClientType, string[]> = {
	// `--sandbox danger-full-access` rather than `workspace-write`: workspace-write also blocks
	// network, so `git pull`, `pnpm install` and `gh pr create` — the ordinary work of a coding
	// agent — would still fail, just less obviously.
	codex: ["--sandbox danger-full-access", "--dangerously-bypass-approvals-and-sandbox", "--sandbox workspace-write"],
	gemini: ["--approval-mode yolo", "--approval-mode auto_edit", "--yolo", "-y"],
	grok: ["--permission-mode bypassPermissions", "--permission-mode acceptEdits", "--permission-mode auto", "--always-approve"],
	claude: ["--dangerously-skip-permissions", "--permission-mode acceptEdits"],
};

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
