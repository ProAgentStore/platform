/**
 * The opt-in hooks' plan (#902): which of CI's checks a change runs locally. The hook is a
 * trip-wire, so its one hard requirement is that it never checks something CI does not — and
 * never drifts from CI's own commands, which the last test pins against the workflow file.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { biomeTargets, CI_GUARDS, commandsNeedingHostPages, HOST_BUILD_INPUTS, HOST_PAGES, HOST_PREREQUISITES, hostPagesMessage, hostPagesPlan, memberOf, relatedTestTargets, typecheckCommands } from "./hook-plan.mjs";

const MEMBERS = ["agents/coder/web", "packages/sdk", "store/console", "workers/api", "workers/host", "workers/mcp"];
const INFO = {
	"agents/coder/web": { typecheck: true, testConfig: false },
	"packages/sdk": { typecheck: true, testConfig: true },
	"store/console": { typecheck: true, testConfig: false },
	"workers/api": { typecheck: true, testConfig: true },
	"workers/host": { typecheck: false, testConfig: false },
	"workers/mcp": { typecheck: true, testConfig: true },
};
const info = (dir) => INFO[dir];

describe("biomeTargets — CI's lint scope and nothing wider", () => {
	it("keeps code and JSON under the four directories CI lints", () => {
		expect(biomeTargets(["workers/api/src/a.ts", "store/console/src/b.tsx", "packages/cli/package.json", "agents/coder/web/src/c.ts"])).toHaveLength(4);
	});

	it("drops what CI never lints: other directories, other agents, docs, CSS", () => {
		expect(biomeTargets(["scripts/x.mjs", "agents/site-monitor/src/a.ts", "README.md", "store/console/src/x.css", "e2e/a.spec.ts"])).toEqual([]);
	});
});

describe("typecheckCommands — only the projects a change touched, the way CI checks them", () => {
	it("maps a file to its project, longest path first", () => {
		expect(memberOf("agents/coder/web/src/a.ts", [...MEMBERS, "agents/coder"])).toBe("agents/coder/web");
		expect(memberOf("scripts/a.mjs", MEMBERS)).toBeNull();
	});

	it("runs a project's typecheck, plus its test config where CI checks one", () => {
		expect(typecheckCommands(["workers/api/src/a.ts", "workers/api/src/b.ts"], MEMBERS, info)).toEqual([
			["pnpm", "--dir", "workers/api", "run", "typecheck"],
			["pnpm", "--dir", "workers/api", "exec", "tsc", "-p", "tsconfig.test.json"],
		]);
		expect(typecheckCommands(["store/console/src/a.tsx"], MEMBERS, info)).toEqual([["pnpm", "--dir", "store/console", "run", "typecheck"]]);
	});

	it("checks nothing for files outside every project, and skips a project with no typecheck", () => {
		expect(typecheckCommands(["scripts/a.mjs", "README.md"], MEMBERS, info)).toEqual([]);
		expect(typecheckCommands(["workers/host/build.js"], MEMBERS, info)).toEqual([]);
	});

	it("re-checks every project when a shared root config changes", () => {
		const all = typecheckCommands(["tsconfig.base.json"], MEMBERS, info).map((c) => c[2]);
		expect(new Set(all)).toEqual(new Set(["agents/coder/web", "packages/sdk", "store/console", "workers/api", "workers/mcp"]));
	});
});

describe("relatedTestTargets", () => {
	it("passes source and test files, not declarations, docs or data", () => {
		expect(relatedTestTargets(["a.ts", "b.tsx", "c.mjs", "d.d.ts", "e.md", "f.json", "g.test.ts"])).toEqual(["a.ts", "b.tsx", "c.mjs", "g.test.ts"]);
	});
});

describe("the pre-push guards are CI's guards", () => {
	it("runs exactly the guard scripts ci.yml runs, with the same arguments", () => {
		const ci = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../.github/workflows/ci.yml"), "utf8");
		const inCi = [...ci.matchAll(/run: node (scripts\/check-[\w-]+\.mjs)([^\n]*)/g)].map((m) => [m[1], ...m[2].trim().split(/\s+/).filter(Boolean)]);
		// e2e projects need a Playwright install and a built console; that one stays CI-only. So does the release gate (#1321): it
		// compares a push's range (CI's `before`..`sha`) and asks npm what is published, neither of which a local push has.
		const CI_ONLY = new Set(["scripts/check-e2e-projects.mjs", "scripts/check-release-version.mjs"]);
		const local = inCi.filter(([s]) => !CI_ONLY.has(s));
		expect(CI_GUARDS).toEqual(local);
		expect(CI_GUARDS.length).toBeGreaterThan(10);
	});
});

/**
 * #1564 — a clean checkout has no `workers/host/src/pages.ts` (build output, gitignored), and `tsc -p tsconfig.test.json` for the API
 * fails with TS2307 because the cross-package tests import the host index, which imports `./pages.js`. Vitest's stub resolver does not
 * apply to `tsc`. The hook now builds the pages as CI does when it can, and says precisely what is missing when it cannot.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const API_TEST_TSC = ["pnpm", "--dir", "workers/api", "exec", "tsc", "-p", "tsconfig.test.json"];
const API_PROD_TSC = ["pnpm", "--dir", "workers/api", "run", "typecheck"];

describe("which typechecks need the generated host pages (#1564)", () => {
	it("the API's TEST typecheck does — it is the one that reaches the host index across packages", () => {
		expect(commandsNeedingHostPages([API_PROD_TSC, API_TEST_TSC])).toEqual([API_TEST_TSC]);
	});

	it("the API's production typecheck, other projects, and a change that runs no typecheck do not", () => {
		expect(commandsNeedingHostPages([API_PROD_TSC])).toEqual([]);
		expect(commandsNeedingHostPages([["pnpm", "--dir", "workers/mcp", "exec", "tsc", "-p", "tsconfig.test.json"], ["pnpm", "--dir", "packages/sdk", "run", "typecheck"]])).toEqual([]);
		expect(commandsNeedingHostPages([])).toEqual([]);
	});

	it("the host's own program does, whichever script runs it", () => {
		expect(commandsNeedingHostPages([["pnpm", "--dir", "workers/host", "run", "typecheck"]])).toHaveLength(1);
	});

	it("is derived from the commands the hook really plans, not a parallel list", () => {
		const cmds = typecheckCommands(["workers/api/src/a.ts"], MEMBERS, info);
		expect(commandsNeedingHostPages(cmds)).toEqual([API_TEST_TSC]);
		expect(commandsNeedingHostPages(typecheckCommands(["workers/mcp/src/a.ts"], MEMBERS, info))).toEqual([]);
	});
});

describe("hostPagesPlan over a real clean checkout (#1564)", () => {
	/** A throwaway tree standing in for a fresh `git clone` + frozen-lockfile install: none of the generated files exist. */
	function checkout() {
		const dir = mkdtempSync(join(tmpdir(), "pags-host-pages-"));
		const exists = (p) => {
			try {
				return readFileSync(join(dir, p)) !== undefined;
			} catch {
				return false;
			}
		};
		const put = (p) => {
			mkdirSync(dirname(join(dir, p)), { recursive: true });
			writeFileSync(join(dir, p), "x");
		};
		return { dir, exists, put, done: () => rmSync(dir, { recursive: true, force: true }) };
	}

	it("THE REPORTED STATE: nothing generated, so the hook STOPS and names exactly what is missing and how to build it", () => {
		const c = checkout();
		try {
			const plan = hostPagesPlan([API_TEST_TSC], c.exists);
			expect(plan.action).toBe("report");
			expect(plan.missing).toEqual(HOST_BUILD_INPUTS);
			expect(plan.message).toContain(HOST_PAGES);
			expect(plan.message).toContain("TS2307");
			expect(plan.message).toContain("pnpm --dir workers/api exec tsc -p tsconfig.test.json");
			for (const input of HOST_BUILD_INPUTS) expect(plan.message).toContain(input);
			// CI's commands, in CI's order, so someone can paste them.
			const at = HOST_PREREQUISITES.map((cmd) => plan.message.indexOf(cmd));
			expect(at.every((i) => i >= 0)).toBe(true);
			expect([...at].sort((a, b) => a - b)).toEqual(at);
			expect(plan.message).toMatch(/Nothing was pushed/);
		} finally {
			c.done();
		}
	});

	it("only SOME inputs built: it names the ones still missing, not all of them", () => {
		const c = checkout();
		try {
			for (const p of HOST_BUILD_INPUTS.filter((x) => x.startsWith("store/console"))) c.put(p);
			const plan = hostPagesPlan([API_TEST_TSC], c.exists);
			expect(plan.action).toBe("report");
			expect(plan.missing).toEqual(HOST_BUILD_INPUTS.filter((x) => !x.startsWith("store/console")));
			expect(plan.message).not.toContain("store/console/dist/assets/bundle.js");
		} finally {
			c.done();
		}
	});

	it("every input present but pages.ts missing: the hook BUILDS it, exactly as CI's last step does", () => {
		const c = checkout();
		try {
			for (const p of HOST_BUILD_INPUTS) c.put(p);
			expect(hostPagesPlan([API_TEST_TSC], c.exists)).toEqual({ action: "build", command: ["node", "workers/host/build.js"] });
		} finally {
			c.done();
		}
	});

	it("pages.ts present: nothing to do — a built checkout is never rebuilt or interrupted", () => {
		const c = checkout();
		try {
			c.put(HOST_PAGES);
			expect(hostPagesPlan([API_TEST_TSC], c.exists)).toEqual({ action: "none" });
		} finally {
			c.done();
		}
	});

	it("a push that runs no host-dependent typecheck is never blocked by the missing pages", () => {
		const c = checkout();
		try {
			expect(hostPagesPlan([API_PROD_TSC], c.exists)).toEqual({ action: "none" });
			expect(hostPagesPlan([], c.exists)).toEqual({ action: "none" });
			expect(hostPagesPlan(typecheckCommands(["packages/sdk/src/a.ts"], MEMBERS, info), c.exists)).toEqual({ action: "none" });
		} finally {
			c.done();
		}
	});

	it("never fabricates anything: the plan only ever builds the real file or reports; it has no 'stub' action", () => {
		const c = checkout();
		try {
			const actions = new Set([hostPagesPlan([API_TEST_TSC], c.exists).action]);
			for (const p of HOST_BUILD_INPUTS) c.put(p);
			actions.add(hostPagesPlan([API_TEST_TSC], c.exists).action);
			c.put(HOST_PAGES);
			actions.add(hostPagesPlan([API_TEST_TSC], c.exists).action);
			expect([...actions].sort()).toEqual(["build", "none", "report"]);
		} finally {
			c.done();
		}
	});
});

