/**
 * doc-files.mjs — the INPUT SETS behind `scripts/docs-drift.mjs`, and their floors (#604).
 *
 * ── Why these moved out of docs-drift.mjs
 *
 * Adding `docs/` to the sweep took that file over the 800-line ratchet, and the ratchet said
 * what it says every time: "split it now, which is cheaper than it will ever be again". This
 * is the same split `doc-claims.mjs`, `mcp-split.mjs` and `claim-shape.mjs` already made, for
 * the reason all three give — a function that takes strings or a root path can be tested
 * against the shape that broke it, where one welded into a 800-line script can only be tested
 * against whatever the repo happens to contain today.
 *
 * ── What `docs/` being absent cost
 *
 * `docFiles()` collected `platform-docs/`; `servedHtmlFiles()` skips any directory named
 * `docs`. So `docs/` — the internal design records, the verification logs, and `docs/adr/`,
 * where this repo keeps the constraints whose violation looks locally correct — was read by
 * NO gate at all. An audit found 27 findings across 9 of its 21 files while `pnpm docs:drift`
 * passed all thirteen checks, and `architecture.md:132` was bisected to the commit that
 * introduced it: there was never an instant at which it agreed with the code, so a sweep would
 * have caught it on its first day.
 *
 * ── What `skills/` and `plugins/` being absent costs (#741)
 *
 * The operator skill (`skills/proagentstore-mcp-operator/SKILL.md`) is the canonical artefact
 * installed into MCP clients (Codex, Claude Code). It was last touched 2026-08-06 while the MCP
 * server published seven versions since — listing 33 of 145 tools and never mentioning the
 * `confirm` gate that six of those tools require. Nothing read it. Adding it here puts it under
 * checks 5, 6, 6b, 6c and 7 — the tool-table parity check, the "N tools" claims, and the
 * confirm-gate check. Its own floor is separate from the totals so the skill cannot vanish while
 * the aggregate stays plausible.
 *
 * ── ADR 0002 (a guard states what it measured)
 *
 * G1 is the whole point of this module: every collector here asserts its own size, and
 * `docs/` gets its OWN floor rather than being absorbed into the total. A floor on the sum
 * would let the entire directory disappear while the number stayed plausible, which is the
 * failure mode being fixed — not a smaller version of it.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** An input set this script cannot collect is not a clean tree — it is a check that has
 *  stopped running. Same construction as scripts/check-design-tokens.mjs:97-101, and for
 *  the same reason: the number a guard prints is trusted, so it must be a measurement. */
export const requireInputs = (what, got, floor, why) => {
	if (got >= floor) return;
	console.error(
		`✗ ${what}: collected ${got}, expected at least ${floor}.\n  ${why}\n` +
			"  This guard would pass by checking nothing. Fix the collector — do not lower the floor\n" +
			"  to make today's number pass.",
	);
	process.exit(1);
};

/** Everything a reader or an agent is expected to trust. */
export function docFiles(p) {
	const files = [];
	const add = (f) => {
		if (existsSync(f) && statSync(f).isFile()) files.push(f);
	};
	for (const name of readdirSync(p("platform-docs"))) {
		if (name.endsWith(".md")) add(p("platform-docs", name));
	}
	add(p("store/llms.txt"));
	add(p("store/llms-full.txt"));
	// `docs/` — the internal design records, ADRs and verification logs. Read by NO gate
	// until #604: `docFiles()` collected `platform-docs/` and `servedHtmlFiles()` skips any
	// directory named `docs`, so the whole tree sat outside every input set. An audit found 27
	// findings across 9 of its 21 files while docs:drift passed all thirteen checks, and
	// `architecture.md:132` was bisected to the commit that introduced it — there was never a
	// moment when it agreed with the code, so a sweep would have caught it on day one.
	//
	// Recursive because `docs/adr/` is where the constraints live.
	const walkDocs = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walkDocs(full);
			else if (entry.name.endsWith(".md")) files.push(full);
		}
	};
	const beforeDocs = files.length;
	walkDocs(p("docs"));
	requireInputs(
		"docFiles() — docs/",
		files.length - beforeDocs,
		15,
		"docs/ holds 21 markdown files including docs/adr/. A walk finding fewer has lost the\n" +
			"  directory, and this whole tree was invisible to every gate until #604.",
	);
	add(p("README.md"));
	add(p("AGENTS.md"));
	add(p("SECURITY.md"));
	for (const dir of ["workers", "packages", "agents", "templates"]) {
		const base = p(dir);
		if (!existsSync(base)) continue;
		for (const name of readdirSync(base)) {
			// CLAUDE.md counts: it is guidance an agent acts on, and it drifted the same
			// way everything else did — it carried "`/health` reports a hardcoded
			// `tools: 41`" as a documented gotcha.
			for (const doc of ["README.md", "AGENTS.md", "CLAUDE.md"]) {
				add(join(base, name, doc));
			}
		}
	}
	// `skills/` and `plugins/` — the operator skill installed into MCP clients. Read by NO
	// gate until #741: the skill listed 33 of 145 tools and never mentioned the `confirm` gate
	// that six of those tools require, and nothing caught it.
	//
	// The skill lives in THREE copies that must stay identical: `skills/<slug>/SKILL.md` is the
	// canonical source; `plugins/codex/…/SKILL.md` and `plugins/claude/…/SKILL.md` are the
	// client-specific copies. All three are added here so checks 5–7 sweep them; a separate
	// copy-equality check in docs-drift.mjs ensures they match.
	const beforeSkills = files.length;
	const skillsBase = p("skills");
	if (existsSync(skillsBase)) {
		for (const slug of readdirSync(skillsBase)) {
			add(join(skillsBase, slug, "SKILL.md"));
		}
	}
	const pluginsBase = p("plugins");
	if (existsSync(pluginsBase)) {
		const walkPlugins = (dir) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walkPlugins(full);
				else if (entry.name === "SKILL.md") files.push(full);
			}
		};
		walkPlugins(pluginsBase);
	}
	requireInputs(
		"docFiles() — skills/ + plugins/",
		files.length - beforeSkills,
		3,
		"skills/ has one SKILL.md and plugins/ has two client-specific copies. A walk finding\n" +
			"  fewer than 3 has lost a directory or a copy was deleted without updating the other two.",
	);
	requireInputs(
		"docFiles()",
		files.length,
		20,
		"platform-docs alone holds ten pages, and every worker and package carries a README.",
	);
	return files;
}

/** The marketing site as it is SERVED. `workers/host/build.js` inlines each of these into
 *  `pages.ts`, so what is here is what a visitor reads — and none of it was in any input
 *  set until #555, which is why /about could carry a number nothing compared to anything.
 *
 *  `store/docs` is excluded because it is generated from platform-docs (already covered,
 *  and absent in a fresh checkout); `dist` is Vite output for the console and admin SPAs,
 *  whose source is .tsx. */
export function servedHtmlFiles(p) {
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (["docs", "dist", "node_modules"].includes(entry.name)) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".html")) files.push(full);
		}
	};
	walk(p("store"));
	requireInputs(
		"servedHtmlFiles()",
		files.length,
		8,
		"store/ carries the homepage, about, get-started, skills, agent detail, developer profile,\n" +
			"  changelog, 404 and the app/* legal pages — a walk that finds fewer has lost a directory.",
	);
	return files;
}
