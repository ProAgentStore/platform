import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateRelease, formatProblems, PACKAGES, shippedFiles } from "./lib/release-gate.mjs";

const CLI = PACKAGES[0];
const SDK = PACKAGES[1];
const published = (set) => (name, version) => set.has(`${name}@${version}`);

describe("what counts as shipped", () => {
	it("the CLI ships its own source, its scripts, and the browser runner it bundles", () => {
		expect(shippedFiles(CLI, ["packages/cli/src/index.ts", "packages/cli/scripts/copy-browser-runner.mjs", "packages/browser-runner/src/coding/headless.ts"])).toHaveLength(3);
	});

	it("tests, fixtures and docs never reach the package", () => {
		expect(shippedFiles(CLI, ["packages/cli/src/index.test.ts", "packages/browser-runner/src/coding/x.test.ts", "packages/browser-runner/src/coding/windows-runner.fixture.ts", "packages/browser-runner/src/README.md", "packages/browser-runner/APPLICATION_PROFILES.md", "workers/api/src/x.ts", "docs/a.md"])).toEqual([]);
	});

	it("the SDK is its own package: an SDK change is not a CLI change", () => {
		expect(shippedFiles(CLI, ["packages/sdk/src/client.ts"])).toEqual([]);
		expect(shippedFiles(SDK, ["packages/sdk/src/client.ts", "packages/sdk/src/client.test.ts"])).toEqual(["packages/sdk/src/client.ts"]);
	});
});

describe("evaluateRelease (#1321)", () => {
	const v = { "@proagentstore/cli": "0.4.176", "@proagentstore/sdk": "0.2.0" };

	it("FAILS: shipped CLI code changed and the version is already on npm - the #1312 state", () => {
		const r = evaluateRelease({ changed: ["packages/cli/src/relay.ts"], versions: v, isPublished: published(new Set(["@proagentstore/cli@0.4.176"])) });
		expect(r.ok).toBe(false);
		expect(r.problems).toEqual([expect.objectContaining({ pkg: "@proagentstore/cli", version: "0.4.176", files: ["packages/cli/src/relay.ts"] })]);
		expect(formatProblems(r)).toContain("already on npm");
		expect(formatProblems(r)).toContain("Bump the version");
	});

	it("a change to the bundled browser runner counts - that is where #1312's detector lived", () => {
		const r = evaluateRelease({ changed: ["packages/browser-runner/src/relay.ts"], versions: v, isPublished: published(new Set(["@proagentstore/cli@0.4.176"])) });
		expect(r.ok).toBe(false);
	});

	it("passes when the version was bumped to one npm does not have", () => {
		const r = evaluateRelease({ changed: ["packages/cli/src/relay.ts"], versions: { ...v, "@proagentstore/cli": "0.4.177" }, isPublished: published(new Set(["@proagentstore/cli@0.4.176"])) });
		expect(r).toMatchObject({ ok: true, problems: [], unknown: [] });
	});

	it("passes when only tests, docs or the cloud changed, even under a published version", () => {
		const r = evaluateRelease({ changed: ["packages/cli/src/relay.test.ts", "docs/x.md", "workers/api/src/a.ts"], versions: v, isPublished: published(new Set(["@proagentstore/cli@0.4.176"])) });
		expect(r.ok).toBe(true);
	});

	it("judges each package on its own version", () => {
		const r = evaluateRelease({ changed: ["packages/sdk/src/a.ts", "packages/cli/src/b.ts"], versions: { ...v, "@proagentstore/cli": "0.4.177" }, isPublished: published(new Set(["@proagentstore/sdk@0.2.0"])) });
		expect(r.problems.map((p) => p.pkg)).toEqual(["@proagentstore/sdk"]);
	});

	it("an unknown answer from npm is reported, not failed - a registry outage must not block a push", () => {
		const r = evaluateRelease({ changed: ["packages/cli/src/a.ts"], versions: v, isPublished: () => null });
		expect(r.ok).toBe(true);
		expect(r.unknown).toEqual([expect.objectContaining({ pkg: "@proagentstore/cli" })]);
		expect(formatProblems(r)).toContain("could not be asked");
	});

	it("a version file with no readable version fails closed", () => {
		const r = evaluateRelease({ changed: ["packages/cli/src/a.ts"], versions: { ...v, "@proagentstore/cli": null }, isPublished: () => false });
		expect(r.ok).toBe(false);
	});

	it("lists a long run of files with a count", () => {
		const files = Array.from({ length: 12 }, (_, i) => `packages/cli/src/f${i}.ts`);
		const text = formatProblems(evaluateRelease({ changed: files, versions: v, isPublished: () => true }));
		expect(text).toContain("… and 4 more");
	});
});

