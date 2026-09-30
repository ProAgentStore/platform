// Re-authenticating a coding engine from anywhere — the pure half (#881).
//
// ── The problem
//
// Coding runs stalled on "Not logged in · Please run /login" and waited 15 minutes for a takeover
// nobody could perform: the engine's login is interactive and lives on the RUNNER, and every remote
// tool assumed the CLI was already signed in. The only recovery was sitting at the machine.
//
// ── Why this cannot just forward the engine's sign-in URL
//
// Both CLIs' DEFAULT login is a loopback OAuth redirect to 127.0.0.1 on the runner (see
// `engine-auth-prompt.ts`), so a URL opened on the owner's phone redirects to the phone's own
// localhost. Each engine also ships a flow that was built for exactly this situation, and those are
// what the relay drives:
//
//   * Claude — the PASTE-CODE flow. The CLI prints an authorize URL whose redirect is Anthropic's
//     own callback page, which shows a code; the CLI waits at "Paste code here". The owner opens the
//     URL on any device and the code is relayed back into the waiting CLI.
//   * Codex — the DEVICE-CODE flow (`codex login --device-auth`). The CLI prints a URL and a
//     one-time code; the owner enters the code on any device. Nothing needs relaying back.
//
// Both are SUBSCRIPTION logins (claude.ai / ChatGPT accounts). This module never plans an API-key
// sign-in, never selects a Console/API-billing option in a menu, and strips inherited provider keys
// from the login process so the CLI cannot silently prefer one.
//
// ── Where the login has to LAND (#867)
//
// A login the engine does not read fixes nothing — #867 was exactly that: a fresh interactive
// `/login` on the machine, and every spawned engine still failing on a stale exported token. Which
// credential the engine reads is decided by `resolveEngineEnv` (coding-engines.ts), so the plan is
// derived from the same inputs:
//
//   * Claude, `auto`/`subscription`, a platform-stored `claude-code` token → the engine is spawned
//     WITH that token (CLAUDE_CODE_OAUTH_TOKEN), which beats any machine login. A machine `/login`
//     would land where nothing reads it. So the relay runs `claude setup-token` and REPLACES the
//     stored token with the fresh one.
//   * Claude, `auto`/`subscription`, no stored token → the engine is spawned with
//     CLAUDE_CODE_OAUTH_TOKEN stripped and reads the machine's own login. The relay runs `/login`.
//   * Claude, `machine` → whatever the machine holds, an exported token included. The relay runs
//     `/login`, and when the runner reported the engine resolving a token from its environment
//     (`authResolved: "subscription"`), says plainly that the exported token will still win.
//   * Codex → Codex's own auth store, which the engine reads because the platform strips
//     OPENAI_API_KEY in every mode but `api-key`.
//
// Pure: every decision here is testable without a runner, a relay or a CLI.

import { isAuthUrl } from "./engine-auth-prompt.js";
import type { CodingClientType } from "./coding-types.js";
import type { EngineAuth } from "./coding-engines.js";
import type { EngineAuthResolved } from "./usage-payer.js";

/** How the relay signs an engine in. Each one is a subscription login. */
export type ReauthMethod = "claude-login" | "claude-setup-token" | "codex-device-auth";

export type ReauthPlan =
	| {
			ok: true;
			method: ReauthMethod;
			/** The exact command the relay runs on the runner, in a dedicated tmux session. */
			command: string;
			/** Where the credential lands, and why that is where the engine reads it. */
			lands: string;
			/** Set when something on the machine will still beat this login. */
			warning: string | null;
	  }
	| { ok: false; reason: string };

/** The dedicated tmux session a relay runs in — one per engine, never a coding session's. */
export function reauthSessionName(clientType: CodingClientType): string {
	return `pags-signin-${clientType}`;
}

/** Inherited provider keys removed from the LOGIN process, so the CLI cannot choose one over the login. */
const STRIP_FOR_LOGIN: Partial<Record<CodingClientType, string[]>> = {
	claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
	codex: ["OPENAI_API_KEY"],
};

function withStripped(clientType: CodingClientType, command: string): string {
	const vars = STRIP_FOR_LOGIN[clientType] ?? [];
	return vars.length ? `env ${vars.map((v) => `-u ${v}`).join(" ")} ${command}` : command;
}

