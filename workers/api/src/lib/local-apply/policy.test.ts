/**
 * The Application Runner's policy (#957): settings refuse what they cannot honour, and the
 * auto-submit gate passes only when EVERY check does — each failing one named.
 */
import { describe, expect, it } from "vitest";
import { type GateInput, RUNNER_DEFAULTS, evaluateSubmitGate, mergeRunnerSettings } from "./policy";

describe("mergeRunnerSettings", () => {
	it.each([
		[{ authMode: "api-key" }, /never a provider API key/],
		[{ workspace: "~/../etc" }, /under the home folder/],
		[{ sources: { profile: "applications/x.md" } }, /outside applications/],
		[{ allowDomains: ["*.example.com"] }, /not a hostname/],
		[{ autoSubmit: { enabled: "yes" } }, /true or false/],
		[{ autoSubmit: { dailyCap: 500 } }, /dailyCap/],
		[{ maxActions: 0 }, /maxActions/],
	])("refuses %j", (patch, msg) => {
		const r = mergeRunnerSettings(RUNNER_DEFAULTS, patch);
		expect("error" in r && r.error).toMatch(msg);
	});
	it("patches only what is sent", () => {
		const r = mergeRunnerSettings(RUNNER_DEFAULTS, { engine: "codex", autoSubmit: { roles: ["Engineer "] } });
		expect("settings" in r && r.settings).toMatchObject({ engine: "codex", authMode: "machine", autoSubmit: { enabled: false, roles: ["engineer"] } });
	});
});

const PASSING: GateInput = {
	settings: { ...RUNNER_DEFAULTS, allowDomains: ["example.com"], autoSubmit: { enabled: true, roles: ["engineer"], locations: ["sydney"], exclude: ["contract"], minSalary: null, dailyCap: 2 } },
	application: { profileVersion: "v1", resumeSha: "a", coverLetterSha: "b", blockReason: null, submitAttemptedAt: null, leadUrl: "https://jobs.example.com/1", lead: { title: "Staff Engineer", company: "Globex", location: "Sydney NSW" } },
	autoSubmitsToday: 0,
	activeRuns: 0,
};

describe("evaluateSubmitGate", () => {
	it("allows only when every check passes", () => {
		expect(evaluateSubmitGate(PASSING)).toMatchObject({ allowed: true });
	});
	it("refuses the defaults — submission is off unless the owner turns it on", () => {
		const g = evaluateSubmitGate({ ...PASSING, settings: RUNNER_DEFAULTS });
		expect(g.allowed).toBe(false);
		expect(g.checks.find((c) => c.check === "auto_submit_enabled")).toMatchObject({ ok: false });
	});
	it.each<[string, Partial<GateInput> | ((g: GateInput) => GateInput)]>([
		["materials_complete", (g) => ({ ...g, application: { ...g.application, profileVersion: null } })],
		["domain_allowlisted", (g) => ({ ...g, application: { ...g.application, leadUrl: "https://evil.example.org/1" } })],
		["role_matches", (g) => ({ ...g, application: { ...g.application, lead: { ...g.application.lead, title: "Sales Lead" } } })],
		["location_matches", (g) => ({ ...g, application: { ...g.application, lead: { ...g.application.lead, location: "Perth" } } })],
		["not_excluded", (g) => ({ ...g, application: { ...g.application, lead: { ...g.application.lead, title: "Contract Engineer" } } })],
		["salary_matches", (g) => ({ ...g, settings: { ...g.settings, autoSubmit: { ...g.settings.autoSubmit, minSalary: 100000 } } })],
		["daily_cap", { autoSubmitsToday: 2 }],
		["concurrency", { activeRuns: 1 }],
		["no_blocker", (g) => ({ ...g, application: { ...g.application, submitAttemptedAt: 1 } })],
	])("refuses, naming %s", (check, change) => {
		const input = typeof change === "function" ? change(PASSING) : { ...PASSING, ...change };
		const g = evaluateSubmitGate(input);
		expect(g.allowed).toBe(false);
		expect(g.checks.filter((c) => !c.ok).map((c) => c.check)).toEqual([check]);
	});
});
