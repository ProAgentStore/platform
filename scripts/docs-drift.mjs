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
 *   7. docs links           every /docs/<slug>/ URL resolves to a real page
 *   8. API surface          delegates to scripts/openapi-coverage.mjs (#209)
 *
 * Run: `node scripts/docs-drift.mjs`  (or `pnpm docs:drift`)
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...s) => resolve(ROOT, ...s);
const rel = (f) => relative(ROOT, f).split(sep).join("/");
const read = (f) => readFileSync(f, "utf8");

const failures = [];
const notes = [];
const fail = (check, message) => failures.push({ check, message });
const ok = (message) => notes.push(message);

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

/** Everything a reader or an agent is expected to trust. */
function docFiles() {
	const files = [];
	const add = (f) => {
		if (existsSync(f) && statSync(f).isFile()) files.push(f);
	};
	for (const name of readdirSync(p("platform-docs"))) {
		if (name.endsWith(".md")) add(p("platform-docs", name));
	}
	add(p("store/llms.txt"));
	add(p("store/llms-full.txt"));
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
	return files;
}

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
function mcpTools() {
	const names = new Set();
	const perFile = new Map();
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!/\.ts$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) continue;
			let n = 0;
			for (const m of read(full).matchAll(
				/(?:^|[^\w.])(?:this\.)?server\.tool\(\s*"([a-z0-9_]+)"/g,
			)) {
				names.add(m[1]);
				n++;
			}
			if (n) perFile.set(entry.name, n);
		}
	};
	walk(p("workers/mcp/src"));
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
	if (!missing.length && !orphans.length) ok(`nav ↔ sources: ${nav.length} pages, both directions`);
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
		ok("generated docs: skipped (git not available)");
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
			ok("generated docs: store/docs correctly untracked");
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
	for (const file of docFiles()) {
		const src = read(file);
		const name = rel(file);
		for (const { line, n } of fencedLines(src)) {
			for (const { token, why } of REMOVED_COMMANDS) {
				if (line.includes(token)) cmdHits.push({ name, n, token, why, line: line.trim() });
			}
		}
		if (!IDENTITY_SCOPE.some((prefix) => name.startsWith(prefix))) continue;
		src.split("\n").forEach((line, i) => {
			for (const { token, why } of REMOVED_IDENTITY) {
				if (line.includes(token)) idHits.push({ name, n: i + 1, token, why, line: line.trim() });
			}
		});
	}
	if (cmdHits.length) {
		fail(
			"removed-commands",
			`${cmdHits.length} runnable code block(s) still teach a removed command:\n` +
				cmdHits
					.map((h) => `    ${h.name}:${h.n}  ${h.token} — ${h.why}\n      ${h.line}`)
					.join("\n"),
		);
	} else {
		ok(`removed commands: ${REMOVED_COMMANDS.length} tokens absent from every code block`);
	}
	if (idHits.length) {
		fail(
			"removed-identity",
			`${idHits.length} line(s) in the platform docs still claim the old runtime identity:\n` +
				idHits.map((h) => `    ${h.name}:${h.n}  ${h.token} — ${h.why}`).join("\n"),
		);
	} else {
		ok("removed identity: no FAGS runtime-plane claim in platform-docs or llms files");
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
		ok(`MCP tool table: ${registered.size} registered, ${documented.size} documented, exact match`);
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

	// Every "N tools" / "N tool registrations" claim in the docs must be that number.
	// Only files that state the TOTAL belong here — workers/mcp/CLAUDE.md quotes per-file
	// counts in its module layout, which are checked separately below.
	const claimFiles = [
		p("platform-docs/mcp.md"),
		p("store/llms-full.txt"),
		p("workers/mcp/README.md"),
	].filter(existsSync);
	const badClaims = [];
	for (const file of claimFiles) {
		read(file)
			.split("\n")
			.forEach((line, i) => {
				for (const m of line.matchAll(/\b(\d+)\s+tools?\b|\b(\d+)\s+tool registrations?\b/g)) {
					const n = Number(m[1] ?? m[2]);
					if (declared !== null && n !== declared) {
						badClaims.push({ name: rel(file), n: i + 1, claimed: n, line: line.trim() });
					}
				}
			});
	}
	if (badClaims.length) {
		fail(
			"mcp-count",
			`${badClaims.length} doc claim(s) disagree with MCP_TOOL_COUNT (${declared}):\n` +
				badClaims
					.map((b) => `    ${b.name}:${b.n}  says ${b.claimed}\n      ${b.line.slice(0, 120)}`)
					.join("\n"),
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
		ok(
			`MCP tool count: ${registered.size} registered == constant == every doc claim ` +
				`(+ ${registeredPerFile.size} per-file counts)`,
		);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. /docs/<slug>/ links resolve
// ─────────────────────────────────────────────────────────────────────────────

if (nav) {
	const slugs = new Set(nav.map((n) => (n === "index.md" ? "" : n.replace(/\.md$/, ""))));
	const broken = [];
	for (const file of docFiles()) {
		read(file)
			.split("\n")
			.forEach((line, i) => {
				for (const m of line.matchAll(/proagentstore\.online\/docs\/([a-z0-9-]*)\/?/g)) {
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
		ok("docs links: every /docs/<slug>/ reference resolves to a nav page");
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. API surface — delegate, do not reimplement
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
