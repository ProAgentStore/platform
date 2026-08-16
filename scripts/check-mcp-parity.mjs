#!/usr/bin/env node
/**
 * check-mcp-parity.mjs — everything the console can reach should be reachable over MCP, and
 * until #610 nothing measured whether it was.
 *
 * ── Why this exists
 *
 * The console and the MCP server are two clients of ONE API. So every capability the console has
 * is structurally available to MCP, and where MCP falls short it is either a deliberate exclusion
 * or an accident — with no way to tell which. Three accidents were found in one week, all the
 * same shape (the console had it, MCP dropped it):
 *
 *   · `coding_session_capture` stripped `runnerConnected`/`alive`/`ready`/`authPrompt` (#593)
 *   · `instance_board` dropped `updatedAt`, which was on `BoardItemView` all along (#592)
 *   · `instance_board` dropped `reasoning` entirely (#574)
 *
 * and the one that produced this ticket: an owner watching a stuck agent could read the terminal
 * in the web UI while their assistant, over MCP, was told the session did not exist.
 *
 * Three in one week is an unguarded boundary, not bad luck.
 *
 * ── What it compares, and the risk that was named before it was written
 *
 * #610 recorded as INFERRED that console calls and MCP tool routes are statically comparable, and
 * asked for that to be reported rather than forced. It is comparable, with two caveats that were
 * found by measuring rather than by reasoning, and both are handled in `lib/api-calls.mjs`:
 *
 *   1. A nested template literal. `agent_trace` builds
 *      `` `/v1/instances/${id}/trace${qs ? `?${qs}` : ""}` `` and the first prototype reported it
 *      as MISSING, because a regex ends the string at the inner backtick. A false gap is the worst
 *      output this check can produce, so the literal reader tracks interpolation nesting.
 *   2. A path that is a variable. Seven MCP call sites pass one — `instance_runtime_status` picks
 *      `/runtime/status` or `/runtime` by argument, and the Drive/WorkDrive grant tools build the
 *      prefix from a lookup table. Unresolved, those alone accounted for 14 false gaps out of 103.
 *
 * What remains genuinely unmeasurable is counted and PRINTED rather than swallowed: a call whose
 * path is a member expression off a data table (`entry.flow.start`) is a capability this check
 * cannot see, and "0 gaps" over a tree where six calls were skipped is the empty-set-passes trap.
 *
 * ── The two inventories, which are NOT the same thing
 *
 * {@link EXCLUSIONS} is a DECISION: MCP will not have this, and here is why. `platform-docs/mcp.md`
 * is rendered from it (`--write`), so the published list and the enforced list cannot be two
 * hand-maintained copies — which is exactly how #585 and #602 happened.
 *
 * {@link KNOWN_GAPS} is a RATCHET: the console can do this and MCP cannot, nobody has decided that
 * is right, and it is recorded so a NEW one fails the build. The first run found 81 capabilities
 * with no MCP path — 10 of them deliberate, leaving 71 recorded here across 14 groups. That 71 is
 * the number #610 AC5 asked for and the reason this file is not simply a green check; the whole
 * inventory is on #613, and `--gaps` reprints it. Entries leave by being CLOSED — a gap that no
 * longer exists FAILS as dead config, the same rule `UNBACKED_CLAIMS`, `PINS` and
 * `KNOWN_DUPLICATES` all carry.
 *
 * Usage:
 *   node scripts/check-mcp-parity.mjs            # check
 *   node scripts/check-mcp-parity.mjs --write    # regenerate the doc's exclusion table
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCalls } from "./lib/api-calls.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(ROOT, "platform-docs/mcp.md");
const BEGIN = "<!-- BEGIN generated: mcp-exclusions (scripts/check-mcp-parity.mjs --write) -->";
const END = "<!-- END generated: mcp-exclusions -->";

// ─────────────────────────────────────────────────────────────────────────────
// EXCLUSIONS — capabilities MCP deliberately does not have.
//
// `match` is a RegExp over the normalised "METHOD /path" key, or `null` for a row that is a
// STATEMENT about the surface rather than a rule about routes ("no shell tool"). The two are
// counted separately on purpose: a route rule is enforced and a statement is not, and a list that
// blurred them would report enforcement it does not perform.
//
// A route rule matching nothing FAILS. Dead config in a guard is how the guard stops being
// believed — and an exclusion that matches nothing usually means the console screen it was
// written for is gone.
// ─────────────────────────────────────────────────────────────────────────────
const EXCLUSIONS = [
	{
		label: "The credentials vault — site logins, passwords, PINs, recovery codes",
		why: "Secrets. Console → Knowledge → Credentials.",
		match: /^[A-Z]+ \/v1\/instances\/\{\}\/credentials/,
	},
	{
		label: "API-key **values**",
		why:
			"`keys_status` returns provider names only. There is no reveal tool and no route that returns a stored key, and there is no tool that WRITES one either — a key sent through a tool call is a secret in a transcript. Gmail refresh tokens are never revealable at all.",
		match: /^(PUT|DELETE) \/v1\/keys\/\{\}$/,
	},
	{
		label: "Credentials for an outbound MCP server",
		why:
			"Same rule as the vault, on the newer surface: the console stores the bearer or OAuth secret an instance uses to reach someone else's MCP server, and it is never read back or written over MCP. `list_instance_tools` reports whether a connection HAS one.",
		match: /^[A-Z]+ \/v1\/instances\/\{\}\/mcp\/credentials$/,
	},
	{
		label: "Browser sign-in and account-link redirects",
		why:
			"An OAuth start returns a URL for a human to open in a browser with cookies. A headless caller cannot complete one, so returning the URL would be an invitation to a dead end.",
		match: /^[A-Z]+ \/v1\/auth\/[a-z]+\/link\/start$/,
	},
	{
		label: "Web Push subscription plumbing",
		why:
			"A push subscription is a browser object (a VAPID key and an endpoint minted by the user's own browser). There is nothing for a server-side caller to subscribe WITH.",
		match: /^[A-Z]+ \/v1\/push\//,
	},
	{
		label: "Permission writes on instance state",
		why:
			"`get_instance_state` is read-only for the permission block; toggles stay in the console. The one carve-out is `set_instance_model`, which writes the `model` field and nothing else.",
		match: null,
	},
	{
		label: "Stripe checkout and the customer portal",
		why: "Browser redirects — a redirect URL is useless to a headless caller. `billing_status` reads; nothing writes.",
		match: null,
	},
	{
		label: "Binary routes — voice-audio, R2 multipart upload parts, file byte download",
		why:
			"MCP results are text. `list_instance_files` and `delete_instance_file` exist; reading the bytes does not. `upload_agent_file` takes text only; `upload_resume` is the single binary path, and is apply-scoped.",
		match: null,
	},
	{
		label: "Arbitrary shell execution, or a generic API proxy",
		why:
			"No shell tool, no open proxy. `call_instance_tool` reaches only the connector tools an instance declares and its owner has left enabled.",
		match: null,
	},
	{
		label: "User deletion",
		why: "Not modelled.",
		match: null,
	},
	{
		label: "Another user's data",
		why:
			"Every instance route is owner-scoped server-side. `list_errors` with `scope: \"all\"` is the only cross-user read and is admin-only.",
		match: null,
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// KNOWN_GAPS — the console can do it, MCP cannot, and nobody has decided that is right.
//
// This is the first run's measurement, grouped by the console screen the capability belongs to.
// It is a ceiling, not a permission: adding a tool deletes an entry, and an entry that matches
// nothing fails. Each group carries the issue tracking it where one exists.
// ─────────────────────────────────────────────────────────────────────────────
const KNOWN_GAPS = [
	{
		why:
			"Agent TEMPLATE authoring (the creator side of AgentDetail). `create_agent`/`update_agent` exist, but reading an agent as its OWNER does not — `agent_info` serves `/v1/public/agents/{}`, the published projection, which omits drafts and config. Nor is there delete, export, version history, rollback, the template's own memory/state/chat, or the AI agent-builder. #613.",
		match:
			/^([A-Z]+ \/v1\/agents\/\{\}(\/(capabilities|export|memory|messages|state|chat|versions|knowledge\/\{\}|versions\/\{\}\/rollback))?|POST \/v1\/agent-builder\/(plan|execute))$/,
	},
	{
		why:
			"Notifications and account preferences. The console reads a notification feed, marks items read, and edits per-account preferences (timezone, notification channels); MCP has neither. A caller cannot tell an owner what their agents have been trying to tell them. #613.",
		match: /^[A-Z]+ \/v1\/(notifications|preferences)/,
	},
	{
		why:
			"Voice settings — STT mode, TTS provider/voice/speed, language, `commandsEnabled`. `get_instance_settings` reads typed agent settings, which is a different table; the voice block has no tool at all. #613.",
		match: /^[A-Z]+ \/v1\/instances\/\{\}\/voice-settings$/,
	},
	{
		why:
			"Outbound MCP connections — the console lists presets, tests a server, reads and writes per-server consent, and answers an elicitation (`mcp/input-requests`). None of it is reachable over MCP, which is the loop this platform is most likely to want closed. #613.",
		match: /^[A-Z]+ \/v1\/(mcp\/presets|instances\/\{\}\/mcp\/(consent|test|input-requests))/,
	},
	{
		why:
			"Machines and terminals, the part still missing: FORGETTING a node (and un-claiming its name), and the Tmux tab's terminal-session read/write. #613. Narrowed by #671, which closed the half that mattered for placement — `list_runner_nodes` lists every connected CLI across agents, `instance_runner_node` reads one instance's pin and its alternatives, and `set_instance_runner_node` writes it through the same route the console uses. What is left is deliberate rather than pending: forgetting a node is destructive and has refusal logic (`diagnoseUnclaim`) whose blockers a caller has no way to read over MCP yet, and `terminal-session` is UI state for a tab MCP does not render.",
		match: /^[A-Z]+ \/v1\/(terminals\/nodes\/\{\}|instances\/\{\}\/terminal-session)$/,
	},
	{
		why:
			"A run's detail view: read one task, delete it, resume it, and drive a live human takeover (end/input/resume) or answer a needs_input handoff. `instance_board` lists cards and `coding_timeline` narrates a coding session, but the per-run controls a stuck agent actually needs are console-only. #613.",
		match:
			/^[A-Z]+ \/v1\/instances\/\{\}\/(tasks\/\{\}(\/resume)?|takeover\/\{\}\/(end|input|resume)|input|browse)$/,
	},
	{
		why:
			"Standing agent tasks (`agent-tasks`) — the recurring instructions an agent carries, created, edited and deleted in the console's Tasks section. Distinct from runtime tasks, which `run_instance_task` covers. #613.",
		match: /^[A-Z]+ \/v1\/instances\/\{\}\/agent-tasks(\/\{\})?$/,
	},
	{
		why:
			"Teamwork plumbing: delete a connection, read the delivery outbox, replay a dead delivery, and read a supervisor's direction. `list_instance_connections` and the supervision tools cover the happy path; the failure path — which is what an outbox is for — does not. #613.",
		match:
			/^[A-Z]+ \/v1\/instances\/\{\}\/(connections\/(\{\}|deliveries)|connections\/deliveries\/\{\}\/replay|supervision\/\{\}\/direction)$/,
	},
	{
		why:
			"Knowledge writes the console has and MCP does not: edit an existing document in place, ingest a URL, and edit one record of a collection. `add_knowledge` only appends, so a correction over MCP means delete-then-add under a new id. #613.",
		match:
			/^[A-Z]+ \/v1\/instances\/\{\}\/(knowledge\/\{\}|knowledge\/ingest-url|collections\/\{\}\/records\/\{\})$/,
	},
	{
		why:
			"Product feedback — file, list and dismiss. `list_feedback` does not exist; an agent that hits a platform defect can only tell the user to open the console. #613.",
		match: /^[A-Z]+ \/v1\/feedback(\/\{\})?$/,
	},
	{
		why:
			"Loop presets — the saved objectives the console offers when starting a loop. `start_instance_loop` takes a free-text objective, so the presets an owner curated are invisible to it. #613.",
		match: /^[A-Z]+ \/v1\/instances\/\{\}\/loop-presets$/,
	},
	{
		why:
			"Trigger and connector metadata the console uses to BUILD a trigger: the action catalogue (`/triggers/actions`), a dry-run preview (`/triggers/preview`), the account connector list, the per-instance connector list and its write-consent toggle. `create_instance_trigger` can write one blind; nothing lets a caller check it first. #613.",
		match:
			/^[A-Z]+ \/v1\/(connectors|triggers\/(actions|preview)|instances\/\{\}\/connectors(\/\{\}\/consent)?)$/,
	},
	{
		why:
			"File-connector reads and imports: list a granted Drive folder's files, and import from Drive or WorkDrive into an instance. The grants themselves ARE reachable (`list_instance_connector_grants`), which is what makes the missing import conspicuous. #613.",
		match: /^[A-Z]+ \/v1\/(drive|workdrive)\/instances\/\{\}\/(files|import)$/,
	},
	{
		why:
			"Assorted single routes with no group: the creator dashboard tallies, the stats source catalogue, the behaviour SCHEMA (`get_instance_behaviour` reads the values but not the field table the console renders), deleting one chat turn, posting a system message into a conversation, and the translation endpoint the gloss layer calls. #613.",
		match:
			/^[A-Z]+ \/v1\/(dashboard\/(creator|usage)|stats\/sources|instances\/behaviour-schema|instances\/\{\}\/(messages\/\{\}|system-message|translate))$/,
	},
];

// ─────────────────────────────────────────────────────────────────────────────
// Inventory
// ─────────────────────────────────────────────────────────────────────────────

/** Every non-test `.ts`/`.tsx` under `dir`. */
function sources(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) sources(p, out);
		else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
	}
	return out;
}

