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
}

export interface EngineAuthBadge {
	/** The headline answer to "what am I paying with?". */
	label: string;
	/** The supporting line: what was asked for, and what the engine is. */
	detail: string;
	/** "warn" when the outcome contradicts the setting — this is the loud case. */
	tone: "warn" | "neutral";
}

const RESOLVED_LABEL: Record<EngineAuthResolved, string> = {
	// Named for the BILL, not the mechanism: "API key" alone never answered the question people
	// actually have when they open this.
	"api-key": "API key — billing per token",
	subscription: "Claude subscription",
	"machine-login": "This machine's own login",
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
	return { label, detail, tone: auth.warning ? "warn" : "neutral" };
}
