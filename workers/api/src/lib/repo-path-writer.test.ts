import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_LOCAL_TOOLS, REPO_PATH_SETTINGS, repoPathForInstance } from "./connectors/repo-local.js";
import type { Env } from "../types.js";

/**
 * The repo path has a reachable WRITER, and the reader reads it (#520).
 *
 * The failure this exists to stop, stated as it happened. Migration 0102 deleted `coder-repo`'s
 * `repo` setting — the right call, because #410 had already made the folder editable on the
 * `coding_repos` row and two homes for one address is what produced the original "I corrected it
 * and it still uses the old one". It also wrote, of that setting, "no code reads it — it is
 * inert". `repo-local.ts` read it, and it was the ONLY source of the workdir for six tools. So the
 * INPUT went and the READER stayed: `applySettingsPatch` is schema-driven, so from that migration
 * on no console control and no API call could set the value six tools required, and every
 * `coder-repo` instance subscribed afterwards could only refuse (FIS coder `5d14a2e1`).
 *
 * This is the SECOND time a "no code reads it" claim in a migration comment turned out to be
 * wrong. A comment cannot be executed; this can. Two legs, because "orphaned" needs both halves:
 *
 *   Leg 1 — every seeded agent that declares a repo-local tool has SOMEWHERE its owner can put the
 *           path: its final settingsSchema still declares one of `REPO_PATH_SETTINGS`, or its
 *           capabilities give it the `coding` surface, where the repo row and its folder live.
 *   Leg 2 — each of those writers is one `repoPathForInstance` actually consults. Leg 1 alone
 *           would have been GREEN through #520: `coder-repo` had the Coding tab all along, and the
 *           reader ignored it. A writer the reader does not read is not a writer.
 *
 * WHY MIGRATIONS ARE THE DENOMINATOR: same reasoning as `tool-reachability.test.ts`, whose header
 * is worth reading before touching this one. Migrations are the repo's own claim about the catalog
 * and are the thing a PR can be wrong about; asserting against the live API instead would make a
 * green build mean "the operator account happens to be configured right today". An agent that
 * exists only as a D1 row is invisible here — the honest fixes are to seed it or to write the
 * reason down, never to loosen the assertion.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "..", "migrations");

const REPO_LOCAL_TOOL_NAMES: ReadonlySet<string> = new Set(REPO_LOCAL_TOOLS.map((t) => t.name));

// ── Resolving what a slug declares TODAY, out of the migrations ──────────────

interface AgentState {
	/** The field ids on `config.settingsSchema`, in declaration order. */
	settingsIds: string[];
	surfaces: string[];
	tools: string[];
	/** Every migration file that changed this agent — quoted in failures, so a break names itself. */
	files: string[];
}

