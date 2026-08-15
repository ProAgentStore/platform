/**
 * No tool description advertises a value the code cannot emit (#593 AC2).
 *
 * The denominator is EVERY registered tool, not the one this ticket was about: the same defect
 * was found three times on 2026-08-15 — `coding_session_capture`'s run states, `list_instance_tools`'
 * tiers (#569), `agent_trace`'s levels — so a guard scoped to one tool would certify the surface
 * on the strength of its least interesting case.
 *
 * Descriptions are read from a REAL registration run, not from source text, because several are
 * assembled at registration time (`tierGloss()`, `runStateSentence()`) and a source scan would
 * measure the template instead of the sentence a model receives.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@cloudflare/workers-oauth-provider", () => ({ OAuthProvider: class {} }));
vi.mock("agents/mcp", () => ({
	McpAgent: class {
		env: unknown;
		props: unknown;
		static serve() {
			return { fetch: () => new Response("mock") };
		}
	},
}));

const { PagsMcp } = await import("./index.js");
const { MCP_TOOL_COUNT } = await import("./tool-count.js");
const {
	BACKED_VOCABULARIES,
	CODING_RUN_STATES,
	RUN_HEALTH_STATES,
	UNBACKED_CLAIMS,
	claimKey,
	runHealthSentence,
	runStateSentence,
	stateEnumClaims,
} = await import("./state-vocabulary.js");

interface Registered {
	name: string;
	description: string;
}

/** Drive the real registration, every surface gated on, and read back the descriptions. */
async function registeredTools(): Promise<Registered[]> {
	const store = new Map<string, string>();
	const kv = {
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void store.set(k, v),
		delete: async (k: string) => void store.delete(k),
		list: async () => ({ keys: [], list_complete: true, cursor: undefined, cacheStatus: null }),
	} as unknown as KVNamespace;

	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		const body = url.endsWith("/v1/instances/my/instances")
			? { instances: ["apply", "repo", "coding"].map((s) => ({ capabilities: { surfaces: [s] } })) }
			: {};
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	});

	const tools: Registered[] = [];
	const agent = new (PagsMcp as unknown as new (...a: unknown[]) => {
		server: { tool: (...a: unknown[]) => void };
		env: unknown;
		props: unknown;
		init: () => Promise<void>;
	})();
	agent.env = { API_BASE: "https://api.test", OAUTH_KV: kv };
	agent.props = { authToken: "t", mcpScopes: ["read", "write", "runtime", "destructive"], mcpSubject: "u1" };
	await agent.init();
	// `init()` builds the real server; capture what it registered by replaying through a probe.
	const server = agent.server as unknown as { _registeredTools?: Record<string, { description?: string }> };
	for (const [name, def] of Object.entries(server._registeredTools ?? {})) {
		tools.push({ name, description: String(def.description ?? "") });
	}
	vi.unstubAllGlobals();
	return tools;
}

describe("the coding run-state vocabulary is the API's, not a restatement of it", () => {
	it("matches workers/api/src/lib/coding-run-state.ts, derived from its source", () => {
		// The MCP worker cannot import from the API worker (separate deployable), so the copy is
		// checked against the original's SOURCE rather than trusted.
		const src = readFileSync(join(import.meta.dirname, "../../api/src/lib/coding-run-state.ts"), "utf8");
		const listOf = (name: string): string[] => {
			const m = src.match(new RegExp(`export const ${name} = \\[([^\\]]+)\\]`));
			return m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
		};
		const engine = listOf("ENGINE_RUN_STATES");
		const probe = listOf("PROBE_RUN_STATES");
		// G1/G3 — a parse that found nothing must fail as a broken guard, not pass as a clean tree.
		expect(engine.length, "parsed no ENGINE_RUN_STATES — the guard has stopped measuring").toBeGreaterThanOrEqual(3);
		expect(probe.length, "parsed no PROBE_RUN_STATES — the guard has stopped measuring").toBeGreaterThanOrEqual(3);
		expect([...CODING_RUN_STATES].sort()).toEqual([...engine, ...probe].sort());
	});

	it("gives every state a gloss, so a new one cannot arrive unlabelled", () => {
		const sentence = runStateSentence();
		for (const s of CODING_RUN_STATES) expect(sentence, `no gloss for \`${s}\``).toContain(`\`${s}\` (`);
		// The three that are NOT an engine's answer are the whole point — unlabelled, a reader
		// collapses them into "idle", which is the defect.
		expect(sentence).toContain("no runner is connected");
		expect(sentence).toContain("did not answer the probe");
	});

	it("never names `working` — a value no engine can emit", () => {
		// The exact string that shipped for six weeks: "Also returns run state (idle/working/offline)".
		expect(runStateSentence()).not.toContain("working");
		expect([...CODING_RUN_STATES]).not.toContain("working");
	});
});

