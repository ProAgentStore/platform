/**
 * What the tools that return an UNBOUNDED collection put on the wire (#595).
 *
 * ── Why a third wire-size file, and what it does that the other two do not
 *
 * `instance-tools/tool-listing-wire-size.test.ts` (#569/#578) and
 * `instance-tools/coding-timeline-wire-size.test.ts` (#581) each measure ONE tool, and each was
 * written after that tool had already been served over a host's limit in production. Nothing swept
 * for the class. #595 is the consequence: `vector_stats` and `my_agents` were found over the limit
 * while somebody was measuring something else, and the issue said so plainly — "the full tool
 * surface was not swept for size", "inferred: that these two are the only offenders".
 *
 * They were not the only offenders. Swept against the live account on 2026-08-15 — every
 * collection-returning read tool, on all 34 instances and the account-scoped routes, 25 tools and
 * ~450 calls — **four** were over 64 KiB, not two:
 *
 *   | tool               | worst measured | where                                |
 *   |--------------------|----------------|--------------------------------------|
 *   | `agent_trace`      | 163,437 B      | Facebook Friends (200 events)        |
 *   | `vector_stats`     | 151,700 B      | Repo Chat (315 sources)              |
 *   | `instance_board`   | 128,692 B      | Small Business Website Lead Finder   |
 *   | `my_agents`        |  66,013 B      | account (41 agents)                  |
 *
 * and the next two are close enough to matter: `list_errors` 60,810 B and `list_pipeline_runs`
 * 43,777 B, both of which grow with use and neither of which has a bound.
 *
 * ── Why this file has a fixture table when `conformance.test.ts` deliberately refuses one
 *
 * #586's sweep calls all 136 tools through a real client and is the natural home for a size
 * assertion — the issue says so. It cannot be, and the reason is worth recording. Its fixture
 * answers EVERY request with one body carrying 39 collection keys, because a per-tool table is a
 * second hand-maintained restatement of the surface. That is right for asking "is this compact",
 * which is a property of the serialiser. It is useless for asking "does this fit", because every
 * tool then reads a body 39 times larger than its endpoint could ever return: run at 300 rows, it
 * reports 10,657,229 B for `billing_status`, which returns no collection at all. A guard that
 * names `billing_status` as an unbounded-collection tool is worse than no guard — it is ADR 0002's
 * "certifying ground it never walked", facing the other way.
 *
 * So the fixture here is per-endpoint and SIZED FROM THE LIVE SWEEP: the row shapes and the row
 * counts are the ones production actually served on the worst instance for each tool. A fixture of
 * five short rows would pass any limit assertion and prove nothing, which is how #569's guard
 * passed at ~54 KB against a production response of 66,042 B.
 *
 * ── What is asserted, and what is deliberately recorded as still broken
 *
 * `agent_trace` and `instance_board` are NOT fixed here. Both are real, both are measured above,
 * and both live in files another change is holding open; fixing them by guessing at their shape
 * from this file is how two agents overwrite each other. They are recorded as {@link KNOWN_OVER}
 * with the bytes they serve, so the guard states the true count rather than implying it is two —
 * and the assertion is an EQUALITY, so this file goes red both when a new tool overflows and when
 * one of these two is fixed and its entry is not removed.
 */

import { describe, expect, it, vi } from "vitest";
import { WIRE_LIMIT_BYTES, wireBytes } from "./wire-budget.js";

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
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const pad = (n: number, seed: string) => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);

/**
 * `my_agents` is fixtured from the REAL distribution, not from a mean — because the mean is a lie
 * about this collection. The 41 owned agents' `config` values, in bytes, descending, read off the
 * live API on 2026-08-15: one agent carries 13,097 (`site-builder`, which embeds two whole
 * pipeline definitions) and the MEDIAN is 4 (`"{}"`). A fixture giving all 41 the mean would be
 * simultaneously too fat for 23 of them and 300x too thin for the one that matters, and would miss
 * the whole point — `fitPage`'s zero-row corner exists because ONE row can dwarf a page.
 */
const CONFIG_BYTES = [13_097, 4436, 3263, 3153, 3008, 2267, 2120, 1625, 1526, 1508, 1047, 972, 718, 305, 304, 243, 98, ...Array(24).fill(4)];
/** The same 41 agents' `description` lengths, same reading. 14.2% of the payload; mean 208. */
const DESC_CHARS = [736, 555, 474, 374, 370, 319, 293, 279, 273, 272, 270, 267, 263, 262, 259, 240, 234, 234, 231, 215, 159, 141, 138, 118, 117, 116, 105, 104, 104, 104, 103, 101, 100, 95, 91, 87, 86, 84, 77, 69, 49];

