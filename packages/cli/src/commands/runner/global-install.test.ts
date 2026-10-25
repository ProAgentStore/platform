/** #1147 — a runner not under the bootstrap stub updates in place, but a release that will not start is put back. */
import { describe, expect, it, vi } from "vitest";
import { installGlobalWithRollback } from "./global-install.js";
import { releaseTrial, rollbackAvailable } from "./release-trial.js";
import { BOOTSTRAP_ENV } from "../../bootstrap/payload.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { badVersions, markBad } from "../../bootstrap/trial.js";

const setup = (over: { rootOut?: string; payload?: { version: string; entry: string } | null; verdict?: unknown; failRestore?: boolean; failInstall?: boolean } = {}) => {
	const calls: string[] = [];
	const marks: Array<[string, string, string | null]> = [];
	const deps = {
		npm: vi.fn(async (args: string[]) => {
			calls.push(args.join(" "));
			if (args[0] === "root") return { stdout: over.rootOut ?? "/g/lib/node_modules\n" };
			if (over.failInstall && args[2]?.endsWith("@0.4.150")) throw Object.assign(new Error("x"), { stderr: "E404 no such version" });
			if (over.failRestore && args[2]?.endsWith("@0.4.148")) throw Object.assign(new Error("x"), { stderr: "EACCES" });
			return {};
		}),
		payloadAt: vi.fn(() => (over.payload === undefined ? { version: "0.4.150", entry: "/g/lib/node_modules/@proagentstore/cli/dist/index.js" } : over.payload)),
		probe: vi.fn(async () => (over.verdict ?? { state: "passed", detail: "ok" }) as never),
		mark: (v: string, r: string, to: string | null) => void marks.push([v, r, to]),
		log: () => undefined,
	};
	return { deps, calls, marks };
};

describe("installGlobalWithRollback", () => {
	it("installs in place, finds the package where npm put it, probes its entry, and leaves a passing release alone", async () => {
		const { deps, calls } = setup();
		await installGlobalWithRollback("0.4.150", "0.4.148", deps);
		expect(calls).toEqual(["i -g @proagentstore/cli@0.4.150", "root -g"]);
		expect(deps.payloadAt).toHaveBeenCalledWith("/g/lib/node_modules/@proagentstore/cli");
		expect(deps.probe).toHaveBeenCalledWith("/g/lib/node_modules/@proagentstore/cli/dist/index.js", "0.4.150");
	});
	it("a release that fails its start-up check is replaced by the one that was running, marked bad, and reported", async () => {
		const { deps, calls, marks } = setup({ verdict: { state: "failed", permanent: true, detail: "it did not start: SyntaxError" } });
		await expect(installGlobalWithRollback("0.4.150", "0.4.148", deps)).rejects.toThrow(/0\.4\.150 failed its start-up check.*SyntaxError.*this machine is back on 0\.4\.148/);
		expect(calls.at(-1)).toBe("i -g @proagentstore/cli@0.4.148");
		expect(marks).toEqual([["0.4.150", expect.stringMatching(/start-up check failed: it did not start/), "0.4.148"]]);
	});
	it("a failure that may be the network is rolled back too, but not remembered", async () => {
		const { deps, calls, marks } = setup({ verdict: { state: "failed", permanent: false, detail: "relay: no answer within 10s" } });
		await expect(installGlobalWithRollback("0.4.150", "0.4.148", deps)).rejects.toThrow(/back on 0\.4\.148.*tried again/);
		expect(calls.at(-1)).toBe("i -g @proagentstore/cli@0.4.148");
		expect(marks).toEqual([]);
	});
	it("says plainly when putting the old release back failed, or when there is none to put back", async () => {
		const bad = { state: "failed", permanent: true, detail: "x" };
		await expect(installGlobalWithRollback("0.4.150", "0.4.148", setup({ verdict: bad, failRestore: true }).deps)).rejects.toThrow(/putting 0\.4\.148 back FAILED \(EACCES\).*npm i -g @proagentstore\/cli@0\.4\.148/);
		const unknown = setup({ verdict: bad });
		await expect(installGlobalWithRollback("0.4.150", null, unknown.deps)).rejects.toThrow(/not known, so nothing was put back/);
		expect(unknown.calls.filter((c) => c.startsWith("i -g"))).toHaveLength(1);
	});
	it("an install npm refuses fails with npm's own words, with nothing probed", async () => {
		const { deps } = setup({ failInstall: true });
		await expect(installGlobalWithRollback("0.4.150", "0.4.148", deps)).rejects.toThrow("E404 no such version");
		expect(deps.probe).not.toHaveBeenCalled();
	});
	it("learns nothing when the install cannot be located or is another version: the update goes on as it always did", async () => {
		for (const o of [{ payload: null }, { payload: { version: "0.4.149", entry: "e" } }, { rootOut: "" }]) {
			const { deps } = setup(o);
			await installGlobalWithRollback("0.4.150", "0.4.148", deps);
			expect(deps.probe).not.toHaveBeenCalled();
		}
	});
	it("a skipped probe (a release without one, or switched off) keeps the release", async () => {
		const { deps, calls } = setup({ verdict: { state: "skipped", detail: "that release has no start-up check" } });
		await installGlobalWithRollback("0.4.150", "0.4.148", deps);
		expect(calls.filter((c) => c.startsWith("i -g"))).toHaveLength(1);
	});
});

describe("reporting and reading rollbacks off the stub (#1147)", () => {
	it("says whether an update can be rolled back: yes under the stub, no in place, nothing for a source checkout", () => {
		expect(rollbackAvailable({ [BOOTSTRAP_ENV]: "/x/bootstrap.js" })).toBe(true);
		expect(rollbackAvailable({})).toBe(false);
		expect(rollbackAvailable({}, true)).toBeNull();
	});
	it("a runner not under the stub still lists, and can retry, a release it refused", () => {
		const root = mkdtempSync(join(tmpdir(), "pags-inplace-"));
		try {
			markBad(root, "0.4.150", "its start-up check failed: x", "0.4.148", 7, { notice: false });
			const t = releaseTrial("0.4.148", { record: () => undefined }, () => undefined, {}, () => root);
			expect(t.rolledBack()).toEqual({ "0.4.150": "its start-up check failed: x" });
			expect(t.rollbacks()).toEqual([{ from: "0.4.150", reason: "its start-up check failed: x", to: "0.4.148", at: 7 }]);
			expect(t.rollbackReason).toBeNull();
			expect(t.forget("0.4.150")).toBe(true);
			expect(badVersions(root)).toEqual({});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
