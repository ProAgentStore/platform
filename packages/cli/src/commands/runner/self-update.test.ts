/**
 * `runner_update`'s decision on the machine (#859): when it may update, when it must wait, and when
 * it must refuse because nothing would bring it back.
 */
import { describe, expect, it, vi } from "vitest";
import { leaveForRestart, olderThan, restartUpArgs, planRunnerUpdate, RESTART_COMMAND_ENV, restarterFrom, RUNNER_RESTART_EXIT_CODE, SERVICE_ENV, SUPERVISED_ENV, SUPERVISOR_RESTARTS, supervisorNote, type UpdateFacts } from "./self-update.js";

const facts = (over: Partial<UpdateFacts> = {}): UpdateFacts => ({ current: "0.4.62", latest: "0.4.63", fromSource: false, restarter: "pags-up", busy: [], ...over });

describe("planRunnerUpdate (#859)", () => {
	it("updates an idle, supervised, npm-installed runner that is behind", () => {
		expect(planRunnerUpdate(facts())).toEqual({ action: "update", current: "0.4.62", latest: "0.4.63", restarter: "pags-up" });
	});

	it("WAITS while any engine is mid-turn — a run is paused across the restart, never cut off", () => {
		expect(planRunnerUpdate(facts({ busy: ["csess_1", "csess_2"] }))).toEqual({ action: "wait", current: "0.4.62", latest: "0.4.63", waitingFor: ["csess_1", "csess_2"] });
	});

	it("does nothing when it is already current", () => {
		expect(planRunnerUpdate(facts({ current: "0.4.63" }))).toEqual({ action: "up-to-date", current: "0.4.63" });
		expect(planRunnerUpdate(facts({ current: "0.5.0" })).action).toBe("up-to-date");
	});

	it("refuses when NOTHING would restart it — and names every way to make it restartable (#860)", () => {
		const out = planRunnerUpdate(facts({ restarter: null }));
		expect(out.action).toBe("refused");
		expect(out.action === "refused" && out.reason).toMatch(/not started by `pags up`.*PAGS_SERVICE=1.*PAGS_RESTART_COMMAND.*later updates can then be done remotely.*npm i -g @proagentstore\/cli/);
	});

	it("updates a runner under a service manager or a restart command exactly like one under `pags up` (#860)", () => {
		expect(planRunnerUpdate(facts({ restarter: "service" }))).toMatchObject({ action: "update", restarter: "service" });
		expect(planRunnerUpdate(facts({ restarter: "command" }))).toMatchObject({ action: "update", restarter: "command" });
		// …and waits on busy engines just the same — the in-flight guarantee does not depend on who restarts it.
		expect(planRunnerUpdate(facts({ restarter: "service", busy: ["csess_1"] }))).toMatchObject({ action: "wait", waitingFor: ["csess_1"] });
	});

	it("refuses a source checkout, and a machine that cannot reach npm", () => {
		expect(planRunnerUpdate(facts({ fromSource: true }))).toMatchObject({ action: "refused", reason: expect.stringMatching(/git pull/) });
		expect(planRunnerUpdate(facts({ latest: null }))).toMatchObject({ action: "refused", reason: expect.stringMatching(/npm could not be asked/) });
	});
});

describe("olderThan", () => {
	it("compares numerically, and never calls a version it cannot read older", () => {
		expect(olderThan("0.4.9", "0.4.10")).toBe(true);
		expect(olderThan("0.4.61", "0.4.62")).toBe(true);
		expect(olderThan("0.4.62", "0.4.62")).toBe(false);
		expect(olderThan("1.0.0", "0.9.9")).toBe(false);
		expect(olderThan("dev", "0.4.62")).toBe(false);
	});
});

describe("what restarts a runner after an update (#860)", () => {
	it("reads it from the environment its supervisor set", () => {
		expect(restarterFrom({ [SUPERVISED_ENV]: SUPERVISOR_RESTARTS })).toBe("pags-up");
		expect(restarterFrom({ [SUPERVISED_ENV]: "1" })).toBe("pags-up-child-only");
		expect(restarterFrom({ [SERVICE_ENV]: "1" })).toBe("service");
		expect(restarterFrom({ [RESTART_COMMAND_ENV]: "pags runner connect i1 --watch-instances" })).toBe("command");
		expect(restarterFrom({ [RESTART_COMMAND_ENV]: "  " })).toBeNull();
		expect(restarterFrom({})).toBeNull();
	});

	it("a `pags up` supervising the runner wins over anything else in the environment", () => {
		expect(restarterFrom({ [SUPERVISED_ENV]: SUPERVISOR_RESTARTS, [SERVICE_ENV]: "1", [RESTART_COMMAND_ENV]: "x" })).toBe("pags-up");
	});

	it("says so when the `pags up` supervisor will NOT move onto the new release — and only then", () => {
		expect(supervisorNote("pags-up-child-only")).toMatch(/predates supervisor restarts.*keeps running its own older code/);
		for (const r of ["pags-up", "service", "command"] as const) expect(supervisorNote(r)).toBeNull();
	});
});

describe("leaveForRestart (#860)", () => {
	const deps = () => ({ spawn: vi.fn(() => ({ unref: vi.fn() })), exit: vi.fn() });

	it("`pags up` and a service manager: exits with the restart code, which both restart on", () => {
		for (const r of ["pags-up", "pags-up-child-only", "service"] as const) {
			const d = deps();
			leaveForRestart(r, d as never);
			expect(d.exit).toHaveBeenCalledWith(RUNNER_RESTART_EXIT_CODE);
			expect(d.spawn).not.toHaveBeenCalled();
		}
	});

	it("a restart command: starts it detached — it outlives this process — then exits cleanly", () => {
		process.env[RESTART_COMMAND_ENV] = "tmux send-keys -t pags 'pags runner connect i1 --watch-instances' Enter";
		try {
			const d = deps();
			leaveForRestart("command", d as never);
			expect(d.spawn).toHaveBeenCalledWith(process.env[RESTART_COMMAND_ENV], expect.objectContaining({ shell: true, detached: true, stdio: "ignore" }));
			expect(d.exit).toHaveBeenCalledWith(0);
		} finally {
			delete process.env[RESTART_COMMAND_ENV];
		}
	});
});

describe("restartUpArgs — the supervisor restarts itself with the SAME flags (#860)", () => {
	it("keeps a scoped run scoped, and every other flag", () => {
		expect(restartUpArgs({})).toEqual(["up"]);
		expect(restartUpArgs({ headless: true, force: true, instance: "inst-9" })).toEqual(["up", "--headless", "--force", "--instance", "inst-9"]);
	});
});