export function planReauth(input: {
	clientType: CodingClientType;
	auth: EngineAuth;
	/** Does the platform hold a `claude-code` token for this owner? Presence only. */
	hasStoredClaudeToken: boolean;
	/** What the runner last reported the engine actually resolved (#248), when known. */
	authResolved?: EngineAuthResolved | null;
}): ReauthPlan {
	const { clientType, auth } = input;
	if (auth === "api-key") {
		return {
			ok: false,
			reason:
				"This engine is set to API-key sign-in. The re-auth relay performs subscription login only — switch the engine's sign-in to `auto` or `subscription` first.",
		};
	}
	if (clientType === "codex") {
		return {
			ok: true,
			method: "codex-device-auth",
			command: withStripped("codex", "codex login --device-auth"),
			lands:
				"Codex's own login store on the runner (~/.codex), which the engine reads — the platform strips OPENAI_API_KEY from the engine in this mode, so the login is authoritative.",
			warning: null,
		};
	}
	if (clientType !== "claude") {
		return { ok: false, reason: `The re-auth relay supports the Claude and Codex engines; ${clientType} has to be signed in on the machine.` };
	}
	if (auth !== "machine" && input.hasStoredClaudeToken) {
		return {
			ok: true,
			method: "claude-setup-token",
			command: withStripped("claude", "claude setup-token"),
			lands:
				"The platform-stored Claude Code token, which is replaced with the fresh one. The engine is spawned with that token (CLAUDE_CODE_OAUTH_TOKEN), so a machine /login would be shadowed by it — this is the credential the engine actually reads.",
			warning: null,
		};
	}
	return {
		ok: true,
		method: "claude-login",
		command: withStripped("claude", "claude /login"),
		lands:
			auth === "machine"
				? "The machine's own Claude login (keychain / ~/.claude), which a `machine`-mode engine uses unless the runner's environment exports a token."
				: "The machine's own Claude login (keychain / ~/.claude). In this mode the platform strips any inherited CLAUDE_CODE_OAUTH_TOKEN from the engine (#867), so this is the login it reads.",
		warning:
			auth === "machine" && input.authResolved === "subscription"
				? "The runner reported this engine picking up CLAUDE_CODE_OAUTH_TOKEN from its environment. In `machine` mode that exported token beats this login — switch the engine's sign-in to `auto`, or unset the variable where `pags up` starts."
				: null,
	};
}

// ── Reading the login pane ──────────────────────────────────────────────────

export type ReauthPaneState =
	/** A login-method menu is showing. */
	| "menu"
	/** The CLI printed an authorize URL and is waiting for the code from its callback page. */
	| "awaiting_code"
	/** A device code is showing; the owner enters it at the URL, nothing is relayed back. */
	| "device_code"
	/** The login finished. */
	| "succeeded"
	/** The CLI reported the login failed. */
	| "failed"
	/** Nothing conclusive yet — the CLI is starting or working. */
	| "working";

export interface ReauthPaneReading {
	state: ReauthPaneState;
	/** The sign-in URL to open on ANY device — only an https URL on a known sign-in host. */
	url: string | null;
	/** The one-time code to enter at `url` (device-code flow). */
	deviceCode: string | null;
}

