/**
 * What the "stop using this agent" control actually does, said in the control's own words
 * (#742).
 *
 * ── The defect
 *
 * The button read *"Unsubscribe from this agent"* and the panel above it *"Stop using this
 * agent."* Both name the AGENT. What they call — `POST /v1/instances/:id/cancel` — is
 * instance-scoped: it sets `status = 'canceled'` on one row and deletes nothing. The owner read
 * it, concluded it would destroy every instance of that agent, and asked twice before touching
 * it. That reaction is the finding: a label is a declaration, and nothing was comparing this one
 * to its implementation.
 *
 * The platform explicitly supports several instances of one agent — it auto-names them "Agent 2",
 * "Agent 3" — so the gap between the two scopes is not hypothetical.
 *
 * ── Why the last instance is a separate sentence
 *
 * It is the ONLY case where anything beyond the instance changes. `subscriptions` is keyed
 * `UNIQUE(agent_id, user_id)` — one row per (agent, subscriber), shared by every instance — and
 * `retireSubscriptionSql()` retires it only when this cancel takes the last live one (#669). Today
 * that case is indistinguishable from the common one, so the user cannot tell the run-of-the-mill
 * act from the one that ends their standing with the agent.
 *
 * ── Why a roster count is the right evidence, and not an approximation of one
 *
 * `GET /v1/instances/my/instances` excludes `status = 'canceled'` by default (#67), and the
 * server's retire predicate keeps the subscription alive when any OTHER sibling is in a status
 * other than `'canceled'` — `'paused'` included, deliberately (`lib/subscription-standing.ts`).
 * Those two sets are the same set. So a sibling count taken from that roster answers exactly the
 * question the server will ask, rather than resembling it. `unsubscribeScope.test.ts` pins that
 * correspondence, because it is the reason this may be decided in the browser at all.
 *
 * ── The unknown branch is not padding
 *
 * The roster fetch can fail; SettingsTab already accumulates that into its "could not load"
 * banner. A control that then asserted "your 3 other instances keep running" would be inventing
 * the number that made the user trust it. So an absent roster gets a statement that is true
 * without one, and names the last-instance consequence as a conditional instead of claiming it
 * either way.
 */

/** The fields this needs from one `GET /v1/instances/my/instances` row. */
export interface RosterInstance {
	id: string;
	/** The instance's display name. Falls back to the agent's name when none is set. */
	name?: string | null;
	/** Present ONLY when a per-instance display name is set — then `name` is that name. */
	agentName?: string | null;
	agent_id?: string | null;
}

export interface UnsubscribeScope {
	/** The button's label. Names the instance's scope, never the agent's. */
	button: string;
	/**
	 * The panel sentence AND the confirm dialog's, deliberately one string. The dialog used to
	 * carry a shorter restatement of the same scope error, which answered the data question twice
	 * and the sibling question never.
	 */
	statement: string;
	/** The full confirm-dialog text: the question, then `statement` verbatim. */
	confirm: string;
	/** Does cancelling this instance also retire the (agent, user) subscription? */
	endsSubscription: boolean;
	/** How many OTHER live instances of the same agent survive, or null when unknown. */
	siblings: number | null;
}

/** Kept identical across all three branches — the data answer was never the wrong part. */
const DATA = "Nothing is deleted — chat, memory, knowledge and files stay unless you clear them above.";

/** Said when the roster cannot answer the sibling question. True without a count, and the
 *  last-instance consequence is a conditional rather than a claim in either direction. */
const UNKNOWN =
	"Cancels this instance only — never your other instances of this agent. " +
	`If it is your last one, your subscription to the agent ends with it. ${DATA}`;

/**
 * Describe what cancelling `instanceId` will do, given the roster the console already holds.
 *
 * @param roster every non-canceled instance the user owns, or null/undefined if the read failed.
 *   `readonly` because this only ever reads it — the caller's state array is not ours to touch.
 * @param instanceId the instance whose Settings tab is open
 */
export function unsubscribeScope(
	roster: readonly RosterInstance[] | null | undefined,
	instanceId: string,
): UnsubscribeScope {
	const mine = (roster ?? []).find((r) => r.id === instanceId);
	// No roster, this instance not in it, or a row with no `agent_id` to group by. The last of
	// those is the one worth spelling out: without an agent id there is nothing to compare
	// siblings against, and treating "found no sibling" as "has no sibling" would announce that
	// the subscription ends — a false claim, in the direction that alarms the reader. The real
	// response always carries `agent_id` (it is in the SELECT); this is what keeps a thinner one
	// honest rather than confident.
	if (!mine?.agent_id) {
		return {
			button: "Cancel this instance",
			statement: UNKNOWN,
			confirm: `Cancel this instance?\n\n${UNKNOWN}`,
			endsSubscription: false,
			siblings: null,
		};
	}

	// `agentName` is present only when a per-instance display name is set; without one, `name` IS
	// the agent's name and the two read the same, which is correct — an unnamed instance has no
	// other label to offer.
	const agent = (mine.agentName || mine.name || "this agent").trim();
	const label = (mine.name || "this instance").trim();
	const siblings = (roster ?? []).filter((r) => r.id !== mine.id && r.agent_id && r.agent_id === mine.agent_id).length;

	const statement =
		siblings > 0
			? `Cancels ${label} only. Your ${siblings} other instance${siblings === 1 ? "" : "s"} of ${agent} ` +
				`${siblings === 1 ? "keeps" : "keep"} running. ${DATA}`
			: `This is your only instance of ${agent}, so cancelling it ends your subscription to ${agent} too. ${DATA}`;

	return {
		button: "Cancel this instance",
		statement,
		confirm: `Cancel ${label}?\n\n${statement}`,
		endsSubscription: siblings === 0,
		siblings,
	};
}