/** `METHOD /path` → the files that call it, plus the call sites that could not be read. */
function inventory(dir, fns) {
	const map = new Map();
	const unresolved = [];
	for (const file of sources(join(ROOT, dir))) {
		const short = file.slice(ROOT.length + 1);
		const { calls, unresolved: skipped } = extractCalls(readFileSync(file, "utf8"), fns);
		for (const c of calls) {
			const key = `${c.method} ${c.path}`;
			if (!map.has(key)) map.set(key, new Set());
			map.get(key).add(short);
		}
		for (const s of skipped) unresolved.push(`${short}: ${s}`);
	}
	return { map, unresolved };
}

const consoleSide = inventory("store/console/src", ["api", "useApi"]);
const mcpSide = inventory("workers/mcp/src", ["authedCall", "apiCall"]);

// G1/G3 — an extractor that stopped working must fail as a broken guard, not pass as a clean
// tree. Floors, not equalities: both surfaces grow, and only a COLLAPSE is a defect.
const problems = [];
if (consoleSide.map.size < 120) {
	problems.push(`only ${consoleSide.map.size} console capabilities found — the extractor has stopped measuring`);
}
if (mcpSide.map.size < 100) {
	problems.push(`only ${mcpSide.map.size} MCP routes found — the extractor has stopped measuring`);
}

