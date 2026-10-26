import { describe, expect, it } from "vitest";
import { macRunnerServiceRemoved } from "./actions-runner-mac-removal.js";

const dir = "/Users/serge/.proagentstore/actions-runner/proappstore-online";
const home = "/Users/serge";
const oldPath = "/Library/LaunchDaemons/actions.runner.proappstore-online.pags-tiny-laptop.plist";
const empty = {
	exists: () => false,
	plists: () => [],
	parsePlist: () => null,
	runnerProcessCwds: () => [],
};

describe("macOS Actions service removal verification", () => {
	it("accepts only when the PAGS plist, legacy service and local processes are all absent", () => {
		expect(macRunnerServiceRemoved(dir, home, empty)).toBe(true);
		expect(macRunnerServiceRemoved(dir, home, { ...empty, exists: () => true })).toBe(false);
		expect(macRunnerServiceRemoved(dir, home, { ...empty, plists: () => [oldPath], parsePlist: () => ({ WorkingDirectory: dir, ProgramArguments: [`${dir}/runsvc.sh`] }) })).toBe(false);
		expect(macRunnerServiceRemoved(dir, home, { ...empty, runnerProcessCwds: () => [`${dir}/_work/job`] })).toBe(false);
	});

	it("treats an unreadable service or process inventory as unknown, not removed", () => {
		expect(macRunnerServiceRemoved(dir, home, { ...empty, plists: () => null })).toBe(false);
		expect(macRunnerServiceRemoved(dir, home, { ...empty, runnerProcessCwds: () => null })).toBe(false);
	});
});
