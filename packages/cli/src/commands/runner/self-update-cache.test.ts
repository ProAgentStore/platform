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

const { installVersion } = await import("./self-update.js");
const { BOOTSTRAP_ENV, cachedPayloads } = await import("../../bootstrap/payload.js");

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pags-update-"));
	process.env.PAGS_CLI_CACHE = root;
	npmCalls.length = 0;
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
		expect(npmCalls).toEqual([["i", "-g", "@proagentstore/cli@0.4.70"]]);
		expect(cachedPayloads(root)).toEqual([]);
	});
});
