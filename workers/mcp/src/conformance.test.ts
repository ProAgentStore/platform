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
 * **It owns three layers, and they are not the same claim:**
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
 *  3. **Change detection** — did the surface move without the advertised version moving?
 *     (#573 AC2.) Layers 1 and 2 both passed through all four of #561's commits, correctly:
 *     the surface stayed legal and stayed within the directory bar while what a client
 *     RECEIVES changed under a frozen `serverInfo.version`. This layer hashes the published
 *     objects (minus `description`) against `surface-lock.ts`, whose header carries the two
 *     decisions — what counts as the surface, and why a mismatch fails rather than
 *     auto-bumps.
 *
 *     It lives HERE rather than in a file of its own for the reason stated two paragraphs
 *     up: it must hash the objects a host actually receives, and this file is where those
 *     objects are. A separate file would need either a second harness — a reconstruction,
 *     which is what this file exists to avoid — or an extracted helper that `tsconfig.json`'s
 *     `src/**\/*.test.ts` exclude would not cover, dragging build config into a test's
 *     plumbing. Three claims measured off one honest reading of the wire beats three files
 *     measuring three different things.
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
const { annotationsFor, TOOL_RISK, SERVER_INSTRUCTIONS } = await import("./tool-metadata.js");
const { MCP_SERVER_VERSION } = await import("./server-version.js");
const { SURFACE_LOCK } = await import("./surface-lock.js");
const { createHash } = await import("node:crypto");
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

/**
 * A live client/server pair with the network stubbed, for CALLING a tool rather than
 * listing one. This is the only harness in the repo that runs the SDK's own
 * `validateToolOutput` — the check that rejects a call when a tool declares an
 * `outputSchema` and its result does not conform. A schema is a promise the SDK enforces,
 * so the promise has to be tested where it is enforced.
 */
async function withClient(
	respond: (url: string) => unknown,
	authToken: string | null,
	// biome-ignore lint/suspicious/noExplicitAny: the SDK client type is not exported usefully here
	fn: (client: any) => Promise<void>,
): Promise<void> {
	const kv = {
		get: async () => null,
		put: async () => {},
		delete: async () => {},
		list: async () => ({ keys: [], list_complete: true, cursor: undefined, cacheStatus: null }),
	} as unknown as KVNamespace;
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		return new Response(JSON.stringify(respond(url) ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	// biome-ignore lint/suspicious/noExplicitAny: constructing the mocked-base subclass
	const inst = new (PagsMcp as any)();
	inst.env = { API_BASE: "https://api.test", OAUTH_KV: kv, GITHUB_ORG: "ProAgentStore" };
	inst.props = { authToken, mcpScopes: ["read", "write", "runtime", "destructive"], mcpSubject: "user-1" };
	await inst.init();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "pags-conformance", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), inst.server.connect(serverTransport)]);
	try {
		await fn(client);
	} finally {
		vi.unstubAllGlobals();
	}
}

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

		// The tallies are printed, not asserted, for the three fields #561 owns: the
		// assertions live in the block below and are the point of this file. This test exists
		// so the numbers are in every green build — which is what made "0 annotations, 0
		// titles" impossible to miss while #561 was in flight, and what will make a silent
		// slide back down visible now that it has landed (ADR 0002 G2).
		expect(published.length).toBe(MCP_TOOL_COUNT);
	});
});

/**
 * ── The arms that catch #561's class — armed, #561 landed ───────────────────────────────
 *
 * These were `todo` (not `skip`: a skipped test reads as passing, and the subject of this
 * file is guards that look green while measuring nothing) until the annotations shipped.
 * They convert #561 from a fix into an invariant, and they run on the WIRE objects — what a
 * host actually receives — where `index.test.ts` runs on the registration call.
 *
 * Arm 4 is the check no external tool could perform, because only PAGS knows `safety.ts` is
 * the authority on what a tool may do. It deliberately writes NO scope table of its own: a
 * second hand-maintained classification is what #561 AC1 forbids, so it reads the one #561
 * produces and asserts the wire agrees with it. Holding that classification to the gate each
 * handler enforces — by driving all 135 handlers under two scope sets — is `index.test.ts`'s
 * job, and duplicating it here would produce a second, weaker answer to the same question.
 */
