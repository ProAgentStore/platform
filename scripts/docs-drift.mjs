#!/usr/bin/env node
/**
 * docs-drift.mjs — fail when the docs describe something the code does not do (#210).
 *
 * The audit behind that issue found five drifts at once: runtime docs disagreeing on
 * relay-vs-tunnel, a README describing a task type that no longer exists, an OpenAPI
 * spec missing most of the API, Coder docs calling shipped UI "future work", and
 * `GET /health` on the MCP server reporting 41 tools when it registered 124. None of
 * them broke a build. Prose is the one part of this repo nothing checks, so it rots
 * silently and then teaches an agent something false.
 *
 * The checks here are deliberately narrow. Each one either compares a documented
 * NUMBER or NAME to the code that defines it, or asserts the absence of a specific
 * removed thing. There is no snapshot of prose: a giant golden file would fail on
 * every honest edit and be deleted within a month.
 *
 *   1. nav ↔ sources        every zensical nav entry is a real page, and every page is
 *                           reachable from the nav
 *   2. generated output     store/docs/** is build output and must not be committed
 *   3. removed commands     no runnable code block teaches `--tunnel` / `cloudflared`
 *   4. removed identity     the runtime docs no longer claim the FAGS runtime plane
 *   5. MCP tool surface     README's tool table == the tools actually registered
 *   6. MCP tool count       every "N tools" claim == workers/mcp/src/tool-count.ts
 *  6b. MCP always-on split every "N are always …" / "N are gated" claim == the OTHER two
 *                          constants in that same file, which nothing compared (#575)
 *   7. confirm gates        every documented `confirm` value == a requireConfirmation site
 *   8. wire surface         every fact a client RECEIVES — tool annotations, output schemas,
 *                           the advertised version — == the code defining it, and is named
 *                           in the docs (#572, #573; scripts/lib/wire-surface.mjs)
 *   9. docs links           every /docs/<slug>/ URL resolves to a real page
 *  10. API surface          delegates to scripts/openapi-coverage.mjs (#209)
 *
 * ── Every check states its denominator (#555, and #559's proposed ADR 0002)
 *
 * Check 6 shipped with a success line reading "135 registered == constant == every doc
 * claim" over a hand-written list of THREE paths. The served marketing site was in none of
 * the input sets, so https://proagentstore.online/about/ told every prospective user the
 * MCP server had "~67 tools" while `/health` served 135 — understating the product by 68
 * tools, past the one guard whose job was that comparison, in a green build.
 *
 * The rule taken from that, applied to every check here:
 *
 *   - the input set is ASSERTED, not assumed. `docFiles()` and `servedHtmlFiles()` fail
 *     when they collect implausibly little, because "found nothing" and "found nothing
 *     wrong" print the same tick.
 *   - a file this script expects a claim from must PRODUCE one. Grepping prose has two
 *     failure modes and only one of them is loud: `\d+ tools` does not match "135 MCP
 *     tools", so an honest rewrite would otherwise retire the check on that file in
 *     silence. See scripts/lib/doc-claims.mjs.
 *   - a listed path that does not exist is a failure, never a skip.
 *   - every ✓ line names how many files it read.
 *
 * Run: `node scripts/docs-drift.mjs`  (or `pnpm docs:drift`)
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	diffConfirm,
	findToolCountClaims,
	parseConfirmBullets,
	parseConfirmCallSites,
	parseConfirmProse,
	parseConfirmTable,
} from "./lib/doc-claims.mjs";
import { SUBSET_CLAIMS, checkClaimShape } from "./lib/claim-shape.mjs";
import { docFiles as collectDocFiles, requireInputs, servedHtmlFiles as collectServedHtml } from "./lib/doc-files.mjs";
import { checkMcpSplit } from "./lib/mcp-split.mjs";
import { checkWireSurface } from "./lib/wire-surface.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...s) => resolve(ROOT, ...s);
const rel = (f) => relative(ROOT, f).split(sep).join("/");
const read = (f) => readFileSync(f, "utf8");

const failures = [];
const notes = [];
const fail = (check, message) => failures.push({ check, message });
const ok = (message) => notes.push(message);


// ─────────────────────────────────────────────────────────────────────────────
// Inputs — collectors + their ADR 0002 floors live in scripts/lib/doc-files.mjs (#604)
// ─────────────────────────────────────────────────────────────────────────────

const docFiles = () => collectDocFiles(p);
const servedHtmlFiles = () => collectServedHtml(p);


/** Lines that live inside a ``` fence — i.e. things a reader is meant to RUN. Prose
 *  may freely discuss a removed flag ("there is no `--tunnel` flag"); a code block
 *  cannot, because a code block is an instruction. */
