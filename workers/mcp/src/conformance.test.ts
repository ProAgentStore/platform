/**
 * What `tools/list` publishes, checked against the spec AND against the directory bar (#562).
 *
 * ── What this file measures, and what it does NOT ───────────────────────────────────────
 *
 * #561's gaps — 135 tools with no annotations, no titles and no output schemas — were found by
 * a person reading another product's settings page. Nothing in this repo looked at the tool
 * surface at all, so the build stayed green throughout. This file is the thing that looks.
 *
 * It gets its input the only way that cannot be wrong about the answer: a REAL `McpServer`
 * driven by the real `PagsMcp.init()`, connected to a real `Client` over `InMemoryTransport`,
 * and then `listTools()`. The objects asserted on below are the ones a host receives, not a
 * reconstruction of what the SDK would emit from the registration config. `index.test.ts`
 * deliberately keeps a capturing double instead — it is testing dispatch, auth and gating, and
 * a double is the right tool there. This is a second, separate harness.
 *
 * **It owns two layers, and they are not the same claim:**
 *
 *  1. **Spec conformance** — is this structurally a legal MCP tool surface? Validated against
 *     the published `schema/2025-11-25/schema.json`, vendored beside this file.
 *
 *     Stated plainly because it is the trap this file exists inside: **this arm passed before
 *     #561 and would not have caught any of it.** `Tool.required` is `["inputSchema", "name"]`
 *     — `description`, `title`, `annotations` and `outputSchema` are all OPTIONAL in the spec.
 *     A spike measured exactly that: 0 schema violations at both 2025-06-18 and 2025-11-25,
 *     with 0/2 annotations, 0/2 titles and 0/2 output schemas. Schema validation is worth
 *     having for future breakage — in particular for the hand-written `outputSchema`s #561
 *     introduces, which today would fail only at runtime inside the SDK's `validateToolOutput`
 *     — but on its own it is a guard certifying ground it never walked (ADR 0002).
 *
 *  2. **Directory conformance** — does the surface meet the published bar for listing? This is
 *     the layer with #561's findings in it, and **no published validator enforces it.**
 *     Anthropic's Software Directory Policy §5.E: "MCP servers must provide all applicable
 *     annotations for their tools, in particular `readOnlyHint`, `destructiveHint`, and
 *     `title`." §5.C caps tool names at 64 characters. PAGS has to assert this itself, and is
 *     unusually well placed to, because `safety.ts` already classifies every tool.
 *
 * **It does NOT decide whether a declared annotation is TRUE.** Nothing in a schema can tell
 * you that `cancel_instance` really is destructive. What CAN be checked — and is the one check
 * no external tool could perform — is that the annotation agrees with the scope `safety.ts`
 * gates the tool under. That classification is #561's deliverable; see the pending block at the
 * bottom of this file for the arms waiting on it.
 *
 * The official `@modelcontextprotocol/conformance` suite is deliberately NOT wired in. It
 * cannot authenticate (its `server` subcommand has no `--header`/`--token`; run against
 * production it gets the correct 401 from the OAuth provider), it is pre-1.0, and 26 of its 31
 * required server scenarios test features PAGS deliberately does not implement or fixture tools
 * it will never have. Full reasoning and measurements: #562.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// Only the Workers-runtime base class and the OAuth provider are mocked. The MCP SDK is
// REAL — mocking it is what would make this file measure a reconstruction instead of the
// wire. Verified safe: `this.server.tool` is the only method PagsMcp calls on the server.
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
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { LATEST_PROTOCOL_VERSION } = await import("@modelcontextprotocol/sdk/types.js");
const { Ajv2020 } = await import("ajv/dist/2020.js");
const addFormats = (await import("ajv-formats")).default;

/** The spec revision this file validates against, and the one the pinned SDK speaks. */
const SPEC_REVISION = "2025-11-25";

type WireTool = {
	name: string;
	description?: string;
	title?: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
};

/**
 * Drive the real registration and read back what a host would see.
 *
 * Every surface is gated on (`apply`, `repo`, `coding`) so the denominator is the whole
 * registrable surface — `MCP_TOOL_COUNT` — rather than the always-on subset.
 */
