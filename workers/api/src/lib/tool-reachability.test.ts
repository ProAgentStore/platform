import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CREATOR_SELECTABLE_TOOLS, TOOL_CATALOG, toolNamesFor } from "../agent-do-tools.js";
import { STORAGE_TOOLS } from "./storage-tools.js";
import { registryTools } from "./tool-registry.js";
import { AGENT_TOOLS } from "./tools.js";

/**
 * Tool reachability (#444) — a tool the platform provides that no agent can call.
 *
 * This has happened three times in four days (#415's `github_list_pulls`/`github_read_pull`,
 * #279's `transfer_conversation`, and `delete_record` found by reading the catalog), and it is
 * silent every time: nothing throws, no test fails, `GET /v1/instances/:id/tools` reports
 * `not_declared` on a page nobody has open, and the agent — having no tool for the request —
 * answers CONVERSATIONALLY. `convo.ts:205-216` records what that looks like: a reply that
 * confirms an action nobody performed.
 *
 * Two individually-correct decisions compose into it. `capabilities.tools` is an AUTHORITATIVE
 * allowlist rather than an addition to the default (`agent-do-tools.ts` `toolNamesFor`), which is
 * exactly what makes third-party tool scope safe (#58/#51); and adding a tool to
 * `connectors/registry.ts` is the normal way to add one. Neither is wrong. There is just no edge
 * between them, so a registry addition is inert until a migration says otherwise.
 *
 * So there are TWO ways to be unreachable, and they need different assertions:
 *
 *   Leg 1 — the tool is in NO catalog group. `CREATOR_SELECTABLE_TOOLS` is built from
 *           `TOOL_CATALOG` and `FULL` is the union of the groups, so an ungrouped name is dropped
 *           from `buildAgentToolDefinitions`, refused as a text-embedded call, AND silently
 *           dropped from an explicit `capabilities.tools` — unreachable through every path.
 *   Leg 2 — the tool is grouped, but no default grants it and no agent declares it.
 *
 * WHY A TEST AND NOT A `scripts/*.mjs` GUARD. The question is "what does `toolNamesFor` do with
 * this name", not "does this string appear in the tree". Importing the real modules is what makes
 * the check true rather than approximately true — the same reasoning `tmux-operator-seed.test.ts`
 * gives for resolving its seed through the real registry instead of restating it.
 *
 * WHAT THIS FILE CANNOT SEE, stated plainly so nobody weakens an assertion instead of the data.
 * Leg 2's denominator is MIGRATIONS, because migrations are the repo's own claim about the
 * catalog and are the thing a PR can be wrong about. Asserting against the live API instead would
 * make a green build mean "the operator account happens to be configured right today". But several
 * agents exist ONLY as D1 rows with no seed migration — `mcp-client`, `local-repo-chat`,
 * `lead-outreach-tj6qrr`, `facebook-friend-confirmer` (#67) — so a tool they declare is invisible
 * here and will be reported as undeclared. That is still a real finding with two honest fixes:
 * declare it in a migration (which also repairs a fresh database), or write the reason into
 * `UNREACHABLE_BY_DESIGN`. It is never a reason to loosen the assertion.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "..", "migrations");

/** Every tool name in any catalog group — the set `FULL` and `CREATOR_SELECTABLE_TOOLS` derive from. */
const CATALOG_NAMES: ReadonlySet<string> = new Set(TOOL_CATALOG.flatMap((g) => g.tools));

/**
 * Leg 1's escape hatch: tools that are deliberately outside `TOOL_CATALOG`.
 *
 * Both entries are reachable — they are just not reachable BY DECLARATION, which is a different
 * statement and the reason they are exempt rather than broken.
 */
const NOT_IN_CATALOG_BY_DESIGN: Readonly<Record<string, string>> = {
	find_confirmation_link:
		"Permission-gated, never declarable: buildAgentToolDefinitions adds it only when the owner has " +
		"switched on Settings → Permissions & Connections AND connected Gmail. Putting it in the catalog " +
		"would let a creator grant a read of the owner's mailbox by declaration.",
	submit_job_application:
		"Legacy, superseded by the LLM-driven apply workflow. It is in the APPLY group inside FULL so " +
		"existing agents keep it, and deliberately out of the catalog so no new agent can select it.",
};

/**
 * Leg 2's escape hatch: catalog tools that no default grants and that nobody is expected to
 * declare — YET. The map is the deliverable as much as the assertion: it turns "nobody declares
 * it" from an accident into a written decision.
 *
 * Adding an entry here is a decision, and should be reviewed like one. The reason must say WHY the
 * tool is unreachable and WHAT would change that; "not used yet" is not a reason, it is the bug.
 */
