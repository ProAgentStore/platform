import { describe, expect, it } from "vitest";
import { attentionByInstance, instanceIdFromUrl, isUnread, pickNextConversation, type NotificationLike, type RosterEntry } from "./nextAgent";

const ROSTER: RosterEntry[] = [
	{ id: "i-coder", name: "FWS platform", agent_id: "a-coder" },
	{ id: "i-repo", name: "Repo Chat", agent_id: "a-repo" },
	{ id: "i-leads", name: "Lead Finder", agent_id: "a-leads" },
];

const notif = (over: Partial<NotificationLike> = {}): NotificationLike => ({
	id: `n${Math.random()}`,
	title: "🙋 Coder needs you",
	url: "/console/instances/i-coder/coding",
	created_at: "2026-08-04T10:00:00Z",
	read: 0,
	...over,
});

describe("instanceIdFromUrl", () => {
	// The producers do not agree on a shape: some link with the /console prefix, some with a
	// tab, some with a query. Reading only one of them would make whole classes of notice
	// invisible to "next" — silently, because the agent would just never come up.
	it("reads the id out of every deep-link shape the platform emits", () => {
		expect(instanceIdFromUrl("/console/instances/i-coder/coding")).toBe("i-coder");
		expect(instanceIdFromUrl("/instances/i-coder")).toBe("i-coder");
		expect(instanceIdFromUrl("https://proagentstore.online/console/instances/i-coder/board?x=1")).toBe("i-coder");
	});

	// Guessing is worse than declining: a mis-read link navigates to the WRONG agent, and in
	// hands-free the user cannot see that it happened.
	it("returns null rather than guessing", () => {
		expect(instanceIdFromUrl("/console/profile")).toBeNull();
		expect(instanceIdFromUrl("")).toBeNull();
		expect(instanceIdFromUrl(null)).toBeNull();
	});
});

describe("isUnread", () => {
	// `read` is a D1 INTEGER, and an absent column means the row was never marked.
	it("treats only an explicit 1/true as read", () => {
		expect(isUnread(notif({ read: 0 }))).toBe(true);
		expect(isUnread(notif({ read: undefined }))).toBe(true);
		expect(isUnread(notif({ read: 1 }))).toBe(false);
		expect(isUnread(notif({ read: true }))).toBe(false);
	});
});

describe("attentionByInstance", () => {
	it("groups unread notices onto the instance they point at", () => {
		const a = attentionByInstance([notif(), notif({ title: "Loop complete" })], ROSTER);
		expect(a).toHaveLength(1);
		expect(a[0].instanceId).toBe("i-coder");
		expect(a[0].count).toBe(2);
		expect(a[0].notificationIds).toHaveLength(2);
	});

	// The reason is spoken aloud, so it must be the thing the agent MOST RECENTLY said — an
	// older notice masking a newer one would announce a switch with stale grounds.
	it("takes the reason from the newest notice", () => {
		const a = attentionByInstance(
			[
				notif({ title: "Loop complete", created_at: "2026-08-04T09:00:00Z" }),
				notif({ title: "🙋 needs your approval", created_at: "2026-08-04T11:00:00Z" }),
			],
			ROSTER,
		);
		expect(a[0].reason).toBe("🙋 needs your approval");
	});

	it("ignores notices already read", () => {
		expect(attentionByInstance([notif({ read: 1 })], ROSTER)).toEqual([]);
	});

	// Navigating to an instance you no longer have produces a page that cannot load — with no
	// way back by voice, which is the worst possible failure for this feature.
	it("drops a notice for an instance that is not in the roster", () => {
		expect(attentionByInstance([notif({ url: "/console/instances/i-gone/chat" })], ROSTER)).toEqual([]);
	});

	// Older notices carry no deep link at all, only the template id.
	it("falls back to agent_id when there is no usable link", () => {
		const a = attentionByInstance([notif({ url: null, agent_id: "a-repo" })], ROSTER);
		expect(a[0]?.instanceId).toBe("i-repo");
	});

	// Subscribing to the same agent twice is supported and people do it (one Coder per repo).
	// The template id then names two instances, and picking one is a coin toss.
	it("refuses the agent_id fallback when it is ambiguous", () => {
		const twice: RosterEntry[] = [
			{ id: "i-a", name: "Coder A", agent_id: "a-coder" },
			{ id: "i-b", name: "Coder B", agent_id: "a-coder" },
		];
		expect(attentionByInstance([notif({ url: null, agent_id: "a-coder" })], twice)).toEqual([]);
	});
});