describe("the run-health vocabulary is the API's RunHealth union, not a restatement of it (#588)", () => {
	/**
	 * `RunHealth`'s members, read out of the API worker's source — the only copy that is authority.
	 *
	 * Parses the `as const` ARRAY rather than the type union, and the array exists over there partly
	 * so this can: a `type` is erased, so nothing on the API side could iterate it either (no CI gate
	 * typechecks a Worker test — both tsconfigs exclude `*.test.ts`). One value, two guards.
	 */
	function runHealthFromSource(): string[] {
		const src = readFileSync(join(import.meta.dirname, "../../api/src/lib/work-report.ts"), "utf8");
		const m = src.match(/export const RUN_HEALTH_STATES = \[([^\]]+)\]/);
		return m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
	}

	it("matches workers/api/src/lib/work-report.ts, derived from its source", () => {
		const members = runHealthFromSource();
		// G1/G3 — a parse that found nothing must fail as a broken guard, not pass as a clean tree.
		// If `RUN_HEALTH_STATES` is ever reshaped (back to a bare union, a TS enum, a list built from
		// another constant) this fires, which is correct: the derivation stopped measuring and must
		// be rewritten, not silently believed.
		expect(members.length, "parsed no RunHealth members — the guard has stopped measuring").toBeGreaterThanOrEqual(
			4,
		);
		// THE ASSERTION THIS TICKET EXISTS FOR. Adding a member over there without touching this
		// file turns the build red — which is exactly what did NOT happen when `ended` was added,
		// because the vocabulary lived in two hand-written English sentences instead of a constant.
		expect([...RUN_HEALTH_STATES].sort()).toEqual([...members].sort());
	});

	it("carries `ended` — the member whose absence produced the ticket", () => {
		// #588 measured `health:"working"` on 89 of 89 CLOSED runs. `ended` is the member that made
		// "no liveness claim" expressible; a vocabulary that lost it would take the defect back.
		expect([...RUN_HEALTH_STATES]).toContain("ended");
	});

	it("gives every state a gloss, so a new one cannot arrive unlabelled", () => {
		const sentence = runHealthSentence();
		for (const s of RUN_HEALTH_STATES) expect(sentence, `no gloss for \`${s}\``).toContain(`\`${s}\` (`);
		// The two clauses that are the CORRECTION, not decoration: `ended` says it makes no claim
		// (the whole point of the member), and `waiting` promises a resume time only conditionally,
		// because `coding-pause.ts:146` writes none for a human handoff (#596).
		expect(sentence).toContain("makes NO claim that anything is running");
		expect(sentence).toContain("only when one is knowable");
	});

	it("leads with a chain the sweep can actually see", () => {
		// Not cosmetic. Both drifted descriptions were INVISIBLE to `stateEnumClaims` — they wrote
		// the members with parenthesised glosses, a shape it does not read — so the claim was never
		// one of the twelve #593 swept and no inventory entry could have recorded it. Leading with
		// the bare chain puts it inside the denominator, where the backed-vocabulary check applies.
		const claims = stateEnumClaims(runHealthSentence());
		expect(claims, "the rendered sentence publishes no detectable claim").toContainEqual(
			[...RUN_HEALTH_STATES].sort(),
		);
	});

	it("is what BOTH tools publish, verbatim, because they call the same endpoint", async () => {
		const tools = await registeredTools();
		for (const name of ["check_instance_loop", "coding_loop_status"]) {
			const tool = tools.find((t) => t.name === name);
			expect(tool, `${name} is not registered`).toBeDefined();
			expect(tool?.description, `${name} does not carry the rendered vocabulary`).toContain(runHealthSentence());
			// G4 on the shipped strings: the exact wording that was live on 2026-08-15, both of which
			// defined a three-member enum the payload had already outgrown.
			expect(tool?.description).not.toContain("three values");
			expect(tool?.description).not.toContain("says what for and until when");
		}
	});
});

describe("stateEnumClaims — the scanner, proven on the strings it exists for", () => {
	it("finds the defect that produced this ticket", () => {
		// G4: the assertion flips on the real defective sentence, without needing the fix reverted.
		const claims = stateEnumClaims("Also returns run state (idle/working/offline).");
		expect(claims).toEqual([["idle", "offline", "working"]]);
		const backed = new Set(BACKED_VOCABULARIES["coding run state"].values);
		expect(claims[0].filter((v) => !backed.has(v)), "`working` must be caught as unemittable").toEqual(["working"]);
	});

	it("finds pipe lists, spaced lists and backticked chains", () => {
		expect(stateEnumClaims("reason (ok | not_declared | disabled_by_owner)")).toEqual([
			["disabled_by_owner", "not_declared", "ok"],
		]);
		expect(stateEnumClaims("plus `thinking`/`responding` is a long step")).toEqual([["responding", "thinking"]]);
		expect(stateEnumClaims("view (kanban | list)")).toEqual([["kanban", "list"]]);
	});

	it("does not mistake ordinary parenthesised prose for a value set", () => {
		expect(stateEnumClaims("Capture the pane (what the CLI is showing right now).")).toEqual([]);
		expect(stateEnumClaims("no parentheses at all here")).toEqual([]);
		// Both real, both on this surface, both containing a slash inside prose. A guard that read
		// these as value sets would demand an inventory entry for a phrase, and the next person
		// would delete the guard rather than the phrase.
		expect(stateEnumClaims("Filter by trace_id (one run/turn)")).toEqual([]);
		expect(stateEnumClaims("Remove one repo (by repo_url or owner/repo)")).toEqual([]);
	});
});

