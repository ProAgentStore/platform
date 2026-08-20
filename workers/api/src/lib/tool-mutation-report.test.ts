import { describe, expect, it } from "vitest";
import { allToolPolicyInputs, resolveToolPolicy } from "./instance-tool-policy.js";
import { builtinToolPolicyInputs, mutatesBuiltin } from "./builtin-tool-policy.js";
import { registryTools, runRegistryTool } from "./tool-registry.js";
import type { AgentCapabilities } from "./agent-capabilities.js";
import type { ToolDef } from "./connectors/types.js";
import type { Env } from "../types.js";

/**
 * Does the tool listing tell an auditor the truth about what changes things (#563)?
 *
 * ── The claim that was false ────────────────────────────────────────────────────────────────
 *
 * `list_instance_tools` said "use this to verify an agent is read-only", and the field it offered
 * for that was `scope`. Measured on production instance bd43f4de-… (104 rows, 2026-08-15), NINE
 * tools that change things reported `scope: "read"`: start_work (starts a durable autonomous run),
 * stop_work, end_coding_session (kills an engine on the owner's machine), set_behaviour,
 * set_stats_card, run_pipeline, create_ticket, record_feedback and dedupe_upsert. In the same
 * response `configure_board` correctly read `write` — so one listing told a reader that changing
 * kanban columns is a write and changing who the agent IS is a read.
 *
 * ── Why the obvious fix is the wrong one, and this file's job ───────────────────────────────
 *
 * `scope` is not an audit label. It is the input to the write-consent gate (#90), and
 * `runRegistryTool` refuses a `scope:"write"` tool that has no connector OUTRIGHT — "unreachable
 * rather than silently ungated". So stamping `write` on those nine would not have corrected the
 * report, it would have BROKEN all nine. That is the trap, and `the nine stay reachable` below is
 * the assertion that keeps someone from walking into it later: it drives the real dispatcher and
 * fails the moment one of them starts being refused by the consent gate.
 *
 * ── ADR 0002: what this file measured ───────────────────────────────────────────────────────
 *
 * Every arm states its denominator and fails when the input set is implausibly small, because an
 * empty registry and a clean registry are otherwise the same green tick. The floors are set below
 * the live counts with a reason, never at them: this surface grows.
 */

const caps = (over: Partial<AgentCapabilities>): AgentCapabilities =>
	({ surfaces: [], runtime: null, workflow: null, ...over }) as AgentCapabilities;

/**
 * Every tool in the listing that CHANGES something, written out rather than derived.
 *
 * Derived would be circular — it would assert the code agrees with itself. This is the audit
 * answer, and it is a decision: a tool arriving here (or leaving) fails this test by name, which
 * is what makes someone read the handler and decide, the way `BUILTIN_TOOL_SCOPES` forces the
 * read/write decision one layer down.
 *
 * Every entry was checked against its handler. The non-obvious ones carry their reason at the
 * declaration site: `http_request`/`fetch_url` (the CALLER picks the verb, so one of the verbs is
 * DELETE), `fan_out`/`enrich` (they re-dispatch a tool, or a whole request, supplied as input),
 * `dedupe_upsert` (writes the instance's own collection and fires the agent-to-agent pump).
 */