describe("directory bar — annotations (#561)", () => {
	it("every tool declares annotations.readOnlyHint (Anthropic §5.E)", () => {
		const missing = published.filter((t) => typeof t.annotations?.readOnlyHint !== "boolean");
		expect(missing.map((t) => t.name)).toEqual([]);
	});

	it("every tool declares annotations.destructiveHint (Anthropic §5.E)", () => {
		// Applicable to all 135 because a read-only tool answers it too — with `false`, which
		// is the value that stops a host reading the two fields independently and seeing the
		// spec's default `true` on a tool that cannot write.
		const missing = published.filter((t) => typeof t.annotations?.destructiveHint !== "boolean");
		expect(missing.map((t) => t.name)).toEqual([]);
	});

	it("every tool declares a title (Anthropic §5.E)", () => {
		const missing = published.filter((t) => typeof t.title !== "string" || t.title.trim() === "");
		expect(missing.map((t) => t.name)).toEqual([]);
	});

	it("every annotation agrees with the scope safety.ts gates the tool under", () => {
		// The wire carries exactly the classification, tool for tool. `TOOL_RISK` is the
		// single source; `index.test.ts` is where it is held to the enforced gate, including
		// `remove_repo`, whose scope depends on its arguments and which is therefore annotated
		// with the worse of its two branches.
		const disagreements: string[] = [];
		for (const tool of published) {
			const expected = annotationsFor(tool.name);
			if (!expected) {
				disagreements.push(`${tool.name}: classified nowhere in TOOL_RISK`);
				continue;
			}
			if (JSON.stringify(tool.annotations) !== JSON.stringify(expected)) {
				disagreements.push(`${tool.name}: wire ${JSON.stringify(tool.annotations)} ≠ ${JSON.stringify(expected)}`);
			}
		}
		expect(disagreements).toEqual([]);
		// Non-vacuity: the classification covers the whole published surface, so "no
		// disagreements" cannot mean "nothing was compared".
		expect(published.filter((t) => TOOL_RISK[t.name]).length).toBe(MCP_TOOL_COUNT);
	});
});

/**
 * ── Output schemas: the promise the SDK enforces (#561) ─────────────────────────────────
 *
 * "If an output schema is provided: Servers MUST provide structured results that conform to
 * this schema" — and `validateToolOutput` (mcp.js:185-207) turns a miss into a rejected
 * call. So the risk a schema introduces is not a worse answer, it is NO answer, on a tool
 * that worked yesterday. These call the real client and would fail if that happened.
 */