describe("pickNextConversation", () => {
	// The ticket's third verification bullet, and the one that keeps the feature safe: an
	// unexplained move to an arbitrary agent means the user's next sentence goes somewhere
	// they did not choose.
	it("returns null when nothing is waiting — never cycles to an arbitrary agent", () => {
		expect(pickNextConversation({ roster: ROSTER, notifications: [], currentId: "i-coder" })).toBeNull();
		expect(pickNextConversation({ roster: ROSTER, notifications: [notif({ read: 1 })], currentId: "i-coder" })).toBeNull();
	});

	// You are already here; "next" must mean somewhere else.
	it("never picks the agent you are already talking to", () => {
		expect(pickNextConversation({ roster: ROSTER, notifications: [notif()], currentId: "i-coder" })).toBeNull();
	});

	it("picks the agent that is asking for you, and carries its reason", () => {
		const pick = pickNextConversation({ roster: ROSTER, notifications: [notif()], currentId: "i-repo" });
		expect(pick?.instanceId).toBe("i-coder");
		expect(pick?.name).toBe("FWS platform");
		expect(pick?.reason).toBe("🙋 Coder needs you");
	});

	// The ticket's second verification bullet: a back-and-forth between two agents should feel
	// like toggling. Without this rule, "next" from B would jump to whichever third agent
	// happened to have shouted most recently, and the conversation you were having is lost.
	it("prefers the agent you were just with, over a newer call from a third", () => {
		const pick = pickNextConversation({
			roster: ROSTER,
			notifications: [
				notif({ url: "/console/instances/i-coder/chat", created_at: "2026-08-04T10:00:00Z" }),
				notif({ url: "/console/instances/i-leads/chat", created_at: "2026-08-04T12:00:00Z" }),
			],
			currentId: "i-repo",
			lastEngagedId: "i-coder",
		});
		expect(pick?.instanceId).toBe("i-coder");
	});

	// …but only when that agent is actually asking. The toggle is a tie-break among agents that
	// want you, not a licence to return to a quiet one.
	it("does not toggle back to an agent that is not asking for you", () => {
		const pick = pickNextConversation({
			roster: ROSTER,
			notifications: [notif({ url: "/console/instances/i-leads/chat" })],
			currentId: "i-repo",
			lastEngagedId: "i-coder",
		});
		expect(pick?.instanceId).toBe("i-leads");
	});

	it("otherwise takes the most recent call", () => {
		const pick = pickNextConversation({
			roster: ROSTER,
			notifications: [
				notif({ url: "/console/instances/i-coder/chat", created_at: "2026-08-04T10:00:00Z" }),
				notif({ url: "/console/instances/i-leads/chat", created_at: "2026-08-04T12:00:00Z" }),
			],
			currentId: "i-repo",
		});
		expect(pick?.instanceId).toBe("i-leads");
	});

	// Repeated "next" has to walk the same way every time; ordering off a Map's iteration would
	// make the sequence depend on which notice happened to arrive first.
	it("breaks ties by roster order, so the walk is stable", () => {
		const same = "2026-08-04T10:00:00Z";
		const pick = pickNextConversation({
			roster: ROSTER,
			notifications: [
				notif({ url: "/console/instances/i-leads/chat", created_at: same }),
				notif({ url: "/console/instances/i-repo/chat", created_at: same }),
			],
			currentId: "i-coder",
		});
		expect(pick?.instanceId).toBe("i-repo"); // earlier in the roster
	});
});