const MUTATING = new Set<string>([
	// ── the nine the audit found misreported ──
	"start_work",
	"stop_work",
	"end_coding_session",
	"set_behaviour",
	"set_stats_card",
	"run_pipeline",
	"create_ticket",
	"record_feedback",
	"dedupe_upsert",
	// ── found by walking the REST of the surface, which the audit did not enumerate ──
	"fan_out", // pages mode forwards the author's method to http_request
	"enrich", // runs whatever tool its `tool` input names
	"http_request", // caller picks the verb
	"fetch_url", // the built-in with http_request's shape; same answer, by derivation
	// ── connector tools that were already honest (scope:"write" → mutates) ──
	"github_create_issue",
	"github_comment_issue",
	"github_update_issue",
	"whatsapp_send_message",
	"instagram_send_dm",
	"terminal_run_command",
	"terminal_send_keys",
	"terminal_send_message",
	"terminal_new_target",
	"terminal_kill_target",
	"tmux_run_command",
	"tmux_send_keys",
	"tmux_send_message",
	"tmux_new_session",
	"tmux_kill_session",
	"browser_navigate",
	"browser_act",
	"delegate_goal",
	"transfer_conversation",
	"set_direction",
	"mcp_call_tool",
	"sheets_append",
	// #713. Mail leaves under the owner's name and cannot be recalled — the most irreversible
	// mutation on the platform, and the reason both sit behind the write-consent gate.
	"gmail_reply",
	"gmail_send",
	// #716. Reversible — an archived message is still in All Mail — but it changes what the
	// owner sees in their inbox, which is a mutation by any reading.
	"gmail_archive",
	"gmail_mark_read",
	// #712. Neither touches the SOURCE pdf — both write a NEW file into the instance's store,
	// which is a change to this agent's own data and so a mutation. inspect_pdf_form only reads.
	"fill_pdf_form",
	"build_answer_sheet",
	// ── built-ins, derived from BUILTIN_TOOL_SCOPES ──
	"write_memory",
	"delete_memory",
	"create_task",
	"update_task",
	"configure_board",
	"update_knowledge",
	"delete_knowledge",
	"add_knowledge",
	"upload_file",
	"delete_file",
	"create_collection",
	"insert_record",
	"update_record",
	"delete_record",
	"set_user_preference",
	"submit_job_application",
	"send_to_cli",
]);

/** The nine, exactly as the issue measured them, in the shape that makes them dangerous:
 *  they change things AND they have no connector, so no consent gate can ever cover them. */
const CONNECTORLESS_MUTATORS = [
	"start_work",
	"stop_work",
	"end_coding_session",
	"set_behaviour",
	"set_stats_card",
	"run_pipeline",
	"create_ticket",
	"record_feedback",
	"dedupe_upsert",
] as const;

/** The consent gate's refusal, matched as a shape rather than a sentence. */
const CONSENT_REFUSAL = /isn't permitted for this agent/;

/** Env whose consent lookup answers "not granted" for every (instance, connector, write). */
const envNoConsent = () =>
	({
		DB: {
			prepare(_sql: string) {
				return { bind() { return { first: async () => null }; } };
			},
		},
	}) as unknown as Env;

