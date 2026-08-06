/**
 * "Which agent wants me?" — the pure half of the `next` voice command (#277).
 *
 * ── What "wants you" means, and why ──
 *
 * An agent wants you when it has TRIED TO REACH YOU and you have not looked yet: an unread
 * notification pointing at one of your instances.
 *
 * The obvious alternative was a board status — `needs_human` / `needs_approval`. Two things
 * ruled it out. First, availability: the board is a per-instance endpoint, so resolving "who
 * wants me" across a dozen agents would be a dozen requests on every "next", where the
 * notification list is one call the console already makes for the bell badge. Second, and more
 * decisive, a board status does not clear by ARRIVING. `needs_human` clears when the work is
 * acted on, so "next" would keep steering you back to the same agent until you finished its
 * task — the opposite of "repeated next walks the set". A notification clears the moment you
 * are taken there, which is what makes the walk terminate and "nothing is waiting" honest.
 *
 * It is also not a new invention: `notifyUser` is already called at exactly the moments the
 * ticket lists — a `needs_human` handoff, an ask-and-hold `needs_input`, a finished loop run —
 * so this reads the platform's own answer instead of inventing a parallel one.
 *
 * Everything below is pure so the ranking is testable and lives in ONE place: an agent switcher
 * that disagreed with itself about who is next would be indistinguishable from a bug in the
 * voice layer.
 */

/** A notification row as `/v1/notifications` returns it (snake_case, straight from D1). */
export interface NotificationLike {
	id: string;
	type?: string | null;
	title?: string | null;
	/** Deep link into the console, e.g. `/console/instances/<id>/coding`. */
	url?: string | null;
	agent_id?: string | null;
	created_at?: string | null;
	read?: number | boolean | null;
}

/** The subset of an instance this needs — id, display name, and its template. */
export interface RosterEntry {
	id: string;
	name: string;
	agent_id?: string;
}

/** One agent asking for you, with everything the announcement and the read-receipt need. */
export interface Attention {
	instanceId: string;
	name: string;
	/** How many unread notices it has — surfaced as a count, never as an ordering key. */
	count: number;
	/** Epoch ms of the newest one (0 when no timestamp parsed). */
	latestAt: number;
	/** The newest notice's own title — spoken verbatim, so the reason is the platform's
	 *  words rather than a classification this module would have to guess at. */
	reason: string;
	/** The notices to mark read on arrival, which is what stops "next" returning here. */
	notificationIds: string[];
}

/**
 * Pull an instance id out of a notification deep link.
 *
 * Tolerant of the shapes the producers actually emit: with or without the `/console` prefix,
 * with or without a tab segment or query string, and absolute or relative. Returns null rather
 * than guessing — a link we cannot read must not silently resolve to the wrong agent.
 */
export function instanceIdFromUrl(url: string | null | undefined): string | null {
	if (!url) return null;
	const m = /\/instances\/([^/?#]+)/.exec(String(url));
	const id = m?.[1]?.trim();
	return id ? id : null;
}

/** Unread, in the D1 sense: the column is an INTEGER, and absent means "not marked read". */
export function isUnread(n: NotificationLike): boolean {
	return !(n.read === 1 || n.read === true);
}

/**
 * Group unread notifications by the instance they point at.
 *
 * The deep link is the primary key because it names the INSTANCE; `agent_id` is a fallback and
 * is deliberately only used when it resolves to exactly one of your instances — the same agent
 * subscribed twice (which the platform supports, and people do) would otherwise send you to an
 * arbitrary one of the two. A notice for an instance that is no longer in the roster
 * (unsubscribed, or belonging to a creator's agent rather than a subscription) is dropped: it
 * would navigate to a page that cannot load.
 */
export function attentionByInstance(
	notifications: NotificationLike[] | null | undefined,
	roster: RosterEntry[] | null | undefined,
): Attention[] {
	const byId = new Map((roster ?? []).map((r) => [r.id, r]));
	const byAgent = new Map<string, RosterEntry[]>();
	for (const r of roster ?? []) {
		if (!r.agent_id) continue;
		const list = byAgent.get(r.agent_id) ?? [];
		list.push(r);
		byAgent.set(r.agent_id, list);
	}

	const out = new Map<string, Attention>();
	for (const n of notifications ?? []) {
		if (!isUnread(n)) continue;
		const linked = instanceIdFromUrl(n.url);
		let entry = linked ? byId.get(linked) : undefined;
		if (!entry && n.agent_id) {
			const candidates = byAgent.get(n.agent_id) ?? [];
			if (candidates.length === 1) entry = candidates[0];
		}
		if (!entry) continue;
		const at = Date.parse(String(n.created_at ?? ""));
		const ts = Number.isFinite(at) ? at : 0;
		const cur = out.get(entry.id);
		if (!cur) {
			out.set(entry.id, {
				instanceId: entry.id,
				name: entry.name,
				count: 1,
				latestAt: ts,
				reason: (n.title ?? "").trim(),
				notificationIds: [n.id],
			});
			continue;
		}
		cur.count += 1;
		cur.notificationIds.push(n.id);
		// The NEWEST notice supplies the spoken reason — it is the thing the agent most
		// recently wanted to say, and the one an older notice would otherwise mask.
		if (ts >= cur.latestAt) {
			cur.latestAt = ts;
			cur.reason = (n.title ?? "").trim() || cur.reason;
		}
	}
	return [...out.values()];
}

/** The agent "next" moves you to, plus why. */
export interface NextPick extends Attention {}

/**
 * Choose the agent to switch to. `null` = nothing is waiting, which the caller must SAY rather
 * than paper over by moving somewhere arbitrary — in hands-free a silent, unexplained move
 * means the next sentence goes to an agent the user never chose.
 *
 * The order is the ticket's, and the two rules interact deliberately:
 *
 *   1. The agent you were talking to just before this one wins, if it is asking for you. A
 *      back-and-forth between two agents should feel like TOGGLING, not like cycling a roster.
 *   2. Otherwise the one that spoke most recently, ties broken by roster order so the walk is
 *      stable and repeatable rather than dependent on map iteration.
 *
 * The toggle cannot trap you, because arriving marks that agent's notices read: the second
 * "next" only comes back if it has asked for you AGAIN in the meantime, which is precisely when
 * you want to be taken back.
 */
export function pickNextConversation(input: {
	roster: RosterEntry[] | null | undefined;
	notifications: NotificationLike[] | null | undefined;
	/** The agent you are talking to now — never a destination. */
	currentId?: string | null;
	/** The one before it (see rule 1). */
	lastEngagedId?: string | null;
}): NextPick | null {
	const roster = input.roster ?? [];
	const order = new Map(roster.map((r, i) => [r.id, i]));
	const candidates = attentionByInstance(input.notifications, roster).filter((a) => a.instanceId !== input.currentId);
	if (candidates.length === 0) return null;

	const toggle = candidates.find((a) => a.instanceId === input.lastEngagedId);
	if (toggle) return toggle;

	return candidates.slice().sort((a, b) => {
		if (b.latestAt !== a.latestAt) return b.latestAt - a.latestAt;
		return (order.get(a.instanceId) ?? 0) - (order.get(b.instanceId) ?? 0);
	})[0];
}
