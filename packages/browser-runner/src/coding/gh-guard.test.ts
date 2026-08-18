import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findRealGh, GH_REFUSED_EXIT, GH_REFUSED_MARKER, ghGuardEnv, ghGuardStatus, installGhGuard, normalizeRepo } from "./gh-guard.js";

/**
 * #679. These run the GENERATED SHIM, not a TypeScript re-implementation of it — the artifact that
 * ships is the artifact under test. `gh` is a fake that prints its argv, so nothing here touches
 * real GitHub, and a pass means the shim really did (or really did not) exec.
 */
let dir: string;
let binDir: string;
let root: string;

/** A stand-in `gh`: prints what it was asked to do and succeeds. */
const FAKE_GH = `#!/bin/sh
echo "REAL GH: $@"
exit 0
`;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pags-ghguard-"));
	binDir = join(dir, "bin");
	root = join(dir, "guard");
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, "gh"), FAKE_GH);
	chmodSync(join(binDir, "gh"), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Install a guard for `scope` and run `gh <args>` through it. */
function runGh(scope: string[], args: string[]) {
	const out = installGhGuard(scope, { PATH: binDir }, root);
	if (!("dir" in out)) throw new Error(`guard not installed: ${out.reason}`);
	const r = spawnSync(join(out.dir, "gh"), args, { encoding: "utf8" });
	return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const SCOPE = ["ProAgentStore/platform"];

describe("the gh guard refuses a write outside the session's scope", () => {
	it("refuses `gh pr create --repo <other>` and names the repository it refused", () => {
		const r = runGh(SCOPE, ["pr", "create", "--repo", "proappstore-online/platform", "--title", "x"]);
		expect(r.code).toBe(GH_REFUSED_EXIT);
		expect(r.stderr).toContain(GH_REFUSED_MARKER);
		expect(r.stderr).toContain("proappstore-online/platform");
		// The reason has to be actionable in the pane the Pilot reads, not a bare non-zero exit.
		expect(r.stderr).toContain("not registered for");
		expect(r.stdout).not.toContain("REAL GH"); // it never reached the real binary
	});

	it("refuses the other write verbs the same way, including `-R` and `--repo=`", () => {
		for (const args of [
			["issue", "comment", "5", "-R", "someone/else", "--body", "hi"],
			["release", "create", "v1", "--repo=someone/else"],
			["repo", "delete", "--repo", "someone/else"],
			["workflow", "run", "deploy.yml", "-R", "someone/else"],
			["secret", "set", "TOKEN", "-R", "someone/else"],
		]) {
			const r = runGh(SCOPE, args);
			expect(r.code, args.join(" ")).toBe(GH_REFUSED_EXIT);
			expect(r.stderr).toContain("someone/else");
		}
	});

	it("refuses a mutating `gh api`, taking the target out of the /repos path", () => {
		// The generic escape hatch. Without this, `gh api -X POST repos/x/y/issues` walks straight
		// past a list of named verbs.
		const r = runGh(SCOPE, ["api", "-X", "POST", "repos/someone/else/issues", "-f", "title=x"]);
		expect(r.code).toBe(GH_REFUSED_EXIT);
		expect(r.stderr).toContain("someone/else");
	});
});

describe("the gh guard lets everything else through untouched", () => {
	it("a CROSS-REPO `gh pr view` still succeeds — the property most likely to be lost", () => {
		// Verified production case: instance a185b1db, session csess_42bdfe20, 2026-08-16T01:38:04Z,
		// the Pilot running `gh pr view 138 --repo proappstore-online/platform`. A guard that broke
		// this would be withdrawn within a day and the containment would go with it.
		const r = runGh(SCOPE, ["pr", "view", "138", "--repo", "proappstore-online/platform"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("REAL GH: pr view 138 --repo proappstore-online/platform");
	});

	it("a write to the session's OWN repo runs, case- and host-insensitively", () => {
		for (const target of ["ProAgentStore/platform", "proagentstore/PLATFORM", "github.com/ProAgentStore/platform"]) {
			const r = runGh(SCOPE, ["pr", "create", "--repo", target, "--title", "x"]);
			expect(r.code, target).toBe(0);
			expect(r.stdout).toContain("REAL GH: pr create");
		}
	});

	it("a write with NO --repo runs — gh resolves it from the working directory, which is a STATED gap", () => {
		// Ordinarily the working directory IS the repo the session was registered for, and refusing
		// this would break `gh pr create` inside the agent's own checkout — the common case. But the
		// Engine has a shell and can `cd`, so this is not containment, and the gap list says so
		// rather than the diagnostics implying otherwise.
		const r = runGh(SCOPE, ["pr", "create", "--title", "x", "--body", "y"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("REAL GH: pr create");
	});

	it("a read through `gh api` runs, and so does a graphql call — which is a STATED gap", () => {
		expect(runGh(SCOPE, ["api", "repos/someone/else/pulls"]).code).toBe(0);
		// Not classified on purpose: deciding whether a query string mutates is a judgement over
		// free prose. It is reported as a gap rather than half-enforced.
		expect(runGh(SCOPE, ["api", "graphql", "-f", "query=mutation{}"]).code).toBe(0);
	});

	it("passes every argument through verbatim, quoting and all", () => {
		const r = runGh(SCOPE, ["pr", "comment", "1", "--body", "two words 'quoted'"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("two words 'quoted'");
	});
});

describe("the guard fails OPEN, and says which way it failed", () => {
	it("installs nothing when the platform named no scope", () => {
		// An older cloud sends none. Refusing every write on that basis would break those sessions,
		// so the absence of a scope means "not said", never "allow nothing".
		expect(installGhGuard([], { PATH: binDir }, root)).toEqual({ reason: "no-scope" });
		const env = ghGuardEnv({ PATH: binDir }, undefined, root);
		expect(env.PATH).toBe(binDir);
		expect(ghGuardStatus(undefined, { PATH: binDir }, root)).toMatchObject({ installed: false, reason: "no-scope" });
	});

	it("installs nothing when this machine has no gh at all", () => {
		expect(installGhGuard(SCOPE, { PATH: join(dir, "nowhere") }, root)).toEqual({ reason: "gh-not-found" });
	});

	it("never resolves ITSELF as the real gh", () => {
		// Once the guard is on PATH, a second generation resolving `gh` would find the shim and
		// exec it — a loop that would hang every gh call the engine makes.
		const out = installGhGuard(SCOPE, { PATH: binDir }, root);
		if (!("dir" in out)) throw new Error("expected an install");
		expect(findRealGh(`${out.dir}:${binDir}`, root)).toBe(join(binDir, "gh"));
		expect(readFileSync(join(out.dir, "gh"), "utf8")).toContain(join(binDir, "gh"));
	});

	it("puts the guard AHEAD of the real gh on PATH when it is installed", () => {
		const env = ghGuardEnv({ PATH: binDir }, SCOPE, root);
		expect(env.PATH?.endsWith(`:${binDir}`)).toBe(true);
		expect(env.PATH?.startsWith(binDir)).toBe(false);
	});

	it("reports the gaps it does NOT close, so no surface can overstate it", () => {
		const report = ghGuardStatus(SCOPE, { PATH: binDir }, root);
		expect(report).toMatchObject({ installed: true, scope: ["proagentstore/platform"] });
		expect(report.gaps.join(" ")).toContain("git push");
		expect(report.gaps.join(" ")).toContain("bypassable");
		expect(report.gaps.join(" ")).toContain("graphql");
		// The fourth is the one a reader would otherwise infer the opposite of, because the guard
		// looks like it inspects every write: an unqualified write is resolved from the cwd and is
		// not checked at all. Every gap the shim leaves has to be in this list, since
		// `coding_diagnostics` reports it verbatim and nothing downstream re-derives it.
		expect(report.gaps.join(" ")).toContain("no `--repo`");
		expect(report.gaps).toHaveLength(4);
	});
});

describe("normalizeRepo", () => {
	it("reduces every shape gh accepts to one comparable key", () => {
		expect(normalizeRepo("ProAgentStore/platform")).toBe("proagentstore/platform");
		expect(normalizeRepo("github.com/ProAgentStore/platform")).toBe("proagentstore/platform");
		expect(normalizeRepo("https://github.com/ProAgentStore/platform.git")).toBe("proagentstore/platform");
		expect(normalizeRepo("  ProAgentStore/platform  ")).toBe("proagentstore/platform");
	});
});