/**
 * One endpoint's body at the scale production served it.
 *
 * Every count and every row shape below was read off the live API on 2026-08-15 and is quoted in
 * the header table. They are the measurement, not an estimate of one — and the
 * "fixtures still match production" arm below asserts each one still serialises to within 5% of
 * the byte count recorded in {@link MEASURED_IN_PRODUCTION}, so a fixture cannot quietly shrink
 * until the size assertions stop meaning anything.
 */
const BODIES: { match: (url: string) => boolean; body: () => unknown }[] = [
	{
		// 315 sources, 314 of them repo files whose `name` duplicates their `sourceId`, previews
		// averaging 233 of their 240-character maximum. 151,700 B compact.
		match: (u) => u.includes("/vectors"),
		body: () => {
			const sources = Array.from({ length: 315 }, (_, i) => {
				const sourceId = `ProAgentStore/platform::workers/api/src/lib/module-${i}.ts`;
				return { sourceType: "repo", sourceId, name: sourceId, chunks: 13, chars: 41_231, lastIndexed: "2026-08-04T14:40:24.045Z", preview: pad(233, `File: ${sourceId}\nexport function thing() { return 1; }\n`) };
			});
			return { totalSources: sources.length, totalChunks: 3979, totalChars: 12_987_431, sources };
		},
	},
	{
		// 41 owned agents, `config` 60.9% of the bytes. `site-builder` carries two whole pipeline
		// definitions and is 13,908 B on its own — the row that makes the zero-row corner in
		// `fitPage` reachable rather than theoretical.
		match: (u) => u.includes("/v1/agents/my/agents"),
		body: () => ({
			agents: CONFIG_BYTES.map((configBytes, i) => ({
				id: `agent_slug_number_${i}`,
				slug: `agent-slug-number-${i}`,
				name: `Agent Number ${i}`,
				owner_id: "user_9f2c1b7e-4a3d-4f8a-9c2e-1b7e4a3d4f8a",
				description: pad(DESC_CHARS[i], "An agent that does a useful thing for its owner, described at length. "),
				category: "productivity",
				model: "claude-sonnet-4-6",
				status: i % 2 ? "active" : "inactive",
				visibility: i % 3 ? "draft" : "published",
				store_type: "pags",
				cron_schedule: null,
				icon: "bot",
				icon_bg: "#1f2937",
				worker_name: `agent-slug-number-${i}`,
				created_at: "2026-06-02T09:41:12.000Z",
				updated_at: "2026-08-14T22:03:51.000Z",
				// A JSON STRING, as the column really is (`config` is stored serialised and handed
				// back serialised, so every quote inside it is escaped again on the wire).
				// `CONFIG_BYTES` records the size that string occupied INCLUDING its escaping and
				// its own two delimiters, so the filler is quote-free and `configBytes - 2` long —
				// that makes the fixture's bytes equal to the measured bytes, not merely similar.
				config: pad(Math.max(2, configBytes) - 2, "capabilities-surfaces-coding-tools-search_knowledge-pipelines-step-ai_generate-"),
			})),
		}),
	},
	{
		// 200 events (the tool's own default `limit`), 816 B mean and 1,611 B max. 163,437 B.
		match: (u) => u.includes("/trace"),
		body: () => ({
			instanceId: "inst-1",
			count: 200,
			events: Array.from({ length: 200 }, (_, i) => ({
				id: `evt_${i}`,
				instance_id: "inst-1",
				user_id: "user_9f2c1b7e",
				trace_id: `trace_${i >> 3}`,
				source: "chat",
				event: "tool.call",
				level: i % 9 === 0 ? "warn" : "info",
				message: pad(280, "the agent called a tool and this is what it said about the result. "),
				context: pad(260, '{"tool":"search_knowledge","args":{"query":"what is the thing"}}'),
				created_at: "2026-08-14 22:03:51",
				ts: "2026-08-14T22:03:51.000Z",
			})),
		}),
	},
	{
		/**
		 * 118 cards on the Small Business Website Lead Finder — 128,692 B on the API, and the
		 * field distribution below was RE-MEASURED live on 2026-08-16 because the original
		 * fixture's was wrong in a way its own 5% total check could not see.
		 *
		 * It gave every card a 600-byte `description` and no `reasoning`, which sums to the right
		 * total out of the wrong parts. Production is the other way round: `reasoning` is ~628 B
		 * per card (69.4% of the opt-in read) and `detail` is ~15 B — five distinct values across
		 * all 118 cards, mostly "No website". A guard calibrated on the total alone will happily
		 * measure a payload composed of fields production does not send, which is #615's finding
		 * arriving inside #595's own file.
		 *
		 * Two live facts the shape now carries, both verified on 118/118 cards:
		 *   · `latestTaskId` is BYTE-IDENTICAL to `jobKey` — 19.1% of the default reply is a
		 *     second copy of the field printed immediately before it (`lib/board.ts` returns the
		 *     task id as the job key whenever the task carries no input URL). Recorded, not
		 *     trimmed: #595's rule is that the bound belongs on the collection.
		 *   · `url` is `""` and `runStatus` equals `status` on every card.
		 *
		 * What the TOOL serves is smaller than this body, and that matters: `reasoning` is opt-in
		 * (#574), so the default read measured **33,363 B live — it fits**, and only
		 * `reasoning:true` overruns, at **108,190 B**. The 128,692 B recorded here is the API
		 * body, which the live sweep could not read back and so did not contradict.
		 */
		match: (u) => u.includes("/board"),
		body: () => ({
			view: "board",
			columns: Array.from({ length: 7 }, (_, i) => ({ id: `col${i}`, title: `Column ${i}`, statuses: ["queued", "running"], color: "#1f2937" })),
			items: Array.from({ length: 118 }, (_, i) => {
				// The duplicate, reproduced rather than described.
				const taskId = `task_${String(i).padStart(30, "0")}`;
				return {
					jobKey: taskId,
					latestTaskId: taskId,
					title: `Business Number ${i} — Newtown NSW`,
					subtitle: "",
					description: "No website",
					reasoning: pad(750, "The listing has no website field and the phone number resolves to a mobile. "),
					url: "",
					status: "completed",
					userStatus: null,
					runStatus: "completed",
					attempts: 1,
					threadTurns: 0,
					updatedAt: "2026-08-14T22:03:51.000Z",
				};
			}),
		}),
	},
	{
		// 100 rows, 607 B mean, 1,826 B max. 60,810 B — under, and with no bound of its own.
		match: (u) => u.includes("/v1/errors"),
		body: () => ({
			scope: "account",
			count: 100,
			errors: Array.from({ length: 100 }, (_, i) => ({
				id: `err_${i}`,
				user_id: "user_9f2c1b7e",
				source: "client:voice",
				level: "error",
				status: "open",
				message: pad(120, "TypeError: cannot read properties of undefined reading transcript "),
				context: pad(160, '{"instanceId":"inst-1","turnId":"turn-9","agent":"language-buddy"}'),
				last_context: pad(40, "same as above "),
				build: "2026-08-14",
				repeat_count: 3,
				created_at: "2026-08-01 09:12:33",
				last_seen_at: "2026-08-14 22:03:51",
			})),
		}),
	},
	{
		// 50 rows, 875 B mean. 43,777 B — under, and grows with every run.
		match: (u) => u.includes("/pipeline-runs"),
		body: () => ({
			runs: Array.from({ length: 50 }, (_, i) => ({
				run_id: `run_${i}`,
				instance_id: "inst-1",
				user_id: "user_9f2c1b7e",
				pipeline: "lead-outreach",
				trigger: "cron",
				status: "completed",
				added: 3,
				seen: 41,
				skipped: 38,
				errors: null,
				detail: pad(465, "read 41 listings, 3 were new, drafted a pitch for each and filed a ticket. "),
				params: pad(120, '{"suburb":"Newtown","radius_m":4000}'),
				started_at: "2026-08-14 21:59:02",
				finished_at: "2026-08-14 22:03:51",
			})),
		}),
	},
];

