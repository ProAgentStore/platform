#!/usr/bin/env node
// CI guard (#49 / epic #50): only Tier-0 agents may live in the monorepo under `agents/` —
// the ones the platform actually builds/imports. A normal catalog agent is a standalone org
// repo (cloned to ~/dev/stores/pags/agents/<slug>), NOT a folder here; adding one back only
// grows the stale-copy graveyard the platform explicitly removed. Fail the build if a new
// folder appears outside the allowlist. If something is genuinely Tier-0, add it below.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = new Set(["coder", "job-application-assistant", "repo-chat"]);

const dir = "agents";
let entries = [];
try {
	entries = readdirSync(dir).filter((n) => {
		try {
			return statSync(join(dir, n)).isDirectory();
		} catch {
			return false;
		}
	});
} catch {
	console.log(`✓ no ${dir}/ directory — nothing to check.`);
	process.exit(0);
}

const offenders = entries.filter((n) => !ALLOWED.has(n));
if (offenders.length) {
	console.error(`✗ Disallowed agent folder(s) under ${dir}/: ${offenders.join(", ")}`);
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