/** Strip `--` line comments without touching a `--` inside a string literal. */
function stripComments(sql: string): string {
	let out = "";
	let inStr = false;
	for (let i = 0; i < sql.length; i++) {
		const c = sql[i];
		if (inStr) {
			out += c;
			if (c === "'") inStr = false;
			continue;
		}
		if (c === "'") {
			inStr = true;
			out += c;
			continue;
		}
		if (c === "-" && sql[i + 1] === "-") {
			while (i < sql.length && sql[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		out += c;
	}
	return out;
}

/** Split a SQLite VALUES tuple into its top-level values, honouring `''` escapes and nesting. */
function splitTuple(tuple: string): string[] {
	const out: string[] = [];
	let cur = "";
	let depth = 0;
	let inStr = false;
	for (let i = 0; i < tuple.length; i++) {
		const c = tuple[i];
		if (inStr) {
			if (c === "'" && tuple[i + 1] === "'") {
				cur += "''";
				i++;
				continue;
			}
			if (c === "'") inStr = false;
			cur += c;
			continue;
		}
		if (c === "'") {
			inStr = true;
			cur += c;
			continue;
		}
		if (c === "(") depth++;
		else if (c === ")") depth--;
		if (c === "," && depth === 0) {
			out.push(cur.trim());
			cur = "";
			continue;
		}
		cur += c;
	}
	if (cur.trim()) out.push(cur.trim());
	return out;
}

/** A SQLite string literal, or one wrapped in `json(…)` — half the seeds write the config that way. */
function unquote(v: string): string | null {
	let t = v.trim();
	const wrapped = t.match(/^json\s*\(([\s\S]*)\)$/i);
	if (wrapped) t = wrapped[1].trim();
	if (!t.startsWith("'") || !t.endsWith("'")) return null;
	return t.slice(1, -1).replace(/''/g, "'");
}

function fieldIds(schema: unknown): string[] {
	return Array.isArray(schema) ? schema.filter((f): f is { id: string } => typeof (f as { id?: unknown })?.id === "string").map((f) => f.id) : [];
}

/** Apply a seeding INSERT: `(columns) VALUES (…)`, so slug and config are read positionally. */
function applyInsert(stmt: string, state: Map<string, AgentState>, file: string): void {
	const cols = stmt.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+agents\s*\(([^)]*)\)/i);
	if (!cols) return;
	const names = cols[1].split(",").map((s) => s.trim());
	const valuesAt = stmt.toUpperCase().indexOf("VALUES", cols.index ?? 0);
	if (valuesAt < 0) return;
	const open = stmt.indexOf("(", valuesAt);
	const close = stmt.lastIndexOf(")");
	if (open < 0 || close < open) return;
	const values = splitTuple(stmt.slice(open + 1, close));
	if (values.length !== names.length) return; // a SELECT-shaped insert is not a seed blob
	const slug = unquote(values[names.indexOf("slug")] ?? "");
	const rawConfig = unquote(values[names.indexOf("config")] ?? "");
	if (!slug || !rawConfig) return;
	let cfg: { settingsSchema?: unknown; capabilities?: { surfaces?: string[]; tools?: string[] } };
	try {
		cfg = JSON.parse(rawConfig) as typeof cfg;
	} catch {
		return; // a config assembled by SQL rather than written as a literal is not resolvable here
	}
	state.set(slug, {
		settingsIds: fieldIds(cfg.settingsSchema),
		surfaces: cfg.capabilities?.surfaces ?? [],
		tools: cfg.capabilities?.tools ?? [],
		files: [file],
	});
}

/**
 * Apply one UPDATE. Recognised shapes only — an unrecognised statement that touches
 * `$.settingsSchema` THROWS rather than resolving to a stale answer, because the way a guard like
 * this dies is a migration shape it silently cannot read.
 */
function applyUpdate(stmt: string, state: Map<string, AgentState>, file: string): void {
	const touchesSchema = stmt.includes("$.settingsSchema");
	const slugMatch = stmt.match(/slug\s*=\s*'([^']+)'/);
	const codingScoped = /\$\.capabilities\.surfaces'?\s*\)?[^;]*LIKE\s*'%coding%'/.test(stmt);
	const targets: string[] = slugMatch
		? [slugMatch[1]]
		: codingScoped
			? [...state.entries()].filter(([, s]) => s.surfaces.includes("coding")).map(([slug]) => slug)
			: [];

	if (!targets.length) {
		if (touchesSchema) {
			throw new Error(`${file}: a statement changes $.settingsSchema and this walk cannot tell which agents it hits — teach the parser, do not delete the assertion.`);
		}
		return;
	}

	const wholeCaps = stmt.match(/'\$\.capabilities'\s*,\s*json\('(\{[\s\S]*?\})'\)/);
	const toolsOnly = stmt.match(/'\$\.capabilities\.tools'\s*,\s*json\('(\[[\s\S]*?\])'\)/);
	const surfacesOnly = stmt.match(/'\$\.capabilities\.surfaces'\s*,\s*json\('(\[[\s\S]*?\])'\)/);
	// 0091 step 1 sets `$.settingsSchema` to `[]` ONLY for an agent that has no array yet
	// (`json_type(…) <> 'array'`), purely so step 2 has something to append to. Applying it
	// unguarded would erase every field the seed declared — which is the difference between
	// resolving what production has and resolving a fiction.
	const initGuard = /<>\s*'array'/.test(stmt);
	const wholeSchema = initGuard ? null : stmt.match(/'\$\.settingsSchema'\s*,\s*json\('(\[[\s\S]*?\])'\)/);
	const appended = stmt.match(/'\$\.settingsSchema\[#\]'\s*,\s*json\('(\{[\s\S]*?\})'\)/);
	// 0102's shape: rebuild the array, dropping the element whose `$.id` is the named one.
	const removed = touchesSchema ? stmt.match(/json_extract\(\s*\w+\.value\s*,\s*'\$\.id'\s*\)\s*<>\s*'([^']+)'/) : null;

	const known = wholeCaps || toolsOnly || surfacesOnly || wholeSchema || appended || removed;
	if (touchesSchema && !initGuard && !wholeSchema && !appended && !removed) {
		throw new Error(`${file}: an unrecognised statement rewrites $.settingsSchema for ${targets.join(", ")} — teach the parser, do not delete the assertion.`);
	}
	if (!known) return;

	for (const slug of targets) {
		const prev = state.get(slug);
		if (!prev) continue; // an UPDATE for an agent no migration seeds is not resolvable here
		const next: AgentState = { ...prev, files: [...prev.files, file] };
		if (wholeCaps) {
			const caps = JSON.parse(wholeCaps[1]) as { surfaces?: string[]; tools?: string[] };
			next.surfaces = caps.surfaces ?? [];
			next.tools = caps.tools ?? [];
		}
		if (toolsOnly) next.tools = JSON.parse(toolsOnly[1]) as string[];
		if (surfacesOnly) next.surfaces = JSON.parse(surfacesOnly[1]) as string[];
		if (wholeSchema) next.settingsIds = fieldIds(JSON.parse(wholeSchema[1]));
		if (appended) {
			const id = (JSON.parse(appended[1]) as { id?: string }).id;
			if (id && !next.settingsIds.includes(id)) next.settingsIds = [...next.settingsIds, id];
		}
		if (removed) next.settingsIds = next.settingsIds.filter((id) => id !== removed[1]);
		state.set(slug, next);
	}
}

