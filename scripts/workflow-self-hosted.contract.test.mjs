/**
 * #1214 — the deploy and publish workflows can be routed to the pinned self-hosted machine, and cannot hang or double-run.
 *
 * Every Linux job reads its runner from `vars.PAGS_RUNNER` (the platform writes the pinned node's own labels there when Actions
 * minutes run out; see docs/runner-self-hosted-design.md) with a PINNED fallback, never `ubuntu-latest` (#1266). Every such job
 * has a `timeout-minutes`, and every workflow has a `concurrency` group so two runs of the same deploy never overlap.
 * macOS (TestFlight) and Windows (release smoke) jobs are deliberately not routed, and neither is the Linux release smoke test
 * (#1152): it proves the candidate starts on a CLEAN GitHub-hosted image, which a pinned owner machine is not.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(import.meta.dirname, "..", ".github", "workflows");
const UNROUTED_JOBS = new Set(["smoke-linux"]);
const ROUTED = ["deploy-api.yml", "deploy-host.yml", "deploy-mcp.yml", "publish-mcp-registry.yml", "publish-npm.yml"];
const read = (f) => readFileSync(join(DIR, f), "utf8");

/** [{ name, text }] for each job of a workflow: the job's block, from its key to the next job. */
function jobs(text) {
	const body = text.slice(text.search(/^jobs:\s*$/m));
	const parts = body.split(/^ {2}(?=[A-Za-z0-9_-]+:\s*$)/m).slice(1);
	return parts.map((block) => ({ name: block.split(":")[0], text: block }));
}
const runsOn = (job) => /^\s*runs-on:\s*(.*?)(?:\s+#.*)?$/m.exec(job.text)?.[1]?.trim() ?? "";

describe("deploy and publish workflows route through PAGS_RUNNER (#1214)", () => {
	for (const f of ROUTED) {
		describe(f, () => {
			const text = read(f);

			it("has a workflow-level concurrency group", () => {
				expect(text).toMatch(/^concurrency:\n\s+group: \S+/m);
			});

			it("every Linux job reads PAGS_RUNNER with a pinned ubuntu fallback and has a timeout", () => {
				const linux = jobs(text).filter((j) => /ubuntu/.test(runsOn(j)) && !UNROUTED_JOBS.has(j.name));
				expect(linux.length).toBeGreaterThan(0);
				for (const j of linux) {
					expect(runsOn(j), `${f}:${j.name}`).toBe("${{ fromJSON(vars.PAGS_RUNNER || '\"ubuntu-24.04\"') }}");
					expect(j.text, `${f}:${j.name} timeout-minutes`).toMatch(/^\s+timeout-minutes:\s*\d+\s*$/m);
				}
			});

			it("never floats on a -latest image", () => {
				expect(text).not.toMatch(/runs-on:[^\n]*-latest/);
			});
		});
	}

	it("a publish is never cancelled halfway; a deploy superseded by a newer push may be", () => {
		for (const f of ["publish-mcp-registry.yml", "publish-npm.yml"]) expect(read(f)).toMatch(/group: publish-[\w-]+\n\s+cancel-in-progress: false/);
		for (const f of ["deploy-api.yml", "deploy-host.yml", "deploy-mcp.yml"]) expect(read(f)).toMatch(/cancel-in-progress: true/);
	});

	it("the release smoke tests stay on clean, pinned GitHub-hosted images", () => {
		const smoke = jobs(read("publish-npm.yml")).find((j) => j.name === "smoke-linux");
		expect(runsOn(smoke)).toBe("ubuntu-24.04");
	});

	it("the macOS and Windows jobs are left on their own images", () => {
		expect(read("deploy-testflight.yml")).toMatch(/runs-on: macos-15/);
		expect(read("publish-npm.yml")).toMatch(/runs-on: windows-2022/);
	});

	it("every deploy and publish workflow is covered here or is deliberately macOS-only", () => {
		const all = readdirSync(DIR).filter((f) => /^(deploy|publish)-.*\.yml$/.test(f));
		expect(all.filter((f) => !ROUTED.includes(f))).toEqual(["deploy-testflight.yml"]);
	});

	it("a job that mints an OIDC token keeps id-token: write when routed", () => {
		for (const f of ["publish-mcp-registry.yml", "publish-npm.yml"]) expect(read(f)).toMatch(/id-token: write/);
	});
});
