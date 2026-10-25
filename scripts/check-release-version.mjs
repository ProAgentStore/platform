#!/usr/bin/env node
/**
 * check-release-version.mjs - a push that changes shipped code must bump a version npm does not have (#1321).
 *
 * Run: `node scripts/check-release-version.mjs <base> [head]` (head defaults to HEAD). CI passes the push's `before` and the new SHA.
 * Reads the changed files between them, each published package's version at head, and asks npm whether that version exists.
 * Exits 1 when shipped code changed under an already-published version. With no usable base (a first push, a zero SHA, a ref git
 * cannot resolve) it says so and exits 0: there is no range to judge.
 */
import { execFileSync } from "node:child_process";
import { evaluateRelease, formatProblems, PACKAGES } from "./lib/release-gate.mjs";

const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function versionAt(ref, file) {
	try {
		const v = JSON.parse(git(["show", `${ref}:${file}`])).version;
		return typeof v === "string" ? v : null;
	} catch {
		return null;
	}
}

/** true / false, or null when npm cannot be reached (a 404 for an unpublished version is `false`, not an error). */
function publishedOnNpm(name, version) {
	try {
		return execFileSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim() === version;
	} catch (e) {
		const text = `${e.stderr ?? ""}${e.stdout ?? ""}`;
		return /E404|No match found|is not in this registry/i.test(text) ? false : null;
	}
}

function main() {
	const [base, head = "HEAD"] = process.argv.slice(2);
	if (!base || /^0+$/.test(base)) {
		console.log("✓ Release gate: no base commit to compare against; nothing to judge.");
		return;
	}
	let changed;
	try {
		changed = git(["diff", "--name-only", `${base}..${head}`]).split("\n").filter(Boolean);
	} catch {
		console.log(`✓ Release gate: ${base} is not a commit this checkout has; nothing to judge.`);
		return;
	}
	const versions = Object.fromEntries(PACKAGES.map((p) => [p.name, versionAt(head, p.versionFile)]));
	const result = evaluateRelease({ changed, versions, isPublished: publishedOnNpm });
	if (!result.ok || result.unknown.length) console.log(formatProblems(result));
	if (!result.ok) process.exit(1);
	console.log(`✓ Release gate: ${changed.length} changed file(s); no shipped code under an already-published version.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
