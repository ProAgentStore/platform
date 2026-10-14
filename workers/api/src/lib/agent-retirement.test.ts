/**
 * A retired workflow, as every surface reads it (#979) — and the table's membership (#1062).
 *
 * JOB_APPLY was the first member (2026-10-08) and was removed on 2026-10-14 (#1062): "legacy" never
 * meant retired, and it is a supported browser-work path alongside Scout → Tailor → Runner. The
 * machinery stays for a real future retirement, so it is tested against a FIXTURE notice.
 */
import { describe, expect, it } from "vitest";
import { RETIRED_WORKFLOWS, replacementsFrom, retirementFor, retirementView } from "./agent-retirement.js";
import { FIXTURE_RETIREMENT as NOTICE } from "./agent-retirement.fixture.js";
import { AGENT_WORKFLOWS } from "./agent-workflows.js";

describe("the closed table of retired workflows", () => {
	it("JOB_APPLY is NOT retired (#1062) — it is a supported browser-work path", () => {
		expect(retirementFor("JOB_APPLY")).toBeUndefined();
		expect(Object.hasOwn(RETIRED_WORKFLOWS, "JOB_APPLY")).toBe(false);
	});

	it("no workflow the platform runs today resolves a retirement", () => {
		for (const w of AGENT_WORKFLOWS) expect(retirementFor(w.value), w.value).toBeUndefined();
		expect(Object.keys(RETIRED_WORKFLOWS)).toEqual([]);
		expect(retirementFor(null)).toBeUndefined();
		expect(retirementFor(undefined)).toBeUndefined();
		expect(retirementFor("")).toBeUndefined();
	});

	it("a notice says what is PRESERVED, so disabled is not read as deleted", () => {
		expect(NOTICE.preserved).toMatch(/board|history|readable/i);
		expect(NOTICE.summary).toMatch(/nothing it recorded has been deleted/i);
	});

	it("names the replacement by the RUNTIME each role is recognised by, not by a slug or a name", () => {
		expect(NOTICE.replacement.roles.map((r) => r.runtime)).toEqual(["local_browser", "local_artifact", "local_apply"]);
		expect(NOTICE.replacement.roles.map((r) => r.role)).toEqual(["scout", "tailor", "runner"]);
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
		// A `browser`-runtime agent defines no role, so it cannot match.
		const resolved = replacementsFrom(NOTICE, [{ id: "i-retired", name: "Retired agent", runtime: "browser" }]);
		expect(resolved.every((r) => r.instanceId === null)).toBe(true);
	});

	it("the view carries the notice through unchanged — the badge text is the server's, once", () => {
		const view = retirementView(NOTICE, mine);
		expect(view.label).toBe(NOTICE.label);
		expect(view.migration).toBe(NOTICE.migration);
		expect(view.replacement.pipeline).toBe("Scout → Tailor → Runner");
	});
});
