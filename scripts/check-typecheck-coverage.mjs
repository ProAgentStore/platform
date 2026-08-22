#!/usr/bin/env node
/**
 * check-typecheck-coverage.mjs — every workspace project is typechecked by CI, or its
 * absence is recorded here with a reason (#740).
 *
 * WHY. `ci.yml` typechecked by a hand-written list of directories. Each `tsc` step was
 * added one at a time, each after a real incident, each correct — so the list covered
 * exactly the six projects that had already burned someone. Measured 2026-08-23 at
 * `a8c1927`: `export const plantedTypeError: number = "not a number";` planted in five
 * files at once — packages/cli, packages/browser-runner, packages/compliance,
 * agents/job-application-assistant and workers/host — passed EVERY gate this workflow
 * declares, including the full 10,226-test vitest run, because vitest transpiles without
 * typechecking. 12,662 lines of TypeScript that nothing compiled, among them the CLI +
 * runner bundle a user installs with `npm i -g @proagentstore/cli` and runs on their own
 * machine with their own credentials.
 *
 * `pnpm -r typecheck` closes ten of the eleven, and `ci.yml` now runs it. This guard is
 * the part that makes it COUNTABLE, because `pnpm -r` fails open: it runs the script
 * only where the script exists, prints `Scope: 11 of 12 workspace projects`, and names
 * the one it dropped NOWHERE. A member that never declares `typecheck` is therefore
 * silently uncovered forever — the same "an empty selection and a clean tree look
 * identical" failure the sweep was added to fix, moved one level down.
 *
 * ADR 0002 — this asserts a NUMBER (projects covered, out of projects that exist), which
 * is G2. It is not the mechanical G1-presence check that ADR 0002's Enforcement section
 * deliberately declines; that one would grade on an assertion EXISTING, this one grades
 * on the denominator matching the workspace on disk.
 *
 * G4, proven by watching it fail — recorded 2026-08-23:
 *   • deleting `"typecheck"` from `packages/cli/package.json` → red, naming packages/cli
 *   • removing `pnpm -r typecheck` from `.github/workflows/ci.yml` → red
 *   • giving `workers/host` a `typecheck` script → red, "stale exemption"
 *   • a `packages/*` glob that matches nothing → red from the reader, not a green zero
 *
 * Run: `node scripts/check-typecheck-coverage.mjs`
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceMembers } from "./lib/workspace-members.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = resolve(ROOT, "pnpm-workspace.yaml");
const CI = resolve(ROOT, ".github/workflows/ci.yml");

/** The command in `ci.yml` that actually does the sweep. Named here so removing it from
 *  the workflow fails this guard instead of quietly halving what CI compiles. */
const SWEEP = "pnpm -r typecheck";

/**
 * Fewer members than this means the workspace file moved or the reader stopped reading
 * it, not that the repo shrank. ADR 0002 G1: a bound with a reason, never one chosen to
 * make today's number pass. Eleven exist today; ten is the floor at which "a project was
 * deliberately removed" is still plausible and "the list is gone" is not.
 */
const MIN_MEMBERS = 10;

/**
 * Members with no `typecheck` script, and why. An entry is a debt with a name on it, not
 * an exception — the guard fails if one becomes stale, so the list can only shrink
 * without someone editing this file.
 */
const EXEMPT = {
	"workers/host":
		"`src/index.ts:12` imports `./pages.js`, which `build.js` GENERATES from `store/` and\n" +
		"  `.gitignore:13` excludes. On a clean checkout that module does not exist, so `tsc` here\n" +
		"  cannot run until `pnpm docs:build`, a console build and `node build.js` have all run —\n" +
		"  the deploy-host.yml ordering. `src/cors.test.ts` records the same constraint for the\n" +
		"  same reason and answers it with a source scan rather than importing the worker.\n" +
		"  Measured 2026-08-23: a `tsconfig.json` here also needs a `@cloudflare/workers-types`\n" +
		"  devDependency it does not have (TS2688). A committed `src/pages.d.ts` IS resolved for\n" +
		"  `./pages.js` when `src/pages.ts` is absent — verified — but it would hand-declare 32\n" +
		"  generated exports with nothing comparing it to `build.js`, which is precisely the\n" +
		"  'certifies ground it never walked' shape ADR 0002 forbids.\n" +
		"  COST OF THIS ENTRY: 290 non-test lines that ship to production are typechecked by\n" +
		"  nothing. Remove it once #740 step 3 is decided — either the types dep plus a\n" +
		"  post-`build.js` typecheck, or a declaration whose drift from `build.js` is itself\n" +
		"  checked.",
};