async function listPublishedTools(): Promise<WireTool[]> {
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

	// biome-ignore lint/suspicious/noExplicitAny: constructing the mocked-base subclass
	const inst = new (PagsMcp as any)();
	inst.env = { API_BASE: "https://api.test", OAUTH_KV: kv, GITHUB_ORG: "ProAgentStore" };
	inst.props = {
		authToken: "session-token",
		mcpScopes: ["read", "write", "runtime", "destructive"],
		mcpSubject: "user-1",
	};
	await inst.init();

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "pags-conformance", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), inst.server.connect(serverTransport)]);

	// Paginated by contract even though this server answers in one page: a future page size
	// would otherwise silently shrink the denominator, which is the failure ADR 0002 is about.
	const tools: WireTool[] = [];
	let cursor: string | undefined;
	do {
		const page = await client.listTools(cursor ? { cursor } : {});
		tools.push(...(page.tools as WireTool[]));
		cursor = page.nextCursor;
	} while (cursor);

	vi.unstubAllGlobals();
	return tools;
}

/** Read once — every test below shares it, and a fresh init per test costs nothing useful. */
const published = await listPublishedTools();

const specSchema = JSON.parse(
	readFileSync(new URL(`./mcp-schema-${SPEC_REVISION}.json`, import.meta.url), "utf-8"),
) as { $defs: Record<string, unknown>; $schema?: string };

