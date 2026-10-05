/**
 * The opt-in hooks' plan (#902): which of CI's checks a change runs locally. The hook is a
 * trip-wire, so its one hard requirement is that it never checks something CI does not — and
 * never drifts from CI's own commands, which the last test pins against the workflow file.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { biomeTargets, CI_GUARDS, memberOf, relatedTestTargets, typecheckCommands } from "./hook-plan.mjs";

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
		// e2e projects need a Playwright install and a built console; that one stays CI-only.
		const local = inCi.filter(([s]) => s !== "scripts/check-e2e-projects.mjs");
		expect(CI_GUARDS).toEqual(local);
		expect(CI_GUARDS.length).toBeGreaterThan(10);
	});
});
