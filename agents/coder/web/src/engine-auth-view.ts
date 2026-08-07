// How a session's credential report reads in the header (#248).
//
// The API answers two questions the UI could not previously ask: which credential the engine
// actually ran on (subscription vs an API key billed per token), and what the engine actually is
// (a child process — never a tmux pane, despite years of the surface implying otherwise, #247).
//
// Kept pure and separate from the component so the wording of the money question is testable.

export type EngineAuthMode = "auto" | "machine" | "subscription" | "api-key";
export type EngineAuthResolved = "subscription" | "api-key" | "machine-login";

/** The `auth` block attached to every /capture and /diagnostics session response. */
export interface EngineAuthReport {
	mode: EngineAuthMode;
	/** null when no runner is connected, or the runner predates the field. */
	resolved: EngineAuthResolved | null;
	runtime: "child-process";
	warning: string | null;
	/** Who pays, as the ledger records it (#346). null = unknown; optional for an older API. */
	payer?: "byok-api" | "subscription" | "platform" | null;
	/** The positive statement of what this session's spend is. Optional for an older API. */
	note?: string;
}

export interface EngineAuthBadge {
	/** The headline answer to "what am I paying with?". */
	label: string;
	/** The supporting line: what was asked for, and what the engine is. */
	detail: string;
	/** "warn" when the outcome contradicts the setting — this is the loud case. */
	tone: "warn" | "neutral";
	/**
	 * What this session's spend IS, from the API (#343). Distinct from `warning`, which only ever
	 * fires when something is wrong — so before this, the ordinary case said nothing at all.
	 */
	note: string | null;
}

const RESOLVED_LABEL: Record<EngineAuthResolved, string> = {
	// Named for the BILL, not the mechanism: "API key" alone never answered the question people
	// actually have when they open this.
	"api-key": "API key — billing per token",
	subscription: "Claude subscription — no per-token charge",
	// The one that used to say nothing beyond the mechanism (#343). It is the most common
	// resolution, and it is the case where the user can LEAST tell which account is paying — so
	// the label names the ambiguity rather than leaving the reader to assume either answer.
	"machine-login": "This machine's own login — payer unknown",
};

const MODE_LABEL: Record<EngineAuthMode, string> = {
	auto: "Automatic",
	machine: "This machine's login",
	subscription: "Claude subscription",
	"api-key": "API key",
};

/**
 * Render the report, or null when there is nothing honest to show.
 *
 * An UNKNOWN outcome is still shown — "unknown" is a real, useful answer here, and hiding the
 * badge until a runner connects would leave the same silence the ticket is about.
 */
export function engineAuthBadge(auth: EngineAuthReport | null | undefined): EngineAuthBadge | null {
	if (!auth) return null;
	const label = auth.resolved ? RESOLVED_LABEL[auth.resolved] : "Credential unknown — no runner connected";
	// Always state the runtime: "is this tmux?" was unanswerable, and the old `tmuxSession` label
	// actively suggested the wrong answer.
	const detail = `Set to ${MODE_LABEL[auth.mode]} · child process`;
	return { label, detail, tone: auth.warning ? "warn" : "neutral", note: auth.note ?? null };
}

/**
 * Is Claude Code signed out on the runner machine?
 *
 * There is no field for this. The headless engine reports it the only way a child process can —
 * by printing it — so the console reads the captured transcript. That makes the pattern the whole
 * of the rule, and it decides whether the user is shown a `claude setup-token` CTA, so it belongs
 * next to the rest of the credential reporting rather than inline in a render.
 *
 * Gated on the ENGINE, not just the words. Codex and Grok have their own sign-in flows and their
 * own way of saying "invalid api key"; telling their user to run `claude setup-token` would be
 * advice for a program they are not running.
 */
const SIGNED_OUT = /not logged in|please run \/login|invalid api key|oauth token (is |has )?(expired|revoked)/i;

export function isClaudeSignedOut(session: { clientType?: string } | null | undefined, terminalText: string): boolean {
	return session?.clientType === "claude" && SIGNED_OUT.test(terminalText);
}
