import { describe, expect, it } from "vitest";
import { browserCliWarning } from "./browserCliWarning";

const machines = (runnerVersion?: string) => [{ node: "mac", machineId: "m-1", connected: true, runnerVersion }];
const pinned = { runnerNode: "mac" };

describe("the CLI-version warning on the Browser sub-tab (#1593)", () => {
	it("warns when the pinned runner is older, linking to its machine page", () => {
		expect(browserCliWarning("0.4.230", pinned, machines("0.4.215"))).toEqual({ state: "Runner 0.4.215 is older than 0.4.230", href: "/terminals/machines/m-1" });
	});
	it("says nothing when the runner is equal or newer", () => {
		expect(browserCliWarning("0.4.230", pinned, machines("0.4.230"))).toBeNull();
		expect(browserCliWarning("0.4.230", pinned, machines("0.4.231"))).toBeNull();
	});
	it("an unknown or malformed version is a warning, because the server refuses that launch", () => {
		expect(browserCliWarning("0.4.230", pinned, machines())?.state).toBe("Runner version unknown");
		expect(browserCliWarning("0.4.230", pinned, machines("dev-build"))?.state).toBe("Runner version unknown");
	});
	it("links to Terminals when the node reports no machine id", () => {
		expect(browserCliWarning("0.4.230", pinned, [{ node: "mac", connected: true, runnerVersion: "0.4.1" }])?.href).toBe("/terminals");
	});
	it("says nothing with no pinned machine, no requirement, or an unreadable machine list", () => {
		expect(browserCliWarning("0.4.230", { runnerNode: null }, machines("0.1.0"))).toBeNull();
		expect(browserCliWarning(undefined, pinned, machines("0.1.0"))).toBeNull();
		expect(browserCliWarning("0.4.230", pinned, null)).toBeNull();
		expect(browserCliWarning("0.4.230", null, machines("0.1.0"))).toBeNull();
	});
});
