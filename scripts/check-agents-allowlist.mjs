#!/usr/bin/env node
// CI guard (#49 / epic #50): only Tier-0 agents may live in the monorepo under `agents/` —
// the ones the platform actually builds/imports. A normal catalog agent is a standalone org
// repo (cloned to ~/dev/stores/pags/agents/<slug>), NOT a folder here; adding one back only
// grows the stale-copy graveyard the platform explicitly removed. Fail the build if a new
// folder appears outside the allowlist. If something is genuinely Tier-0, add it below.
//
// ADR 0002 (G1) — worked example. This guard used to resolve `agents/` relative to the CWD and
// answer a missing directory with a TICK and exit 0. Run from anywhere but the repo root it
// certified the allowlist having read nothing, and `agents/` is tracked, so "the directory this
// guard exists to police is gone" is news rather than a clean tree. The path is now anchored to
// this file like every other guard under scripts/, and an unreadable `agents/` fails.
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED = new Set(["coder", "job-application-assistant", "repo-chat"]);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(ROOT, "agents");
let entries = [];
try {
	entries = readdirSync(dir).filter((n) => {
		try {
			return statSync(join(dir, n)).isDirectory();
		} catch {
			return false;
		}
	});
} catch (err) {
	console.error(`✗ Could not read ${dir}: ${err.message}`);
	console.error("  agents/ is tracked, so this is the guard losing its input, not a clean tree.");
	process.exit(1);
}

const offenders = entries.filter((n) => !ALLOWED.has(n));
if (offenders.length) {
	console.error(`✗ Disallowed agent folder(s) under agents/: ${offenders.join(", ")}`);
	console.error(`  Only Tier-0 agents may live in the monorepo: ${[...ALLOWED].join(", ")}.`);
	console.error(
		"  A normal catalog agent is a standalone org repo (see epic #50), not a folder here.",
	);
	console.error(
		"  Remove it, or add it to ALLOWED in scripts/check-agents-allowlist.mjs if it's genuinely Tier-0.",
	);
	process.exit(1);
}
console.log(`✓ agents/ contains only Tier-0 agents (${entries.join(", ") || "none"}).`);