function fencedLines(src) {
	const out = [];
	let inFence = false;
	src.split("\n").forEach((line, i) => {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			return;
		}
		if (inFence) out.push({ line, n: i + 1 });
	});
	return out;
}

/** Every `server.tool("name", …)` registration in the MCP worker, plus how many live in
 *  each source file — the module layout in workers/mcp/CLAUDE.md quotes the per-file
 *  numbers, and they rot exactly like the total does. */
function mcpSourceFiles() {
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) files.push(full);
		}
	};
	walk(p("workers/mcp/src"));
	requireInputs(
		"mcpSourceFiles()",
		files.length,
		10,
		"workers/mcp/src holds index.ts, safety.ts and a dozen instance-tools modules.",
	);
	return files;
}

const MCP_SOURCES = mcpSourceFiles();

function mcpTools() {
	const names = new Set();
	const perFile = new Map();
	for (const full of MCP_SOURCES) {
		let n = 0;
		for (const m of read(full).matchAll(
			/(?:^|[^\w.])(?:this\.)?server\.tool\(\s*"([a-z0-9_]+)"/g,
		)) {
			names.add(m[1]);
			n++;
		}
		if (n) perFile.set(full.split(sep).pop(), n);
	}
	requireInputs(
		"mcpTools()",
		names.size,
		50,
		"`server.tool(` is how every tool is registered; matching none means the shape moved.",
	);
	return { names, perFile };
}

/** The nav is the site's table of contents; a page missing from it is built and
 *  unreachable, which reads to a user exactly like a page that does not exist. */
function navPages() {
	const toml = read(p("zensical.toml"));
	const navBlock = toml.match(/^nav = \[([\s\S]*?)^\]/m);
	if (!navBlock) return null;
	return [...navBlock[1].matchAll(/"([^"]+\.md)"/g)].map((m) => m[1]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. nav ↔ sources
// ─────────────────────────────────────────────────────────────────────────────

const nav = navPages();
if (!nav) {
	fail("nav", "Could not parse the `nav = [...]` table out of zensical.toml.");
} else {
	const sources = readdirSync(p("platform-docs")).filter((f) => f.endsWith(".md"));
	const missing = nav.filter((n) => !sources.includes(n));
	const orphans = sources.filter((s) => !nav.includes(s));
	if (missing.length) {
		fail(
			"nav",
			`zensical.toml nav points at ${missing.length} page(s) with no source file: ${missing.join(", ")}.\n` +
				"  `zensical build --strict` would fail on this; catching it here says which file to add.",
		);
	}
	if (orphans.length) {
		fail(
			"nav",
			`platform-docs has ${orphans.length} page(s) missing from the zensical.toml nav: ${orphans.join(", ")}.\n` +
				"  They are built but unreachable — indistinguishable from not existing. Add them to nav,\n" +
				"  or delete the file if it was superseded.",
		);
	}
	if (!missing.length && !orphans.length) {
		ok(`nav ↔ sources: ${nav.length} nav entries vs ${sources.length} source pages, both directions`);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. generated output must not be committed
// ─────────────────────────────────────────────────────────────────────────────

{
	let tracked = null;
	try {
		tracked = execFileSync("git", ["ls-files", "store/docs"], { cwd: ROOT, encoding: "utf8" })
			.split("\n")
			.filter(Boolean);
	} catch {
		ok("generated docs: 0 files read — git not available, so this check did NOT run");
	}
	if (tracked) {
		if (tracked.length) {
			fail(
				"generated-docs",
				`store/docs is build output but ${tracked.length} file(s) are committed.\n` +
					"  It is rebuilt from platform-docs by `pnpm docs:build` in BOTH ci.yml and\n" +
					"  deploy-host.yml, so the committed copy is never what ships — it can only be stale.\n" +
					"  It was: the checked-in mcp page was missing the whole Tool Surface section that\n" +
					"  platform-docs/mcp.md has had for weeks. `git rm -r --cached store/docs`.",
			);
		} else {
			ok(`generated docs: git tracks ${tracked.length} file(s) under store/docs`);
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 3–4. removed things
// ─────────────────────────────────────────────────────────────────────────────

/** Removed from the product. A code block that still shows one is a set of
 *  instructions that cannot work. */
const REMOVED_COMMANDS = [
	{ token: "--tunnel", why: "the CLI flag was removed; the WebSocket relay is the only transport" },
	{ token: "cloudflared", why: "the tunnel binary is no longer a dependency" },
	{ token: "job.apply_basic", why: "superseded by the LLM-driven `job.apply_agent` pipeline" },
];

/** Removed from the runtime's identity. The browser runtime advertised itself as
 *  FAGS until `runtimePlane` became "pags"; docs that still say otherwise send a
 *  reader to the wrong store. README may name FreeAgentStore — it is a sibling
 *  store in the ecosystem table, which is a different claim. */
const REMOVED_IDENTITY = [
	{ token: "FAGS", why: 'the runtime plane is `runtimePlane: "pags"`' },
	{ token: "freeagentstore-browser-runtime", why: "the service id is `proagentstore-browser-runtime`" },
];
const IDENTITY_SCOPE = ["platform-docs/", "store/llms"];

{
	const cmdHits = [];
	const idHits = [];
	const docs = docFiles();
	let fenced = 0;
	let idFiles = 0;
	for (const file of docs) {
		const src = read(file);
		const name = rel(file);
		const fences = fencedLines(src);
		fenced += fences.length;
		for (const { line, n } of fences) {
			for (const { token, why } of REMOVED_COMMANDS) {
				if (line.includes(token)) cmdHits.push({ name, n, token, why, line: line.trim() });
			}
		}
		if (!IDENTITY_SCOPE.some((prefix) => name.startsWith(prefix))) continue;
		idFiles++;
		src.split("\n").forEach((line, i) => {
			for (const { token, why } of REMOVED_IDENTITY) {
				if (line.includes(token)) idHits.push({ name, n: i + 1, token, why, line: line.trim() });
			}
		});
	}
	// A fenced-line count of zero means fencedLines() stopped recognising a fence, at which
	// point "no code block teaches --tunnel" is true of no code blocks at all.
	requireInputs(
		"fenced code lines",
		fenced,
		200,
		"Every runtime doc in platform-docs opens with a shell block; the docs are full of them.",
	);
	requireInputs(
		"identity-scoped docs",
		idFiles,
		3,
		`IDENTITY_SCOPE (${IDENTITY_SCOPE.join(", ")}) matched no file — the paths moved.`,
	);
	if (cmdHits.length) {
		fail(
			"removed-commands",
			`${cmdHits.length} runnable code block(s) still teach a removed command:\n` +
				cmdHits
					.map((h) => `    ${h.name}:${h.n}  ${h.token} — ${h.why}\n      ${h.line}`)
					.join("\n"),
		);
	} else {
		ok(
			`removed commands: ${REMOVED_COMMANDS.length} tokens absent from ${fenced} fenced line(s) ` +
				`in ${docs.length} doc file(s)`,
		);
	}
	if (idHits.length) {
		fail(
			"removed-identity",
			`${idHits.length} line(s) in the platform docs still claim the old runtime identity:\n` +
				idHits.map((h) => `    ${h.name}:${h.n}  ${h.token} — ${h.why}`).join("\n"),
		);
	} else {
		ok(
			`removed identity: ${REMOVED_IDENTITY.length} tokens absent from ${idFiles} ` +
				"platform-docs/llms file(s)",
		);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 5–6. the MCP tool surface
// ─────────────────────────────────────────────────────────────────────────────

const { names: registered, perFile: registeredPerFile } = mcpTools();

{
	const readme = p("workers/mcp/README.md");
	const documented = new Set(
		[...read(readme).matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|/gm)].map((m) => m[1]),
	);
	const undocumented = [...registered].filter((t) => !documented.has(t)).sort();
	const phantom = [...documented].filter((t) => !registered.has(t)).sort();
	if (undocumented.length) {
		fail(
			"mcp-tools",
			`workers/mcp/README.md omits ${undocumented.length} registered tool(s): ${undocumented.join(", ")}.\n` +
				"  That table is what an agent reads to decide what it can do; a missing row is a\n" +
				"  capability nobody uses.",
		);
	}
	if (phantom.length) {
		fail(
			"mcp-tools",
			`workers/mcp/README.md documents ${phantom.length} tool(s) that are not registered: ${phantom.join(", ")}.\n` +
				"  Worse than an omission — an agent will call it and get an error.",
		);
	}
	if (!undocumented.length && !phantom.length) {
		ok(
			`MCP tool table: ${registered.size} registered across ${MCP_SOURCES.length} source(s) == ` +
				`${documented.size} documented rows in workers/mcp/README.md, exact match`,
		);
	}
}

{
	const src = read(p("workers/mcp/src/tool-count.ts"));
	const constOf = (name) => {
		const m = src.match(new RegExp(`export const ${name} = (\\d+)`));
		return m ? Number(m[1]) : null;
	};
	const declared = constOf("MCP_TOOL_COUNT");
	const alwaysOn = constOf("MCP_TOOL_ALWAYS_ON");

	if (declared === null) {
		fail("mcp-count", "workers/mcp/src/tool-count.ts no longer exports a numeric MCP_TOOL_COUNT.");
	} else if (declared !== registered.size) {
		fail(
			"mcp-count",
			`MCP_TOOL_COUNT says ${declared}; ${registered.size} tools are actually registered.\n` +
				"  `/health` and three docs quote this number. index.test.ts asserts it against a real\n" +
				"  registration run — update the constant, do not loosen the test.",
		);
	}

	// Every "N tools" / "N tool registrations" claim must be that number — swept across the
	// WHOLE trusted surface (docFiles + the served marketing HTML), not a hand-written list.
	// The list was three paths and the sweep is now ~90 files; #555's defect was on the one
	// page a prospective user reads, which was in neither the list nor docFiles().
	//
	// One file is exempt, and only because it is checked HARDER elsewhere — the reason lives
	// with the list in claim-shape.mjs, because check 6c honours the same exemption and one
	// decision restated in two places is how the two come to mean different things.

	// Files that MUST state the total. The other half of the denominator: a claim that is
	// deleted, or rephrased past the regex ("135 MCP tools" does not match), otherwise
	// retires the check on that file and reads exactly like agreement.
	const MUST_CLAIM = [
		"platform-docs/mcp.md",
		"store/llms-full.txt",
		"workers/mcp/README.md",
		"store/about/index.html",
	];

	const sweep = [...docFiles(), ...servedHtmlFiles()];
	const badClaims = [];
	const claimsPerFile = new Map();
	for (const file of sweep) {
		const name = rel(file);
		if (SUBSET_CLAIMS.includes(name)) continue;
		const claims = findToolCountClaims(read(file));
		claimsPerFile.set(name, claims.length);
		for (const c of claims) {
			if (declared !== null && c.claimed !== declared) {
				badClaims.push({ name, ...c });
			}
		}
	}
	if (badClaims.length) {
		fail(
			"mcp-count",
			`${badClaims.length} doc claim(s) disagree with MCP_TOOL_COUNT (${declared}), ` +
				`out of ${sweep.length} file(s) swept:\n` +
				badClaims
					.map((b) => `    ${b.name}:${b.n}  says ${b.claimed}\n      ${b.line.slice(0, 120)}`)
					.join("\n"),
		);
	}

	const silent = MUST_CLAIM.filter((name) => !claimsPerFile.get(name));
	if (silent.length) {
		fail(
			"mcp-count",
			`${silent.length} file(s) are listed as stating the MCP tool total and no longer do:\n` +
				silent.map((name) => `    ${name}`).join("\n") +
				"\n  Either the file is not in the swept set (check docFiles/servedHtmlFiles), or the\n" +
				'  sentence was rephrased past `N tools` — "135 MCP tools" does not match. A claim that\n' +
				"  stops being visible to this check is how /about drifted 68 tools out (#555). Restore\n" +
				"  the phrasing, or remove the file from MUST_CLAIM as a decision.",
		);
	}

	// The per-surface gated table in platform-docs/mcp.md must add up to the gap
	// between "always on" and the total — the split is the whole point of the table.
	const mcpDoc = read(p("platform-docs/mcp.md"));
	const gatedRows = [...mcpDoc.matchAll(/^\|\s*`(apply|repo|coding)`\s*\|([^|]*)\|/gm)];
	if (gatedRows.length && alwaysOn !== null && declared !== null) {
		const listed = gatedRows.reduce(
			(sum, row) => sum + [...row[2].matchAll(/`[a-z0-9_]+`/g)].length,
			0,
		);
		const expected = declared - alwaysOn;
		if (listed !== expected) {
			fail(
				"mcp-count",
				`platform-docs/mcp.md lists ${listed} surface-gated tool(s); MCP_TOOL_COUNT - MCP_TOOL_ALWAYS_ON is ${expected}.\n` +
					"  Either a gated tool is missing from the table or the constants moved without it.",
			);
		}
	}

	// The module layout in workers/mcp/CLAUDE.md gives a per-file count. Matched only when
	// the number follows the filename directly (`base.ts   65 tools`) — a line like
	// `coding.ts  system_status (gated) + 3 loop tools` is prose about a subset, and
	// guessing at it would produce a false failure, which is how a check gets deleted.
	const claudeDoc = p("workers/mcp/CLAUDE.md");
	if (existsSync(claudeDoc)) {
		const src = read(claudeDoc);
		const badFiles = [];
		src.split("\n").forEach((line, i) => {
			const m = line.match(/^[\s│├└─]*([\w.-]+\.ts)\s+(\d+)\s+tools?\b/);
			if (!m) return;
			const actual = registeredPerFile.get(m[1]);
			if (actual === undefined || actual === Number(m[2])) return;
			badFiles.push({ n: i + 1, file: m[1], claimed: Number(m[2]), actual });
		});
		if (badFiles.length) {
			fail(
				"mcp-count",
				`workers/mcp/CLAUDE.md's module layout miscounts ${badFiles.length} file(s):\n` +
					badFiles
						.map((b) => `    line ${b.n}  ${b.file}: says ${b.claimed}, registers ${b.actual}`)
						.join("\n"),
			);
		}
		if (declared !== null && !src.includes(`${declared} tool registrations`)) {
			fail(
				"mcp-count",
				`workers/mcp/CLAUDE.md does not state "${declared} tool registrations".\n` +
					"  It is the guidance a session in that directory reads before touching the tool\n" +
					"  surface; a stale total there is the drift that started this check (it carried\n" +
					'  "`/health` reports a hardcoded `tools: 41`" as documented behaviour).',
			);
		}
	}

	if (!failures.some((f) => f.check === "mcp-count")) {
		const total = [...claimsPerFile.values()].reduce((a, b) => a + b, 0);
		ok(
			`MCP tool count: ${registered.size} registered == constant == ${total} claim(s) ` +
				`across ${claimsPerFile.size} file(s) swept (${MUST_CLAIM.length} required to state it, ` +
				`${SUBSET_CLAIMS.length} exempt) + ${registeredPerFile.size} per-file counts`,
		);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 6b. the always-on / surface-gated SPLIT — the two constants beside the one
//     that was already checked
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `tool-count.ts` exports three numbers and check 6 compared ONE of them to anything, so
 * `workers/mcp/CLAUDE.md` could say — and did — "114 are always registered; 18 are
 * surface-gated (apply=4, repo=3, coding=11+3)": wrong against the constant, wrong against
 * its own paragraph, and wrong inside its own parentheses (#575).
 *
 * The comparison, its floors and its reasoning are in scripts/lib/mcp-split.mjs, unit-tested
 * against strings. The sweep is the SAME one check 6 uses, passed in rather than recomputed,
 * so the two checks cannot come to disagree about what the trusted surface is.
 */
{
	const files = [...docFiles(), ...servedHtmlFiles()].map((f) => ({ name: rel(f), src: read(f) }));
	const { failures: splitFailures, notes: splitNotes } = checkMcpSplit({
		toolCountSrc: read(p("workers/mcp/src/tool-count.ts")),
		files,
	});
	for (const f of splitFailures) fail(f.check, f.message);
	for (const n of splitNotes) ok(n);

	// 6c. …and the SHAPE arm over the same sweep: a document that quantifies the tool
	// surface in a phrasing neither check above can read is a claim nothing compares to
	// anything, which is how AGENTS.md:15 carried a stale 124 through a green build (#603).
	const { failures: shapeFailures, notes: shapeNotes } = checkClaimShape({ files });
	for (const f of shapeFailures) fail(f.check, f.message);
	for (const n of shapeNotes) ok(n);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. confirm gates — three documents transcribe one list; compare each to the CODE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `requireConfirmation(…, "tool", confirm, "expected", …)` is the only thing that makes a
 * tool confirm-gated. Three surfaces restate that list by hand and nothing compared any of
 * them to the call sites, so `store/llms.txt` and `store/llms-full.txt` both said "Twelve
 * tools … eleven use their own name" while the code gated THIRTEEN — `delete_supervision`
 * missing from both (#555). The two llms files are the LLM-facing ones, i.e. the reader
 * that cannot ask.
 *
 * Each parser reports its own denominator, because "documents nothing" and "documents
 * everything correctly" are otherwise the same result.
 */
{
	const sites = parseConfirmCallSites(
		MCP_SOURCES.filter((f) => !f.endsWith(`${sep}safety.ts`)).map((f) => ({
			name: rel(f),
			src: read(f),
		})),
	);
	requireInputs(
		"confirm call sites",
		sites.size,
		10,
		"`requireConfirmation(` is the gate itself; matching none means the helper was renamed.",
	);
	const known = new Set(sites.keys());

	/** @type {{name: string, tools: Map<string,string>, found: number, how: string}[]} */
	const surfaces = [];
	{
		const f = "platform-docs/mcp.md";
		const tools = parseConfirmBullets(read(p(f)));
		surfaces.push({ name: f, tools, found: tools.size, how: "`tool`: `confirm: \"value\"` bullets" });
	}
	{
		const f = "workers/mcp/README.md";
		const { tools, tables } = parseConfirmTable(read(p(f)));
		surfaces.push({ name: f, tools, found: tables, how: "the Confirm column of its tool tables" });
	}
	for (const f of ["store/llms.txt", "store/llms-full.txt"]) {
		const { tools, stated, lines } = parseConfirmProse(read(p(f)), known);
		const ownName = [...sites].filter(([t, v]) => v.expected === t).length;
		surfaces.push({ name: f, tools, found: lines, how: "its confirm sentence" });
		if (lines && (stated[0] !== sites.size || stated[1] !== ownName)) {
			fail(
				"confirm-gates",
				`${f}'s confirm sentence states ${stated[0] ?? "?"}/${stated[1] ?? "?"}; the code gates ` +
					`${sites.size} tools, ${ownName} of them by their own name.\n` +
					"  The counts are written as words on purpose — digits there would collide with the\n" +
					"  MCP tool-total check above.",
			);
		}
	}

	for (const s of surfaces) {
		if (!s.found) {
			fail(
				"confirm-gates",
				`${s.name}: found no confirm declarations by reading ${s.how}.\n` +
					"  Either the list was deleted or its shape moved. This check would otherwise pass by\n" +
					"  comparing an empty set to the code and reporting agreement.",
			);
			continue;
		}
		const { missing, phantom, wrong } = diffConfirm(sites, s.tools);
		if (missing.length) {
			fail(
				"confirm-gates",
				`${s.name} omits ${missing.length} confirm-gated tool(s): ${missing.join(", ")}.\n` +
					missing.map((t) => `    gated at ${sites.get(t).at}`).join("\n") +
					"\n  An agent reading this will call the tool without `confirm` and be refused.",
			);
		}
		if (phantom.length) {
			fail(
				"confirm-gates",
				`${s.name} documents ${phantom.length} confirm gate(s) that no call site declares: ${phantom.join(", ")}.`,
			);
		}
		if (wrong.length) {
			fail(
				"confirm-gates",
				`${s.name} gives the wrong confirm value for ${wrong.length} tool(s):\n` +
					wrong
						.map((w) => `    ${w.tool}: says "${w.documented}", the code compares "${w.actual}"`)
						.join("\n") +
					"\n  Compared with `===`, so a documented value that is one character off never works.",
			);
		}
	}

	if (!failures.some((f) => f.check === "confirm-gates")) {
		ok(
			`confirm gates: ${sites.size} requireConfirmation site(s) == every list in ` +
				`${surfaces.length} file(s) (${MCP_SOURCES.length} MCP sources read)`,
		);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. the wire surface — what a client RECEIVES vs the code that defines it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks 5–7 all passed through #561's four commits, and were right to: the tool count did
 * not move and no `confirm` value changed. What DID change is what the server puts on the
 * wire — `readOnlyHint`/`destructiveHint` on all 135 tools, an `outputSchema` on two of
 * them, a server `instructions` string — and no document mentioned any of it (#572). A
 * capability could reach a caller carrying no documentation obligation while a `confirm`
 * value could not, and the two are the same failure: a decision made from a signal the docs
 * do not explain.
 *
 * The facts, their parsers, their floors and the reasoning are in
 * scripts/lib/wire-surface.mjs, unit-tested against strings in wire-surface.test.mjs.
 */
{
	const { failures: wireFailures, notes: wireNotes } = checkWireSurface({
		read: (f) => read(p(f)),
		exists: (f) => existsSync(p(f)),
	});
	for (const f of wireFailures) fail(f.check, f.message);
	for (const n of wireNotes) ok(n);
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. /docs/<slug>/ links resolve
// ─────────────────────────────────────────────────────────────────────────────

if (nav) {
	const slugs = new Set(nav.map((n) => (n === "index.md" ? "" : n.replace(/\.md$/, ""))));
	const broken = [];
	// The served HTML is in scope here too: a /docs/ link on the marketing site is exactly
	// as broken to a visitor, and unlike the removed-command check this one is a URL match
	// with no fence semantics to get wrong.
	const linkFiles = [...docFiles(), ...servedHtmlFiles()];
	let links = 0;
	for (const file of linkFiles) {
		read(file)
			.split("\n")
			.forEach((line, i) => {
				for (const m of line.matchAll(/proagentstore\.online\/docs\/([a-z0-9-]*)\/?/g)) {
					links++;
					if (!slugs.has(m[1])) {
						broken.push({ name: rel(file), n: i + 1, slug: m[1] });
					}
				}
			});
	}
	if (broken.length) {
		fail(
			"docs-links",
			`${broken.length} link(s) point at a docs page that is not in the nav:\n` +
				broken.map((b) => `    ${b.name}:${b.n}  /docs/${b.slug}/`).join("\n"),
		);
	} else {
		ok(
			`docs links: ${links} /docs/<slug>/ reference(s) across ${linkFiles.length} file(s) resolve ` +
				`to ${slugs.size} nav page(s)`,
		);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. API surface — delegate, do not reimplement
// ─────────────────────────────────────────────────────────────────────────────

{
	const res = spawnSync(process.execPath, [p("scripts/openapi-coverage.mjs")], {
		cwd: ROOT,
		encoding: "utf8",
	});
	if (res.status !== 0) {
		fail(
			"openapi",
			"scripts/openapi-coverage.mjs reported route/spec drift. Its own output:\n\n" +
				`${res.stdout ?? ""}${res.stderr ?? ""}`.trimEnd(),
		);
	} else {
		const summary = (res.stdout ?? "")
			.split("\n")
			.find((l) => l.includes("in-scope coverage"));
		ok(`API surface: ${summary ? summary.trim() : "openapi-coverage.mjs passed"}`);
	}
}

// ─────────────────────────────────────────────────────────────────────────────

console.log("Docs drift — documented claims vs the code that defines them\n");
for (const n of notes) console.log(`  ✓ ${n}`);

if (!failures.length) {
	console.log("\n✓ No drift.");
	process.exit(0);
}

console.log("");
for (const f of failures) {
	console.error(`\n✗ [${f.check}] ${f.message}`);
}
console.error(
	`\n${failures.length} drift(s). Fix the docs, or fix the code they describe — but do not\n` +
		"silence a check without moving the thing it was watching.",
);
process.exit(1);
