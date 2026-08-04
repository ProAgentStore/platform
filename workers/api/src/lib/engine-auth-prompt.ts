// Detect that a coding engine is stuck waiting for a human to sign in (#coding-auth).
//
// Why this is needed at all. An engine CLI authenticates with a loopback OAuth redirect: it
// starts a server on 127.0.0.1:PORT and expects a browser on THAT MACHINE to complete the flow.
// Sending the URL to the owner's laptop does not work — their browser would redirect to their own
// localhost, where nothing is listening. Same IP does not help either; it is literally 127.0.0.1
// on the runner.
//
// So the sign-in has to happen in a browser that really is on the runner, driven remotely. The
// platform already owns that: the takeover relay (human.takeover + browser.playwright) that
// solves reCAPTCHAs in the apply flow. This module is the missing first step — noticing that an
// engine is waiting, and finding the URL to hand to that browser.
//
// Pure, because the alternative is discovering the patterns are wrong only when a real engine
// hangs and looks like a dead session.

export type EngineAuthKind = "oauth-url" | "menu" | "unknown";

export interface EngineAuthPrompt {
	kind: EngineAuthKind;
	/** The URL to open in the RUNNER's browser, when the CLI printed one. */
	url: string | null;
	/** The line that gave it away, for the console to show verbatim. */
	evidence: string;
}

/**
 * Hosts that mean "a human is being asked to sign in", not merely a link in some output.
 *
 * Matched on the parsed HOSTNAME (exact or a subdomain), never as a substring of the whole URL.
 * A substring test accepted `https://accounts.google.com.evil.example/login` and
 * `https://evil.example/?next=claude.ai` — and the console's sign-in button feeds this URL
 * straight to `/browser/act {navigate}` on the runner, which drives the owner's REAL-PROFILE,
 * already-logged-in Chrome. That turns any string an engine prints (a file it read, a CI log, a
 * dependency banner) into a platform-endorsed "sign in here" page. Same class as the
 * `endsWith("slack.com")` bug already fixed in routes/auth.ts.
 */
const AUTH_HOSTS = [
	{ host: "accounts.google.com" },
	{ host: "claude.ai" },
	{ host: "console.anthropic.com" },
	{ host: "auth.openai.com" },
	{ host: "platform.openai.com" },
	{ host: "chatgpt.com", path: "/auth" },
	{ host: "x.ai" },
	{ host: "grok.com" },
	{ host: "github.com", path: "/login" },
];

/** Is this a real https URL whose HOSTNAME is one of the sign-in hosts (or a subdomain of one)? */
export function isAuthUrl(raw: string): boolean {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return false;
	}
	if (u.protocol !== "https:") return false; // an http "sign-in" page is never legitimate here
	const host = u.hostname.toLowerCase();
	return AUTH_HOSTS.some(
		(h) => (host === h.host || host.endsWith(`.${h.host}`)) && (!h.path || u.pathname.toLowerCase().startsWith(h.path)),
	);
}

/**
 * Phrases an engine prints while blocked on sign-in. Deliberately narrow: a false positive tells
 * the owner to sign in when the engine is working fine, which is worse than missing one — they
 * stop trusting the signal.
 */
const AUTH_PHRASES = [
	"how would you like to authenticate",
	"sign in with google",
	"please sign in",
	"not logged in",
	"authentication required",
	"failed to sign in",
	"press enter to log in",
	"waiting for authentication",
	"visit the following url",
	"open this url in your browser",
];

/** Phrases that look like auth but are NOT a block — the engine is running normally. */
const NOT_BLOCKED = [
	"connectors are disabled", // Claude's API-key-precedence warning; it still runs
	"already logged in",
	"logged in as",
	"authentication successful",
];

const URL_RE = /https?:\/\/[^\s"'`)<>\]]+/g;

/** Terminal prose puts URLs mid-sentence; drop trailing punctuation that isn't part of the URL. */
function stripTrailingPunctuation(u: string): string {
	return u.replace(/[.,;:!?'")\]]+$/, "");
}

/** The last N lines are what the CLI is showing NOW — an auth prompt scrolled away is history. */
const TAIL_LINES = 40;

/**
 * Is this pane waiting for a human to sign in?
 *
 * Returns null for normal output. Only looks at the tail: a login the engine already completed
 * sits earlier in the scrollback, and reporting it would send the owner to sign in again.
 */
export function detectAuthPrompt(pane: string): EngineAuthPrompt | null {
	const text = (pane || "").trim();
	if (!text) return null;
	const tail = text.split("\n").slice(-TAIL_LINES);
	const hay = tail.join("\n").toLowerCase();

	// A "still running fine" marker anywhere in the tail wins — Claude prints its API-key
	// precedence warning at startup on every single run, and it is not a sign-in request.
	if (NOT_BLOCKED.some((p) => hay.includes(p)) && !AUTH_PHRASES.some((p) => hay.includes(p))) {
		return null;
	}

	const phrase = AUTH_PHRASES.find((p) => hay.includes(p));
	// Terminal output wraps URLs in prose, so the match often carries a trailing `.` or `,` —
	// strip it BEFORE parsing, and report the cleaned URL, since this is what gets navigated to.
	const url = (tail.join("\n").match(URL_RE) ?? []).map(stripTrailingPunctuation).find(isAuthUrl);

	if (!phrase && !url) return null;

	const evidence = (tail.find((l) => (phrase && l.toLowerCase().includes(phrase)) || (url && l.includes(url))) ?? "").trim().slice(0, 300);
	return {
		kind: url ? "oauth-url" : phrase ? "menu" : "unknown",
		url: url ?? null,
		evidence,
	};
}

/**
 * What to tell the owner.
 *
 * A menu with no URL cannot be relayed by opening a link — the human has to drive the CLI itself,
 * which the takeover view already allows. Saying which case they are in avoids the "I clicked the
 * button and nothing happened" dead end.
 */
export function authPromptGuidance(prompt: EngineAuthPrompt): string {
	if (prompt.kind === "oauth-url") {
		return "This engine needs you to sign in. Open the takeover view — the sign-in page loads in the browser on the runner machine, so the redirect it expects actually works.";
	}
	return "This engine is showing a sign-in menu. Open the takeover view and choose an option there; it is running on the runner machine, not in this tab.";
}