const UNREACHABLE_BY_DESIGN: Readonly<Record<string, string>> = {
	delete_record:
		"COLLECTIONS_DESTRUCTIVE is its own group precisely so nobody inherits an irreversible delete: " +
		"the group is outside FULL, so a creator opts in by declaring it. No seeded agent has yet had a " +
		"reason to. Reachable the moment one does.",
	browser_navigate:
		"Gated by the BROWSER_TOOLS_ENABLED env flag and first-party only (#103) — the browser plane is " +
		"driven by the apply workflow, not by a declared chat tool. Declaring it on a catalog agent is a " +
		"product decision that has not been made.",
	browser_snapshot: "Same as browser_navigate — BROWSER_TOOLS_ENABLED, first-party only (#103).",
	browser_act: "Same as browser_navigate — BROWSER_TOOLS_ENABLED, first-party only (#103).",
	whatsapp_send_message:
		"The meta connector is inert until Meta review grants the messaging permissions; declaring it on " +
		"an agent now would ship a tool that can only fail at the API boundary.",
	instagram_send_dm: "Same as whatsapp_send_message — the meta connector is inert until Meta review.",
	sheets_read:
		"The google_sheets connector is inert until the Sheets OAuth scope lands on the Google client; " +
		"until then every call fails at consent, not at the tool.",
	sheets_append: "Same as sheets_read — inert until the Sheets OAuth scope lands.",
	terminal_send_message:
		"The generic terminal connector is for creator-built agents that declare it. The first-party " +
		"tmux Operator declares the backend-specific `tmux_send_message` instead (migration 0117, #482), " +
		"which is the right tool for a tmux-only agent. No catalog agent has needed the generic form yet. " +
		"Reachable the moment a creator declares it or a first-party agent has a reason to use it.",
};

// ── Leg 2's denominator: what any migration declares ─────────────────────────

/**
 * Every tool name declared by any `capabilities.tools` in any migration, in the three shapes the
 * migrations actually use. Deliberately slug-agnostic: the question here is "can ANY agent call
 * this", not "which one", so this collects across the whole catalog rather than walking one slug
 * the way `coder2-parity.test.ts`'s `effectiveDeclared` does.
 *
 * A LATER migration that narrows an agent is therefore not caught by this union. That is on
 * purpose and it is `coder2-parity.test.ts`'s job — it asserts per slug that a restated
 * capabilities object never loses a name. Folding the two would make this file answer a question
 * it cannot answer for the ~35 slugs it does not track.
 */
function declaredByAnyMigration(): { names: Set<string>; files: number } {
	const names = new Set<string>();
	let files = 0;
	for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
		files++;
		const sql = readFileSync(join(MIGRATIONS, f), "utf8");
		// (a) path-set: json_set(config, '$.capabilities.tools', json('[…]'))   — 0067/0070/0096/0099
		for (const m of sql.matchAll(/'\$\.capabilities\.tools'\s*,\s*json\('(\[[\s\S]*?\])'\)/g)) {
			for (const n of JSON.parse(m[1]) as string[]) names.add(n);
		}
		// (b) whole-object set: json_set(config, '$.capabilities', json('{…}'))  — 0054/0101/0107
		for (const m of sql.matchAll(/'\$\.capabilities'\s*,\s*json\('(\{[\s\S]*?\})'\)/g)) {
			for (const n of (JSON.parse(m[1]) as { tools?: string[] }).tools ?? []) names.add(n);
		}
		// (c) the seeding INSERT's config blob: "capabilities": { … "tools": [ … ] } — 0063/0072/0087
		for (const obj of capabilitiesObjectsIn(sql)) {
			for (const n of obj.tools ?? []) names.add(n);
		}
	}
	return { names, files };
}

/** Brace-matched `"capabilities": {…}` objects out of a seed's config blob. Regex cannot do this:
 *  the object nests (`surfaceOptions`), so a lazy `\{[\s\S]*?\}` stops at the first inner brace. */
