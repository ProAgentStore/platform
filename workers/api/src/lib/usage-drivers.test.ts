/**
 * #1040 — provider-token spend attribution and cost optimisation, on the production paths and the
 * real schema (every migration applied):
 *
 *  - a controller call that stalls and is retried lands on the ledger as attempt 2, with its
 *    objective (trace), source, phase and the tool calls it asked for — through `controllerAiCall`
 *    and `runUserWorkersAi` with only the provider's HTTP response simulated;
 *  - `GET /v1/usage/drivers` names the top spend drivers and the waste the ledger proves;
 *  - `GET /v1/usage/savings` verifies a saving against a baseline per unit of work, so a quiet week
 *    cannot pose as one;
 *  - the daily spend alert is a setting on the budget route and a push at most once a day;
 *  - the ledger stays privacy-safe: no column can hold prompt or reply text.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "./auth.js";
import { controllerAiCall, policyFrom } from "./controller-ai-recovery.js";
import { encryptKey } from "./crypto.js";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import { signSession } from "./session.js";
import { runSpendAlerts } from "./spend-alerts.js";
import { CHEAPER_BRAIN_MODEL, compareWindows, spendDrivers, type DriverRow } from "./usage-drivers.js";
import { estimateCostMicros } from "./ai-pricing.js";
import { runUserWorkersAi } from "./user-ai.js";
import { budgetRoutes } from "../routes/budget.js";
import { usageRoutes } from "../routes/usage.js";
import type { Env } from "../types.js";

const KEK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SECRET = "t1040-secret";

let d1: RealSchemaD1;
let env: Env;
let token: string;

beforeEach(async () => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: KEK, SESSION_SIGNING_KEY: SECRET } as unknown as Env;
	token = await signSession("u1", SECRET, { roles: [] });
});
afterEach(() => {
	vi.unstubAllGlobals();
	d1.close();
});

/** One provider reply as Anthropic streams it: usage on message_start/message_delta, blocks between. */
function anthropicStream(blocks: Array<Record<string, unknown>>, usage: Record<string, number>, complete = true): Response {
	const frames: string[] = [];
	const emit = (e: Record<string, unknown>) => frames.push(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
	emit({ type: "message_start", message: { usage } });
	blocks.forEach((b, index) => {
		if (b.type === "tool_use") {
			emit({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
			emit({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
		} else {
			emit({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
			emit({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
		}
		if (complete) emit({ type: "content_block_stop", index });
	});
	if (complete) {
		emit({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: usage.output_tokens ?? 0 } });
		emit({ type: "message_stop" });
	}
	return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
}

async function storeAnthropicKey() {
	const e = await encryptKey("sk-ant-test", KEK);
	d1.sqlite.prepare("INSERT INTO user_api_keys (user_id, provider, key_ciphertext, dek_wrapped, iv) VALUES ('u1', 'anthropic', ?, ?, ?)").run(Buffer.from(e.ciphertext), Buffer.from(e.dekWrapped), Buffer.from(e.iv));
}

const ledger = () => d1.sqlite.prepare("SELECT trace_id, source, phase, tool_calls, attempt, input_tokens, output_tokens, cost_micros FROM ai_usage ORDER BY created_at").all() as Array<Record<string, unknown>>;

describe("the ledger attributes a call to its objective, phase, tools and retry (#1040)", () => {
	it("a stalled controller call retried once is recorded as attempt 2 with its trace, source, phase and tool calls", async () => {
		await storeAnthropicKey();
		const fetchMock = vi
			.fn()
			// Attempt 1: the stream drops mid prose — a stall, retried by the controller policy.
			.mockImplementationOnce(async () => anthropicStream([{ type: "text", text: "half" }], { input_tokens: 0 }, false))
			.mockImplementation(async () => anthropicStream([{ type: "tool_use", id: "t1", name: "send_message", input: { text: "run the tests" } }, { type: "tool_use", id: "t2", name: "read_file", input: { path: "a" } }], { input_tokens: 1200, output_tokens: 80 }));
		vi.stubGlobal("fetch", fetchMock);

		await controllerAiCall(env, { userId: "u1", instanceId: "i1", traceId: "trace-1", surface: "loop", policy: policyFrom(), sleep: async () => undefined }, (deadlines) =>
			runUserWorkersAi(env, "u1", "claude-sonnet-4-6", { messages: [{ role: "user", content: "decide" }], streamDeadlines: deadlines }, { kind: "chat", instanceId: "i1", traceId: "trace-1", promptSource: "loop", promptPhase: "decide" }),
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(ledger()).toEqual([{ trace_id: "trace-1", source: "loop", phase: "decide", tool_calls: 2, attempt: 2, input_tokens: 1200, output_tokens: 80, cost_micros: estimateCostMicros("claude-sonnet-4-6", 1200, 80) }]);
	});

	it("a first-attempt call with no prompt labels falls back to its kind, attempt 1 and zero tool calls", async () => {
		await storeAnthropicKey();
		vi.stubGlobal("fetch", vi.fn(async () => anthropicStream([{ type: "text", text: "hi" }], { input_tokens: 10, output_tokens: 5 })));
		await runUserWorkersAi(env, "u1", "claude-sonnet-4-6", { messages: [{ role: "user", content: "hello" }] }, { kind: "chat", instanceId: "i1" });
		expect(ledger()).toEqual([expect.objectContaining({ trace_id: null, source: "chat", phase: null, tool_calls: 0, attempt: 1 })]);
	});

	it("is privacy-safe by construction: the ledger has no column that could hold prompt or reply text", () => {
		const cols = (d1.sqlite.prepare("PRAGMA table_info(ai_usage)").all() as Array<{ name: string }>).map((c) => c.name).sort();
		expect(cols).toEqual(
			["agent_id", "attempt", "cache_read_tokens", "cache_write_tokens", "cost_micros", "cost_source", "created_at", "id", "input_tokens", "instance_id", "kind", "model", "output_tokens", "payer", "phase", "provider", "source", "tool_calls", "trace_id", "user_id"].sort(),
		);
	});
});

/** A ledger row seeded directly — the shape every writer above produces. */
function seed(r: Partial<DriverRow> & { created_at: string }) {
	d1.sqlite
		.prepare(
			`INSERT INTO ai_usage (id, user_id, instance_id, provider, model, kind, source, phase, trace_id, tool_calls, attempt, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros, payer, created_at)
			 VALUES (?, 'u1', ?, ?, ?, 'chat', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'byok-api', ?)`,
		)
		.run(crypto.randomUUID(), r.instance_id ?? "i1", r.provider ?? "anthropic", r.model ?? "claude-sonnet-4-6", r.source ?? null, r.phase ?? null, r.trace_id ?? null, r.tool_calls ?? 0, r.attempt ?? 1, r.input_tokens ?? 0, r.output_tokens ?? 0, r.cache_read_tokens ?? 0, r.cost_micros ?? 0, r.created_at);
}
const ago = (days: number, minutes = 0) => new Date(Date.now() - days * 86_400_000 - minutes * 60_000).toISOString().replace("T", " ").slice(0, 19);

async function get(path: string) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/usage", usageRoutes);
	app.route("/v1/budget", budgetRoutes);
	app.onError((e, c) => c.json({ error: e.message }, e instanceof HttpError ? (e.status as 400) : 500));
	const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } }, env);
	// biome-ignore lint/suspicious/noExplicitAny: read field by field
	return { status: res.status, body: (await res.json()) as any };
}

describe("GET /v1/usage/drivers names the top spend drivers and the provable waste (#1040)", () => {
	it("ranks objectives, phases and instances by cost, and counts retries, duplicates and uncached context", async () => {
		d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('a1', 'u1', 't1040-coder', 'Repo Coder')`);
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'a1', 'u1', 'active', '{"displayName":"Chess coder"}')`);
		// Objective A: three Loop decisions on the same 8k-token prompt, none cached — the 2nd and 3rd
		// are duplicates AND uncached repeats; plus one retry.
		for (let k = 0; k < 3; k++) seed({ trace_id: "A", source: "loop", phase: "decide", input_tokens: 8000, output_tokens: 100, cost_micros: 25_500, created_at: ago(1, 30 - k) });
		seed({ trace_id: "A", source: "loop", phase: "decide", input_tokens: 8001, output_tokens: 100, attempt: 2, cost_micros: 25_503, created_at: ago(1, 20) });
		// Objective B: one Pilot step (never offered cheaper routing) and a tool-using chat turn.
		seed({ trace_id: "B", source: "coding", phase: "pilot_decide", input_tokens: 2000, output_tokens: 50, cost_micros: 6_750, created_at: ago(2) });
		seed({ trace_id: "B", source: "chat", input_tokens: 500, output_tokens: 50, tool_calls: 3, cost_micros: 2_250, created_at: ago(2, 5) });
		// Pre-#1040 row: no objective at all.
		seed({ source: null, input_tokens: 100, output_tokens: 10, cost_micros: 450, created_at: ago(3) });
		// Outside the 7-day window and another user's row: neither may appear.
		seed({ trace_id: "OLD", source: "loop", cost_micros: 9_999_999, created_at: ago(10) });
		d1.exec(`INSERT INTO users (id, github_login) VALUES ('u2', 'u2')`);
		d1.exec(`INSERT INTO ai_usage (id, user_id, provider, model, kind, cost_micros, payer, created_at) VALUES ('x', 'u2', 'anthropic', 'claude-sonnet-4-6', 'chat', 8888888, 'byok-api', '${ago(1)}')`);

		const { status, body } = await get("/v1/usage/drivers?days=7");
		expect(status).toBe(200);
		expect(body.totals).toMatchObject({ calls: 7, costMicros: 25_500 * 3 + 25_503 + 6_750 + 2_250 + 450, objectives: 2, retryCalls: 1, retryMicros: 25_503, duplicateCalls: 2, duplicateMicros: 51_000, toolCallTurns: 1, toolCalls: 3, unattributedMicros: 450 });
		expect(body.byObjective[0]).toMatchObject({ key: "A", calls: 4 });
		expect(body.byPhase[0]).toMatchObject({ key: "loop · decide", calls: 4 });
		expect(body.byInstance[0]).toMatchObject({ key: "i1", label: "Chess coder" });
		expect(JSON.stringify(body)).not.toContain("OLD");

		const opp = Object.fromEntries((body.opportunities as Array<{ id: string; basis: string }>).map((o) => [o.id, o]));
		expect(opp.retries).toMatchObject({ estimatedMicros: 25_503, calls: 1 });
		expect(opp.duplicates).toMatchObject({ estimatedMicros: 51_000, calls: 2 });
		// 2nd, 3rd and the retry repeat objective A's uncached 8k prompt: input rate minus the cache-read rate.
		expect(opp["uncached-context"]).toMatchObject({ calls: 3, estimatedMicros: Math.round(8000 * 3 * 0.9) * 2 + Math.round(8001 * 3 * 0.9) });
		// Advisory calls only: the four Loop decisions and the chat turn — never the Pilot step.
		const advisory = [...Array(3)].map(() => [8000, 100]).concat([[8001, 100], [500, 50]]);
		const repriced = advisory.reduce((s, [i, o]) => s + estimateCostMicros(CHEAPER_BRAIN_MODEL, i, o), 0);
		expect(opp["cheaper-advisory-model"]).toMatchObject({ calls: 5, estimatedMicros: 25_500 * 3 + 25_503 + 2_250 - repriced });
		expect(opp["cheaper-advisory-model"].basis).toContain("Never the Pilot");
	});

	it("refuses a malformed window", async () => {
		expect((await get("/v1/usage/drivers?from=yesterday")).status).toBe(400);
		expect((await get("/v1/usage/drivers?from=2026-10-10&to=2026-10-01")).status).toBe(400);
	});
});

describe("GET /v1/usage/savings verifies a saving against a baseline, per unit of work (#1040)", () => {
	const window = (n: number, perObjective: number, daysAgo: number) => {
		for (let k = 0; k < n; k++) seed({ trace_id: `w${daysAgo}-${k}`, source: "loop", cost_micros: perObjective, created_at: ago(daysAgo, k) });
	};

	it("a cheaper cost per objective is a saving, sized over the current window's objectives", async () => {
		window(10, 40_000, 10); // baseline: 10 objectives at $0.04
		window(8, 30_000, 3); // current: 8 objectives at $0.03
		const { body } = await get("/v1/usage/savings?days=7");
		expect(body).toMatchObject({ basis: "objective", verdict: "saving", unitDeltaMicros: -10_000, unitDeltaPct: -25, savedMicros: 80_000 });
		expect(body.baseline).toMatchObject({ objectives: 10, costPerObjectiveMicros: 40_000 });
		expect(body.summary).toMatch(/fell 25%.*saved about \$0\.08 over 8 objectives/);
	});

	it("less work at the same unit cost is NOT a saving, however much lower the total is", async () => {
		window(20, 40_000, 10);
		window(5, 40_000, 3);
		const { body } = await get("/v1/usage/savings?days=7");
		expect(body.current.costMicros).toBeLessThan(body.baseline.costMicros);
		expect(body).toMatchObject({ verdict: "no-change", savedMicros: 0 });
	});

	it("a dearer unit is a regression; too few calls is said, not guessed", async () => {
		window(6, 10_000, 10);
		window(6, 20_000, 3);
		expect((await get("/v1/usage/savings?days=7")).body).toMatchObject({ verdict: "regression", savedMicros: -60_000 });
		d1.exec("DELETE FROM ai_usage");
		window(2, 10_000, 3);
		expect((await get("/v1/usage/savings?days=7")).body.verdict).toBe("insufficient-data");
	});

	it("an explicit baseline window compares the weeks either side of a change", () => {
		const rows = (n: number, cost: number): DriverRow[] => [...Array(n)].map((_, k) => ({ trace_id: `t${k}`, cost_micros: cost, created_at: "2026-10-01 00:00:00" }) as DriverRow);
		const c = compareWindows(spendDrivers(rows(5, 100), { from: "a", to: "b" }), spendDrivers(rows(5, 50), { from: "b", to: "c" }));
		expect(c).toMatchObject({ verdict: "saving", savedMicros: 250 });
	});
});

describe("the daily spend alert (#1040)", () => {
	const notifications = () => d1.sqlite.prepare("SELECT type, title, body, url FROM notifications WHERE user_id = 'u1'").all() as Array<Record<string, string>>;

	async function put(body: unknown) {
		const app = new Hono<{ Bindings: Env }>();
		app.route("/v1/budget", budgetRoutes);
		const res = await app.request("/v1/budget/limits", { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
		// biome-ignore lint/suspicious/noExplicitAny: read field by field
		return (await res.json()) as any;
	}

	it("is set on the budget route beside the ceilings, and patching another field keeps it", async () => {
		expect((await put({ spendAlertMicros: 5_000_000 })).stored.spendAlertMicros).toBe(5_000_000);
		const after = await put({ tokenCeiling: 1_000 });
		expect(after.stored).toMatchObject({ spendAlertMicros: 5_000_000, tokenCeiling: 1_000 });
		expect((await put({ spendAlertMicros: null })).stored.spendAlertMicros).toBeNull();
	});

	it("pushes once when 24h charged spend reaches it, links to Usage, and stops nothing", async () => {
		await put({ spendAlertMicros: 1_000_000 });
		seed({ cost_micros: 600_000, created_at: ago(0, 30) });
		expect(await runSpendAlerts(env)).toBe(0);
		expect(notifications()).toEqual([]);

		seed({ cost_micros: 500_000, created_at: ago(0, 10) });
		expect(await runSpendAlerts(env)).toBe(1);
		const [n] = notifications();
		expect(n).toMatchObject({ type: "spend", url: "/console/usage" });
		expect(n.body).toContain("$1.10");
		expect(n.body).toContain("Nothing was stopped");

		// The same day again: no second push.
		seed({ cost_micros: 5_000_000, created_at: ago(0, 1) });
		expect(await runSpendAlerts(env)).toBe(0);
		expect(notifications()).toHaveLength(1);

		// A day later it may speak again.
		d1.exec(`UPDATE account_budget_limits SET spend_alert_sent_at = datetime('now', '-25 hours')`);
		expect(await runSpendAlerts(env)).toBe(1);
	});

	it("counts charged spend only — subscription work never trips it", async () => {
		await put({ spendAlertMicros: 1_000 });
		d1.exec(`INSERT INTO ai_usage (id, user_id, provider, model, kind, cost_micros, payer, created_at) VALUES ('s', 'u1', 'anthropic', 'claude-sonnet-4-6', 'engine', 9000000, 'subscription', '${ago(0, 5)}')`);
		expect(await runSpendAlerts(env)).toBe(0);
	});
});
