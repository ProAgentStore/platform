/**
 * #992 — the notification policy. These are the properties the product promises an owner.
 *
 * The two that must never regress are stated first and asserted hardest:
 *
 *  1. an `alert` still gets through unless the owner turned it off ON PURPOSE, and nothing the
 *     compatibility layer derives from an existing account can turn one off;
 *  2. the in-app row is a log — only an explicit rule stops one being written.
 *
 * Everything else is precedence: four levels of it, each asserted against the level below, plus
 * the channel independence and the per-instance isolation that make the whole thing useful.
 */
import { describe, expect, it } from "vitest";
import type { NotificationPreferences } from "./notifications.js";
import {
	type NotificationContext,
	type NotificationPolicy,
	type NotificationRule,
	NOTIFICATION_CHANNEL_SPECS,
	RULES_MAX,
	allOffPolicy,
	effectiveNotificationMatrix,
	legacyAccountRules,
	pushOffPolicy,
	resolveNotificationDelivery,
	ruleMatches,
	ruleSpecificity,
	sanitizeNotificationPolicy,
	unknownSelector,
} from "./notification-policy.js";

const ctx = (over: Partial<NotificationContext> = {}): NotificationContext => ({
	type: "apply",
	severity: "update",
	instanceId: "inst-a",
	...over,
});
const policy = (...rules: NotificationRule[]): NotificationPolicy => ({ rules });
const account = (over: Partial<NotificationPreferences> = {}): NotificationPreferences => ({ muted: [], ...over });

describe("the invariants an owner relies on", () => {
	it("an ALERT still gets through when nothing explicitly says otherwise", () => {
		// Including with every legacy control set against it: the mute and the instance scope have
		// never applied to an alert, and the policy does not change that floor.
		const prefs = account({ muted: ["apply", "coding"], instances: ["somewhere-else"] });
		const d = resolveNotificationDelivery(ctx({ severity: "alert" }), { account: prefs });
		expect(d.push).toMatchObject({ allowed: true, source: "baseline" });
		expect(d.inapp.allowed).toBe(true);
	});

	it("an alert is only silenced by a rule that says so — and then it says who said it", () => {
		const d = resolveNotificationDelivery(ctx({ severity: "alert" }), { account: account(), instance: policy({ severity: "alert", push: false }) });
		expect(d.push).toMatchObject({ allowed: false, source: "instance" });
		// Still in the log: silencing the interruption is not the same as losing the record.
		expect(d.inapp.allowed).toBe(true);
	});

	it("the in-app row is written for everything until a rule explicitly stops it", () => {
		for (const severity of ["update", "alert"] as const) {
			const quiet = resolveNotificationDelivery(ctx({ severity }), { account: account({ muted: ["apply"] }), instance: pushOffPolicy() });
			expect(quiet.inapp, `${severity}: push off must not take the log with it`).toMatchObject({ allowed: true, source: "default" });
		}
		const off = resolveNotificationDelivery(ctx(), { instance: allOffPolicy() });
		expect(off.inapp).toMatchObject({ allowed: false, source: "instance" });
		expect(off.push.allowed).toBe(false);
	});
});

describe("backward compatibility: an account that never writes a rule behaves exactly as before", () => {
	it("falls through to the legacy mute and instance scope, and SAYS it was the baseline", () => {
		const muted = resolveNotificationDelivery(ctx({ type: "deploy" }), { account: account({ muted: ["deploy"] }) });
		expect(muted.push).toMatchObject({ allowed: false, source: "baseline" });

		const outsideScope = resolveNotificationDelivery(ctx({ type: "coding", instanceId: "inst-b" }), { account: account({ instances: ["inst-a"] }) });
		expect(outsideScope.push.allowed).toBe(false);

		const insideScope = resolveNotificationDelivery(ctx({ type: "coding", instanceId: "inst-a" }), { account: account({ instances: ["inst-a"] }) });
		expect(insideScope.push.allowed).toBe(true);

		// No preferences at all: everything through, which is the platform default.
		expect(resolveNotificationDelivery(ctx(), {}).push.allowed).toBe(true);
	});

	it("the legacy pair, shown as rules, can never match an alert — so no existing alert is lost", () => {
		const rules = legacyAccountRules(account({ muted: ["apply", "coding"] }));
		expect(rules).toHaveLength(2);
		for (const r of rules) {
			expect(r.severity, "an update-only rule is the whole compatibility guarantee").toBe("update");
			expect(r.push).toBe(false);
			expect(ruleMatches(r, ctx({ type: r.type, severity: "alert" }))).toBe(false);
		}
		expect(legacyAccountRules(undefined)).toEqual([]);
	});

	it("a rule can OPEN a channel the legacy mute closed — the policy is above the baseline", () => {
		// "Mute applications generally, but this instance's progress is the one I want."
		const d = resolveNotificationDelivery(ctx({ type: "apply" }), { account: account({ muted: ["apply"] }), instance: policy({ type: "apply", push: true }) });
		expect(d.push).toMatchObject({ allowed: true, source: "instance" });
	});
});