/**
 * What each endpoint ACTUALLY served, live, on 2026-08-15 — the worst case across the population
 * named in the header table. Keyed by a fragment of the endpoint, in the order of {@link BODIES}.
 *
 * This is what makes the fixtures falsifiable. Without it, "sized from the live sweep" is a claim
 * in a comment that nothing checks, and the fixtures drift the moment somebody trims one to make a
 * test pass — at which point every size assertion in this file keeps passing while measuring a
 * payload production never sends. #569's guard asserted ~54 KB against a real 66,042 B for exactly
 * that reason.
 */
const MEASURED_IN_PRODUCTION: Record<string, number> = {
	"/vectors": 151_700,
	"/v1/agents/my/agents": 66_013,
	"/trace": 163_437,
	"/board": 128_692,
	"/v1/errors": 60_810,
	"/pipeline-runs": 43_777,
};

/**
 * Tools measured over the limit in production and NOT fixed by #595, with the bytes they serve.
 *
 * An entry here is a debt, not a permission: it exists so this guard can state the true count of
 * offenders instead of implying #595's two were all of them. The arm below asserts EQUALITY, so
 * removing a tool from this map without fixing it fails, and fixing one without removing it fails
 * too.
 */
const KNOWN_OVER: Record<string, { measured: number; why: string }> = {
	// EMPTY, and that is the assertion. #595 recorded `agent_trace` (163,437 B) and
	// `instance_board` (128,692 B) here because both lived in files another change was holding
	// open; #614 paged them, so the entries went with the fix — which is the removal this map's
	// equality arm was built to demand, and it did demand it: paging the two handlers turned this
	// file red at "expected [] to deeply equal ['agent_trace','instance_board']" before the
	// entries were deleted.
	//
	// An entry here is a DEBT, never a permission. Adding one is how a tool measured over the
	// limit gets recorded instead of hidden — and with the map empty, the arm below now says
	// something stronger: no tool may exceed a calling host's limit at all unless someone writes
	// down which one and why.
};

