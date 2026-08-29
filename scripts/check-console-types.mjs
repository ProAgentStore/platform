#!/usr/bin/env node
/**
 * check-console-types.mjs — every inline anonymous type in a console `api<{…}>` call is
 * recorded here, so a new one fails the build and the count can only shrink (#616).
 *
 * ── Why this exists
 *
 * #616 counted 125 console API-response type declarations, 90 of them hand-copied from the
 * Worker with no guard, and at least 15 already disagreeing with their producer. #617 fixed
 * the 17 real divergences it found and added compile-time type assertions for the named types
 * that CAN be compared (KnowledgeDoc, RuntimeTask, etc. — see
 * store/console/src/lib/types.test.ts).
 *
 * What remains is the 108 ANONYMOUS shapes: the console calls `api<{ connected: boolean }>`,
 * the Worker sends whatever it sends, and no check compares the two. There is no TypeScript
 * trick for an inline literal — the shape needs a NAME in `agent-types.ts` before
 * `types.test.ts` can run its `Extra<Console, Worker> extends never` assertion.
 *
 * This guard does not compare them — it COUNTS and RATCHETS them. Every currently-anonymous
 * type is recorded in KNOWN_ANONYMOUS by a stable 8-char SHA-256 prefix of its normalised
 * text. Adding a new one fails; removing one (because it was given a name and moved to
 * types.test.ts) shrinks the list. The only legal transition is downward.
 *
 * ── What "anonymous" means here
 *
 * A call site is anonymous when its type parameter starts with `{` — an inline object literal.
 * Named types (`api<Message>(…)`, `api<KnowledgeDoc[]>(…)`) are not anonymous even when the
 * underlying interface is yet unguarded, because they can be compared once the Worker-side type
 * is named. Inline literals are different: you cannot run `Extra<{ connected: boolean }, T>`
 * until you give that literal a name, and that is a Worker change, not a console change.
 *
 * ── The denominator (AC3)
 *
 * Every run prints:
 *
 *   console api<> call sites total   : 168
 *   anonymous inline {…} (ratcheted) : 129 / 168  (76.8%)
 *   named (no ratchet needed)         :  39 / 168
 *   unique anonymous shapes           : 108
 *   unlisted shapes                   :   0  ← fails when > 0
 *   dead KNOWN entries                :   0  ← fails when > 0
 *
 * "anonymous call sites" exceeds "unique shapes" because several routes are called from more
 * than one component with the same inline type — each is a separate invitation to drift, and
 * the denominator counts them all.
 *
 * ── How to close an entry (AC2 — the count goes down)
 *
 *   1. Add an interface to `workers/api/src/agent-types.ts` (or the relevant lib file).
 *   2. Mirror it in `store/console/src/lib/types.ts` (or derive it with `import type`).
 *   3. Add a `Extra<ConsoleType, WorkerType> extends never` assertion to
 *      `store/console/src/lib/types.test.ts`.
 *   4. Replace every `api<{ … }>` call that used this shape with `api<YourNamedType>`.
 *   5. Delete the entry from KNOWN_ANONYMOUS — the dead-entry check will demand it.
 *
 * ── AC4: watching it go red
 *
 * Add any `api<{ anything: string }>` call to a console source file and run this script.
 * The new call site is printed and the exit code is 1.
 *
 * ── AC5: anonymous-vs-named split
 *
 * The denominator already shows this split. Every entry in KNOWN_ANONYMOUS is an anonymous
 * literal that needs a Worker-side name before it can be compared. Entries leave as their
 * Worker routes get named interfaces; until then they are measured and ceiling-capped, not
 * invisible.
 *
 * Run: node scripts/check-console-types.mjs
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONSOLE_SRC = join(ROOT, "store/console/src");

// ─────────────────────────────────────────────────────────────────────────────
// KNOWN_ANONYMOUS — every unique inline `{…}` shape in a console `api<>` call.
//
// Key: 8-char SHA-256 prefix of the NORMALISED type text (whitespace collapsed to one space).
// Value: a human-readable excerpt so the entry is legible without running the script.
//
// TWO RULES:
//   · An entry whose hash matches nothing FAILS — dead config. Delete it.
//   · A call site whose hash is not here FAILS — add it, or better: give the shape a name.
//
// Count when #616 was closed: 108 unique shapes across 129 call sites.
// ─────────────────────────────────────────────────────────────────────────────
const KNOWN_ANONYMOUS = {
	// ── Board / BoardTab ──────────────────────────────────────────────────────
	"c6ba1547": "{ columns?: BoardColumn[]; items?: BoardItem[]; view?: BoardView; truncated?: boolean }",
	"457150c4": "{ instances?: Array<{ id: string; capabilities?: { workflow?: string } }> }",

	// ── Behaviour tab ─────────────────────────────────────────────────────────
	"92240cd1": "{ fields: Field[] }",
	"d355d0ec": "{ behaviour: Record<string, Value>; templateDefault?: Record<string, Value> }",
	"53e50005": "{ behaviour: Record<string, Value>; templateDefault?: Record<string, Value>; rejected?: string[] }",

	// ── Knowledge / IndexingTab ───────────────────────────────────────────────
	"416be846": "{ documents?: KnowledgeDoc[]; knowledge?: KnowledgeDoc[] }",
	"0a638811": "{ files?: FileItem[] }",
	"874684b6": "{ triggers?: InstanceTrigger[] }",
	"3fe4daaa": "{ events?: TriggerEvent[] }",
	"44e0a725": "{ documents: KnowledgeDoc[] }",

	// ── KnowledgeTab ──────────────────────────────────────────────────────────
	"0b761bf9": "{ credentials: Credential[] }",
	"317492a0": "{ instructions?: string }",
	"98b94f32": "{ connected: boolean; configured: boolean; email?: string | null }",
	"da472e79": "{ grants?: ConnectorGrant[] }",
	"c5823709": "{ connected: boolean; configured: boolean; account?: string | null }",
	"29c2260f": "{ id: string }",
	"9e034bd9": "{ files?: DriveFile[] }",
	"4893c3e5": "{ files?: WorkDriveFile[]; nextOffset?: number | null }",

	// ── SettingsTab ───────────────────────────────────────────────────────────
	"d725def1": "{ instances?: RosterInstance[] }",
	"736c7fb5": "{ settings?: Record<string, string | number | boolean>; fields?: SettingsField[] }",
	"188eeb83": "{ translation?: { enabled: boolean; target: string; transliterate?: boolean; wordTap?: boolean; fontSize?: string }; languages?: Array<{ name: string; tag: string }>; hasOverride?: boolean }",
	"4f8f8740": "{ voiceSettings?: Record<string, unknown>; hasOverride?: boolean }",
	"a122f740": "{ providers?: Array<{ id: string; hasKey: boolean }> }",
	"84086d7e": "{ permissions?: { email?: boolean } }",
	"1f3f505b": "{ connectors?: InstanceConnectorPolicy[] }",
	"3d4a12fb": "{ settings?: Record<string, string | number | boolean> }",
	"9a5a0856": "{ voiceSettings?: Record<string, unknown> }",
	"5a7f6ff7": "{ translation?: { enabled: boolean; target: string; transliterate?: boolean; wordTap?: boolean; fontSize?: string } }",
	"367249af": "{ grant: ConnectorGrant }",
	"4cfb87e5": "{ translation?: TranslationConfigWire }",

	// ── TriggersSection ───────────────────────────────────────────────────────
	"bdb33978": "{ actions?: TriggerActionOffer[] }",

	// ── StatsTab ──────────────────────────────────────────────────────────────
	"74e87378": "{ rejected?: StatsRejection[] }",

	// ── LoopPresetsSection ────────────────────────────────────────────────────
	"8a1e616b": "{ presets?: LoopPreset[] }",

	// ── LoopRunsSection ───────────────────────────────────────────────────────
	"fd4f4630": "{ runs: LoopRun[] }",
	"a50ac460": "{ runs: LoopRunLike[] }",
	"111af681": "{ runs?: Run[] }",

	// ── ActivityTab ───────────────────────────────────────────────────────────
	"bcf3717f": "{ events?: ActivityEvent[] }",

	// ── RepoTab ───────────────────────────────────────────────────────────────
	"6728bfeb": "{ repos: RepoState[] }",

	// ── TeamworkSection ───────────────────────────────────────────────────────
	"d8dd0f0d": "{ connections: Connection[] }",
	"e0cc2b51": "{ deliveries: Delivery[] }",
	"e3f463a5": "{ supervision: SupervisionLink[] }",
	"0492da1e": "{ tasks: { id: string; title: string; status: string; description?: string }[] }",
	"90b75c4b": "{ instances?: Array<{ id: string; name?: string; agent_name?: string }> }",

	// ── TmuxTab ───────────────────────────────────────────────────────────────
	"2f4347e0": "{ tools?: ToolPolicyEntry[] }",
	"0ead8558": "{ activeTerminalTarget?: string | null }",
	"67290c68": "{ nodes: TerminalNode[] }",
	"c8cab155": "{ frame: string; width: number; height: number }",

	// ── AgentDetail ───────────────────────────────────────────────────────────
	"249888dd": "{ agents: CatalogAgent[] }",
	"ba110193": "{ versions: { id: string; version_num: number; description: string; created_at: string }[] }",
	"aa7acdec": "{ agents: Agent[] }",
	"e7b679b4": "{ plan: BuilderPlan }",
	"75ff4d69": "{ result: { agentId: string } }",
	"c48c8da0": "{ memory: MemoryEntry[] }",
	"4ea04dcd": "{ tasks: AgentTaskEntry[]; limits?: typeof limits }",
	"bf5c0c1d": "{ settingsSchema?: Array<{ id: string; label: string; type: string; description?: string; options?: Array<{ value: string; label: string }> }> }",
	"00ae7019": "{ customSurfaces: Array<Omit<CSurface, \"clientId\">> }",

	// ── InstanceDetail ────────────────────────────────────────────────────────
	"507c16f9": "{ instances?: Array<{ capabilities?: { surfaces?: string[] } }> }",
	"1bb9dea4": "{ items?: { attempts?: { id: string }[] }[] }",
	"9f00bc5a": "{ ids?: string[] }",
	"c83f4514": "{ message?: Message; toolMessage?: Message; transfer?: unknown }",
	"b050b6ba": "{ instanceId: string }",
	"019be6af": "{ message?: Message }",
	"290f2895": "{ runId: string; driver?: string }",
	"538a0be0": "{ status: string; iteration: number; stopReason?: string | null; detail?: string | null; cancelRequested?: boolean }",
	"1244d58f": "{ messages: Message[] }",
	"6d96f472": "{ runtime?: { runnerNode?: string | null }; relay?: { connected?: boolean; runnerNode?: string | null } }",

	// ── RunDetail ─────────────────────────────────────────────────────────────
	"941d3299": "{ events: RuntimeEvent[] }",
	"531286e7": "{ answer?: TicketTurn }",
	"a703a98d": "{ turns?: TicketTurn[] }",

	// ── Notifications ─────────────────────────────────────────────────────────
	"96a73ba4": "{ notifications: Notification[] }",
	"0189e6cb": "{ notifications: NotificationLike[] }",
	"eac926ee": "{ unreadCount?: number }",

	// ── Profile ───────────────────────────────────────────────────────────────
	"326f512b": "{ providers: Provider[] }",
	"2db7e152": "{ fields: ProfileField[]; profile: Record<string, string> }",

	// ── AccountConnections ────────────────────────────────────────────────────
	"6ee36591": "{ url: string }",
	"774469a3": "{ connectors?: ConnectorEntry[] }",
	"6a567cc0": "{ revoked?: ConnectorReach }",
	"49d55f32": "{ githubLinked?: string | null }",

	// ── AgentAccountChoice ────────────────────────────────────────────────────
	"576bfee6": "{ connectors?: InstanceConnectorAccounts[] }",

	// ── DeploymentCard ────────────────────────────────────────────────────────
	"945b46a1": "{ available: boolean; runs?: BuildRun[] }",
	"a7f33737": "{ repo: string | null; error?: string }",
	"00877499": "{ repo: string | null; available: boolean; run: BuildRun | null }",

	// ── FeedbackList ──────────────────────────────────────────────────────────
	"7ddfcdb8": "{ feedback?: FeedbackRow[] }",
	"54a34e33": "{ events?: TraceEvent[] }",
	"1d8c5b35": "{ events: TraceEvent[] }",

	// ── FilesSection ──────────────────────────────────────────────────────────
	"9bbf5862": "{ files: FileItem[] }",

	// ── McpConnections ────────────────────────────────────────────────────────
	"d2ac6cc9": "{ content: string; success: boolean }",
	"6f96a576": "{ url: string; unattended?: string }",
	"4eb35448": "{ presets: McpPreset[] }",
	"4b02d899": "{ grants?: McpGrant[] }",
	"d769ffa9": "{ ok?: boolean; status?: string; content?: string; detail?: string }",
	"22a37ea3": "{ requests: McpInputRequest[] }",

	// ── MemorySection ─────────────────────────────────────────────────────────
	// (covered above — c48c8da0)

	// ── RunnerPanel ───────────────────────────────────────────────────────────
	"220e676d": "{ nodes: Machine[] }",
	"b5960fce": "{ instances?: Array<{ id: string; capabilities?: { runtime?: string | null } }> }",

	// ── TasksSection ──────────────────────────────────────────────────────────
	// (covered above — 4ea04dcd)

	// ── ToolPermissions ───────────────────────────────────────────────────────
	"807aa970": "{ consents?: Array<{ connector: string; scope: string }> }",
	"3ac5ad62": "{ connectors?: ConnectorPolicyEntry[] }",

	// ── VectorsSection ────────────────────────────────────────────────────────
	"9b344cd0": "{ results: SearchHit[] }",

	// ── accountTimezone ───────────────────────────────────────────────────────
	"369ae37f": "{ preferences?: { timezone?: string } }",

	// ── ConversationContext ───────────────────────────────────────────────────
	"4226d6e1": "{ instances: RosterEntry[] }",

	// ── push.ts ───────────────────────────────────────────────────────────────
	"afb6c233": "{ publicKey: string | null }",

	// ── mcp-audit ─────────────────────────────────────────────────────────────
	"f15508d4": "{ events: McpAuditEvent[] }",

	// ── DataTab / collections ─────────────────────────────────────────────────
	"94accf36": "{ collections?: Collection[] }",
	"d7f40120": "{ records?: Rec[] }",

	// ── loop/LoopRunsSection (agents side) ────────────────────────────────────
	// (covered above — fd4f4630, a50ac460, 111af681)

	// ── preferences ──────────────────────────────────────────────────────────
	"bb96a385": "{ preferences?: { voice?: Record<string, unknown>; translation?: Record<string, unknown>; notifications?: Record<string, unknown> } }",
	"d6477d03": "{ preferences?: { voice?: Record<string, unknown> } }",
	"2e201707": "{ providers?: Record<string, boolean> }",

	// ── instances (misc) ──────────────────────────────────────────────────────
	"40a44af1": "{ instances: Instance[] }",
	"b17034a5": "{ tools: ToolVerdict[] }",
};

// ─────────────────────────────────────────────────────────────────────────────
// Scanner — walks the console src tree and extracts every api<…> call site.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the balanced `<…>` starting at `src[i]`, tracking `<>` nesting and skipping
 * string literals so a nested generic like `Array<{ id: string }>` does not close early.
 * Returns the content (without the outer `<>`), or null if not a valid type param.
 */