describe("precedence: account default → type/severity → instance → channel", () => {
	it("an instance rule beats an account rule, even a more specific one", () => {
		const d = resolveNotificationDelivery(ctx({ type: "apply", event: "approval_required", severity: "alert" }), {
			account: account({ rules: [{ type: "apply", event: "approval_required", severity: "alert", push: false }] }),
			instance: policy({ push: true }),
		});
		// The owner said it while looking at THIS agent; that is the more specific statement.
		expect(d.push).toMatchObject({ allowed: true, source: "instance" });
	});

	it("within a level, the narrower selector wins, and the order is total", () => {
		expect(ruleSpecificity({ event: "approval_required", push: false })).toBeGreaterThan(ruleSpecificity({ type: "apply", severity: "alert", push: false }));
		expect(ruleSpecificity({ type: "apply", severity: "alert", push: false })).toBeGreaterThan(ruleSpecificity({ type: "apply", push: false }));
		expect(ruleSpecificity({ type: "apply", push: false })).toBeGreaterThan(ruleSpecificity({ severity: "alert", push: false }));
		expect(ruleSpecificity({ severity: "alert", push: false })).toBeGreaterThan(ruleSpecificity({ push: false }));

		// No two different selector sets can score the same — a tie would make the outcome depend
		// on array order, which is not a precedence rule anyone could predict.
		const combos: NotificationRule[] = [];
		for (const event of [undefined, "approval_required"]) {
			for (const type of [undefined, "apply"]) {
				for (const severity of [undefined, "alert" as const]) combos.push({ event, type, severity, push: false });
			}
		}
		expect(new Set(combos.map(ruleSpecificity)).size).toBe(combos.length);
	});

	it("resolves the issue's own example: approvals on, routine progress off, failures on", () => {
		const runner = policy(
			{ event: "approval_required", inapp: true, push: true },
			{ type: "apply", severity: "update", push: false },
			{ type: "apply", severity: "alert", push: true },
		);
		const approval = resolveNotificationDelivery(ctx({ type: "apply", event: "approval_required", severity: "alert" }), { instance: runner });
		expect(approval.push.allowed).toBe(true);
		expect(resolveNotificationDelivery(ctx({ type: "apply", severity: "update" }), { instance: runner }).push.allowed).toBe(false);
		expect(resolveNotificationDelivery(ctx({ type: "apply", severity: "alert" }), { instance: runner }).push.allowed).toBe(true);
		// And the approval row is still in the log whatever happens to the push.
		expect(approval.inapp.allowed).toBe(true);
	});

	it("and the Coder example: deploy failures and input requests, no successful-deploy chatter", () => {
		const coder = policy({ type: "deploy", severity: "update", push: false }, { type: "deploy", severity: "alert", push: true }, { event: "input_required", push: true });
		expect(resolveNotificationDelivery(ctx({ type: "deploy", severity: "update" }), { instance: coder }).push.allowed).toBe(false);
		expect(resolveNotificationDelivery(ctx({ type: "deploy", severity: "alert" }), { instance: coder }).push.allowed).toBe(true);
		expect(resolveNotificationDelivery(ctx({ type: "coding", event: "input_required", severity: "alert" }), { instance: coder }).push.allowed).toBe(true);
	});
});

describe("the channels are independent", () => {
	it("one rule may decide one channel and leave the other inherited", () => {
		const d = resolveNotificationDelivery(ctx(), { account: account({ muted: ["apply"] }), instance: policy({ inapp: false }) });
		expect(d.inapp).toMatchObject({ allowed: false, source: "instance" });
		// push was never mentioned by that rule, so it still falls to the baseline — which mutes it.
		expect(d.push).toMatchObject({ allowed: false, source: "baseline" });
	});

	it("a narrower rule wins per channel, so the two can come from different rules", () => {
		const d = resolveNotificationDelivery(ctx({ type: "apply", severity: "alert" }), {
			instance: policy({ push: false }, { type: "apply", severity: "alert", inapp: false }),
		});
		expect(d.inapp).toMatchObject({ allowed: false, rule: { type: "apply", severity: "alert", inapp: false } });
		expect(d.push).toMatchObject({ allowed: false, rule: { push: false } });
	});

	it("every declared channel is resolvable — a new channel cannot be half-wired", () => {
		const d = resolveNotificationDelivery(ctx(), {});
		for (const ch of NOTIFICATION_CHANNEL_SPECS) expect(d[ch.id], ch.id).toMatchObject({ allowed: expect.any(Boolean), source: expect.any(String) });
	});
});