/** Every seeded agent, resolved through every migration in the order wrangler applies them. */
function seededAgents(): Map<string, AgentState> {
	const state = new Map<string, AgentState>();
	for (const file of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
		const sql = stripComments(readFileSync(join(MIGRATIONS, file), "utf8"));
		for (const stmt of sql.split(/;\s*\n/)) {
			if (/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+agents\s*\(/i.test(stmt)) applyInsert(stmt, state, file);
			else if (/^\s*UPDATE\s+agents/im.test(stmt)) applyUpdate(stmt, state, file);
		}
	}
	return state;
}

// ── Leg 1: the writer exists ─────────────────────────────────────────────────

describe("leg 1 — an agent with repo-local tools has somewhere to put the path", () => {
	it("reads the migrations it claims to read", () => {
		// The whole file is vacuous if the walk resolves nothing, and that is how it would be
		// neutered — a shape it cannot parse, not someone editing an expectation.
		const agents = seededAgents();
		expect(agents.size, "no seeded agents resolved — the path or the INSERT parser is wrong").toBeGreaterThan(5);
		expect([...agents.keys()]).toContain("coder-repo");
		expect([...agents.keys()]).toContain("local-repo-chat");
	});

	it("resolves coder-repo's settings to exactly what production returns", () => {
		// The resolver's own check, against measured reality: `GET /v1/instances/:id/settings` on
		// all three live coder-repo instances returned engine/autonomy/merge_policy and nothing else
		// (2026-08-12). engine+autonomy come from 0063's seed, merge_policy from 0091's
		// surface-scoped append, and `repo` is gone because of 0102 — so all three shapes this walk
		// understands are exercised by this one expectation.
		expect(seededAgents().get("coder-repo")?.settingsIds).toEqual(["engine", "autonomy", "merge_policy"]);
	});

	it("every agent declaring a repo-local tool has a reachable writer for its repo path", () => {
		const agents = seededAgents();
		let checked = 0;
		for (const [slug, state] of agents) {
			if (!state.tools.some((t) => REPO_LOCAL_TOOL_NAMES.has(t))) continue;
			checked++;
			const setting = state.settingsIds.find((id) => (REPO_PATH_SETTINGS as readonly string[]).includes(id)) ?? null;
			const coding = state.surfaces.includes("coding");
			expect(
				setting !== null || coding,
				`${slug} declares repo-local tools (${state.tools.filter((t) => REPO_LOCAL_TOOL_NAMES.has(t)).join(", ")}) and has NO way for its owner to set the repo path: ` +
					`its settingsSchema declares none of [${REPO_PATH_SETTINGS.join(", ")}] and it has no "coding" surface, so there is no Coding tab either. ` +
					`Touched by: ${state.files.join(", ")}. That is #520 exactly — six tools requiring a value nothing can write. ` +
					`Give it back a settings field, or give it the coding surface. Do not weaken this assertion.`,
			).toBe(true);
		}
		// A rule that matches no agent passes forever while meaning nothing.
		expect(checked, "no seeded agent declares a repo-local tool — the tools walk is broken").toBeGreaterThanOrEqual(2);
	});

	it("names the two agents it is really about, so a rename cannot silently empty the set", () => {
		const agents = seededAgents();
		// coder-repo: writer is the Coding tab (its `repo` field was deleted by 0102).
		expect(agents.get("coder-repo")?.surfaces).toContain("coding");
		expect(agents.get("coder-repo")?.settingsIds).not.toContain("repo");
		// local-repo-chat: writer is its own setting — `surfaces: []` on purpose, so it has no tab.
		expect(agents.get("local-repo-chat")?.settingsIds).toContain("repo_path");
		expect(agents.get("local-repo-chat")?.surfaces).toEqual([]);
	});
});

// ── Leg 2: the reader reads each writer ──────────────────────────────────────

describe("leg 2 — each accepted writer is one the reader actually consults", () => {
	/** A D1 stub: `.all` answers the coding_repos read, `.first` the instance settings read. */
	const env = (repos: Array<{ name: string; workdir: string | null }>, settings: Record<string, unknown>) =>
		({
			DB: {
				prepare: () => ({
					bind: () => ({
						first: async () => ({ config: JSON.stringify({ settings }) }),
						all: async () => ({ results: repos }),
					}),
				}),
			},
		}) as unknown as Env;

	const ctx = (repos: Array<{ name: string; workdir: string | null }>, settings: Record<string, unknown> = {}) =>
		({ env: env(repos, settings), userId: "u1", instanceId: "i1" }) as never;

	it("the coding-surface writer: a repo row's workdir is what the tools get", async () => {
		// Leg 1 accepts the `coding` surface as a writer BECAUSE the folder is editable on the repo
		// row there (#410). If the reader ever stops reading that row, leg 1 starts accepting a
		// writer that writes nowhere — which is #520's exact shape, and it was green throughout.
		expect(await repoPathForInstance(ctx([{ name: "chess", workdir: "~/dev/chess" }]))).toBe("~/dev/chess");
	});

	it("the settings writer: every key in REPO_PATH_SETTINGS resolves", async () => {
		// The list is the contract between this guard and `local-repo-chat`'s live `repo_path`. A key
		// added to it that the reader ignores would make leg 1 accept it as a writer.
		for (const key of REPO_PATH_SETTINGS) {
			expect(await repoPathForInstance(ctx([], { [key]: "~/work/thing" })), key).toBe("~/work/thing");
		}
	});

	it("the row wins over the setting — one address, and it is the one the console can edit", async () => {
		expect(await repoPathForInstance(ctx([{ name: "chess", workdir: "~/dev/chess" }], { repo: "~/stale" }))).toBe("~/dev/chess");
	});
});