function readTypeParam(src, i) {
	if (src[i] !== "<") return null;
	let depth = 1;
	let j = i + 1;
	while (j < src.length && depth > 0) {
		const c = src[j];
		if (c === "<") depth++;
		else if (c === ">") depth--;
		else if (c === '"' || c === "'" || c === "`") {
			// Skip string literals to avoid misinterpreting `"<"` or `'>'` as angle brackets.
			const q = c;
			j++;
			while (j < src.length && src[j] !== q) {
				if (src[j] === "\\") j++;
				j++;
			}
		}
		j++;
	}
	if (depth !== 0) return null;
	return src.slice(i + 1, j - 1);
}

/** Collapse whitespace runs to a single space and trim. */
function normalize(s) {
	return s.replace(/\s+/g, " ").trim();
}

/** 8-char SHA-256 prefix of a normalized type string — stable across edits. */
function hashType(s) {
	return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

/** Walk a directory recursively, yielding .ts and .tsx paths. */
function* walkTs(dir) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			yield* walkTs(full);
		} else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
			yield full;
		}
	}
}

/**
 * Extract all `api<TYPE>` type parameters from a source file.
 * Returns [{normalized, hash, line, file}] for every call site.
 */
function extractApiCallSites(filePath, src) {
	const results = [];
	let i = 0;
	while (i < src.length) {
		const match = src.indexOf("api<", i);
		if (match === -1) break;

		// Skip if preceded by `use` — that is `useApi<T>` (the hook definition, not a call).
		if (match >= 3 && src.slice(match - 3, match) === "use") {
			i = match + 4;
			continue;
		}

		// Skip if this occurrence is inside a line comment.
		const lineStart = src.lastIndexOf("\n", match) + 1;
		if (src.slice(lineStart, match).includes("//")) {
			i = match + 4;
			continue;
		}

		const typeParam = readTypeParam(src, match + 3);
		if (typeParam !== null) {
			const norm = normalize(typeParam);
			const line = src.slice(0, match).split("\n").length;
			results.push({ normalized: norm, hash: hashType(norm), line, file: filePath });
		}

		i = match + 4;
	}
	return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const allSites = [];

for (const file of walkTs(CONSOLE_SRC)) {
	const rel = relative(CONSOLE_SRC, file);
	if (rel.includes(".test.") || rel.includes(".spec.")) continue;
	const src = readFileSync(file, "utf8");
	for (const site of extractApiCallSites(rel, src)) {
		allSites.push(site);
	}
}

const anonymous = allSites.filter((s) => s.normalized.startsWith("{"));
const named = allSites.filter((s) => !s.normalized.startsWith("{"));
const uniqueShapes = new Set(anonymous.map((s) => s.hash));

// A hash in KNOWN_ANONYMOUS that no call site produces → dead entry.
const deadEntries = Object.keys(KNOWN_ANONYMOUS).filter((h) => !uniqueShapes.has(h));

// A call site whose hash is not in KNOWN_ANONYMOUS → unlisted.
const unlistedSites = anonymous.filter((s) => !KNOWN_ANONYMOUS[s.hash]);

// ─────────────────────────────────────────────────────────────────────────────
// Report — with the denominator (AC3)
// ─────────────────────────────────────────────────────────────────────────────

const total = allSites.length;
const anonSites = anonymous.length;
const namedSites = named.length;
const pct = (n) => (total === 0 ? "0.0" : ((n / total) * 100).toFixed(1));

console.log("Console API-response type guard (#616)\n");
console.log(`  api<> call sites total            : ${total}`);
console.log(`  anonymous inline {…} (ratcheted)  : ${anonSites} / ${total} (${pct(anonSites)}%)`);
console.log(`  named (no ratchet needed)          : ${namedSites} / ${total}`);
console.log(`  unique anonymous shapes            : ${uniqueShapes.size}`);
console.log(`  KNOWN_ANONYMOUS entries            : ${Object.keys(KNOWN_ANONYMOUS).length}`);
console.log(`  unlisted anonymous                 : ${unlistedSites.length}   ← fails when > 0`);
console.log(`  dead KNOWN entries                 : ${deadEntries.length}   ← fails when > 0`);

if (unlistedSites.length > 0) {
	console.log(`\n✗ ${unlistedSites.length} anonymous type(s) not in KNOWN_ANONYMOUS:\n`);
	// Deduplicate by hash for the report (many call sites may share a shape).
	const seen = new Set();
	for (const s of unlistedSites) {
		if (seen.has(s.hash)) continue;
		seen.add(s.hash);
		const preview = s.normalized.length > 100 ? `${s.normalized.slice(0, 100)}…` : s.normalized;
		console.log(`  [${s.hash}] ${s.file}:${s.line}`);
		console.log(`    ${preview}\n`);
	}
	console.log(
		"  How to fix:\n" +
			"  1. Add an interface to workers/api/src/agent-types.ts (or the relevant lib file).\n" +
			"  2. Mirror it in store/console/src/lib/types.ts (or use import type).\n" +
			"  3. Add an Extra<ConsoleType, WorkerType> assertion to types.test.ts.\n" +
			"  4. Replace every api<{ … }> call with api<YourNamedType>.\n" +
			"  5. Delete the entry from KNOWN_ANONYMOUS — the dead-entry check demands it.\n",
	);
}

if (deadEntries.length > 0) {
	console.log(`\n✗ ${deadEntries.length} KNOWN_ANONYMOUS entry(ies) match nothing — dead config:\n`);
	for (const h of deadEntries) {
		console.log(`  [${h}] ${KNOWN_ANONYMOUS[h]}`);
	}
	console.log(
		"\n  Dead entries arise when the anonymous type is converted to a named one (good!).\n" +
			"  Delete these entries from KNOWN_ANONYMOUS to complete the cleanup.\n",
	);
}

if (unlistedSites.length || deadEntries.length) {
	process.exit(1);
}

console.log(
	`\n✓ All ${uniqueShapes.size} anonymous shape(s) across ${anonSites} call site(s) are recorded.\n` +
		"  The count can only shrink: name a Worker shape, add it to types.ts,\n" +
		"  assert it in types.test.ts, then delete its entry here.\n",
);
