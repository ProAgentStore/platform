// The full #264 loop, end to end: a remote MCP server asks the person something, the call pauses,
// the console reads the ask, and the answer retries the ORIGINAL call.
//
// Deliberately not a unit test of the route. Every acceptance criterion in the ticket is about
// something that only shows up when the pieces run together — that the retry preserves endpoint,
// tool, args, auth context and trace; that it re-checks consent and re-resolves the credential
// rather than skipping them as "already authorized"; that a cancel sends nothing; that a timeout
// refuses; that a malformed ask degrades to the honest refusal instead of a broken form. So the
// registry tool, the connector, the store and the routes are all real here, and only the network,
// the clock's deadline and D1 are doubles.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { runRegistryTool } from "../lib/tool-registry.js";
import { resetEraCache } from "../lib/connectors/mcp.js";
import { encryptKey } from "../lib/crypto.js";
import { INPUT_TTL_MS, MAX_ROUNDS } from "../lib/mcp-elicitation.js";
import type { Env } from "../types.js";
import { toolRoutes } from "./tools.js";
import { sqlTimeMs } from "../lib/sql-time.js";

const TEST_SECRET = "test-secret";
const TEST_KEK = "0".repeat(64);
const ENDPOINT = "https://builder.example.com/mcp";
const USER = "user-1";
const INSTANCE = "inst-1";

interface InputRow {
	id: string;
	instance_id: string;
	user_id: string;
	endpoint: string;
	tool: string;
	trace_id: string | null;
	status: string;
	round: number;
	message: string;
	schema_json: string;
	use_auth: number;
	call_ciphertext: Uint8Array | null;
	dek_wrapped: Uint8Array | null;
	iv: Uint8Array | null;
	expires_at: string;
	created_at: string;
	resolved_at: string | null;
}

interface LoggedEvent {
	source: string;
	event: string;
	message: string | null;
	context: Record<string, unknown>;
}

/**
 * A D1 double that holds `mcp_input_requests` as a real array, because the one-shot claim is the
 * property under test: two answers to the same ask must not both reach the remote server, and a
 * stub that always says "updated" could not tell the difference.
 */