/** The tools this file measures — every read tool the live sweep found returning a collection with
 *  no intrinsic bound, minus the two that own dedicated files (`list_instance_tools` in
 *  `instance-tools/tool-listing-wire-size.test.ts`, `coding_timeline` in its neighbour). */
const MEASURED = ["vector_stats", "my_agents", "agent_trace", "instance_board", "list_errors", "list_pipeline_runs"] as const;

/** Which endpoint's body each tool serves — the link the non-vacuity arm needs to check a tool's
 *  RAW size against the limit. Kept beside {@link MEASURED} so a tool added to one without the
 *  other fails the arm that compares them. */
const ENDPOINT_FOR: Record<(typeof MEASURED)[number], string> = {
	vector_stats: "/vectors",
	my_agents: "/v1/agents/my/agents",
	agent_trace: "/trace",
	instance_board: "/board",
	list_errors: "/v1/errors",
	list_pipeline_runs: "/pipeline-runs",
};

async function callAll(): Promise<{ bytes: Map<string, number>; unreached: string[] }> {
	const kv = {
		get: async () => null,
		put: async () => {},
		delete: async () => {},
		list: async () => ({ keys: [], list_complete: true, cursor: undefined, cacheStatus: null }),
	} as unknown as KVNamespace;
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		// The instance-scoped tools resolve an id through `my_instances` first.
		const body = url.includes("/v1/instances/my/instances")
			? { instances: ["apply", "repo", "coding"].map((s) => ({ id: "inst-1", agentSlug: "coder", capabilities: { surfaces: [s] } })) }
			: (BODIES.find((b) => b.match(url))?.body() ?? {});
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	// biome-ignore lint/suspicious/noExplicitAny: constructing the mocked-base subclass
	const inst = new (PagsMcp as any)();
	inst.env = { API_BASE: "https://api.test", OAUTH_KV: kv, GITHUB_ORG: "ProAgentStore", GITHUB_TOKEN: "gh-token" };
	inst.props = { authToken: "session-token", mcpScopes: ["read", "write", "runtime", "destructive"], mcpSubject: "user-1" };
	await inst.init();
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "pags-wire-size", version: "0.0.0" });
	await Promise.all([client.connect(ct), inst.server.connect(st)]);

	const bytes = new Map<string, number>();
	const unreached: string[] = [];
	for (const name of MEASURED) {
		let res: { content?: { type: string; text?: string }[]; isError?: boolean };
		try {
			res = (await client.callTool({ name, arguments: { instance_id: "inst-1", agent_id: "inst-1" } })) as typeof res;
		} catch (err) {
			// G3: a call that threw is reported, never skipped — skipping turns a broken fixture
			// into a quietly smaller measurement.
			unreached.push(`${name}: threw ${(err as Error).message}`);
			continue;
		}
		if (res.isError) {
			unreached.push(`${name}: ${res.content?.[0]?.text?.slice(0, 140)}`);
			continue;
		}
		bytes.set(name, new TextEncoder().encode((res.content ?? []).map((b) => b.text ?? "").join("")).length);
	}
	vi.unstubAllGlobals();
	return { bytes, unreached };
}

const swept = await callAll();

