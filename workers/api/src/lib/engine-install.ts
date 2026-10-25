import type { CodingClientType } from "./coding-types.js";

/**
 * Putting a coding CLI on a runner machine from anywhere (#1156).
 *
 * The preflight (engine-preflight.ts) says what is missing and which command fixes it; this runs that command on the
 * machine, so an owner on a phone can do what used to need a terminal at the Mac mini. Like the sign-in relay it is built on
 * the runner's existing `/tmux/*` endpoints (so it works on runners already in the field) and it is FIXED: the caller picks the
 * engine, never the command. The installers are the vendors' own — xAI's script for Grok (a native binary in ~/.grok/bin, not an
 * npm package), `npm i -g` for the others — the same commands the preflight tells a person to run.
 */
export const INSTALL_CLIENTS: readonly CodingClientType[] = ["claude", "codex", "gemini", "grok"];

interface InstallPlan {
	/** What is run, for the answer and the audit — the whole command, never assembled from caller input. */
	command: string;
	what: string;
}

const PLANS: Record<string, InstallPlan> = {
	grok: { command: "curl -fsSL https://x.ai/cli/install.sh | bash", what: "xAI's Grok CLI, from xAI's own installer (a native binary in ~/.grok/bin)" },
	claude: { command: "npm i -g @anthropic-ai/claude-code", what: "Claude Code, from npm" },
	codex: { command: "npm i -g @openai/codex", what: "Codex, from npm" },
	gemini: { command: "npm i -g @google/gemini-cli", what: "Gemini CLI, from npm" },
};

export const installSessionName = (clientType: CodingClientType): string => `pags-install-${clientType}`;

export function planInstall(clientType: unknown): { ok: true; clientType: CodingClientType; command: string; what: string; typed: string } | { ok: false; reason: string } {
	const plan = typeof clientType === "string" ? PLANS[clientType] : undefined;
	if (!plan) return { ok: false, reason: `\`clientType\` must be one of: ${INSTALL_CLIENTS.join(", ")}.` };
	// The exit status is written after the installer so the pane says how it ended; `$?` is in the typed line only, so the
	// echoed command does not match {@link readInstallPane}'s digits.
	return { ok: true, clientType: clientType as CodingClientType, command: plan.command, what: plan.what, typed: `( ${plan.command} ); echo "PAGS_INSTALL_EXIT=$?"` };
}

export type InstallReading = { state: "running" } | { state: "succeeded"; exitCode: 0 } | { state: "failed"; exitCode: number };

/** Where the install is, from its terminal: finished only once the exit line is printed. */
export function readInstallPane(pane: string): InstallReading {
	const hit = [...pane.matchAll(/^PAGS_INSTALL_EXIT=(\d+)\s*$/gm)].at(-1);
	if (!hit) return { state: "running" };
	const code = Number(hit[1]);
	return code === 0 ? { state: "succeeded", exitCode: 0 } : { state: "failed", exitCode: code };
}
