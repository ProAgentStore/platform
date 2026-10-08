import { describe, expect, it } from "vitest";
import { policyRows, rulesFromChoices, SOURCE_LABEL } from "./notificationPolicy";
import type { InstanceNotificationPolicy, NotificationVocabulary } from "./types";

/**
 * #992 — the editor's three-state logic.
 *
 * The property worth pinning is that "inherit" survives a round trip: a row the owner has not
 * touched must contribute NOTHING to the saved rules, or the first save would freeze every row as
 * an override and the account below would stop reaching this agent forever. The other half is
 * that a row's control agrees with the explanation beside it — the choice is derived from the same
 * `source` the label is.
 */

const vocab: NotificationVocabulary = {
	types: [
		{ id: "apply", label: "Job applications", description: "Progress on an application run.", alerts: true },
		{ id: "deploy", label: "Deploys", description: "A deploy going out, or failing.", alerts: false },
	],
	events: [{ id: "approval_required", label: "Approval needed", description: "A run stopped at something it may not do without you.", kind: "alert", pushOptional: true }],
	channels: [
		{ id: "inapp", label: "In the console", description: "The bell list.", optional: true },
		{ id: "push", label: "Push", description: "Your devices.", optional: true },
	],
	severities: ["update", "alert"],
};

const on = { allowed: true, source: "baseline" as const };
const policy = (over: Partial<InstanceNotificationPolicy> = {}): InstanceNotificationPolicy => ({
	instanceId: "i1",
	rules: [],
	effective: [
		{ type: "apply", severity: "update", inapp: { allowed: true, source: "default" }, push: on },
		{ type: "apply", severity: "alert", inapp: { allowed: true, source: "default" }, push: on },
		{ type: "deploy", severity: "update", inapp: { allowed: true, source: "default" }, push: on },
		{ type: "deploy", severity: "alert", inapp: { allowed: true, source: "default" }, push: on },
		{ type: "", severity: "alert", event: "approval_required", inapp: { allowed: true, source: "default" }, push: on },
	],
	...over,
});

describe("the rows the editor shows", () => {
	it("leads with the events, then every type that can raise each severity", () => {
		const rows = policyRows(vocab, policy());
		expect(rows.map((r) => r.key)).toEqual(["event:approval_required", "type:apply:update", "type:apply:alert", "type:deploy:update"]);
		// `deploy` never raises an alert, so a control for its alerts would configure something
		// that cannot happen.
		expect(rows.some((r) => r.key === "type:deploy:alert")).toBe(false);
	});

	it("starts every row on `inherit`, and says where the current answer came from", () => {
		const rows = policyRows(vocab, policy());
		for (const row of rows) {
			expect(row.inapp.choice, row.key).toBe("inherit");
			expect(row.push.choice, row.key).toBe("inherit");
		}
		expect(SOURCE_LABEL[rows[0].push.source]).toBe("from your account");
		expect(SOURCE_LABEL.instance).toBe("set here");
	});

	it("shows a row as on/off only when THIS instance decided it", () => {
		const decided = policy({
			rules: [{ type: "apply", severity: "update", push: false }],
			effective: [
				{ type: "apply", severity: "update", inapp: { allowed: true, source: "default" }, push: { allowed: false, source: "instance" } },
				{ type: "apply", severity: "alert", inapp: { allowed: true, source: "default" }, push: { allowed: false, source: "baseline" } },
				{ type: "deploy", severity: "update", inapp: { allowed: true, source: "default" }, push: on },
				{ type: "", severity: "alert", event: "approval_required", inapp: { allowed: true, source: "default" }, push: on },
			],
		});
		const rows = policyRows(vocab, decided);
		const applyUpdate = rows.find((r) => r.key === "type:apply:update");
		expect(applyUpdate?.push).toMatchObject({ choice: "off", allowed: false, source: "instance" });
		// Resolved off, but by the ACCOUNT — so the control still reads "inherit" and the label
		// still says where it came from. Showing "off" here would invite the owner to "fix" a row
		// they never set.
		const applyAlert = rows.find((r) => r.key === "type:apply:alert");
		expect(applyAlert?.push).toMatchObject({ choice: "inherit", allowed: false, source: "baseline" });
	});
});

describe("what a save sends", () => {
	it("sends nothing for rows left inheriting — which is how `restore inherited` is expressible", () => {
		expect(rulesFromChoices(policyRows(vocab, policy()))).toEqual([]);
	});

	it("sends one rule per decided row, carrying only the channels that row chose", () => {
		const rows = policyRows(vocab, policy()).map((r) =>
			r.key === "event:approval_required"
				? { ...r, push: { ...r.push, choice: "on" as const } }
				: r.key === "type:apply:update"
					? { ...r, push: { ...r.push, choice: "off" as const }, inapp: { ...r.inapp, choice: "off" as const } }
					: r,
		);
		expect(rulesFromChoices(rows)).toEqual([
			{ event: "approval_required", push: true },
			{ type: "apply", severity: "update", inapp: false, push: false },
		]);
	});

	it("round-trips: everything off, then back to inherited", () => {
		const allOff = policyRows(vocab, policy()).map((r) => ({ ...r, inapp: { ...r.inapp, choice: "off" as const }, push: { ...r.push, choice: "off" as const } }));
		const rules = rulesFromChoices(allOff);
		expect(rules).toHaveLength(4);
		for (const r of rules) expect(r).toMatchObject({ inapp: false, push: false });
		const restored = allOff.map((r) => ({ ...r, inapp: { ...r.inapp, choice: "inherit" as const }, push: { ...r.push, choice: "inherit" as const } }));
		expect(rulesFromChoices(restored)).toEqual([]);
	});
});
