/**
 * Runtime liveness, in FOUR states (#280).
 *
 * The failure this exists to prevent: rendering "unknown" as "offline". An operator who
 * reads "offline" restarts, reassigns or kills the machine — and `instance_runtime_nodes.status`
 * already lies in the other direction (it is never cleared on an unclean disconnect, so a
 * machine that died days ago still reads "online"). Two wrong answers pointing opposite
 * ways is how a healthy runner gets killed.
 *
 * So the states are kept apart deliberately:
 *
 *   no-runner  nobody has ever run `pags up` for this instance — not a liveness fact at all
 *   unknown    we did not check. The list caps its live-check fan-out and returns null past
 *              the budget; an older API response may omit the field entirely
 *   live       the RelayDO holds a socket right now
 *   offline    we checked, and it does not
 */

export type RuntimeStatus = "no-runner" | "unknown" | "live" | "offline";

export interface RuntimeStatusInput {
	/**
	 * The LIVE relay check. `null`/`undefined` mean UNKNOWN — never offline. `undefined`
	 * is listed on purpose: a field the API stops sending, or a row shape that predates
	 * it, must degrade to "we don't know" and not to a confident negative.
	 */
	connected: boolean | null | undefined;
	/** How many runner nodes have ever registered. 0/undefined ⇒ never registered. */
	nodes?: number | null;
}

export function runtimeStatus({ connected, nodes }: RuntimeStatusInput): RuntimeStatus {
	// Checked first: "no runner has ever registered" outranks any liveness answer,
	// because there is no machine for `connected` to be about.
	if (!nodes) return "no-runner";
	if (connected === null || connected === undefined) return "unknown";
	return connected ? "live" : "offline";
}

export interface RuntimeStatusLabel {
	/** The glyph, or "" where the text carries it. */
	mark: string;
	text: string;
	/** The hover explanation — the place the distinction is actually taught. */
	title: string;
	/** Tailwind colour for the mark. */
	markClass: string;
	/** Tailwind colour for the text. */
	textClass: string;
}

export const RUNTIME_LABELS: Record<RuntimeStatus, RuntimeStatusLabel> = {
	"no-runner": {
		mark: "—",
		text: "no runner",
		title: "No runner has ever registered for this instance",
		markClass: "text-muted-soft",
		textClass: "text-muted-soft",
	},
	unknown: {
		mark: "◌",
		text: "unknown",
		title: "Not checked — the live-check budget for this page was spent. This is not 'offline'.",
		markClass: "text-warning",
		textClass: "text-muted-soft",
	},
	live: {
		mark: "●",
		text: "live",
		title: "A runner WebSocket is connected right now (RelayDO)",
		markClass: "text-success",
		textClass: "text-success",
	},
	offline: {
		mark: "○",
		text: "offline",
		title: "No runner socket connected right now (RelayDO)",
		markClass: "text-muted",
		textClass: "text-muted",
	},
};