function capabilitiesObjectsIn(sql: string): Array<{ tools?: string[] }> {
	const out: Array<{ tools?: string[] }> = [];
	for (const m of sql.matchAll(/"capabilities"\s*:\s*\{/g)) {
		const start = m.index + m[0].length - 1;
		let depth = 0;
		let end = -1;
		for (let i = start; i < sql.length; i++) {
			if (sql[i] === "{") depth++;
			else if (sql[i] === "}" && --depth === 0) {
				end = i;
				break;
			}
		}
		if (end < 0) continue;
		try {
			// Migrations single-quote their JSON, so an apostrophe inside it is doubled.
			out.push(JSON.parse(sql.slice(start, end + 1).replace(/''/g, "'")) as { tools?: string[] });
		} catch {
			// A blob this cannot parse is not silently skipped — the count assertion below fails.
		}
	}
	return out;
}

/**
 * The tools no DEFAULT grants — reachable ONLY through `capabilities.tools`.
 *
 * `toolNamesFor(undefined)` is `FULL`, and `FULL` is the widest default: the other two branches
 * (`repo` → BASE+KB_READ, `coding` → BASE+CODING) are both subsets of it. So subtracting it from
 * the creator-selectable set leaves exactly the names a declaration is the only route to.
 */
function declarationOnlyTools(): string[] {
	const granted = toolNamesFor(undefined);
	return [...CREATOR_SELECTABLE_TOOLS].filter((n) => !granted.has(n)).sort();
}

// ── Leg 1 ────────────────────────────────────────────────────────────────────

describe("leg 1 — a tool the platform provides is in the catalog, or says why not", () => {
	it("every legacy AGENT_TOOLS / STORAGE_TOOLS name is in a catalog group", () => {
		// `delete_record` was the live instance of this: a definition, a working handler and a
		// passing test (which called `executeStorageTool` DIRECTLY, past the gate) — and membership
		// in no group, so a collections agent told "delete the duplicate lead" could create and
		// update records forever and never remove one. `store_file` was the second, and was deleted
		// rather than grouped: it wrote to a legacy R2 prefix that no reachable tool reads back.
		const orphans = [...new Set([...AGENT_TOOLS, ...STORAGE_TOOLS].map((t) => t.name))]
			.filter((n) => !CATALOG_NAMES.has(n) && !(n in NOT_IN_CATALOG_BY_DESIGN))
			.sort();
		expect(orphans, `in no TOOL_CATALOG group, so unreachable through every path — group them, delete them, or add a reason to NOT_IN_CATALOG_BY_DESIGN`).toEqual([]);
	});

	it("every connector-provided registry tool is in a catalog group", () => {
		// `registryConnectorGroups()` derives these automatically today, so this passes by
		// construction — which is the point: it fails the day that derivation gains a filter, or a
		// connector tool is added by a path that skips it. `connector` is the same discriminator
		// `undeclaredToolRefusal` uses, so the connector-less step library and first-party tools
		// (map, filter, start_work, …) are exempt by their own declaration and stay exempt with no
		// list to maintain.
		const orphans = registryTools()
			.filter((t) => t.connector && !CATALOG_NAMES.has(t.name) && !(t.name in NOT_IN_CATALOG_BY_DESIGN))
			.map((t) => t.name)
			.sort();
		expect(orphans, "connector tools outside TOOL_CATALOG cannot be declared by any creator").toEqual([]);
	});

	it("keeps NOT_IN_CATALOG_BY_DESIGN honest — no stale entry, no empty reason", () => {
		const real = new Set([...AGENT_TOOLS, ...STORAGE_TOOLS].map((t) => t.name).concat(registryTools().map((t) => t.name)));
		for (const [name, reason] of Object.entries(NOT_IN_CATALOG_BY_DESIGN)) {
			expect(real.has(name), `${name} no longer exists — delete its exception`).toBe(true);
			expect(CATALOG_NAMES.has(name), `${name} is in the catalog now — delete its exception`).toBe(false);
			expect(reason.length, `${name} needs a real reason`).toBeGreaterThan(40);
		}
	});
});

// ── Leg 2 ────────────────────────────────────────────────────────────────────

describe("leg 2 — a declaration-only tool is declared by someone, or says why not", () => {
	it("reads the migrations it claims to read", () => {
		// The whole leg is vacuous if the parser silently matches nothing — the way this assertion
		// gets neutered is a migration shape it cannot read, not someone editing the expectation.
		const { names, files } = declaredByAnyMigration();
		expect(files, "no migrations found — the path is wrong").toBeGreaterThan(100);
		expect(names.size, "no capabilities.tools parsed out of any migration — the shapes changed").toBeGreaterThan(20);
		// Three known declarations, one per shape, so a parser that loses one of the three is loud.
		expect(names, "shape (b): 0101/0107 whole-object set").toContain("transfer_conversation");
		expect(names, "shape (a): 0096 path-set").toContain("mcp_call_tool");
		expect(names, "shape (c): 0072 seed INSERT blob").toContain("tmux_run_command");
	});

	it("every tool that only a declaration can grant is declared by some seeded agent", () => {
		const declared = declaredByAnyMigration().names;
		const dead = declarationOnlyTools().filter((n) => !declared.has(n) && !(n in UNREACHABLE_BY_DESIGN));
		expect(
			dead,
			"declared by no seeded agent, and no default grants it — so nothing on the platform can call it. " +
				"Declare it on an agent in a migration, or add it to UNREACHABLE_BY_DESIGN with a reason. " +
				"NOTE: this reads migrations, not production; an agent that exists only as a D1 row (#67) " +
				"declares tools this cannot see — seed it or write the reason down, do not loosen this.",
		).toEqual([]);
	});

	it("keeps UNREACHABLE_BY_DESIGN honest — no stale entry, no empty reason", () => {
		// A guard whose escape hatch is one line is a guard people suppress. An entry that has been
		// overtaken — the tool got declared, or stopped being declaration-only — must go, or the map
		// stops being a record of decisions and becomes a list of things nobody rechecked.
		const declOnly = new Set(declarationOnlyTools());
		const declared = declaredByAnyMigration().names;
		for (const [name, reason] of Object.entries(UNREACHABLE_BY_DESIGN)) {
			expect(declOnly.has(name), `${name} is no longer declaration-only — delete its entry`).toBe(true);
			expect(declared.has(name), `${name} IS declared by a migration now — delete its entry`).toBe(false);
			expect(reason.length, `${name} needs a real reason, not a placeholder`).toBeGreaterThan(40);
		}
	});
});