function fail(lines) {
	console.error(`\n✗ ${lines.join("\n")}\n`);
	process.exit(1);
}

let members;
try {
	members = workspaceMembers(ROOT, readFileSync(WORKSPACE, "utf8"));
} catch (err) {
	// A reader that cannot read is a guard measuring nothing — say so as a failure, not
	// as a clean tree (ADR 0002 G3).
	fail([
		"Could not read pnpm-workspace.yaml, so this guard measured NOTHING:",
		`  ${err.message}`,
		"",
		"  Teach scripts/lib/workspace-members.mjs the new shape — do not delete the check.",
	]);
}

if (members.length < MIN_MEMBERS) {
	fail([
		`pnpm-workspace.yaml resolves to ${members.length} project(s), below the floor of ${MIN_MEMBERS}.`,
		"  That reads as the workspace list having moved rather than the repo having shrunk.",
		"  If projects were genuinely removed, lower MIN_MEMBERS in the same commit.",
	]);
}

const covered = [];
const uncovered = [];
const notPackages = [];

for (const member of members) {
	const manifest = resolve(ROOT, member, "package.json");
	if (!existsSync(manifest)) {
		// pnpm treats a directory with no manifest as "not a member". Report it rather
		// than dropping it, so a project that lost its package.json is visible.
		notPackages.push(member);
		continue;
	}
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(manifest, "utf8"));
	} catch (err) {
		fail([`${member}/package.json could not be parsed, so its coverage is unknown:`, `  ${err.message}`]);
	}
	if (typeof pkg.scripts?.typecheck === "string" && pkg.scripts.typecheck.trim()) covered.push(member);
	else uncovered.push(member);
}

const problems = [];

// A member that is uncovered and unrecorded is the whole point of the guard.
const unrecorded = uncovered.filter((m) => !(m in EXEMPT));
for (const member of unrecorded) {
	problems.push(
		`${member} declares no \`typecheck\` script, so \`${SWEEP}\` skips it silently.\n` +
			'    Add `"typecheck": "tsc --noEmit"` to its package.json, or record it in EXEMPT\n' +
			"    in this file with the reason it cannot be typechecked.",
	);
}

// An exemption that no longer describes reality is a lie the build keeps telling.
for (const [member, reason] of Object.entries(EXEMPT)) {
	if (!members.includes(member)) {
		problems.push(`EXEMPT lists ${member}, which is no longer a workspace project. Delete the entry.`);
		continue;
	}
	if (covered.includes(member)) {
		problems.push(
			`EXEMPT lists ${member}, but it now declares a \`typecheck\` script — the debt was paid.\n` +
				"    Delete the entry so the exemption list keeps shrinking.",
		);
	}
	if (!reason.trim()) problems.push(`EXEMPT lists ${member} with an empty reason.`);
}

// The sweep this guard exists to protect must actually be wired.
let ci = "";
try {
	ci = readFileSync(CI, "utf8");
} catch (err) {
	problems.push(`Could not read .github/workflows/ci.yml: ${err.message}`);
}
if (ci && !ci.includes(SWEEP)) {
	problems.push(
		`.github/workflows/ci.yml no longer runs \`${SWEEP}\`.\n` +
			`    Without it this guard certifies ${covered.length} projects that CI does not compile,\n` +
			"    which is a worse state than having neither.",
	);
}

if (problems.length) {
	fail([
		`${problems.length} problem(s) in typecheck coverage across ${members.length} workspace project(s):`,
		"",
		...problems.map((p) => `  • ${p}`),
	]);
}

const exemptNames = Object.keys(EXEMPT).sort();
const denominator = covered.length + uncovered.length;
console.log(
	`✓ typecheck coverage: ${denominator} of ${denominator} workspace project(s) accounted for — ` +
		`${covered.length} compiled by \`${SWEEP}\` in ci.yml` +
		(exemptNames.length ? `, ${exemptNames.length} recorded exempt (${exemptNames.join(", ")}).` : "."),
);
if (notPackages.length) {
	console.log(
		`  ${notPackages.length} directory/ies matched by pnpm-workspace.yaml carry no package.json ` +
			`and are not projects: ${notPackages.join(", ")}`,
	);
}