describe("wire size — the tools that return an unbounded collection (#595)", () => {
	it("reached every tool it claims to measure", () => {
		// G1 + G3. A tool whose arguments the SDK rejects answers nothing and would drop out of
		// the denominator silently, which is exactly how a size guard stops measuring.
		expect(swept.unreached, "these tools never ran, so this file did not measure them").toEqual([]);
		expect(swept.bytes.size).toBe(MEASURED.length);
	});

	it("fixtures still serialise to the size production served", () => {
		// The arm that keeps every other arm honest. Each fixture is compared to the byte count its
		// endpoint really returned; 5% absorbs the wording of filler text, nothing more. A fixture
		// trimmed to make a size assertion pass fails HERE, loudly, instead of silently turning this
		// file into a guard that measures a payload nobody is served.
		const drift = Object.entries(MEASURED_IN_PRODUCTION).map(([fragment, measured]) => {
			const entry = BODIES.find((b) => b.match(`https://api.test${fragment}`));
			if (!entry) return `${fragment}: no fixture`;
			const actual = new TextEncoder().encode(JSON.stringify(entry.body())).length;
			const off = Math.abs(actual - measured) / measured;
			return off <= 0.05 ? null : `${fragment}: fixture ${actual} B vs ${measured} B measured (${(off * 100).toFixed(1)}% off)`;
		});
		expect(drift.filter(Boolean)).toEqual([]);
		// G1: every recorded measurement has a fixture, and every fixture has a measurement — so a
		// body added without its production number cannot ride along unverified.
		expect(BODIES.length).toBe(Object.keys(MEASURED_IN_PRODUCTION).length);
	});

	it("gave every tool a body at the scale production served, so a pass means something", () => {
		// The non-vacuity bound, and the arm that had to change when KNOWN_OVER emptied (#614).
		// While the two unfixed tools were listed there, "the fixture is still enormous" could be
		// read off them. Now that every tool is budgeted, EVERY tool passes the limit arm — which
		// is exactly what a guard measuring five short rows would also do.
		//
		// So the ground is stated directly instead: these four endpoints' RAW bodies, before any
		// budgeting, are over what a calling host accepts. Their passing is therefore evidence
		// that paging works, not evidence that the body was small. Named rather than counted, so
		// a fixture that quietly stops being over-limit fails here with its own name.
		const rawOver = Object.entries(ENDPOINT_FOR)
			.filter(([, fragment]) => {
				const entry = BODIES.find((b) => b.match(`https://api.test${fragment}`));
				return entry !== undefined && wireBytes(JSON.stringify(entry.body())) > WIRE_LIMIT_BYTES;
			})
			.map(([name]) => name);
		expect(rawOver.sort()).toEqual(["agent_trace", "instance_board", "my_agents", "vector_stats"]);
	});

	it("keeps every budgeted tool inside the host limit that produced #569", () => {
		const over = [...swept.bytes].filter(([name, n]) => n > WIRE_LIMIT_BYTES && !(name in KNOWN_OVER)).map(([name, n]) => `${name}: ${n} B`);
		expect(over, "these tools serve more than a calling host will accept").toEqual([]);
	});

	it("states the offenders it has NOT fixed, so the count is measured rather than assumed", () => {
		// An equality, both ways. #595 inferred there were two offenders; the sweep found four.
		// This arm is what stops the next reader inheriting that inference — and it fails when one
		// of these is fixed, which is the moment the entry should go.
		const stillOver = [...swept.bytes].filter(([, n]) => n > WIRE_LIMIT_BYTES).map(([name]) => name);
		expect(stillOver.sort()).toEqual(Object.keys(KNOWN_OVER).sort());
	});

	it("states what it measured", () => {
		// G2 — the denominator in the passing output, per ADR 0002.
		const lines = [...swept.bytes].sort((a, b) => b[1] - a[1]).map(([name, n]) => `  ${name.padEnd(20)} ${String(n).padStart(8)} B${n > WIRE_LIMIT_BYTES ? `  OVER (known, ${KNOWN_OVER[name]?.why})` : ""}`);
		console.log(
			`✓ ${swept.bytes.size} unbounded-collection tools called through a real MCP client against the ${WIRE_LIMIT_BYTES} B host limit,\n` +
				"  on per-endpoint fixtures sized from the live sweep of 34 instances + the account routes (2026-08-15):\n" +
				`${lines.join("\n")}\n` +
				`  ${Object.keys(KNOWN_OVER).length} known-over and recorded; list_instance_tools and coding_timeline are measured by their own files.`,
		);
		expect(swept.bytes.size).toBe(MEASURED.length);
	});
});