describe("output schemas (#561)", () => {
	it("declares one only where the result is an identifier the next call needs", () => {
		const withSchema = published.filter((t) => t.outputSchema).map((t) => t.name).sort();
		expect(withSchema).toEqual(["list_agents", "my_instances"]);
	});

	it("returns structured content the SDK accepts, on the success path", async () => {
		await withClient(
			(url) => (url.endsWith("/v1/agents") ? { agents: [{ id: "a1", slug: "coder", name: "Coder" }] } : {}),
			"session-token",
			async (client) => {
				const res = await client.callTool({ name: "list_agents", arguments: {} });
				expect(res.structuredContent).toEqual({ agents: [{ id: "a1", slug: "coder", name: "Coder" }] });
				// The serialized JSON stays in a text block, which the spec asks for explicitly
				// so a client that reads only `content` is unaffected.
				expect(JSON.parse((res.content as { text: string }[])[0].text)).toEqual(res.structuredContent);
			},
		);
	});

	it("answers a REFUSAL without a protocol error — the trap a schema sets", async () => {
		// `authRequired()` returns before the handler runs, so nothing in the handler could
		// have attached structure; the registration pipeline does it. Without that, declaring
		// a schema would convert "you are not signed in" into a rejected call on the first
		// tool a new caller reaches.
		await withClient(
			() => ({}),
			null,
			async (client) => {
				const res = await client.callTool({ name: "my_instances", arguments: {} });
				// Stated in this order so the failure names the cause: a missing
				// `structuredContent` is what the SDK rejects the call over, and the rejection
				// comes back as an error result rather than the refusal the user asked for.
				expect(res.isError ?? false).toBe(false);
				expect(res.structuredContent).toBeDefined();
				expect((res.structuredContent as { error?: string }).error).toContain("authentication required");
			},
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — CHANGE DETECTION: did the surface move without the version? (#573 AC2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A canonical string for a published surface: tools sorted by name, `description` removed,
 * every object's keys sorted recursively, plus the server `instructions`.
 *
 * Key-sorting matters because `JSON.stringify` preserves insertion order, so a refactor that
 * built a tool's schema in a different order would change the hash without changing anything
 * a client receives — a ratchet that cries wolf is a ratchet someone regenerates without
 * reading, which is the same failure as no ratchet at all.
 *
 * `description` is dropped HERE rather than at the call site so there is exactly one place
 * that decides what the surface is. See `surface-lock.ts` for why it is dropped at all.
 */
function canonicalSurface(tools: WireTool[], instructions: string): string {
	const sortKeys = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(sortKeys);
		if (v && typeof v === "object") {
			return Object.fromEntries(
				Object.entries(v as Record<string, unknown>)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([k, val]) => [k, sortKeys(val)]),
			);
		}
		return v;
	};
	const published = [...tools]
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.map((t) => {
			const { description: _dropped, ...rest } = t;
			return sortKeys(rest);
		});
	return JSON.stringify({ instructions, tools: published });
}

const surfaceFingerprint = (tools: WireTool[], instructions: string) =>
	`sha256:${createHash("sha256").update(canonicalSurface(tools, instructions)).digest("hex")}`;

describe("published surface vs the advertised version (#573 AC2)", () => {
	it("has a lock entry for the version it advertises", () => {
		// G1 — the input set, asserted. A lock with no entry for the current version would
		// otherwise make the comparison below vacuous: `undefined === undefined` is not a
		// green build, it is a check that stopped running.
		expect(
			Object.keys(SURFACE_LOCK).length,
			"surface-lock.ts records no versions at all; it cannot certify anything",
		).toBeGreaterThanOrEqual(1);
		expect(
			SURFACE_LOCK[MCP_SERVER_VERSION],
			`surface-lock.ts has no entry for MCP_SERVER_VERSION ${MCP_SERVER_VERSION} ` +
				`(it records: ${Object.keys(SURFACE_LOCK).join(", ")}). A bumped version needs a NEW ` +
				"entry recording the surface it publishes — that pairing is the whole mechanism.",
		).toBeDefined();
	});

	it("publishes exactly the surface its version locked — or says the version must move", () => {
		// Measured over the REAL wire objects this file already holds, which is the reason
		// this layer lives here rather than in a file of its own: a second harness would be
		// a reconstruction of the wire, and the header above explains why that is worthless.
		const computed = surfaceFingerprint(published, SERVER_INSTRUCTIONS);
		expect(
			computed,
			`The published MCP surface no longer matches what ${MCP_SERVER_VERSION} locked.\n\n` +
				`  computed: ${computed}\n` +
				`  locked:   ${SURFACE_LOCK[MCP_SERVER_VERSION]}\n\n` +
				"  Something a client RECEIVES changed: a tool name, an inputSchema, an annotation,\n" +
				"  an outputSchema, or SERVER_INSTRUCTIONS. Descriptions are excluded, so this is not\n" +
				"  a reworded tool.\n\n" +
				"  Fix it by BUMPING `MCP_SERVER_VERSION` in server-version.ts and adding a new entry\n" +
				"  to SURFACE_LOCK with the computed hash above — and let `server.json`, the served\n" +
				"  /.well-known manifest and platform-docs/mcp.md follow it (`pnpm docs:drift` will\n" +
				"  name any that do not). Editing the existing entry in place records a new surface\n" +
				"  against a version that has already been published to the MCP registry.",
		).toBe(SURFACE_LOCK[MCP_SERVER_VERSION]);
	});

	it("hashes the surface and not the prose — a reworded description is not a bump", () => {
		// The decision in surface-lock.ts, executed rather than asserted in a comment. #565
		// rewrote usage_summary's description hours before this landed and correctly did not
		// bump the version; this is what makes that correct rather than merely tolerated.
		const reworded = published.map((t) =>
			t.name === "usage_summary" ? { ...t, description: "something else entirely" } : t,
		);
		expect(reworded).not.toEqual(published); // the fixture really did change
		expect(surfaceFingerprint(reworded, SERVER_INSTRUCTIONS)).toBe(
			surfaceFingerprint(published, SERVER_INSTRUCTIONS),
		);
	});

	it("moves when any of the things a caching host keys on moves", () => {
		// G4, as a property rather than one example: each mutation below is a distinct class
		// of surface change, and every one must change the hash. A ratchet that only noticed
		// tool names would have passed through three of #561's four commits.
		const base = surfaceFingerprint(published, SERVER_INSTRUCTIONS);
		const first = published[0];
		const mutations: [string, WireTool[], string][] = [
			["a tool is added", [...published, { ...first, name: "brand_new_tool" }], SERVER_INSTRUCTIONS],
			["a tool is removed", published.slice(1), SERVER_INSTRUCTIONS],
			["a tool is renamed", [{ ...first, name: "renamed" }, ...published.slice(1)], SERVER_INSTRUCTIONS],
			[
				"an annotation flips",
				[{ ...first, annotations: { ...first.annotations, readOnlyHint: !first.annotations?.readOnlyHint } }, ...published.slice(1)],
				SERVER_INSTRUCTIONS,
			],
			[
				"an outputSchema appears",
				[{ ...first, outputSchema: { type: "object" } }, ...published.slice(1)],
				SERVER_INSTRUCTIONS,
			],
			[
				"an inputSchema changes",
				[{ ...first, inputSchema: { ...first.inputSchema, extra: true } }, ...published.slice(1)],
				SERVER_INSTRUCTIONS,
			],
			["the server instructions change", published, `${SERVER_INSTRUCTIONS} and one more thing`],
		];
		for (const [what, tools, instructions] of mutations) {
			expect(surfaceFingerprint(tools, instructions), `${what} must move the fingerprint`).not.toBe(base);
		}
		expect(mutations.length, "every class of surface change is exercised").toBe(7);
	});

	it("does not move when only key ORDER changes, so the ratchet cannot cry wolf", () => {
		const reordered = published.map((t) => {
			const entries = Object.entries(t).reverse();
			return Object.fromEntries(entries) as WireTool;
		});
		expect(surfaceFingerprint(reordered, SERVER_INSTRUCTIONS)).toBe(
			surfaceFingerprint(published, SERVER_INSTRUCTIONS),
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 4 — SERIALISATION: what a host actually receives, in bytes (#586)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Layers 1–3 measure the tool DEFINITIONS a host receives. This one measures the RESULTS,
 * and it exists because the definitions were never where the bytes went wrong.
 *
 * `jsonText` indented its output by default. That cost ~22% of every JSON result and defeated
 * two guards in a single day:
 *
 *   · **#569** asserted `list_instance_tools`'s API body at ~54 KB and passed. Production
 *     served **66,042 bytes** and the calling host REFUSED it — the assertion was taken one
 *     layer above the code that serialises, so it measured a number nobody receives.
 *   · **#581** measured **44,313 bytes** for `coding_timeline`, then **40,304** with
 *     `{compact:true}`. Caught only because that author had been told about #569.
 *
 * So this arm is deliberately placed where neither of those could be fooled: it CALLS all
 * {@link MCP_TOOL_COUNT} registered tools through the real SDK client and reads the text a
 * host would receive. Not the handler's return value, not the API's body — the wire.
 *
 * **Two detectors, because one of them alone is escapable.**
 *
 *  · The exact one: a result that parses as JSON must be byte-identical to
 *    `JSON.stringify(parsed)`. That catches indentation, and it catches it precisely.
 *  · The signature one: NO result — JSON or prose — may contain `\n` + indent + `"key":`,
 *    the unmistakable fingerprint of `JSON.stringify(v, null, 2)`. This is what covers a
 *    JSON blob embedded in a sentence, which `register_instance_runtime` did until #586, and
 *    which the exact detector cannot see because the whole text does not parse.
 *
 * **It measures the tools, not `jsonText`.** Three of the pretty-printers #586 removed were
 * hand-rolled `JSON.stringify(data, null, 2)` at the call site (`agent_info`,
 * `list_agent_knowledge`, `agent_analytics` in `index.ts`), i.e. copies of the old default
 * that would have survived changing the default. Anything that reaches the wire is in scope
 * however it was produced.
 *
 * **What it does NOT measure: one path per tool.** The sweep calls each tool once, so it reads
 * whichever branch the stubbed API drives it down — a confirm-gated tool answers its refusal, a
 * coding tool answers "no active session". A tool that serialises correctly on the path taken
 * here and indents on an error path would pass. Closing that would need a per-tool table of
 * response fixtures, which is a second hand-maintained restatement of the surface and the thing
 * this file exists to avoid; the mitigation is that `jsonText` no longer HAS an indented mode,
 * so a second path can only differ by hand-rolling one.
 *
 * **The non-vacuity problem, stated because it is the real risk here.** `{}` and `[]`
 * serialise identically pretty or compact, so a tool whose stubbed result is empty cannot
 * fail this arm no matter what it does. The fixture therefore answers every API call with a
 * nested body, and the sweep partitions its results into the ones that CAN discriminate and
 * the ones that cannot — asserting the size of the first. A green run that measured two
 * empty objects is exactly the shape ADR 0002 exists to forbid.
 */

/** Two rows, nested — deep enough that indenting them changes the bytes. */
const SWEEP_ROWS = [
	{ id: "r1", name: "One", status: "ready", nested: { k: 1, deeper: ["a", "b"] } },
	{ id: "r2", name: "Two", status: "done", nested: { k: 2, deeper: ["c"] } },
];

/** The keys tools unwrap a list out of. Every one answers with {@link SWEEP_ROWS} so the
 *  result is nested whichever key a given tool reads — the alternative is a per-tool fixture
 *  table, which is a second hand-maintained restatement of the surface. */
const SWEEP_COLLECTION_KEYS = [
	"activity", "agents", "board", "cards", "collections", "columns", "connections", "connectors",
	"deliveries", "documents", "entries", "errors", "events", "files", "grants", "instances",
	"items", "keys", "loops", "messages", "models", "nodes", "notes", "profiles", "providers",
	"records", "repos", "results", "runs", "sessions", "sources", "stats", "supervisions", "tasks",
	"timeline", "tips", "tools", "triggers", "vectors",
];

function sweepBody(): Record<string, unknown> {
	const body: Record<string, unknown> = {
		ok: true,
		id: "x1",
		count: 2,
		status: "ready",
		agent: SWEEP_ROWS[0],
		data: SWEEP_ROWS[0],
		instance: SWEEP_ROWS[0],
		memory: SWEEP_ROWS,
		result: SWEEP_ROWS[0],
		runtime: SWEEP_ROWS[0],
		settings: { a: 1, b: { c: 2 } },
		state: SWEEP_ROWS[0],
		usage: SWEEP_ROWS[0],
	};
	for (const k of SWEEP_COLLECTION_KEYS) body[k] = SWEEP_ROWS;
	return body;
}

/**
 * Arguments good enough to get PAST the SDK's schema validation and into the handler,
 * derived from the published `inputSchema` rather than from a table — a table would need an
 * entry per new tool and would silently shrink the denominator when it did not get one.
 *
 * Optional arguments are left off (the default path is the one nobody thinks about, which is
 * what this whole ticket is about) except `instance_id`/`agent_id`, which most handlers
 * branch on. `confirm` gets the tool's own name because that is the convention `safety.ts`
 * documents; where it is wrong the tool answers a refusal, which is still a wire result and
 * still measured.
 */
function sweepArgs(tool: WireTool): Record<string, unknown> {
	const schema = tool.inputSchema as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
	const props = schema.properties ?? {};
	const required = new Set(schema.required ?? []);
	const always = new Set(["agent_id", "instance_id"]);
	const valueFor = (name: string, spec: Record<string, unknown>): unknown => {
		if (name === "confirm") return tool.name;
		if (Array.isArray(spec.enum)) return spec.enum[0];
		if (Array.isArray(spec.anyOf)) return valueFor(name, spec.anyOf[0] as Record<string, unknown>);
		switch (spec.type) {
			case "number":
			case "integer":
				return 1;
			case "boolean":
				return false;
			case "array": {
				// `.min(1)` is a real constraint on at least one tool (`update_agent_board_config`),
				// and an empty array there is a validation error, i.e. a handler never reached.
				const min = typeof spec.minItems === "number" ? spec.minItems : 0;
				const items = (spec.items ?? {}) as Record<string, unknown>;
				return Array.from({ length: min }, () => valueFor(name, items));
			}
			case "object": {
				const sub = (spec.properties ?? {}) as Record<string, Record<string, unknown>>;
				const subRequired = new Set((spec.required as string[] | undefined) ?? []);
				const out: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(sub)) if (subRequired.has(k)) out[k] = valueFor(k, v);
				return out;
			}
			default:
				return "x";
		}
	};
	const args: Record<string, unknown> = {};
	for (const [name, spec] of Object.entries(props)) {
		if (required.has(name) || always.has(name)) args[name] = valueFor(name, spec);
	}
	return args;
}

/** The fingerprint of `JSON.stringify(v, null, 2)` surviving inside a larger string. */
const INDENTED_JSON = /\n {2,}"[^"\n]*":/;

type SweepResult = {
	/** Handlers reached — the denominator every assertion below divides by. */
	called: number;
	/** Tools whose JSON result was NOT byte-identical to its compact serialisation. */
	pretty: string[];
	/** Any result, JSON or prose, carrying an indented-JSON block. */
	indented: string[];
	/** Tools whose result JSON is nested enough that pretty ≠ compact — the measurable set. */
	discriminating: string[];
	/** Tools whose result JSON is `{}`/`[]`/a scalar: unfalsifiable here, named on purpose. */
	vacuous: string[];
	/** Tools that answered prose. Covered by the signature detector only. */
	prose: string[];
	/** A call the SDK rejected or that threw — a handler NOT measured (ADR 0002 G3). */
	unreached: string[];
	/** Bytes served across the discriminating set, and what indenting them would have cost. */
	bytes: { served: number; ifIndented: number };
};

async function callEveryTool(): Promise<SweepResult> {
	const kv = {
		get: async () => null,
		put: async () => {},
		delete: async () => {},
		list: async () => ({ keys: [], list_complete: true, cursor: undefined, cacheStatus: null }),
	} as unknown as KVNamespace;
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		const body = url.includes("/v1/instances/my/instances")
			? { instances: ["apply", "repo", "coding"].map((s) => ({ id: "i1", capabilities: { surfaces: [s] } })) }
			: sweepBody();
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	// biome-ignore lint/suspicious/noExplicitAny: constructing the mocked-base subclass
	const inst = new (PagsMcp as any)();
	inst.env = { API_BASE: "https://api.test", OAUTH_KV: kv, GITHUB_ORG: "ProAgentStore", GITHUB_TOKEN: "gh-token" };
	inst.props = { authToken: "session-token", mcpScopes: ["read", "write", "runtime", "destructive"], mcpSubject: "user-1" };
	await inst.init();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "pags-serialisation", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), inst.server.connect(serverTransport)]);

	const out: SweepResult = {
		called: 0,
		pretty: [],
		indented: [],
		discriminating: [],
		vacuous: [],
		prose: [],
		unreached: [],
		bytes: { served: 0, ifIndented: 0 },
	};
	for (const tool of published) {
		let res: { content?: { type: string; text?: string }[]; isError?: boolean };
		try {
			res = (await client.callTool({ name: tool.name, arguments: sweepArgs(tool) })) as typeof res;
		} catch (err) {
			// G3: a call that threw is reported, never skipped — skipping turns a broken
			// fixture into a quietly smaller measurement.
			out.unreached.push(`${tool.name}: threw ${(err as Error).message}`);
			continue;
		}
		if (res.isError) {
			// Nothing in this worker sets `isError`; the SDK sets it when argument validation
			// fails, which means the handler never ran and this tool went unmeasured.
			out.unreached.push(`${tool.name}: ${res.content?.[0]?.text?.slice(0, 120)}`);
			continue;
		}
		out.called++;
		for (const block of res.content ?? []) {
			const body = block.text ?? "";
			const signature = body.match(INDENTED_JSON);
			if (signature) out.indented.push(`${tool.name}: …${signature[0].replace(/\n/g, "\\n")}…`);
			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				out.prose.push(tool.name);
				continue;
			}
			const compact = JSON.stringify(parsed);
			if (JSON.stringify(parsed, null, 2) === compact) {
				out.vacuous.push(tool.name);
			} else if (body !== compact) {
				out.pretty.push(`${tool.name}: ${body.length} bytes served, ${compact.length} compact`);
			} else {
				out.discriminating.push(tool.name);
				out.bytes.served += compact.length;
				out.bytes.ifIndented += JSON.stringify(parsed, null, 2).length;
			}
		}
	}
	vi.unstubAllGlobals();
	return out;
}

/** Read once, like `published` — one sweep of 136 handlers serves every arm below. */
const sweep = await callEveryTool();

describe("result serialisation — every tool, on the wire (#586)", () => {
	it("reached every registered handler, so nothing went unmeasured", () => {
		// G1 + G3 together. An argument shape the SDK rejects looks identical to a clean pass
		// from the outside: the tool answers, the loop moves on, and the denominator quietly
		// drops by one. `update_agent_board_config` was exactly that until `sweepArgs` learned
		// to honour `.min(1)` on a nested array.
		expect(sweep.unreached, "these handlers never ran, so this file did not measure them").toEqual([]);
		expect(sweep.called).toBe(MCP_TOOL_COUNT);
	});

	it("no tool pretty-prints its JSON result", () => {
		// The assertion #569 needed and did not have. Before #586 removed the option this
		// listed 92 tools; reinstating the indented default in `jsonText` puts them all back.
		expect(sweep.pretty).toEqual([]);
	});

	it("no result embeds an indented JSON block inside prose", () => {
		// The escape hatch the arm above cannot see, because such a result does not parse.
		// `register_instance_runtime` answered `Runtime registered for X.\n` + an indented
		// object until #586. Verified not to fire on the two Markdown results
		// (`platform_guide`, `sdk_reference`), whose fenced examples are not JSON objects.
		expect(sweep.indented).toEqual([]);
	});

	it("measured enough nested results for the arms above to mean anything", () => {
		// The non-vacuity bound, and the reason it is a bound rather than an equality: whether
		// a given tool answers JSON or prose against a stubbed API is a property of the
		// fixture, and it moves for honest reasons. What must NOT move is the arms going quiet.
		// `{}` and `[]` are byte-identical indented or not, so only the nested results can
		// falsify anything — 92 of 136 did when this landed, against 42 prose and 2 empty. A
		// fall below 80 means the fixture stopped producing nested bodies, not that the code
		// got cleaner.
		expect(sweep.discriminating.length).toBeGreaterThanOrEqual(80);
	});

	it("states what it measured", () => {
		const total = sweep.discriminating.length + sweep.vacuous.length + sweep.prose.length;
		const overhead = sweep.bytes.ifIndented - sweep.bytes.served;
		console.log(
			`✓ ${sweep.called}/${MCP_TOOL_COUNT} registered tools CALLED through a real client, ${total} result blocks read:\n` +
				`  ${sweep.discriminating.length} nested JSON — all compact, 0 pretty-printed\n` +
				`  ${sweep.vacuous.length} empty JSON (${sweep.vacuous.join(", ") || "none"}) — cannot discriminate, named not counted\n` +
				`  ${sweep.prose.length} prose — checked for an embedded indented block only\n` +
				`  bytes over the nested set: ${sweep.bytes.served} served vs ${sweep.bytes.ifIndented} if indented ` +
				`(+${overhead}, +${((overhead / sweep.bytes.served) * 100).toFixed(0)}%)`,
			// That percentage is the FIXTURE's shape, not production's: these rows are short keys
			// around short values, which is the case indentation punishes hardest. The number to
			// compare against a host limit is #569's measured one — 53,970 compact against 66,042
			// indented on a real 104-row instance, i.e. ~22% on a payload made mostly of prose.
		);
		expect(sweep.called).toBe(MCP_TOOL_COUNT);
	});
});
