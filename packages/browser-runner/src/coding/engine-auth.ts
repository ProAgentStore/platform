// What credential the engine process ACTUALLY got — read off the merged env, on the machine
// where the merge happens (#248).
//
// The platform decides an engine's sign-in MODE (auto / machine / subscription / api-key) in the
// cloud, but the mode is only half an answer: the runner spawns the CLI with
// `{...process.env, ...overlay}`, so the outcome also depends on what the user's shell exports —
// which the cloud cannot see. "Which credential am I actually billing?" was therefore
// unanswerable from any surface, and the one time it went wrong it went wrong SILENTLY: a shell
// `ANTHROPIC_API_KEY` beat the injected subscription token, so picking "subscription" billed per
// token anyway (see the note on `mergeEnv`).
//
// This module derives the answer from the same env the process is spawned with, so the report is
// an observation, never a restatement of the setting.
//
// **Presence only, never values.** Nothing here returns, logs or echoes a key or token — the
// caller gets an enum. This is a transparency feature, not a credential channel.

import type { ClientType } from "./handlers.js";

/**
 * The credential an engine process actually ran on:
 *  - "api-key"       — a per-token provider key was in the env (this is what costs per call)
 *  - "subscription"  — a subscription OAuth token, and no API key to override it
 *  - "machine-login" — neither; the CLI uses whatever login it has stored on the machine
 */
export type EngineAuthResolved = "subscription" | "api-key" | "machine-login";

/**
 * The env var each engine reads a PER-TOKEN API key from. Deliberately duplicated from the
 * cloud's `ENGINE_API_KEYS` (workers/api/src/lib/coding-engines.ts) rather than imported: the
 * runner ships inside the published CLI and does not depend on the API worker — vendoring is the
 * house rule for shared constants across packages.
 */
const API_KEY_ENV: Partial<Record<ClientType, string>> = {
	claude: "ANTHROPIC_API_KEY",
	gemini: "GEMINI_API_KEY",
	codex: "OPENAI_API_KEY",
	grok: "XAI_API_KEY",
};

/**
 * The env var holding a SUBSCRIPTION token. Only Claude Code has one — for every other engine
 * "subscription" and "machine" both mean the machine's own login, so there is nothing to detect.
 */
const SUBSCRIPTION_ENV: Partial<Record<ClientType, string>> = {
	claude: "CLAUDE_CODE_OAUTH_TOKEN",
};

/** A var counts as set only when it holds something. `mergeEnv` deletes on empty, but an
 *  inherited `FOO=` from the shell is present-and-empty and means "no credential", not one. */
function has(env: Record<string, string | undefined>, name: string | undefined): boolean {
	return !!name && !!env[name] && env[name]!.trim() !== "";
}

/**
 * Derive what the engine actually authenticates with from its merged spawn env.
 *
 * API key wins over the subscription token because that is what the CLI itself does — Claude Code
 * prefers `ANTHROPIC_API_KEY` over `CLAUDE_CODE_OAUTH_TOKEN`. Reporting "subscription" whenever a
 * token happened to be present would reproduce the exact illusion this exists to dispel: the
 * setting said subscription, the bill said per-token.
 */
export function resolveEngineAuth(clientType: ClientType, env: Record<string, string | undefined>): EngineAuthResolved {
	if (has(env, API_KEY_ENV[clientType])) return "api-key";
	if (has(env, SUBSCRIPTION_ENV[clientType])) return "subscription";
	return "machine-login";
}