function testEnv(opts: { grants?: string[]; writeConsent?: boolean; credential?: boolean } = {}) {
	const rows: InputRow[] = [];
	const events: LoggedEvent[] = [];
	const grants = opts.grants ?? ["*"];
	const writeConsent = opts.writeConsent !== false;
	const hasCredential = opts.credential !== false;

	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					const a = args as string[];
					return {
						async first() {
							if (sql.includes("FROM agent_instances")) {
								return a[1] === USER && a[0] === INSTANCE ? { id: INSTANCE, agent_id: "agent-1", user_id: USER, status: "active", config: "{}" } : null;
							}
							if (sql.includes("instance_connector_consent")) return writeConsent ? { ok: 1 } : null;
							if (sql.includes("FROM mcp_credentials")) {
								if (!hasCredential) return null;
								const { ciphertext, dekWrapped, iv } = await encryptKey("tok-abc", TEST_KEK);
								return { auth_mode: "bearer", expires_at: null, key_ciphertext: ciphertext, dek_wrapped: dekWrapped, iv };
							}
							if (sql.startsWith("UPDATE mcp_input_requests")) {
								// The claim: `status='pending'` and an unexpired deadline are part of the
								// WHERE, so a second attempt matches nothing and returns null.
																// `sqlTimeMs`, not `Date.parse`: `expires_at` is stored in `datetime('now')`'s shape
								// (#657), and V8 reads `YYYY-MM-DD HH:MM:SS` as LOCAL time — so this double would
								// disagree with SQLite by the machine's UTC offset.
								const row = rows.find((r) => r.id === a[0] && r.instance_id === a[1] && r.user_id === a[2] && r.status === "pending" && sqlTimeMs(r.expires_at) > Date.now());
								if (!row) return null;
								row.status = a[3];
								row.resolved_at = new Date().toISOString();
								row.call_ciphertext = null;
								row.dek_wrapped = null;
								row.iv = null;
								return { id: row.id };
							}
							if (sql.includes("FROM mcp_input_requests")) {
								// Copies, not the live objects: real D1 hands back a snapshot, and returning
								// the array's own row would let the claim's UPDATE null the ciphertext the
								// caller is still holding — a bug that exists only in a test double.
								const match = sql.includes("call_ciphertext")
									? rows.find((r) => r.id === a[0] && r.instance_id === a[1] && r.user_id === a[2] && r.status === "pending")
									: rows.find((r) => r.id === a[0] && r.instance_id === a[1] && r.user_id === a[2]);
								return match ? { ...match } : null;
							}
							return null;
						},
						async all() {
							if (sql.includes("instance_mcp_consent")) {
								const [, , tool, wildcard] = a;
								return { results: grants.filter((g) => g === tool || g === wildcard).map((g) => ({ tool: g })) };
							}
							if (sql.includes("FROM mcp_input_requests")) {
								return { results: rows.filter((r) => r.instance_id === a[0] && r.user_id === a[1]).map((r) => ({ ...r })).reverse() };
							}
							return { results: [] };
						},
						async run() {
							if (sql.includes("INSERT INTO mcp_input_requests")) {
								const v = args as unknown[];
								rows.push({
									id: String(v[0]),
									instance_id: String(v[1]),
									user_id: String(v[2]),
									endpoint: String(v[3]),
									tool: String(v[4]),
									trace_id: v[5] === null ? null : String(v[5]),
									status: "pending",
									round: Number(v[6]),
									message: String(v[7]),
									schema_json: String(v[8]),
									use_auth: Number(v[9]),
									call_ciphertext: v[10] as Uint8Array,
									dek_wrapped: v[11] as Uint8Array,
									iv: v[12] as Uint8Array,
									expires_at: String(v[13]),
									created_at: new Date().toISOString(),
									resolved_at: null,
								});
							}
							if (sql.includes("INSERT INTO agent_events")) {
								const [, , , , , source, , event, message, context] = args as string[];
								events.push({ source, event, message, context: context ? JSON.parse(context) : {} });
							}
							return { success: true };
						},
					};
				},
				async run() {
					if (sql.startsWith("UPDATE mcp_input_requests")) {
						for (const r of rows) {
							if (r.status === "pending" && sqlTimeMs(r.expires_at) <= Date.now()) r.status = "expired";
						}
					}
					return { success: true };
				},
			};
		},
	};

	const env = { DB, KEY_ENCRYPTION_KEY: TEST_KEK, SESSION_SIGNING_KEY: TEST_SECRET } as unknown as Env;
	// `grants` is handed back mutable so a test can revoke consent BETWEEN the ask and the answer —
	// which is the window this whole design has to survive.
	return { env, rows, events, grants };
}

function app() {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/instances", toolRoutes);
	a.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	return a;
}

async function headers() {
	return { Authorization: `Bearer ${await signSession(USER, TEST_SECRET)}`, "Content-Type": "application/json" };
}

/** A well-formed `elicitation/create` arriving as an SSE frame — the shape a streaming server sends. */
function elicits(properties: Record<string, unknown>, required: string[] = []) {
	return {
		status: 200,
		contentType: "text/event-stream",
		body: `event: message\ndata: ${JSON.stringify({
			jsonrpc: "2.0",
			id: 9,
			method: "elicitation/create",
			params: { message: "Which suburb is the business in?", requestedSchema: { type: "object", properties, required } },
		})}\n\n`,
	};
}

/** A normal tool result. */
function answers(payload: unknown) {
	return { status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }) };
}

/** Script `tools/call` responses in order, and record every request that went out. */
function mockNetwork(script: Array<{ status: number; contentType: string; body: string }>) {
	const calls: Array<{ headers: Headers; body: { method: string; params: Record<string, unknown> } }> = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body ?? "{}"));
		calls.push({ headers: new Headers(init?.headers), body });
		const entry = script[Math.min(calls.length - 1, script.length - 1)];
		return new Response(entry.body, { status: entry.status, headers: { "Content-Type": entry.contentType } });
	});
	return calls;
}