describe("the script, against a real git history with a fake npm", () => {
	const dir = mkdtempSync(join(tmpdir(), "release-gate-"));
	const bin = join(dir, "bin");
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const git = (...a) => execFileSync("git", a, { cwd: join(dir, "repo"), encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
	const put = (rel, text) => {
		mkdirSync(join(dir, "repo", rel, ".."), { recursive: true });
		writeFileSync(join(dir, "repo", rel), text);
	};
	const pkg = (cli, sdk = "0.2.0") => {
		put("packages/cli/package.json", JSON.stringify({ version: cli }));
		put("packages/sdk/package.json", JSON.stringify({ version: sdk }));
	};
	const commit = (msg) => {
		git("add", "-A");
		git("commit", "-q", "-m", msg);
		return git("rev-parse", "HEAD");
	};
	/** A fake npm: `published` is the list of name@version it knows; anything else is a 404; `down` makes it unreachable. */
	const fakeNpm = (published, down = false) => {
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "npm"), `#!/bin/sh\n${down ? 'echo "npm ERR! network" >&2; exit 1' : `case "$2" in ${published.map((p) => `"${p}") echo "\${2##*@}";;`).join(" ")} *) echo "npm ERR! code E404" >&2; exit 1;; esac`}\n`);
		chmodSync(join(bin, "npm"), 0o755);
	};
	const run = (base, head) => spawnSync(process.execPath, [join(import.meta.dirname, "check-release-version.mjs"), base, head], { cwd: join(dir, "repo"), encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

	mkdirSync(join(dir, "repo"), { recursive: true });
	git("init", "-q", "-b", "main");
	pkg("0.4.176");
	put("packages/cli/src/relay.ts", "export const a = 1;\n");
	const base = commit("base");

	it("a shipped change under the published version exits 1 and names the file and the fix", () => {
		fakeNpm(["@proagentstore/cli@0.4.176", "@proagentstore/sdk@0.2.0"]);
		put("packages/cli/src/relay.ts", "export const a = 2; // capability reporter\n");
		const head = commit("feature without a bump");
		const r = run(base, head);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("@proagentstore/cli@0.4.176 is already on npm");
		expect(r.stdout).toContain("packages/cli/src/relay.ts");
	});

	it("the same change with the version bumped passes", () => {
		pkg("0.4.177");
		const head = commit("bump");
		const r = run(base, head);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("✓ Release gate");
	});

	it("a docs-only change under a published version passes", () => {
		const before = git("rev-parse", "HEAD");
		fakeNpm(["@proagentstore/cli@0.4.177", "@proagentstore/sdk@0.2.0"]);
		put("docs/notes.md", "hello\n");
		put("packages/cli/src/relay.test.ts", "// a test\n");
		const head = commit("docs and tests");
		expect(run(before, head).status).toBe(0);
	});

	it("npm unreachable: reported, not failed", () => {
		const before = git("rev-parse", "HEAD");
		fakeNpm([], true);
		put("packages/cli/src/relay.ts", "export const a = 3;\n");
		const head = commit("change while npm is down");
		const r = run(before, head);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("could not be asked");
	});

	it("no base (a first push) or an unknown base: nothing to judge, exit 0", () => {
		expect(run("0000000000000000000000000000000000000000", "HEAD").status).toBe(0);
		const r = run("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "HEAD");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("nothing to judge");
	});
});