describe(`MCP tool surface — spec ${SPEC_REVISION} + directory bar (#562)`, () => {
	// ── G1: the input set, asserted rather than assumed ──────────────────────────────────

	it("published the whole registrable surface, and says how big it is", () => {
		// The denominator every other test in this file divides by. `MCP_TOOL_COUNT` exists
		// because `/health` answered `tools: 41` for months while 124 were registered — a
		// count nobody derives from the registration is a count that rots. Asserted here
		// against the REAL wire response, where index.test.ts asserts it against the
		// registration call. Both must agree, and a tool that registers but fails to publish
		// (a duplicate name, a shape the SDK rejects) shows up here and only here.
		expect(published.length).toBe(MCP_TOOL_COUNT);
		expect(new Set(published.map((t) => t.name)).size).toBe(MCP_TOOL_COUNT);
	});

	it("validates against the revision the pinned SDK actually speaks", () => {
		// #562's regression risk, closed: bumping @modelcontextprotocol/sdk past 2025-11-25
		// would leave the vendored schema stale while every test here stayed green — i.e.
		// silently under-measuring against a protocol PAGS no longer speaks. The bump fails
		// HERE instead, which is the only place that can tell you why.
		expect(LATEST_PROTOCOL_VERSION).toBe(SPEC_REVISION);
	});

	it("loaded a spec schema that is actually the spec schema", () => {
		// G1 for the vendored artefact. A truncated or wrong-revision copy would make the
		// validation arm below pass by checking almost nothing, and it would look identical
		// in the output. These three are the fingerprint measured from the published file:
		// 145 definitions, 2020-12, and the `Tool.required` pair that is the whole reason
		// schema validation cannot catch #561.
		expect(specSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
		expect(Object.keys(specSchema.$defs).length).toBe(145);
		const tool = specSchema.$defs.Tool as { required: string[] };
		expect([...tool.required].sort()).toEqual(["inputSchema", "name"]);
	});

	// ── Layer 1: structural conformance to the published schema ──────────────────────────

	it(`every published tool validates against schema/${SPEC_REVISION} $defs/Tool`, () => {
		// Reminder, because this is the arm most likely to be misread as the answer: it
		// passed before #561 landed and covers NONE of #561's findings. What it does cover
		// is structural breakage — most usefully the output schemas #561 adds, which the SDK
		// otherwise rejects only at call time, inside validateToolOutput.
		const ajv = new Ajv2020({ strict: false, allErrors: true });
		addFormats(ajv);
		ajv.addSchema(specSchema, "mcp");
		const validateTool = ajv.getSchema("mcp#/$defs/Tool");
		expect(validateTool).toBeTypeOf("function");

		// G3: a tool the validator THROWS on is counted, never skipped. Skipping would turn
		// a bug in the validator into a quietly smaller measurement.
		const invalid: string[] = [];
		const errored: string[] = [];
		let checked = 0;
		for (const tool of published) {
			try {
				if (!validateTool!(tool)) invalid.push(`${tool.name}: ${ajv.errorsText(validateTool!.errors)}`);
				checked++;
			} catch (err) {
				errored.push(`${tool.name}: ${(err as Error).message}`);
			}
		}
		expect(errored).toEqual([]);
		expect(checked).toBe(MCP_TOOL_COUNT);
		expect(invalid).toEqual([]);
	});

	it(`the whole tools/list response validates against schema/${SPEC_REVISION} $defs/ListToolsResult`, () => {
		const ajv = new Ajv2020({ strict: false, allErrors: true });
		addFormats(ajv);
		ajv.addSchema(specSchema, "mcp");
		const validateResult = ajv.getSchema("mcp#/$defs/ListToolsResult");
		expect(validateResult).toBeTypeOf("function");
		const ok = validateResult!({ tools: published });
		expect(ok ? [] : [ajv.errorsText(validateResult!.errors)]).toEqual([]);
	});

	// ── Layer 2: the directory bar, which no published validator enforces ────────────────

	it("every tool name is legal under SEP-986 and Anthropic §5.C", () => {
		// Simultaneously the spec's own rule and a hard listing requirement ("MCP tool names
		// must not exceed 64 characters"). Measured green on the day it was written — 135
		// names, 0 violations, longest 31 — which is exactly when a guard is most likely to
		// be vacuous, so it was watched failing against a planted `:` before it landed.
		const illegal = published.filter((t) => !/^[A-Za-z0-9_./-]+$/.test(t.name));
		const tooLong = published.filter((t) => t.name.length < 1 || t.name.length > 64);
		expect(illegal.map((t) => t.name)).toEqual([]);
		expect(tooLong.map((t) => t.name)).toEqual([]);
	});

	it("every tool carries a non-empty description", () => {
		// Optional in `Tool.required`, required by Anthropic §2 and by the conformance
		// suite's own tools-list scenario. Also green on day one (135/135).
		const missing = published.filter((t) => typeof t.description !== "string" || t.description.trim() === "");
		expect(missing.map((t) => t.name)).toEqual([]);
	});

	// ── G2: the denominator, in the passing output ───────────────────────────────────────

	it("states the size and shape of what it measured", () => {
		const annotated = published.filter((t) => t.annotations !== undefined).length;
		const readOnlyHinted = published.filter((t) => t.annotations?.readOnlyHint !== undefined).length;
		const destructiveHinted = published.filter((t) => t.annotations?.destructiveHint !== undefined).length;
		const titled = published.filter((t) => typeof t.title === "string" && t.title !== "").length;
		const withOutput = published.filter((t) => t.outputSchema !== undefined).length;
		const longest = published.reduce((max, t) => Math.max(max, t.name.length), 0);

		console.log(
			`✓ ${published.length} tools published over a real tools/list, validated against MCP ${SPEC_REVISION}:\n` +
				`  spec schema: ${published.length}/${published.length} valid · 0 unparseable\n` +
				`  names: 0 SEP-986 violations, longest ${longest} of 64 allowed\n` +
				`  descriptions: ${published.filter((t) => t.description).length}/${published.length}\n` +
				`  directory bar (Anthropic §5.E): ${titled} titled · ${readOnlyHinted} readOnlyHint · ${destructiveHinted} destructiveHint\n` +
				`  annotations present: ${annotated}/${published.length} · outputSchema: ${withOutput}/${published.length}`,
		);

		// The tallies are printed, not asserted, for the three fields #561 owns — asserting
		// them here would make this file red on main while that work is in flight. The
		// assertions live in the pending block below and are the point of this file; this
		// test exists so the number is in every green build in the meantime, which is what
		// makes "still 0" impossible to miss (ADR 0002 G2).
		expect(published.length).toBe(MCP_TOOL_COUNT);
	});
});

/**
 * ── The arms that catch #561's class, pending #561 ──────────────────────────────────────
 *
 * `todo`, not `skip`: a skipped test reads as passing in the reporter, and the whole subject
 * of this file is guards that look green while measuring nothing.
 *
 * These are red until the annotations land, which is the point — they convert #561 from a fix
 * into an invariant. Arm 3 in particular is the check no external tool could perform, because
 * only PAGS knows `safety.ts` is the authority on what a tool is allowed to do. It deliberately
 * does NOT get a scope table written here: a second hand-maintained classification is precisely
 * what #561 AC1 forbids ("one source, not a second hand-maintained list"), so it must read the
 * one #561 produces. `remove_repo` is the known exception — its scope depends on its arguments.
 */
describe("directory bar — annotations (#561)", () => {
	it.todo("every tool declares annotations.readOnlyHint (Anthropic §5.E)");
	it.todo("every tool declares annotations.destructiveHint (Anthropic §5.E)");
	it.todo("every tool declares a title (Anthropic §5.E)");
	it.todo("every annotation agrees with the scope safety.ts gates the tool under");
});
