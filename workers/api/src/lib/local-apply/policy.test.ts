/**
 * The Application Runner's policy (#957): settings refuse what they cannot honour, and the
 * auto-submit gate passes only when EVERY check does — each failing one named.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type GateInput, RUNNER_DEFAULTS, evaluateSubmitGate, mergeRunnerSettings } from "./policy";
import { LOCAL_APPLY_CONTRACT_MIN_CLI } from "./contract.js";
import { runnerContractProblem } from "./apply.js";
import { cliAtLeast } from "../runner-upgrade.js";

const ROOT = join(__dirname, "../../../../..");

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

// ── #977: the contract gate — which machines may fill an application at all ───────────────────
describe("runnerContractProblem (#977)", () => {
	const node = "pink-laptop";

	it.each([["0.4.85"], ["0.4.86"], ["0.5.0"], ["1.0.0"]])("allows %s — at or above the contract", (version) => {
		expect(runnerContractProblem(version, node)).toBeNull();
	});

	// 0.4.84 is REFUSED from #989 on: it is the release the live machine ran, and its bundled bridge
	// reads the control that opens a SEEK application as the final submit (it predates #985).
	it.each([["0.4.84"], ["0.4.83"], ["0.4.70"], ["0.3.99"]])("refuses %s, naming the version, the minimum and the fix", (version) => {
		const problem = runnerContractProblem(version, node);
		expect(problem).toContain(version);
		expect(problem).toContain(LOCAL_APPLY_CONTRACT_MIN_CLI);
		expect(problem).toContain("pink-laptop");
		// Actionable, not just a diagnosis — and it says what the owner would otherwise have seen.
		expect(problem).toMatch(/npm i -g @proagentstore\/cli/);
		expect(problem).toMatch(/restart/);
		expect(problem).toMatch(/reads the control that OPENS an application as the final submit/);
		expect(problem).toMatch(/stops before it types anything/);
	});

	it.each([[""], ["   "], [null], [undefined]])("does not judge an unreported version: %s", (version) => {
		expect(runnerContractProblem(version, node)).toBeNull();
	});

	it("names the machine generically when the node is unknown", () => {
		expect(runnerContractProblem("0.4.83", null)).toContain("that machine");
	});

	it("the minimum is the release that ships the current runner contract, not a future guess", () => {
		// Pinned so bumping the contract minimum is a deliberate edit with a reason, not a drift.
		// 0.4.85 is #989's release: the first published CLI whose bridge classifies the control that
		// OPENS an application as an entry rather than the final submit (#985's fix, which 0.4.84
		// does not contain because that commit never bumped the CLI).
		expect(LOCAL_APPLY_CONTRACT_MIN_CLI).toBe("0.4.85");
	});

	/**
	 * #989: the floor may not name a release the repository does not ship.
	 *
	 * The incident was a floor and a behaviour that moved without the version that carries them:
	 * `packages/browser-runner` changed, `packages/cli/package.json` did not, `publish-npm.yml`
	 * skipped the already-published version, and the machine kept the old runner. Raising the gate
	 * is only a fix if a CLI satisfying it is actually published, so the two are asserted together.
	 */
	it("the CLI this repo ships satisfies the floor the cloud enforces", () => {
		const cli = JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf8")) as { version: string };
		expect(cliAtLeast(cli.version, LOCAL_APPLY_CONTRACT_MIN_CLI), `packages/cli is ${cli.version}, below the ${LOCAL_APPLY_CONTRACT_MIN_CLI} floor this gate refuses machines for — bump the CLI in the same commit, or nothing that satisfies the gate is ever published`).toBe(true);
		// And the runner inside the published package is THIS repo's: the CLI's build rebuilds
		// `@proagentstore/browser-runner` and copies it into `dist/browser-runner`, so the behaviour
		// the floor promises is the behaviour in `packages/browser-runner` — which is exactly why
		// bumping the CLI is what ships a runner change, and why not bumping it shipped nothing.
		const pkg = JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf8")) as { scripts?: Record<string, string> };
		expect(pkg.scripts?.build, "the CLI must rebuild and bundle the runner, or its version says nothing about the runner's behaviour").toMatch(/--filter @proagentstore\/browser-runner build[\s\S]*copy-browser-runner/);
	});
});