describe("the listing reports what mutates (#563)", () => {
	it("classifies every row, and the set is the audited one", () => {
		const rows = resolveToolPolicy(caps({}), [], allToolPolicyInputs(), []);
		// G1/G2 — the denominator, asserted and printed. 104 rows were measured in production;
		// below 90 means a connector or the built-in catalog failed to load and this file is
		// grading a fraction of the surface.
		expect(rows.length, "the tool listing collapsed — this test is measuring a fraction of it").toBeGreaterThan(90);
		const mutating = rows.filter((r) => r.mutates).map((r) => r.name).sort();
		const expected = [...MUTATING].sort();
		expect(mutating, "a tool changed its mutation answer: read its handler and update MUTATING with the reason").toEqual(expected);
		console.log(`✓ #563: ${mutating.length} of ${rows.length} listed tools declare mutates:true`);
	});

	it("answers the acceptance criteria by name", () => {
		const by = new Map(resolveToolPolicy(caps({}), [], allToolPolicyInputs(), []).map((r) => [r.name, r]));
		for (const name of CONNECTORLESS_MUTATORS) {
			expect(by.get(name)?.mutates, `${name} changes things and must report it`).toBe(true);
			// …and still reports the scope the GATE reads. Flipping this is the fix that breaks them.
			expect(by.get(name)?.scope, `${name} must stay scope:"read" — see runRegistryTool`).toBe("read");
			expect(by.get(name)?.connector, `${name} has no connector, which is why scope cannot fix this`).toBeUndefined();
		}
		for (const name of ["map", "filter", "slice", "repo_grep", "github_read_issue"]) {
			expect(by.get(name)?.mutates, `${name} changes nothing and must not report a mutation`).toBe(false);
		}
	});

	it("gives fetch_url and http_request the same answer", () => {
		// builtin-tool-policy.ts's header forbids two answers to one question in one listing, and
		// these two tools are the same question: a caller-chosen HTTP verb. `fetch_url` is a
		// built-in (derived) and `http_request` a registry tool (declared), so nothing but this
		// keeps them equal.
		const by = new Map(resolveToolPolicy(caps({}), [], allToolPolicyInputs(), []).map((r) => [r.name, r]));
		expect(by.get("fetch_url")?.mutates).toBe(by.get("http_request")?.mutates);
		expect(by.get("fetch_url")?.mutates).toBe(true);
		expect(by.get("fetch_url")?.scope).toBe("read");
	});

	it("carries a boolean on every registry tool and every built-in, with no default doing the work", () => {
		// The compiler already refuses a hand-written ToolDef with no `mutates` — that is the
		// primary enforcement and it cannot be tested from here (the field is erased). What CAN be
		// wrong at runtime is the path the compiler does not see: `compileConnector` builds ToolDefs
		// from manifest DATA, and `sanitizeConnectorManifest` from untrusted JSON.
		const registry = registryTools();
		const builtins = builtinToolPolicyInputs();
		expect(registry.length, "the registry collapsed").toBeGreaterThan(60);
		expect(builtins.length, "the built-in catalog collapsed").toBeGreaterThan(25);
		const undeclared = [...registry, ...builtins].filter((t) => typeof t.mutates !== "boolean").map((t) => t.name);
		expect(undeclared, "these tools reach the listing with no mutation answer").toEqual([]);
		console.log(`✓ #563: ${registry.length} registry tools + ${builtins.length} built-ins all declare mutates`);
	});

	it("derives the built-in answer from the scope table it already keeps", () => {
		// Not a second hand-list: `BUILTIN_TOOL_SCOPES` genuinely is a "does the handler mutate"
		// judgement (its own header says so), so deriving is honest here and declaring twice would
		// be a copy that can disagree with itself.
		const schemaOf = new Map(builtinToolPolicyInputs().map((t) => [t.name, t.jsonSchema]));
		for (const t of builtinToolPolicyInputs()) {
			expect(t.mutates, t.name).toBe(mutatesBuiltin(t.name, schemaOf.get(t.name)));
			if (t.scope === "write") expect(t.mutates, `${t.name} is a write and must report a mutation`).toBe(true);
		}
	});

	it("fails closed for an input that declares nothing", () => {
		// The opposite default to `scope`, on purpose: a missing scope means "no gate applies",
		// a missing mutation answer means "assume it changes something".
		const [row] = resolveToolPolicy(caps({ tools: ["mystery"] }), [], [
			{ name: "mystery", description: "a tool added tomorrow", jsonSchema: { type: "object", properties: {} } },
		]);
		expect(row.mutates).toBe(true);
		expect(row.scope).toBe("read");
	});
});

describe("the fix did not change what runs (#563)", () => {
	/**
	 * THE trap. `scope:"write"` on a connector-less tool makes it unreachable, so the tempting fix
	 * — "just declare them writes" — silently disables nine working tools. These two arms drive the
	 * REAL dispatcher, so they fail the day someone tries it.
	 */
	it("the nine stay reachable: the consent gate does not refuse them", async () => {
		expect(CONNECTORLESS_MUTATORS.length, "the audited set shrank").toBe(9);
		for (const name of CONNECTORLESS_MUTATORS) {
			// No instance context, so every handler declines on its own terms after the gates have
			// let it through — which is exactly the evidence wanted: the call REACHED the handler.
			const r = await runRegistryTool(name, { env: {} as Env }, {});
			expect(r.content, `${name} is being refused by the write-consent gate — it has no connector, so it can never be un-refused`).not.toMatch(CONSENT_REFUSAL);
			expect(r.content, `${name} did not reach its handler`).toMatch(/needs an owned instance context|collection and key are required/);
		}
		console.log(`✓ #563: all ${CONNECTORLESS_MUTATORS.length} connector-less mutators still reach their handlers`);
	});

	it("every write-scoped registry tool is still refused without consent", async () => {
		// The refusal set, enumerated from the registry rather than typed out. The gate keys on
		// `scope` and this change did not touch `scope`, so this arm is what proves the claim.
		const gated = registryTools().filter((t: ToolDef) => t.scope === "write");
		expect(gated.length, "no write-scoped tools found — the registry did not load").toBeGreaterThan(15);
		for (const t of gated) {
			const r = await runRegistryTool(t.name, { env: envNoConsent(), userId: "u1", instanceId: "i1" }, {});
			expect(r.success, t.name).toBe(false);
			expect(r.content, `${t.name} is scope:"write" and was NOT refused without consent`).toMatch(CONSENT_REFUSAL);
		}
		console.log(`✓ #563: ${gated.length} write-scoped registry tools still refused without consent`);
	});
});