const excluded = [];
const known = [];
const gaps = [];
const routeRules = EXCLUSIONS.filter((e) => e.match);
const hits = new Map();

for (const [key, files] of consoleSide.map) {
	if (mcpSide.map.has(key)) continue;
	const rule = routeRules.find((e) => e.match.test(key)) ?? KNOWN_GAPS.find((g) => g.match.test(key));
	if (!rule) {
		gaps.push({ key, files: [...files] });
		continue;
	}
	hits.set(rule, (hits.get(rule) ?? 0) + 1);
	(EXCLUSIONS.includes(rule) ? excluded : known).push({ key, files: [...files] });
}

// The shrink arm. An entry that matches nothing has been closed (or was never right), and must
// leave — otherwise both inventories rot into allowlists nobody reads.
for (const rule of [...routeRules, ...KNOWN_GAPS]) {
	if (!hits.has(rule)) {
		problems.push(
			`dead entry in ${EXCLUSIONS.includes(rule) ? "EXCLUSIONS" : "KNOWN_GAPS"}: ${rule.match} matches no gap. ` +
				"If the capability is now reachable over MCP, delete the entry in this commit.",
		);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The doc renders FROM the exclusion list (#610 AC4)
// ─────────────────────────────────────────────────────────────────────────────

function renderTable() {
	const rows = EXCLUSIONS.map(
		(e) => `| ${e.label} | ${e.why} | ${e.match ? "`check-mcp-parity.mjs`" : "—" } |`,
	);
	return [
		BEGIN,
		"",
		"<!-- Generated from EXCLUSIONS in scripts/check-mcp-parity.mjs. Do not edit by hand: the",
		"     check regenerates this block and fails when it drifts. -->",
		"",
		"| Not available via MCP | Why | Enforced by |",
		"|---|---|---|",
		...rows,
		"",
		"A row with no enforcer is a statement about the surface rather than a rule about routes —",
		"there is no console call for the check to compare it against. The rows that name the check",
		"are compared, every run, to what the console actually calls.",
		"",
		END,
	].join("\n");
}

const doc = readFileSync(DOC, "utf8");
const start = doc.indexOf(BEGIN);
const stop = doc.indexOf(END);
const rendered = renderTable();

if (process.argv.includes("--write")) {
	if (start === -1 || stop === -1) {
		console.error(`✗ ${DOC} has no generated block. Add the BEGIN/END markers first.`);
		process.exit(1);
	}
	writeFileSync(DOC, doc.slice(0, start) + rendered + doc.slice(stop + END.length));
	console.log(`✓ wrote the exclusion table into platform-docs/mcp.md (${EXCLUSIONS.length} rows)`);
	process.exit(0);
}

if (start === -1 || stop === -1) {
	problems.push("platform-docs/mcp.md has no generated exclusion block — the doc cannot render from the code.");
} else if (doc.slice(start, stop + END.length) !== rendered) {
	problems.push(
		"platform-docs/mcp.md's exclusion table does not match EXCLUSIONS. Run " +
			"`node scripts/check-mcp-parity.mjs --write`. The doc is generated so the published list " +
			"and the enforced list cannot be two hand-maintained copies (#585, #602).",
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Report — with the denominator, per ADR 0002
// ─────────────────────────────────────────────────────────────────────────────

const total = consoleSide.map.size;
const reachable = total - excluded.length - known.length - gaps.length;
const pct = (n) => (total === 0 ? "0.0" : ((n / total) * 100).toFixed(1));

console.log("MCP parity — what the console can reach vs what MCP can (#610)\n");
console.log(`  console capabilities : ${total}   (distinct METHOD + path, ${consoleSide.unresolved.length} call site(s) unreadable)`);
console.log(`  MCP routes           : ${mcpSide.map.size}   (${mcpSide.unresolved.length} call site(s) unreadable)`);
console.log(`  reachable over MCP   : ${reachable}/${total} (${pct(reachable)}%)`);
console.log(`  deliberately excluded: ${excluded.length} across ${routeRules.length} route rule(s) + ${EXCLUSIONS.length - routeRules.length} statement row(s)`);
console.log(`  known gaps (ratchet) : ${known.length} across ${KNOWN_GAPS.length} group(s)`);
console.log(`  UNLISTED gaps        : ${gaps.length}`);

// `--gaps` prints the ratchet's contents grouped by entry. The inventory is the record of what
// MCP cannot do, and a record only readable by reading a regex is a record nobody consults.
if (process.argv.includes("--gaps")) {
	console.log("\nRecorded gaps, by group:\n");
	for (const g of KNOWN_GAPS) {
		const rows = known.filter((k) => g.match.test(k.key)).map((k) => k.key).sort();
		console.log(`### ${rows.length} route(s)\n${g.why}\n`);
		for (const r of rows) console.log(`  ${r}`);
		console.log("");
	}
}

if (consoleSide.unresolved.length || mcpSide.unresolved.length) {
	console.log("\nNot measured — the path is a variable this check cannot resolve:");
	for (const u of [...consoleSide.unresolved, ...mcpSide.unresolved]) console.log(`  · ${u}`);
	console.log("  (counted rather than hidden: a percentage over a tree with skipped calls is not a coverage figure)");
}

if (gaps.length) {
	console.log(`\n✗ ${gaps.length} console capability(ies) have no MCP path and no entry:\n`);
	for (const g of gaps.sort((a, b) => a.key.localeCompare(b.key))) {
		console.log(`  ${g.key}   [${g.files.join(", ")}]`);
	}
	console.log(
		"\nEither add a tool that calls it, or record it: EXCLUSIONS if MCP should never have it" +
			"\n(the doc renders from that list), KNOWN_GAPS if it simply does not yet.",
	);
}

if (problems.length) {
	console.log(`\n✗ ${problems.length} problem(s) with the check's own inventory:\n`);
	for (const p of problems) console.log(`  · ${p}`);
}

if (gaps.length || problems.length) process.exit(1);

console.log(
	`\n✓ Parity holds: ${reachable} of ${total} console capabilities are reachable over MCP, ` +
		`${excluded.length} are deliberately excluded and ${known.length} are recorded gaps.\n` +
		"  The recorded gaps are a CEILING — a new one fails this check, and closing one deletes its entry.",
);
