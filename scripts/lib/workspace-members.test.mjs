/**
 * Unit tests for the `pnpm-workspace.yaml` reader behind `check-typecheck-coverage.mjs`
 * (#740).
 *
 * ADR 0002's follow-on note requires a hand-rolled reader to carry its own test naming
 * what it does NOT handle. That is most of what is here: the reader's value is not that
 * it parses the file we have, it is that it refuses to half-parse a file we do not, so
 * the guard above it cannot report a smaller workspace than the one on disk.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { expandPattern, parseWorkspacePatterns, workspaceMembers } from "./workspace-members.mjs";

const roots = [];
function scratch(dirs) {
	const root = mkdtempSync(join(tmpdir(), "pags-ws-"));
	roots.push(root);
	for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
	return root;
}
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("parseWorkspacePatterns", () => {
	it("reads a block sequence of quoted scalars, in file order", () => {
		const src = ["packages:", "  - 'packages/*'", "  - 'workers/*'", "  - 'store/console'", ""].join("\n");
		expect(parseWorkspacePatterns(src)).toEqual(["packages/*", "workers/*", "store/console"]);
	});

	it("reads the repo's real pnpm-workspace.yaml shape, comments and all", () => {
		const src = [
			"# a leading comment",
			"packages:",
			"  # the SDK and friends",
			'  - "packages/*"',
			"  - 'agents/coder/web'",
			"",
			"onlyBuiltDependencies:",
			"  - esbuild",
		].join("\n");
		expect(parseWorkspacePatterns(src)).toEqual(["packages/*", "agents/coder/web"]);
	});

	it("throws when there is no `packages:` block, rather than reporting zero members", () => {
		expect(() => parseWorkspacePatterns("onlyBuiltDependencies:\n  - esbuild\n")).toThrow(/no `packages:` block/);
	});

	it("throws when `packages:` is empty, because an empty workspace measures nothing", () => {
		expect(() => parseWorkspacePatterns("packages:\n\nother: 1\n")).toThrow(/empty/);
	});

	// NOT handled — each of these must throw, never be skipped.
	it("throws on a flow sequence", () => {
		expect(() => parseWorkspacePatterns("packages: ['a', 'b']\n")).toThrow(/inline value/);
	});

	it("throws on a bare (unquoted) scalar entry", () => {
		expect(() => parseWorkspacePatterns("packages:\n  - packages/*\n")).toThrow(/not a quoted scalar/);
	});

	it("throws on an entry it cannot read as a list item", () => {
		expect(() => parseWorkspacePatterns("packages:\n  packages/*: true\n")).toThrow(/unreadable entry/);
	});
});

describe("expandPattern", () => {
	it("expands a single trailing /* to every child directory, sorted", () => {
		const root = scratch(["packages/sdk", "packages/cli", "packages/browser-runner"]);
		expect(expandPattern(root, "packages/*")).toEqual([
			"packages/browser-runner",
			"packages/cli",
			"packages/sdk",
		]);
	});

	it("skips dot-directories, which are never workspace members", () => {
		const root = scratch(["packages/sdk", "packages/.cache"]);
		expect(expandPattern(root, "packages/*")).toEqual(["packages/sdk"]);
	});

	it("returns a literal path unchanged", () => {
		const root = scratch(["store/console"]);
		expect(expandPattern(root, "store/console")).toEqual(["store/console"]);
	});

	it("throws when a literal path does not exist", () => {
		const root = scratch(["store/console"]);
		expect(() => expandPattern(root, "store/admin")).toThrow(/does not exist/);
	});

	it("throws when a /* pattern matches nothing — it would select an empty set", () => {
		const root = scratch(["packages"]);
		expect(() => expandPattern(root, "packages/*")).toThrow(/matched no directory/);
	});

	// NOT handled.
	it("throws on a nested glob", () => {
		const root = scratch(["packages/sdk"]);
		expect(() => expandPattern(root, "packages/**")).toThrow(/not handled/);
	});

	it("throws on a mid-segment star", () => {
		const root = scratch(["packages/sdk"]);
		expect(() => expandPattern(root, "pack*/sdk")).toThrow(/not handled/);
	});

	it("throws on a negation", () => {
		const root = scratch(["packages/sdk"]);
		expect(() => expandPattern(root, "!packages/sdk")).toThrow(/negated/);
	});
});

describe("workspaceMembers", () => {
	it("deduplicates a member selected by both a glob and a literal path", () => {
		const root = scratch(["packages/sdk", "packages/cli"]);
		const src = "packages:\n  - 'packages/*'\n  - 'packages/sdk'\n";
		expect(workspaceMembers(root, src)).toEqual(["packages/cli", "packages/sdk"]);
	});

	it("agrees with the real workspace file on this repo", () => {
		const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
		const src = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
		const members = workspaceMembers(repoRoot, src);
		// The denominator this guard exists to protect. If the workspace legitimately
		// grows or shrinks, this number moves in the same commit as the change.
		expect(members.length).toBeGreaterThanOrEqual(11);
		expect(members).toContain("workers/host");
		expect(members).toContain("packages/browser-runner");
	});
});

// Left unpinned on purpose: `packages/*` also selects a directory with no package.json,
// which pnpm treats as "not a member". Deciding that is the caller's job, not the
// reader's — see check-typecheck-coverage.mjs, which counts and reports those rather
// than dropping them silently.
