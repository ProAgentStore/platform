/**
 * A retired workflow, as every surface reads it (#979).
 *
 * The live state: the legacy Job Application Assistant was retired (migration 0189, 410s on every
 * start) and the console still showed an ordinary `active` apply agent — tabs, board, Loop button
 * — beside the live Scout → Tailor → Runner pipeline, which is also an apply agent. The retirement
 * existed only as a refusal, so nothing could SAY it before something was attempted.
 */
import { describe, expect, it } from "vitest";
import { LEGACY_JOB_APPLY_RETIRED_MESSAGE, RETIRED_WORKFLOWS, replacementsFrom, retirementFor, retirementView } from "./agent-retirement.js";
import { AGENT_WORKFLOWS } from "./agent-workflows.js";

const NOTICE = RETIRED_WORKFLOWS.JOB_APPLY;

describe("the closed table of retired workflows", () => {
	it("JOB_APPLY is retired, and says so in two words a badge can carry", () => {
		expect(retirementFor("JOB_APPLY")).toMatchObject({ workflow: "JOB_APPLY", status: "retired", label: "Retired — disabled", since: "2026-10-08" });
	});

	it("nothing else is — a live workflow must never resolve a retirement", () => {
		for (const w of AGENT_WORKFLOWS) {
			if (w.value === "JOB_APPLY") continue;
			expect(retirementFor(w.value), w.value).toBeUndefined();
		}
		expect(retirementFor(null)).toBeUndefined();
		expect(retirementFor(undefined)).toBeUndefined();
		expect(retirementFor("")).toBeUndefined();
		expect(retirementFor("CODING_SESSION")).toBeUndefined();
	});

	it("carries the SAME migration sentence the start refusals return", () => {
		// Two strings would mean a banner explaining one thing and the error from the very action it
		// describes explaining another, which teaches a reader to trust neither.
		expect(NOTICE.migration).toBe(LEGACY_JOB_APPLY_RETIRED_MESSAGE);
		expect(NOTICE.migration).toMatch(/Scout → Tailor → Runner/);
	});

	it("says what is PRESERVED, so disabled is not read as deleted", () => {
		expect(NOTICE.preserved).toMatch(/board|history|readable/i);
		expect(NOTICE.summary).toMatch(/nothing it recorded has been deleted/i);
	});

	it("names the replacement by the RUNTIME each role is recognised by, not by a slug or a name", () => {
		// A name is a display string an owner can change; the runtime is what the capability
		// registry resolves, which is how the owner's own instance is found below.
		expect(NOTICE.replacement.roles.map((r) => r.runtime)).toEqual(["local_browser", "local_artifact", "local_apply"]);
		expect(NOTICE.replacement.roles.map((r) => r.role)).toEqual(["scout", "tailor", "runner"]);
		for (const role of NOTICE.replacement.roles) expect(role.does.length, role.role).toBeGreaterThan(10);
	});
});

describe("the route out, resolved against the owner's OWN instances", () => {
	const mine = [
		{ id: "i-chat", name: "Helper", runtime: null },
		{ id: "i-scout", name: "My Scout", runtime: "local_browser" },
		{ id: "i-tailor", name: "My Tailor", runtime: "local_artifact" },
	];

	it("links the instances they have, by id, with a console path", () => {
		const resolved = replacementsFrom(NOTICE, mine);
		expect(resolved[0]).toMatchObject({ role: "scout", instanceId: "i-scout", instanceName: "My Scout", consolePath: "/instances/i-scout" });
		expect(resolved[1]).toMatchObject({ role: "tailor", instanceId: "i-tailor", consolePath: "/instances/i-tailor" });
	});

	it("keeps a role they have NOT subscribed to, with nulls — that is the route when it is the truth", () => {
		const resolved = replacementsFrom(NOTICE, mine);
		expect(resolved[2]).toMatchObject({ role: "runner", instanceId: null, instanceName: null, consolePath: null });
		expect(resolved).toHaveLength(3);
	});

	it("reports the missing roles, which is what a 'set this up' prompt is built from", () => {
		expect(retirementView(NOTICE, mine).missingRoles).toEqual(["runner"]);
		expect(retirementView(NOTICE, []).missingRoles).toEqual(["scout", "tailor", "runner"]);
		expect(retirementView(NOTICE, [...mine, { id: "i-runner", name: "My Runner", runtime: "local_apply" }]).missingRoles).toEqual([]);
	});

	it("takes the FIRST instance of a role and ignores the rest — a link, not an inventory", () => {
		const two = [
			{ id: "i-runner-a", name: "Runner A", runtime: "local_apply" },
			{ id: "i-runner-b", name: "Runner B", runtime: "local_apply" },
		];
		expect(replacementsFrom(NOTICE, two)[2]).toMatchObject({ instanceId: "i-runner-a" });
	});

	it("never links the retired agent itself, whatever its runtime says", () => {
		// The legacy agent's runtime is `browser`; no role is defined by it, so it cannot match.
		const resolved = replacementsFrom(NOTICE, [{ id: "i-legacy", name: "Job Application Assistant", runtime: "browser" }]);
		expect(resolved.every((r) => r.instanceId === null)).toBe(true);
	});

	it("the view carries the notice through unchanged — the badge text is the server's, once", () => {
		const view = retirementView(NOTICE, mine);
		expect(view.label).toBe(NOTICE.label);
		expect(view.migration).toBe(NOTICE.migration);
		expect(view.replacement.pipeline).toBe("Scout → Tailor → Runner");
	});
});