describe("per-instance isolation", () => {
	it("one agent's policy says nothing about another agent", () => {
		const quiet = policy({ push: false, inapp: false });
		expect(resolveNotificationDelivery(ctx({ instanceId: "inst-a" }), { instance: quiet }).push.allowed).toBe(false);
		// The caller reads the policy per instance; resolving the OTHER instance passes none.
		expect(resolveNotificationDelivery(ctx({ instanceId: "inst-b" }), {}).push.allowed).toBe(true);
	});

	it("an instance rule cannot apply to an account-level notification that names no instance", () => {
		// A résumé parsed belongs to no agent, so "mute this agent" must not reach it — otherwise a
		// per-instance policy would silence account-wide news it was never about.
		const d = resolveNotificationDelivery({ type: "apply", severity: "update" }, { instance: allOffPolicy() });
		expect(d.push).toMatchObject({ allowed: true, source: "baseline" });
		expect(d.inapp).toMatchObject({ allowed: true, source: "default" });
	});
});

describe("what survives a read, and what a write refuses", () => {
	it("drops a rule that decides nothing, and keeps the shape bounded", () => {
		expect(sanitizeNotificationPolicy([{ type: "apply" }])).toBeUndefined();
		expect(sanitizeNotificationPolicy([{ type: "apply", push: false }, "nonsense", null, { inapp: true }])).toEqual({
			rules: [{ type: "apply", push: false }, { inapp: true }],
		});
		expect(sanitizeNotificationPolicy({ rules: [{ push: false }] })).toEqual({ rules: [{ push: false }] });
		expect(sanitizeNotificationPolicy(undefined)).toBeUndefined();
		expect(sanitizeNotificationPolicy("off")).toBeUndefined();
		const many = Array.from({ length: RULES_MAX + 20 }, () => ({ push: false }));
		expect(sanitizeNotificationPolicy(many)?.rules).toHaveLength(RULES_MAX);
		// A bad severity is not a silently different rule: it is dropped from the selector, which
		// widens the rule rather than inventing a severity the resolver would never match.
		expect(sanitizeNotificationPolicy([{ severity: "urgent", push: false }])).toEqual({ rules: [{ push: false }] });
	});

	it("names an unknown selector so a write can refuse it instead of storing a dead rule", () => {
		expect(unknownSelector({ type: "apply", push: false }, [])).toBeUndefined();
		expect(unknownSelector({ type: "aply", push: false }, [])).toMatch(/unknown notification type: aply/);
		expect(unknownSelector({ event: "approval_required", push: false }, ["approval_required"])).toBeUndefined();
		expect(unknownSelector({ event: "approvals", push: false }, ["approval_required"])).toMatch(/unknown notification event: approvals/);
		// `ci` was live in the code and missing from the vocabulary until #992 — a mute for it could
		// not be saved at all, which is the hole that made "control every notification" untrue.
		expect(unknownSelector({ type: "ci", push: false }, [])).toBeUndefined();
	});
});

describe("the effective-state view", () => {
	it("resolves every type × severity plus every event, and attributes each decision", () => {
		const rows = effectiveNotificationMatrix({ types: ["apply", "deploy"], events: ["approval_required"] }, { account: account({ muted: ["deploy"] }), instance: pushOffPolicy() }, "inst-a");
		expect(rows).toHaveLength(2 * 2 + 1);
		for (const r of rows) {
			expect(r.push.source, "an instance-wide push-off decides every row").toBe("instance");
			expect(r.inapp.allowed).toBe(true);
		}
		const approval = rows.find((r) => r.event === "approval_required");
		expect(approval?.severity, "an attention event is raised as an alert (#991)").toBe("alert");
	});

	it("shows the baseline where no rule speaks, which is what makes inheritance visible", () => {
		const rows = effectiveNotificationMatrix({ types: ["apply", "deploy"] }, { account: account({ muted: ["deploy"] }) }, "inst-a");
		const deployUpdate = rows.find((r) => r.type === "deploy" && r.severity === "update");
		const deployAlert = rows.find((r) => r.type === "deploy" && r.severity === "alert");
		expect(deployUpdate?.push).toMatchObject({ allowed: false, source: "baseline" });
		expect(deployAlert?.push).toMatchObject({ allowed: true, source: "baseline" });
		expect(rows.find((r) => r.type === "apply" && r.severity === "update")?.push.allowed).toBe(true);
	});
});