describe("every tool that publishes a value set is backed or recorded", () => {
	it("sweeps the whole registered surface and states what it measured", async () => {
		const tools = await registeredTools();

		// G1 — the input set is asserted. A registration that silently produced nothing, or a
		// description reader that stopped working, must fail HERE rather than sweep zero claims and
		// report a clean surface.
		expect(tools.length, "no tools were registered — the sweep is measuring nothing").toBeGreaterThanOrEqual(
			MCP_TOOL_COUNT,
		);
		const described = tools.filter((t) => t.description.trim());
		expect(described.length, "tools registered but no descriptions were read").toBeGreaterThanOrEqual(MCP_TOOL_COUNT);

		const backedSets = Object.values(BACKED_VOCABULARIES).map((v) => new Set(v.values));
		const violations: string[] = [];
		const seenUnbacked = new Set<string>();
		let claimCount = 0;
		let backedCount = 0;

		for (const tool of described) {
			for (const members of stateEnumClaims(tool.description)) {
				claimCount++;
				const key = claimKey(members);
				// Backed: every member must be emittable by that vocabulary.
				if (backedSets.some((set) => members.every((m) => set.has(m)))) {
					backedCount++;
					continue;
				}
				// A claim that OVERLAPS a backed vocabulary without being a subset is the defect —
				// some of its values are emittable and at least one is not.
				const overlapping = backedSets.find((set) => members.some((m) => set.has(m)));
				if (overlapping) {
					const bad = members.filter((m) => !overlapping.has(m));
					violations.push(`${tool.name}: advertises ${bad.map((b) => `\`${b}\``).join(", ")} — no code emits it (claim: ${key})`);
					continue;
				}
				if (key in UNBACKED_CLAIMS) { seenUnbacked.add(key); continue; }
				violations.push(
					`${tool.name}: publishes the value set \`${key}\` which no vocabulary backs. ` +
						"Either add it to BACKED_VOCABULARIES with the source that emits it, or record it in " +
						"UNBACKED_CLAIMS with the reason it cannot be checked yet.",
				);
			}
		}

		expect(violations, violations.join("\n")).toEqual([]);

		// The ratchet's shrink arm: an entry that no longer appears has been fixed or reworded, and
		// must leave — otherwise the inventory rots into an allowlist nobody reads.
		const stale = Object.keys(UNBACKED_CLAIMS).filter((k) => !seenUnbacked.has(k));
		expect(stale, `UNBACKED_CLAIMS entries no longer found on any description: ${stale.join(", ")}`).toEqual([]);

		// G2 — the denominator, in the passing output. 14 is what the registered surface publishes
		// today, measured; a floor rather than an equality so adding a documented enum is not a
		// failure, but a scanner that stops finding them — or a description that quietly drops its
		// vocabulary — falls under it and says so. It was 12 until #588 rendered `run health` into
		// the two loop tools, which is the point: backing a claim is what moves this number, and a
		// claim nobody can see moves nothing.
		expect(claimCount, "value-set claims swept across the registered surface").toBeGreaterThanOrEqual(14);
		// The split is PRINTED rather than asserted into a string nobody reads, the way
		// `conformance.test.ts` prints its tallies: the number that matters is how much of the
		// surface is checked against emitting code, and it belongs in every green build so a
		// regression in coverage is visible without re-deriving it. Backed/inventoried are
		// OCCURRENCES (a vocabulary published by two tools is two claims, and both are checked).
		console.log(
			`✓ ${described.length} tools swept for value-set claims:\n` +
				`  ${claimCount} claims found · ${backedCount} backed by a derived vocabulary · ${claimCount - backedCount} inventoried as unbacked\n` +
				`  ${Object.keys(BACKED_VOCABULARIES).length} backed vocabularies (${Object.keys(BACKED_VOCABULARIES).join(", ")}) · ` +
				`${seenUnbacked.size} distinct UNBACKED_CLAIMS entries still present\n` +
				"  NOT counted: a claim written with parenthesised glosses is invisible to the scanner — see state-vocabulary.ts for why detection is not the mechanism",
		);
	});

	it("coding_session_capture publishes the RENDERED vocabulary, not a retyped one", async () => {
		const tools = await registeredTools();
		const capture = tools.find((t) => t.name === "coding_session_capture");
		expect(capture, "coding_session_capture is not registered").toBeDefined();
		// The link that makes the generation mechanism real: the description contains the sentence
		// built from the constant, so it cannot name a state the code does not have.
		expect(capture?.description).toContain(runStateSentence());
		expect(capture?.description).not.toContain("(idle/working/offline)");
	});
});