/** Characters a URL or token can wrap onto the next pane line with. No spaces. */
const WRAP_CONTINUATION = /^[A-Za-z0-9%&=_.~:/?#+-]+$/;

/**
 * Rejoin the long lines a terminal hard-wrapped. An authorize URL is 300+ characters and the pane is
 * 200 wide, so reading it line by line yields a truncated URL that fails OAuth with no explanation.
 * A line is joined to the previous one only when it is a single unbroken run of URL characters AND
 * the previous line ended inside a URL or token — never an ordinary line of prose.
 */
export function unwrapPane(pane: string): string {
	const out: string[] = [];
	for (const raw of (pane || "").split("\n")) {
		const line = raw.trimEnd();
		const prev = out[out.length - 1];
		if (prev !== undefined && line && WRAP_CONTINUATION.test(line) && /(https?:\/\/\S+|sk-ant-\S+)$/.test(prev)) {
			out[out.length - 1] = prev + line;
		} else {
			out.push(line);
		}
	}
	return out.join("\n");
}

const URL_RE = /https:\/\/[^\s"'`)<>\]]+/g;
const DEVICE_CODE_RE = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/;
const SETUP_TOKEN_RE = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/;
const SUCCESS_RE = /login successful|logged in successfully|successfully logged in|you are now logged in/i;
const FAILED_RE = /\b(login failed|failed to (?:log|sign) in|authentication failed|oauth error|invalid (?:code|grant)|code (?:has )?expired)\b/i;
const MENU_RE = /select login method|how would you like to authenticate|choose (?:a|your) (?:login|sign-in) method/i;

/** Read what the login CLI is showing. Pure; `method` decides what "done" looks like. */
export function readReauthPane(pane: string, method: ReauthMethod): ReauthPaneReading {
	const text = unwrapPane(pane);
	const url = (text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?'")\]]+$/, "")).find(isAuthUrl) ?? null;
	const deviceCode = method === "codex-device-auth" ? (DEVICE_CODE_RE.exec(text)?.[1] ?? null) : null;
	const succeeded = method === "claude-setup-token" ? SETUP_TOKEN_RE.test(text) : SUCCESS_RE.test(text);
	let state: ReauthPaneState;
	if (succeeded) state = "succeeded";
	else if (FAILED_RE.test(text)) state = "failed";
	else if (deviceCode && url) state = "device_code";
	else if (url && /paste (?:the )?code/i.test(text)) state = "awaiting_code";
	else if (MENU_RE.test(text)) state = "menu";
	else state = "working";
	return { state, url, deviceCode };
}

/**
 * The menu number of the SUBSCRIPTION login option, when the CLI is showing its login-method menu.
 *
 * Claude asks "Claude account with subscription" vs "Anthropic Console account" (API billing) vs
 * third-party platforms. The relay may pick the subscription option on the owner's behalf — that is
 * the only sign-in this platform supports — and must never pick any other, so a menu whose
 * subscription option it cannot identify is left for the owner to drive.
 */
export function subscriptionMenuChoice(pane: string): string | null {
	for (const line of (pane || "").split("\n")) {
		const m = /^\s*(?:[❯>›]\s*)?(\d)\.\s+(.*)$/.exec(line);
		if (m && /subscription/i.test(m[2]) && !/console|api (?:usage|billing)/i.test(m[2])) return m[1];
	}
	return null;
}

/**
 * The fresh token `claude setup-token` printed, for storing — server-side only.
 *
 * Never returned to a caller: every pane that leaves the platform goes through {@link redactPane}.
 */
export function extractSetupToken(pane: string): string | null {
	return SETUP_TOKEN_RE.exec(unwrapPane(pane))?.[0] ?? null;
}

/** The pane as it may be shown to a caller — unwrapped, with any Anthropic token masked. */
export function redactPane(pane: string): string {
	return unwrapPane(pane).replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…[redacted]");
}

/**
 * What a caller may type into the login session: the pasted code, or a menu keystroke.
 * Returns an error sentence, or null when acceptable. Deliberately small — this reaches a live CLI.
 */
export const REAUTH_KEYS = ["Enter", "Up", "Down", "Escape"] as const;
export function reauthInputError(input: { text?: unknown; keys?: unknown }): string | null {
	const { text, keys } = input;
	if (text == null && keys == null) return "Send `text` (the code from the sign-in page) and/or `keys`.";
	if (text != null) {
		if (typeof text !== "string" || !text.trim()) return "`text` must be a non-empty string.";
		if (text.length > 512) return "`text` is too long for a sign-in code.";
		// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
		if (/[\u0000-\u001f\u007f]/.test(text)) return "`text` may not contain control characters or newlines.";
	}
	if (keys != null) {
		if (!Array.isArray(keys) || keys.length > 5 || !keys.every((k) => (REAUTH_KEYS as readonly string[]).includes(k))) {
			return `\`keys\` must be up to 5 of: ${REAUTH_KEYS.join(", ")}.`;
		}
	}
	return null;
}

/** What to tell the owner to do next, for each state. */
export function reauthNextStep(reading: ReauthPaneReading, method: ReauthMethod): string {
	switch (reading.state) {
		case "device_code":
			return `Open ${reading.url} on any device, sign in with your ChatGPT account and enter the code ${reading.deviceCode}. Then check status — nothing needs to be sent back.`;
		case "awaiting_code":
			return `Open the sign-in URL on any device and sign in with your Claude subscription account. The page then shows a code — send it back with action "input" (text: the code).`;
		case "menu":
			return 'The CLI is showing a login-method menu. Choose the Claude subscription option (action "input", e.g. keys ["Enter"] or text "1").';
		case "succeeded":
			return method === "claude-setup-token"
				? "Signed in. The fresh token replaced the stored one; the engine uses it from its next start."
				: "Signed in. The engine uses this login from its next start.";
		case "failed":
			return 'The CLI reported the sign-in failed. Start it again (action "start").';
		default:
			return "The sign-in CLI is still starting — check status again in a few seconds.";
	}
}