/** Make the first call and return the ask it parked. */
async function pause(env: Env, args: Record<string, unknown> = { place_id: "abc" }, traceId = "run-77") {
	return runRegistryTool("mcp_call_tool", { env, userId: USER, instanceId: INSTANCE, traceId }, { url: ENDPOINT, tool: "create_site", args });
}

beforeEach(() => resetEraCache());
afterEach(() => vi.restoreAllMocks());

describe("#264 — a paused MCP call", () => {
	it("parks the ask, tells the agent it is NOT done, and stores no answer", async () => {
		const { env, rows, events } = testEnv();
		mockNetwork([elicits({ suburb: { type: "string", title: "Suburb" } }, ["suburb"])]);

		const first = await pause(env);
		expect(first.success).toBe(false);
		expect(first.content).toMatch(/PAUSED/);
		expect(first.content).toMatch(/did NOT complete/);
		expect(first.content).toMatch(/do not report this as done/i);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ endpoint: ENDPOINT, tool: "create_site", trace_id: "run-77", status: "pending", round: 1, use_auth: 1 });
		// The arguments are held as ciphertext, never as a readable column.
		expect(rows[0].call_ciphertext).toBeInstanceOf(Uint8Array);
		expect(JSON.stringify(rows[0])).not.toContain("place_id");

		// The trace says a human was asked, and records the field NAMES only.
		const asked = events.find((e) => e.event === "mcp.input_required");
		expect(asked?.context.argKeys).toEqual(["suburb"]);
	});

	it("shows the ask on the console with the fields to render", async () => {
		const { env } = testEnv();
		mockNetwork([elicits({ suburb: { type: "string", title: "Suburb" }, hero: { type: "boolean" } }, ["suburb"])]);
		await pause(env);

		const res = await app().request("/v1/instances/inst-1/mcp/input-requests", { headers: await headers() }, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { requests: Array<{ tool: string; message: string; fields: Array<{ name: string; required: boolean }>; status: string }> };
		expect(body.requests).toHaveLength(1);
		expect(body.requests[0].tool).toBe("create_site");
		expect(body.requests[0].message).toBe("Which suburb is the business in?");
		expect(body.requests[0].fields.map((f) => f.name)).toEqual(["suburb", "hero"]);
		expect(body.requests[0].status).toBe("pending");
	});

	// ── CASE 1: SUCCESSFUL RESUME ───────────────────────────────────────────────────────────
	it("resumes the original call, preserving endpoint, tool, args, auth and trace", async () => {
		const { env, rows, events } = testEnv();
		const calls = mockNetwork([elicits({ suburb: { type: "string" } }, ["suburb"]), answers({ site: "https://example.com" })]);
		await pause(env, { place_id: "abc", suburb: "" });

		const res = await app().request(
			`/v1/instances/inst-1/mcp/input-requests/${rows[0].id}`,
			{ method: "POST", headers: await headers(), body: JSON.stringify({ action: "submit", values: { suburb: "Newtown" } }) },
			env,
		);
		expect(res.status).toBe(200);
		expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true, status: "answered" });

		// The SECOND request is the retry: same endpoint, same tool, the original args PLUS the
		// answer — and the answer wins over the empty value the first attempt carried.
		expect(calls).toHaveLength(2);
		expect(calls[1].body.method).toBe("tools/call");
		expect(calls[1].body.params).toMatchObject({ name: "create_site", arguments: { place_id: "abc", suburb: "Newtown" } });
		// Auth context: the endpoint's credential is resolved again and sent again (#286).
		expect(calls[1].headers.get("Authorization")).toBe("Bearer tok-abc");

		// Audit trace: one run, not two unrelated attempts.
		const answered = events.find((e) => e.event === "mcp.input_answered");
		expect(answered?.context).toMatchObject({ endpoint: ENDPOINT, tool: "create_site", fields: ["suburb"] });
		// …and the value itself is nowhere in it.
		expect(JSON.stringify(events)).not.toContain("Newtown");

		expect(rows[0].status).toBe("answered");
		expect(rows[0].call_ciphertext).toBeNull();
	});

	it("re-checks consent on the resume rather than trusting the first attempt", async () => {
		// The ask can sit in the console for half an hour. A grant revoked in that window must stop
		// the retry — which is the whole reason the resume re-enters `mcp_call_tool`.
		const { env, rows, grants } = testEnv();
		const calls = mockNetwork([elicits({ suburb: { type: "string" } }, ["suburb"]), answers({ site: "x" })]);
		await pause(env);

		grants.length = 0; // the owner revoked the grant while the ask sat in the console

		const res = await app().request(
			`/v1/instances/inst-1/mcp/input-requests/${rows[0].id}`,
			{ method: "POST", headers: await headers(), body: JSON.stringify({ action: "submit", values: { suburb: "Newtown" } }) },
			env,
		);
		const body = (await res.json()) as { ok: boolean; content: string };
		expect(body.ok).toBe(false);
		expect(body.content).toMatch(/no consent to call/i);
		// Nothing reached the server on the retry.
		expect(calls).toHaveLength(1);
	});

	it("refuses a second answer to the same ask, so a double click cannot call the tool twice", async () => {
		const { env, rows } = testEnv();
		const calls = mockNetwork([elicits({ suburb: { type: "string" } }, ["suburb"]), answers({ site: "x" }), answers({ site: "x" })]);
		await pause(env);
		const send = async () =>
			app().request(
				`/v1/instances/inst-1/mcp/input-requests/${rows[0].id}`,
				{ method: "POST", headers: await headers(), body: JSON.stringify({ action: "submit", values: { suburb: "Newtown" } }) },
				env,
			);
		expect((await send()).status).toBe(200);
		expect((await send()).status).toBe(409);
		expect(calls).toHaveLength(2); // the ask, and exactly one retry
	});

	it("rejects an invalid answer WITHOUT burning the ask", async () => {
		const { env, rows } = testEnv();
		mockNetwork([elicits({ suburb: { type: "string" } }, ["suburb"]), answers({ site: "x" })]);
		await pause(env);
		const bad = await app().request(
			`/v1/instances/inst-1/mcp/input-requests/${rows[0].id}`,
			{ method: "POST", headers: await headers(), body: JSON.stringify({ action: "submit", values: {} }) },
			env,
		);
		expect(bad.status).toBe(400);
		expect(rows[0].status).toBe("pending"); // still answerable
	});

	// ── CASE 2: USER CANCELLATION ───────────────────────────────────────────────────────────
	it("cancels without sending anything to the server", async () => {
		const { env, rows, events } = testEnv();
		const calls = mockNetwork([elicits({ suburb: { type: "string" } }, ["suburb"]), answers({ site: "x" })]);
		await pause(env);

		const res = await app().request(
			`/v1/instances/inst-1/mcp/input-requests/${rows[0].id}`,
			{ method: "POST", headers: await headers(), body: JSON.stringify({ action: "cancel" }) },
			env,
		);
		expect(res.status).toBe(200);
		expect((await res.json()) as { status: string }).toMatchObject({ status: "cancelled" });
		expect(calls).toHaveLength(1); // no retry went out
		expect(rows[0].status).toBe("cancelled");
		expect(rows[0].call_ciphertext).toBeNull(); // the held arguments are dropped with it
		expect(events.some((e) => e.event === "mcp.input_cancelled")).toBe(true);
	});

	// ── CASE 3: TIMEOUT ─────────────────────────────────────────────────────────────────────
	it("refuses an answer after the deadline, and says so", async () => {
		const { env, rows } = testEnv();
		const calls = mockNetwork([elicits({ suburb: { type: "string" } }, ["suburb"]), answers({ site: "x" })]);
		await pause(env);

		// Walk the clock past the window rather than editing the row, so the DERIVED status is what
		// refuses — the deadline must hold whether or not a sweeper has run.
		vi.spyOn(Date, "now").mockReturnValue(sqlTimeMs(rows[0].expires_at) + 1000);
		const res = await app().request(
			`/v1/instances/inst-1/mcp/input-requests/${rows[0].id}`,
			{ method: "POST", headers: await headers(), body: JSON.stringify({ action: "submit", values: { suburb: "Newtown" } }) },
			env,
		);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toMatch(/timed out/i);
		expect(calls).toHaveLength(1);
	});

	it("expires stale asks when the console lists them, dropping the arguments it held", async () => {
		const { env, rows } = testEnv();
		mockNetwork([elicits({ suburb: { type: "string" } }, ["suburb"])]);
		await pause(env);
		vi.spyOn(Date, "now").mockReturnValue(sqlTimeMs(rows[0].expires_at) + 1000);

		const res = await app().request("/v1/instances/inst-1/mcp/input-requests", { headers: await headers() }, env);
		const body = (await res.json()) as { requests: Array<{ status: string }> };
		expect(body.requests[0].status).toBe("expired");
		expect(rows[0].status).toBe("expired");
	});

	it("gives the deadline a sane window", () => {
		expect(INPUT_TTL_MS).toBeGreaterThanOrEqual(5 * 60_000);
	});

	// ── CASE 4: A MALFORMED INPUT-REQUIRED PAYLOAD ──────────────────────────────────────────
	it("falls back to the honest refusal when the ask cannot be parsed, and parks nothing", async () => {
		// A half-understood ask would produce a form that collects the wrong values and sends them.
		// So the call fails exactly as it did before #264: nothing submitted, nothing pending.
		const { env, rows } = testEnv();
		mockNetwork([{ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "elicitation/create", params: { message: "Account number?" } }) }]);

		const first = await pause(env);
		expect(first.success).toBe(false);
		expect(first.content).toMatch(/elicitation\/create/);
		expect(first.content).toMatch(/nothing was submitted/i);
		expect(first.content).not.toMatch(/PAUSED/);
		expect(rows).toHaveLength(0);
	});

	it("stops asking after MAX_ROUNDS instead of keeping a person answering forever", async () => {
		const { env } = testEnv();
		mockNetwork([elicits({ suburb: { type: "string" } }, ["suburb"])]);
		const out = await runRegistryTool(
			"mcp_call_tool",
			{ env, userId: USER, instanceId: INSTANCE },
			{ url: ENDPOINT, tool: "create_site", args: {}, elicitationRound: MAX_ROUNDS + 1 },
		);
		expect(out.success).toBe(false);
		expect(out.content).toMatch(new RegExp(`asked for more input ${MAX_ROUNDS} times`));
		expect(out.content).toMatch(/Nothing was submitted/);
	});

	it("does not pause when there is no key to encrypt the held call with", async () => {
		// A pause we cannot complete must degrade to the honest failure, never to a promise of a
		// form that will never appear.
		const { env, rows } = testEnv();
		mockNetwork([elicits({ suburb: { type: "string" } }, ["suburb"])]);
		// `auth:"none"` so the missing key does not simply fail the credential lookup first — the
		// case under test is a call that reached the server and got an ask it cannot park.
		const noKey = { ...env, KEY_ENCRYPTION_KEY: "" } as Env;
		const out = await runRegistryTool("mcp_call_tool", { env: noKey, userId: USER, instanceId: INSTANCE }, { url: ENDPOINT, tool: "create_site", args: {}, auth: "none" });
		expect(out.success).toBe(false);
		expect(out.content).toMatch(/nothing was submitted/i);
		expect(out.content).not.toMatch(/PAUSED/);
		expect(rows).toHaveLength(0);
	});

	it("404s a request id that belongs to another agent", async () => {
		const { env, rows } = testEnv();
		mockNetwork([elicits({ suburb: { type: "string" } }, ["suburb"])]);
		await pause(env);
		rows[0].instance_id = "inst-other";
		const res = await app().request(
			`/v1/instances/inst-1/mcp/input-requests/${rows[0].id}`,
			{ method: "POST", headers: await headers(), body: JSON.stringify({ action: "cancel" }) },
			env,
		);
		expect(res.status).toBe(404);
	});
});
