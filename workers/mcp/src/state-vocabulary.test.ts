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
import { existsSync, readFileSync } from "node:fs";
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
	CLEARED_TASK_STATUSES,
	CODING_RUN_STATES,
	RUN_HEALTH_STATES,
	UNBACKED_CLAIMS,
	claimKey,
	clearFinishedSentence,
	enumAnnouncements,
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
		// `waiting` used to promise a resume time unconditionally, then (#596) only "when one is
		// knowable". Neither described the field once `waiting_until` began carrying a GIVE-UP
		// instant for a human handoff: the same column, under a different verb. So the gloss now
		// has to name the verb, and that is what is pinned — a reader who takes a give-up
		// deadline for a resume time has been told the run will continue on its own when the
		// clock is in fact running against them.
		expect(sentence).toContain("when the end is knowable");
		expect(sentence, "a usage-limit park resumes at the instant").toContain("RESUMES then");
		expect(sentence, "a human handoff gives up at the instant").toContain("GIVES UP then");
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

describe("the cleared-task vocabulary is derived from the endpoint AND the runner union (#609)", () => {
	const REPO = join(import.meta.dirname, "../../..");

	/** The endpoint's own filter — the array `clear-finished`'s SQL is built from. */
	function clearFilterFromSource(): string[] {
		const src = readFileSync(join(REPO, "workers/api/src/routes/instances-runtime.ts"), "utf8");
		const m = src.match(/export const CLEARED_RUNTIME_TASK_STATUSES = \[([^\]]+)\]/);
		return m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
	}

	/**
	 * `TaskStatus`'s members, read out of the runner's source.
	 *
	 * Parsed from the TYPE union rather than an `as const` array, unlike `RunHealth`. #609 AC2
	 * proposed converting it, and that was NOT done: nothing in this repo needs to ITERATE
	 * `TaskStatus` at runtime (the iterable copy is `CLEARED_TASK_STATUSES`, right here), so the
	 * conversion would have been a change to a package owned by another agent's work this batch
	 * for no guarantee this parse does not already give. A reshape of that declaration fails the
	 * floor below rather than passing quietly, which is the property that matters.
	 */
	function taskStatusFromSource(): string[] {
		const src = readFileSync(join(REPO, "packages/browser-runner/src/types.ts"), "utf8");
		const m = src.match(/export type TaskStatus =([^;]+);/);
		return m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
	}

	it("publishes the filter narrowed to statuses a task can actually hold", () => {
		const filter = clearFilterFromSource();
		const statuses = taskStatusFromSource();
		// G1/G3 — a parse that found nothing must fail as a broken guard, not pass as a clean tree.
		expect(filter.length, "parsed no CLEARED_RUNTIME_TASK_STATUSES — the guard has stopped measuring")
			.toBeGreaterThanOrEqual(3);
		expect(statuses.length, "parsed no TaskStatus members — the guard has stopped measuring").toBeGreaterThanOrEqual(6);
		expect([...CLEARED_TASK_STATUSES].sort()).toEqual(filter.filter((s) => statuses.includes(s)).sort());
	});

	it("never names `done` — the member that does not exist, in any of the three sources", () => {
		// G4 on the exact string that shipped: "Clear all finished (done/failed/cancelled) runtime
		// tasks from a subscribed instance's board." The assertion flips on the real defect without
		// the fix being reverted, because `done` is absent from the code the sentence is built from.
		expect(taskStatusFromSource(), "`done` is a LoopStopReason, never a TaskStatus").not.toContain("done");
		expect(clearFilterFromSource()).not.toContain("done");
		expect([...CLEARED_TASK_STATUSES]).not.toContain("done");
		expect(clearFinishedSentence()).not.toContain("done");
	});

	it("does not publish `expired`, which the filter names and no writer can produce", () => {
		// The other half of the same defect, and the reason the published set is an INTERSECTION.
		// Advertising a status a row cannot hold is the `agent_trace level:"error"` failure (#564)
		// pointed the other way. The filter keeps it (legacy rows); the description must not — #611.
		expect(clearFilterFromSource(), "the filter still carries it — if not, drop this arm").toContain("expired");
		expect(taskStatusFromSource()).not.toContain("expired");
		expect(clearFinishedSentence()).not.toContain("`expired`");
	});

	it("publishes exactly ONE claim the sweep can see, and it is the backed one", () => {
		// Two assertions in one, both load-bearing. The sentence must be detectable at all (the
		// #600 lesson: a vocabulary rendered from a constant and invisible to the scanner is
		// checked by generation and uncounted by detection at once) — and it must not publish a
		// SECOND chain, because the kept statuses are a subset of the same union rather than a
		// vocabulary of their own, and a second claim would demand its own backing entry.
		const claims = stateEnumClaims(clearFinishedSentence());
		expect(claims).toEqual([[...CLEARED_TASK_STATUSES].sort()]);
		expect(enumAnnouncements(clearFinishedSentence()).length, "the sweep must count this as an announcement")
			.toBeGreaterThanOrEqual(1);
	});

	it("is what clear_finished_tasks publishes, verbatim", async () => {
		const tools = await registeredTools();
		const tool = tools.find((t) => t.name === "clear_finished_tasks");
		expect(tool, "clear_finished_tasks is not registered").toBeDefined();
		expect(tool?.description).toBe(clearFinishedSentence());
		// G4 on the shipped string, at the surface a model actually reads.
		expect(tool?.description).not.toContain("(done/failed/cancelled)");
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
		let announcedCount = 0;
		const unreadable: string[] = [];

		for (const tool of described) {
			// THE DENOMINATOR ARM (#600). A description that announces a value set but yields no
			// parsed claim is not a clean description — it is a claim outside the measurement, and
			// it looks identical to a tool that publishes no vocabulary at all. That is how both
			// drifted `health` descriptions sat outside the twelve #593 counted while the inventory
			// reported itself complete.
			const announcements = enumAnnouncements(tool.description);
			if (announcements.length) {
				announcedCount++;
				if (stateEnumClaims(tool.description).length === 0) {
					unreadable.push(
						`${tool.name}: announces a value set ("${announcements[0]}") that stateEnumClaims cannot read. ` +
							"RENDER the vocabulary so the members are detectable — lead with a `a`/`b`/`c` chain the " +
							"way runHealthSentence and runStateSentence do — rather than widening the scanner, which " +
							"was measured at 6 false positives in 8 candidates.",
					);
				}
			}
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
		expect(unreadable, unreadable.join("\n")).toEqual([]);

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
		// 15 since #600, and the +1 over #588's 14 is the point rather than drift: making
		// `runStateSentence` lead with a bare chain moved `coding_session_capture`'s vocabulary
		// from checked-by-generation-but-invisible-to-detection into the counted population. A
		// claim nobody can see moves nothing, so this number only rises when coverage does.
		expect(claimCount, "value-set claims swept across the registered surface").toBeGreaterThanOrEqual(15);
		// G2 for the arm above: announcements are the population, parsed claims are what was
		// checked. Asserting the floor stops the sweep silently reporting "0 unreadable" because
		// the ANNOUNCEMENT detector broke rather than because the surface is clean — the same
		// empty-set-passes trap one level up.
		expect(announcedCount, "descriptions announcing a value set — the detector has stopped detecting").toBeGreaterThanOrEqual(3);
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
				`  ${announcedCount} description(s) ANNOUNCE a value set == ${announcedCount - unreadable.length} readable by the scanner + ${unreadable.length} unreadable\n` +
				"  That last line replaced a caveat (#600). It used to read \"NOT counted: a claim written with " +
				"parenthesised glosses is invisible to the scanner\" — true, and the sort of thing a guard states " +
				"instead of measuring. It is now the arm that fails.",
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

describe("the inventory's own citations resolve (#600)", () => {
	/**
	 * A verification artefact that is itself unverified erodes trust in the verification, and this
	 * one was: three of nine `reason` strings named code that does not exist — `lib/tool-listing.ts`
	 * (no such file), `lib/connector-consent.ts` (zero occurrences of any of the four members it was
	 * cited for) and `lib/coding-engines.ts` (a DIFFERENT four-member set). An entry pointing at a
	 * missing file passed exactly as an accurate one did, because the citation was prose.
	 *
	 * Three false in nine is too poor a base rate to spot-check the remaining six, so this checks
	 * all of them mechanically and states the denominator.
	 */
	const REPO_ROOT = join(import.meta.dirname, "../../..");

	/**
	 * The members a cited symbol actually DECLARES — not the words that appear near it (#609 AC3).
	 *
	 * Until #609 this was a substring test over a ±12/+16-line window, which answers a weaker
	 * question than the one the inventory is for: "do these words appear near that symbol?" A
	 * window of 28 lines around a function that formats a refusal contains the enum it takes as a
	 * parameter, so citing the FUNCTION passes exactly as citing the enum does — and the record
	 * exists so a future reader can go to the declaration and decide whether the claim can now be
	 * backed. Sending them to a formatter is a softer version of sending them to a missing file.
	 *
	 * Two strategies, and which one answered is REPORTED rather than averaged away:
	 *
	 *   · `declaration` — a `type`/`const`/`enum` statement, read from its first line to the `;`
	 *     that ends it. Tight: only literals inside the declaration count.
	 *   · `doc-comment` — the comment immediately above a field, for the one entry whose members
	 *     are documented rather than declared (`EventInput.source`, an explicitly OPEN field:
	 *     `'chat' | 'apply' | … | …`). Looser by construction, so it is counted separately; a
	 *     doc-comment citation certifies less than a declaration one and must not read as if it
	 *     certified the same.
	 *
	 * `null` is collected as a member because `AgentRuntimeKind` has it unquoted.
	 */
	function declaredMembers(src: string, symbol: string): { members: string[]; from: string } | null {
		const lines = src.split("\n");
		const members = (chunk: string): string[] => {
			const out = [...chunk.matchAll(/["']([a-z_][a-z_/.]*)["']/g)].map((m) => m[1]);
			if (/[=|]\s*null\b/.test(chunk)) out.push("null");
			return out;
		};
		const declAt = lines.findIndex((l) => new RegExp(`\\b(?:type|const|enum|interface)\\s+${symbol}\\b`).test(l));
		if (declAt !== -1) {
			// The STATEMENT, not a window: first line of the declaration through the `;` that ends
			// it (capped, so an unterminated parse cannot swallow the rest of the file).
			const slice = lines.slice(declAt, declAt + 24);
			const end = slice.findIndex((l) => l.includes(";"));
			return { members: members(slice.slice(0, end === -1 ? slice.length : end + 1).join("\n")), from: "declaration" };
		}
		// A field rather than a declaration: take the doc comment that documents it.
		const fieldAt = lines.findIndex((l) => new RegExp(`^\\s*${symbol}\\s*[?:]`).test(l));
		if (fieldAt === -1) return null;
		let top = fieldAt;
		while (top > 0 && /^\s*(\/\*\*|\*|\/\/)/.test(lines[top - 1])) top--;
		if (top === fieldAt) return { members: [], from: "doc-comment" };
		return { members: members(lines.slice(top, fieldAt + 1).join("\n")), from: "doc-comment" };
	}

	/** The one code path both the sweep and its red demonstration run. */
	function citationProblem(key: string, entry: { source: string | null; symbol?: string; valueSet?: false }): string | null {
		if (entry.source === null) return null;
		const path = join(REPO_ROOT, entry.source);
		if (!existsSync(path)) return `${key}: cites ${entry.source}, which does not exist`;
		if (!entry.symbol) return null;
		const declared = declaredMembers(readFileSync(path, "utf8"), entry.symbol);
		if (declared === null) return `${key}: ${entry.source} does not declare \`${entry.symbol}\``;
		if (entry.valueSet === false) return null;
		if (!declared.members.length) {
			return (
				`${key}: ${entry.source} declares \`${entry.symbol}\`, but it holds no string members — ` +
				"either the citation names the wrong symbol, or the symbol is not a value set and the " +
				"entry should say so with `valueSet: false`."
			);
		}
		const missing = key.split("|").filter((m) => !declared.members.includes(m));
		return missing.length
			? `${key}: \`${entry.symbol}\` in ${entry.source} declares [${declared.members.join(", ")}] — ` +
				`${missing.map((m) => `\`${m}\``).join(", ")} is not among them, so the citation names the wrong symbol or file.`
			: null;
	}

	it("every citation names a file that exists and a symbol that DECLARES the members", () => {
		const entries = Object.entries(UNBACKED_CLAIMS);
		// G1 — an inventory that parsed to nothing must fail rather than report nine clean
		// citations over an empty map.
		expect(entries.length, "UNBACKED_CLAIMS is empty — this guard is measuring nothing").toBeGreaterThanOrEqual(5);

		const problems: string[] = [];
		const modes: Record<string, number> = { declaration: 0, "doc-comment": 0, "not-a-value-set": 0, "file-only": 0 };
		let cited = 0;
		for (const [key, entry] of entries) {
			if (entry.source === null) continue;
			cited++;
			const problem = citationProblem(key, entry);
			if (problem) {
				problems.push(problem);
				continue;
			}
			if (!entry.symbol) modes["file-only"]++;
			else if (entry.valueSet === false) modes["not-a-value-set"]++;
			else {
				const declared = declaredMembers(readFileSync(join(REPO_ROOT, entry.source), "utf8"), entry.symbol);
				modes[declared?.from ?? "file-only"]++;
			}
		}

		expect(problems, problems.join("\n")).toEqual([]);
		// G2 — the denominator. "All citations valid" over zero citations is the failure this
		// whole file is about.
		expect(cited, "citations actually resolved against the tree").toBeGreaterThanOrEqual(7);
		const compared = modes.declaration + modes["doc-comment"];
		expect(compared, "citations whose MEMBERS were compared, not merely resolved").toBeGreaterThanOrEqual(6);
		// AC4's denominator, and the distinction it exists to make: resolving is not comparing.
		console.log(
			`✓ ${cited} of ${entries.length} UNBACKED_CLAIMS entries carry a citation; all resolve against the tree.\n` +
				`  ${compared} had their MEMBERS compared to the cited declaration — ` +
				`${modes.declaration} against a type/const declaration, ${modes["doc-comment"]} against a documented (open) field.\n` +
				`  ${modes["not-a-value-set"]} recorded \`valueSet: false\` (the members are field names, not values) · ` +
				`${modes["file-only"]} cite a file with no symbol.\n` +
				"  Members-match is new in #609 and is STRICTLY WEAKER than it sounds: `cancelled|done|failed` " +
				"cited `LoopStopReason`, which contains all three, while describing runtime TASK status. Values " +
				"matching a source does not make it the right source — only generation closes that, which is why " +
				"that entry is gone rather than re-cited.",
		);
	});

	it("goes red on a citation that does not resolve — all three of the ways the real ones failed", () => {
		// G4, on the three shapes actually found rather than one invented one. Each is run
		// through the same code path the sweep uses, against the REAL tree.
		const bad: Record<string, { source: string; symbol: string }> = {
			// 1. the file does not exist — `lib/tool-listing.ts`, as recorded until #600.
			"disabled_by_owner|not_declared|ok": { source: "workers/api/src/lib/tool-listing.ts", symbol: "ToolPolicyReason" },
			// 2. the file exists and contains none of the members — `lib/connector-consent.ts`.
			"granted|n/a|per_call|required": { source: "workers/api/src/lib/connector-consent.ts", symbol: "ConnectorScope" },
			// 3. the file exists and declares a DIFFERENT set of the same size — `EngineAuth`.
			"account|default|env|platform": { source: "workers/api/src/lib/coding-engines.ts", symbol: "EngineAuth" },
		};
		const failures: string[] = [];
		for (const [key, entry] of Object.entries(bad)) {
			const problem = citationProblem(key, entry);
			if (problem) failures.push(problem.includes("does not exist") ? `${key}: missing file` : `${key}: members absent`);
		}
		// All three must be rejected. If any passes, the check is too loose to have caught the
		// citations that were actually wrong, which is the only thing it exists for.
		expect(failures).toHaveLength(3);
		expect(failures[0]).toContain("missing file");
	});

	it("goes red on the FOURTH shape — a symbol that merely MENTIONS the members (#609 AC3)", () => {
		/** The check as it stood after #600: does the ±12/+16 window contain these words? */
		function passedTheOldCheck(source: string, symbol: string, key: string): boolean {
			const lines = readFileSync(join(REPO_ROOT, source), "utf8").split("\n");
			const at = lines.findIndex((l) => new RegExp(`\\b${symbol}\\b`).test(l) && !l.trim().startsWith("*"));
			if (at === -1) return false;
			const window = lines.slice(Math.max(0, at - 12), at + 16).join("\n");
			return key.split("|").every((m) => window.includes(m));
		}

		// The demonstration is on the REAL tree, and the two symbols are in the SAME file, four
		// lines apart: `EventLevel` (`debug|info|warn|error`) is declared at events.ts:14, and the
		// `source` field whose doc comment lists `'chat' | 'apply' | 'coding' | 'voice'` is at :23.
		// A window that starts twelve lines above the type and runs sixteen below it swallows the
		// comment, so citing the WRONG type in the right file passed the old check exactly as the
		// right one did — the hole AC3 names, present on this tree today rather than invented.
		const wrong = { source: "workers/api/src/lib/events.ts", symbol: "EventLevel" };
		expect(passedTheOldCheck(wrong.source, wrong.symbol, "apply|chat|coding|voice"), "the old check rejected it, so this demo proves nothing — pick another pair").toBe(true);
		expect(citationProblem("apply|chat|coding|voice", wrong), "the members-match arm must reject the wrong type").toContain("is not among them");

		// The other shape the statement reader rejects: a symbol that is not a declaration at all.
		// `explainRefusal` is a formatter taking `ToolPolicyReason` as a parameter, so all three
		// members sit in its window — and it declares nothing.
		expect(passedTheOldCheck("workers/api/src/lib/tool-refusal.ts", "explainRefusal", "disabled_by_owner|not_declared|ok")).toBe(true);
		expect(citationProblem("disabled_by_owner|not_declared|ok", { source: "workers/api/src/lib/tool-refusal.ts", symbol: "explainRefusal" })).toContain("does not declare");

		// And the correct citation, one symbol away, still passes — a guard that rejected both
		// would be noise rather than a check, and noise is what gets a guard deleted.
		expect(citationProblem("disabled_by_owner|not_declared|ok", { source: "workers/api/src/lib/tool-refusal.ts", symbol: "ToolPolicyReason" })).toBeNull();
	});
});