describe("the host-pages prerequisite is CI's, and build.js's own (#1564)", () => {
	const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

	it("each prerequisite is a `run:` step in ci.yml, in the order the hook tells a person to run them", () => {
		const at = HOST_PREREQUISITES.map((cmd) => ci.indexOf(`run: ${cmd}`));
		expect(at.every((i) => i >= 0), `a prerequisite is not a CI run step: ${HOST_PREREQUISITES.filter((_, i) => at[i] < 0).join(" | ")}`).toBe(true);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
	});

	it("CI builds them BEFORE the API's test typecheck, which is the whole reason they are prerequisites", () => {
		const build = ci.indexOf("run: cd workers/host && node build.js");
		const testTypecheck = ci.indexOf("tsc -p tsconfig.test.json");
		expect(build).toBeGreaterThan(0);
		expect(testTypecheck).toBeGreaterThan(build);
	});

	it("the inputs the hook checks are the files build.js actually reads, so it can never claim 'ready' while build.js would throw", () => {
		const build = readFileSync(join(ROOT, "workers/host/build.js"), "utf8");
		for (const frag of ["consoleDir", "adminDir", '"dist", "assets", "bundle.js"', '"dist", "assets", "index.css"', 'storeDir, "docs"', "/docs/sitemap.xml"]) {
			expect(build, `build.js no longer contains ${frag} — update HOST_BUILD_INPUTS`).toContain(frag);
		}
		expect(HOST_BUILD_INPUTS).toEqual(expect.arrayContaining(["store/console/dist/assets/bundle.js", "store/admin/dist/assets/index.css", "store/docs/sitemap.xml"]));
	});

	it("pages.ts really is gitignored, so a clean checkout really lacks it — the premise of all of this", () => {
		expect(readFileSync(join(ROOT, ".gitignore"), "utf8")).toMatch(/^workers\/host\/src\/pages\.ts$/m);
	});

	it("the message is plain text a person can act on: it names the file, the failing step and every missing input", () => {
		const msg = hostPagesMessage(["store/docs/sitemap.xml"], [API_TEST_TSC]);
		expect(msg).toContain(HOST_PAGES);
		expect(msg).toContain("store/docs/sitemap.xml");
		expect(msg).toContain("pnpm docs:build");
		expect(msg.split("\n").length).toBeGreaterThan(5);
	});
});
