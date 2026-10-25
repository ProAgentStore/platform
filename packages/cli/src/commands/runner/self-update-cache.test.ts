/**
 * `runner_update` under the bootstrap stub (#862) installs into the stub's payload cache — no global
 * install, no root needed — so the `pags up` respawn, which runs the stub, picks the new release.
 * Outside the stub it still installs globally, as #859 did.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeInstalled } from "../../bootstrap/test-payload.js";

const npmCalls: string[][] = [];
vi.mock("node:child_process", () => ({
	execFile: (_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, out: { stdout: string }) => void) => {
		npmCalls.push(args);
		// `npm install --prefix <dir> … @proagentstore/cli@<v>` lays the package out under the prefix.
		if (args[0] === "install") writeInstalled(args[2], args[args.length - 1].split("@").pop() as string);
		cb(null, { stdout: "" });
	},
}));

const probePayload = vi.fn();
vi.mock("../../bootstrap/start-probe.js", () => ({ probePayload: (...a: unknown[]) => probePayload(...a) }));

const { installVersion } = await import("./self-update.js");
const { badVersions, readTrial, peekRollbackNotice } = await import("../../bootstrap/trial.js");
const { BOOTSTRAP_ENV, cachedPayloads } = await import("../../bootstrap/payload.js");

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pags-update-"));
	process.env.PAGS_CLI_CACHE = root;
	npmCalls.length = 0;
	probePayload.mockReset().mockResolvedValue({ state: "passed", detail: "ok" });
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.PAGS_CLI_CACHE;
	delete process.env[BOOTSTRAP_ENV];
});

describe("installVersion", () => {
	it("bootstrapped: installs the release into the stub's cache", async () => {
		process.env[BOOTSTRAP_ENV] = "/x/dist/bootstrap.js";
		await installVersion("0.4.70");
		expect(npmCalls[0].slice(0, 2)).toEqual(["install", "--prefix"]);
		expect(npmCalls[0]).toContain("@proagentstore/cli@0.4.70");
		expect(cachedPayloads(root).map((p) => p.version)).toEqual(["0.4.70"]);
	});

	it("not bootstrapped: the global install, as before", async () => {
		await installVersion("0.4.70");
		// then asks where npm put it (#1147) — here nowhere it can be probed, so the install stands
		expect(npmCalls).toEqual([["i", "-g", "@proagentstore/cli@0.4.70"], ["root", "-g"]]);
		expect(cachedPayloads(root)).toEqual([]);
	});
});

describe("installVersion probes the new payload before it is swapped in (#1148)", () => {
	beforeEach(() => { process.env[BOOTSTRAP_ENV] = "/x/dist/bootstrap.js"; });

	it("runs the candidate's own entry point, expecting exactly the installed version, and only then puts it on trial", async () => {
		await installVersion("0.4.70", "0.4.69");
		const [entry, version] = probePayload.mock.calls[0] as [string, string];
		expect(entry.startsWith(root)).toBe(true);
		expect(entry).toContain("0.4.70");
		expect(version).toBe("0.4.70");
		expect(readTrial(root)).toMatchObject({ version: "0.4.70", previous: "0.4.69" });
	});

	it("a candidate that will not start is marked bad — quietly, no rollback notice — and never put on trial or swapped in", async () => {
		probePayload.mockResolvedValue({ state: "failed", permanent: true, detail: "it did not start: SyntaxError" });
		await expect(installVersion("0.4.70", "0.4.69")).rejects.toThrow(/failed its start-up check beside the running 0\.4\.69.*SyntaxError.*not swapped in/);
		expect(badVersions(root)["0.4.70"]).toMatch(/start-up check failed: it did not start/);
		expect(readTrial(root)).toBeNull();
		expect(peekRollbackNotice(root)).toBeNull();
	});

	it("a failure that may be the network (sign-in, API, relay) is not remembered: it is tried again", async () => {
		probePayload.mockResolvedValue({ state: "failed", permanent: false, detail: "relay: could not open a relay socket: no answer within 10s" });
		await expect(installVersion("0.4.70", "0.4.69")).rejects.toThrow(/will be tried again/);
		expect(badVersions(root)).toEqual({});
		expect(readTrial(root)).toBeNull();
	});

	it("a candidate with no probe to run (or probing switched off) proceeds exactly as before", async () => {
		probePayload.mockResolvedValue({ state: "skipped", detail: "that release has no start-up check" });
		await installVersion("0.4.70", "0.4.69");
		expect(readTrial(root)).toMatchObject({ version: "0.4.70" });
	});

	it("a global npm install has no payload to probe", async () => {
		delete process.env[BOOTSTRAP_ENV];
		await installVersion("0.4.70");
		expect(probePayload).not.toHaveBeenCalled();
	});
});
