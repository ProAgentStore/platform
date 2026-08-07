import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { HttpError } from "./auth.js";
import { encryptKey } from "./crypto.js";
import { applyJitter, dispatchTrigger, nextRunAt, normalizeSchedule, previewRuns, publicWebhookUrl, type TriggerRow } from "./triggers.js";
import { startPipelineRun } from "./pipeline-run-start.js";
import { startBrowserTask } from "../routes/instances-browse.js";
import { notifyUser } from "../routes/push.js";
import type { Env } from "../types.js";

// #92: dispatchTrigger's run_pipeline branch calls startPipelineRun (which loads the pipeline
// from instance config + kicks the durable workflow). Stub it here to unit-test the wiring.
vi.mock("./pipeline-run-start.js", () => ({ startPipelineRun: vi.fn() }));
// #172: the run_browse branch fires startBrowserTask (starts the BROWSER_TASK workflow) and,
// on a skip, notifyUser. Stub both to unit-test the wiring without the real browser stack.
vi.mock("../routes/instances-browse.js", () => ({ startBrowserTask: vi.fn() }));
vi.mock("../routes/push.js", () => ({ notifyUser: vi.fn(async () => undefined) }));

const TEST_KEK = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

async function encryptedRefreshToken(refreshToken: string) {
	const encrypted = await encryptKey(refreshToken, TEST_KEK);
	return {
		key_ciphertext: encrypted.ciphertext,
		dek_wrapped: encrypted.dekWrapped,
		iv: encrypted.iv,
	};
}

function trigger(config: Record<string, unknown>): TriggerRow {
	return {
		id: "trigger-1",
		user_id: "user-1",
		agent_id: "agent-1",
		instance_id: "inst-1",
		name: "Drive sync",
		type: "cron",
		action: "sync_connector",
		enabled: 1,
		secret_token: null,
		schedule: "@hourly",
		config: JSON.stringify(config),
		last_run_at: null,
		next_run_at: null,
		failure_count: 0,
		last_error: null,
		created_at: "2026-07-12T00:00:00Z",
		updated_at: "2026-07-12T00:00:00Z",
	};
}

async function syncTestEnv() {
	const key = await encryptedRefreshToken("drive-refresh");
	const syncRows = new Map<string, { fingerprint: string }>();
	const agentRequests: Request[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first() {
							if (sql.includes("FROM user_api_keys")) return key;
							if (sql.includes("FROM instance_connector_grants")) {
								return {
									id: "grant-drive",
									instance_id: "inst-1",
									user_id: "user-1",
									provider: "google_drive",
									resource_id: "rootfolder123456789",
									resource_name: "Client docs",
									resource_type: "folder",
									resource_url: null,
									created_at: "2026-07-12T00:00:00Z",
									updated_at: "2026-07-12T00:00:00Z",
								};
							}
							if (sql.includes("FROM agent_trigger_sync_state")) {
								return syncRows.get(`${args[0]}:${args[1]}:${args[2]}`) ?? null;
							}
							return null;
						},
						async all() {
							return { results: [] };
						},
						async run() {
							if (sql.includes("INSERT INTO agent_trigger_sync_state")) {
								syncRows.set(`${args[0]}:${args[3]}:${args[4]}`, { fingerprint: String(args[5]) });
							}
							return {};
						},
					};
				},
				async run() {
					return {};
				},
			};
		},
	};
	const AGENT = {
		idFromName: (name: string) => ({ name }),
		get: () => ({
			fetch: async (req: Request) => {
				agentRequests.push(req);
				return Response.json({ id: "doc-1" }, { status: 201 });
			},
		}),
	};
	return {
		env: {
			DB,
			AGENT,
			KEY_ENCRYPTION_KEY: TEST_KEK,
			GOOGLE_CLIENT_ID: "google-client",
			GOOGLE_CLIENT_SECRET: "google-secret",
		} as unknown as Env,
		agentRequests,
		syncRows,
	};
}

describe("trigger schedules", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("normalizes supported interval schedules", () => {
		expect(normalizeSchedule("@hourly")).toBe("@hourly");
		expect(normalizeSchedule("every 15 minutes")).toBe("every 15 minutes");
		expect(normalizeSchedule("every 2 hours")).toBe("every 120 minutes");
	});

	it("rejects too-frequent schedules", () => {
		expect(() => normalizeSchedule("every 1 minute")).toThrow(HttpError);
	});

	it("computes the next run for aliases and intervals", () => {
		const base = new Date("2026-07-12T02:03:22.000Z");
		expect(nextRunAt("@hourly", base)).toBe("2026-07-12T03:03:00.000Z");
		expect(nextRunAt("every 15 minutes", base)).toBe("2026-07-12T02:18:00.000Z");
		expect(nextRunAt("@daily", base)).toBe("2026-07-13T00:00:00.000Z");
	});

	it("computes simple five-field cron schedules", () => {
		const base = new Date("2026-07-12T02:03:22.000Z");
		expect(nextRunAt("5 * * * *", base)).toBe("2026-07-12T02:05:00.000Z");
		expect(nextRunAt("0 8 * * *", base)).toBe("2026-07-12T08:00:00.000Z");
	});

	it("keeps UTC meaning for every schedule that has no timezone (#18 back-compat)", () => {
		// Timezones are opt-in. A trigger created before they existed must fire at exactly the
		// same instant it always did, so absence of config.timezone has to mean UTC forever.
		const base = new Date("2026-07-12T02:03:22.000Z");
		expect(nextRunAt("@weekly", base)).toBe("2026-07-19T00:00:00.000Z");
		expect(nextRunAt("0 8 * * *", base, undefined)).toBe("2026-07-12T08:00:00.000Z");
		expect(nextRunAt("0 8 * * *", base, "Not/AZone")).toBe("2026-07-12T08:00:00.000Z");
	});

	it("reads a wall-clock schedule in the trigger's timezone (#18)", () => {
		const base = new Date("2026-07-12T02:03:22.000Z"); // 12:03 in Melbourne (+10)
		// 08:00 Melbourne is 22:00Z the previous day, so the next one is the 13th.
		expect(nextRunAt("0 8 * * *", base, "Australia/Melbourne")).toBe("2026-07-12T22:00:00.000Z");
	});

	it("leaves INTERVAL schedules alone — a duration has no wall clock to be in", () => {
		const base = new Date("2026-07-12T02:03:22.000Z");
		expect(nextRunAt("every 15 minutes", base, "Australia/Melbourne")).toBe("2026-07-12T02:18:00.000Z");
		expect(nextRunAt("@hourly", base, "Australia/Melbourne")).toBe("2026-07-12T03:03:00.000Z");
	});

	it("previewRuns walks forward using the SAME calculation the sweep uses", () => {
		// The preview is computed here rather than in the browser precisely so it cannot drift
		// from what actually happens.
		const runs = previewRuns("0 8 * * *", "Australia/Melbourne", 3, new Date("2026-07-12T02:03:22.000Z"));
		expect(runs).toEqual([
			"2026-07-12T22:00:00.000Z",
			"2026-07-13T22:00:00.000Z",
			"2026-07-14T22:00:00.000Z",
		]);
	});

	it("previewRuns holds the local hour across a DST boundary", () => {
		const runs = previewRuns("0 8 * * *", "Australia/Melbourne", 3, new Date("2026-10-02T20:00:00.000Z"));
		// 08:00 on the 3rd is +10; the clocks go forward on the 4th, so 08:00 on the 4th and 5th
		// is +11. Three consecutive runs, one of them an hour closer to its predecessor than the
		// other — which is exactly right, and is what a fixed UTC cron gets wrong.
		expect(runs).toEqual([
			"2026-10-02T22:00:00.000Z",
			"2026-10-03T21:00:00.000Z",
			"2026-10-04T21:00:00.000Z",
		]);
	});

	it("formats public webhook URLs without duplicate slashes", () => {
		expect(publicWebhookUrl("https://api.example.com/", "abc")).toBe("https://api.example.com/v1/triggers/webhook/abc");
	});

	it("syncs a granted Drive folder once and skips unchanged files on the next run", async () => {
		const { env, agentRequests, syncRows } = await syncTestEnv();
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				return Response.json({ access_token: "drive-access" });
			}
			if (url.includes("/drive/v3/files?")) {
				return Response.json({
					files: [{
						id: "file123456789",
						name: "Brief",
						mimeType: "application/vnd.google-apps.document",
						modifiedTime: "2026-07-12T01:00:00.000Z",
						webViewLink: "https://docs.google.com/document/d/file123456789",
						parents: ["rootfolder123456789"],
					}],
				});
			}
			if (url.includes("/drive/v3/files/file123456789?") && !url.includes("/export?")) {
				return Response.json({
					id: "file123456789",
					name: "Brief",
					mimeType: "application/vnd.google-apps.document",
					modifiedTime: "2026-07-12T01:00:00.000Z",
					webViewLink: "https://docs.google.com/document/d/file123456789",
					parents: ["rootfolder123456789"],
				});
			}
			if (url.includes("/drive/v3/files/file123456789/export?")) {
				return new Response("Client brief", { status: 200, headers: { "content-type": "text/plain" } });
			}
			throw new Error(`unexpected fetch ${url}`);
		}));

		await dispatchTrigger(env, trigger({ provider: "google_drive", grantId: "grant-drive" }), "manual", {});
		await dispatchTrigger(env, trigger({ provider: "google_drive", grantId: "grant-drive" }), "manual", {});

		expect(agentRequests).toHaveLength(1);
		expect(syncRows.get("trigger-1:google_drive:file123456789")?.fingerprint).toContain("2026-07-12T01:00:00.000Z");
		const body = await agentRequests[0].clone().json() as { title: string; content: string; source: string; sourceUrl: string };
		expect(body).toMatchObject({
			title: "Brief",
			content: "Client brief",
			source: "drive",
			sourceUrl: "https://docs.google.com/document/d/file123456789",
		});
	});
});

describe("trigger actions: run_pipeline + insert_record (#92)", () => {
	afterEach(() => vi.unstubAllGlobals());

	function baseEnv() {
		const agentRequests: Request[] = [];
		const DB = {
			prepare() {
				const stmt = {
					bind: () => stmt,
					first: async () => null,
					all: async () => ({ results: [] }),
					run: async () => ({}),
				};
				return stmt;
			},
		};
		const AGENT = {
			idFromName: (name: string) => ({ name }),
			get: () => ({ fetch: async (req: Request) => { agentRequests.push(req); return Response.json({ id: "rec-1" }, { status: 201 }); } }),
		};
		return { env: { DB, AGENT } as unknown as Env, agentRequests };
	}

	const pipelineTrigger = (config: Record<string, unknown>): TriggerRow => ({ ...trigger(config), action: "run_pipeline" });
	const recordTrigger = (config: Record<string, unknown>): TriggerRow => ({ ...trigger(config), action: "insert_record" });

	it("run_pipeline kicks startPipelineRun with the configured pipeline + 'trigger' source", async () => {
		const { env } = baseEnv();
		(startPipelineRun as Mock).mockResolvedValue({ ok: true, runId: "run-abcdef12", workflowId: "wf-1" });
		const res = await dispatchTrigger(env, pipelineTrigger({ pipeline: "lead-sweep" }), "cron", { city: "Austin" });
		expect(res.ok).toBe(true);
		// The whole point of #92: cron/webhook → durable pipeline, pipeline resolved by NAME from
		// config (data-driven, no capability-union edit), payload passed through as run params.
		// The trailing null is the parent trace: a cron/webhook trigger has no upstream run.
		// It is non-null only when the CONNECTION pump delivered the event, which is what
		// joins a chain's runs together.
		expect(startPipelineRun).toHaveBeenCalledWith(env, "inst-1", "user-1", "lead-sweep", { city: "Austin" }, "trigger", null);
	});

	it("carries the emitting run into the child run when a CONNECTION delivered the event", async () => {
		// Choreography's weak point: without this a chain is N runs with nothing joining them,
		// and "why didn't outreach fire?" has no single place to look.
		const { env } = baseEnv();
		(startPipelineRun as Mock).mockResolvedValue({ ok: true, runId: "run-child", workflowId: "wf-2" });
		await dispatchTrigger(env, pipelineTrigger({ pipeline: "draft_outreach", traceId: "run-parent" }), "webhook", { place_id: "p1" });
		expect(startPipelineRun).toHaveBeenCalledWith(env, "inst-1", "user-1", "draft_outreach", { place_id: "p1" }, "trigger", "run-parent");
	});

	it("merges the connection's static params UNDER the event payload", async () => {
		// Wiring-level config (which endpoint, which template) that the inbound record can't
		// carry — but a field present on the record still wins.
		const { env } = baseEnv();
		(startPipelineRun as Mock).mockResolvedValue({ ok: true, runId: "run-child", workflowId: "wf-3" });
		await dispatchTrigger(
			env,
			pipelineTrigger({ pipeline: "site-builder", params: { mcpUrl: "https://b.example/mcp", place_id: "from-config" } }),
			"webhook",
			{ place_id: "from-event" },
		);
		expect(startPipelineRun).toHaveBeenCalledWith(
			env, "inst-1", "user-1", "site-builder",
			{ mcpUrl: "https://b.example/mcp", place_id: "from-event" },
			"trigger", null,
		);
	});

	it("run_pipeline surfaces a missing/invalid pipeline as a failed run (throws)", async () => {
		const { env } = baseEnv();
		(startPipelineRun as Mock).mockResolvedValue({ ok: false, error: "No pipeline named \"ghost\" is configured" });
		await expect(dispatchTrigger(env, pipelineTrigger({ pipeline: "ghost" }), "cron", {})).rejects.toThrow(/No pipeline named/);
	});

	it("run_pipeline without a pipeline name refuses rather than guessing", async () => {
		const { env } = baseEnv();
		await expect(dispatchTrigger(env, pipelineTrigger({}), "cron", {})).rejects.toThrow(/requires config\.pipeline/);
	});

	it("insert_record posts the payload (minus the routing key) as a record to the collection", async () => {
		const { env, agentRequests } = baseEnv();
		await dispatchTrigger(env, recordTrigger({ collection: "leads" }), "webhook", { collection: "leads", name: "Acme", email: "a@b.co" });
		expect(agentRequests).toHaveLength(1);
		expect(agentRequests[0].url).toBe("https://agent/collections/leads/records");
		const body = await agentRequests[0].clone().json() as { data: Record<string, unknown> };
		// The 'collection' routing key is stripped; the rest is the record.
		expect(body).toEqual({ data: { name: "Acme", email: "a@b.co" } });
	});

	it("insert_record prefers an explicit `record` object when present", async () => {
		const { env, agentRequests } = baseEnv();
		await dispatchTrigger(env, recordTrigger({ collection: "leads" }), "webhook", { record: { name: "Beta" }, ignored: "meta" });
		const body = await agentRequests[0].clone().json() as { data: Record<string, unknown> };
		expect(body).toEqual({ data: { name: "Beta" } });
	});

	it("insert_record without a collection refuses", async () => {
		const { env } = baseEnv();
		await expect(dispatchTrigger(env, recordTrigger({}), "webhook", { name: "x" })).rejects.toThrow(/requires config\.collection/);
	});
});

describe("trigger payload mapping (#16)", () => {
	function baseEnv() {
		const agentRequests: Request[] = [];
		const DB = {
			prepare() {
				const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) };
				return stmt;
			},
		};
		const AGENT = {
			idFromName: (name: string) => ({ name }),
			get: () => ({ fetch: async (req: Request) => { agentRequests.push(req); return Response.json({ id: "x" }, { status: 201 }); } }),
		};
		return { env: { DB, AGENT } as unknown as Env, agentRequests };
	}

	const taskTrigger = (config: Record<string, unknown>): TriggerRow => ({ ...trigger(config), action: "create_task", type: "webhook" });
	const kbTrigger = (config: Record<string, unknown>): TriggerRow => ({ ...trigger(config), action: "add_knowledge", type: "webhook" });

	it("maps a nested payload onto the task fields", async () => {
		const { env, agentRequests } = baseEnv();
		await dispatchTrigger(
			env,
			taskTrigger({ mapping: { title: "lead.name", description: "lead.note" } }),
			"webhook",
			{ lead: { name: "Acme Pty Ltd", note: "wants a quote" } },
		);
		const body = await agentRequests[0].clone().json() as { title: string; description: string };
		expect(body).toEqual({ title: "Acme Pty Ltd", description: "wants a quote" });
	});

	it("falls back to the existing conventions when the mapped path is absent", async () => {
		// Back-compat is the load-bearing property: adding a mapping must never make a trigger
		// produce LESS than it did before.
		const { env, agentRequests } = baseEnv();
		await dispatchTrigger(env, taskTrigger({ mapping: { title: "lead.name" } }), "webhook", { title: "Flat title" });
		const body = await agentRequests[0].clone().json() as { title: string };
		expect(body.title).toBe("Flat title");
	});

	it("leaves an unmapped trigger behaving exactly as before", async () => {
		const { env, agentRequests } = baseEnv();
		await dispatchTrigger(env, taskTrigger({}), "webhook", { title: "Flat title", content: "body" });
		const body = await agentRequests[0].clone().json() as { title: string; description: string };
		expect(body).toEqual({ title: "Flat title", description: "body" });
	});

	it("maps knowledge content and source URL", async () => {
		const { env, agentRequests } = baseEnv();
		await dispatchTrigger(
			env,
			kbTrigger({ mapping: { title: "doc.name", content: "doc.body", sourceUrl: "doc.link" } }),
			"webhook",
			{ doc: { name: "Policy", body: "the text", link: "https://x.test/p" } },
		);
		const body = await agentRequests[0].clone().json() as { title: string; content: string; sourceUrl: string };
		expect(body).toMatchObject({ title: "Policy", content: "the text", sourceUrl: "https://x.test/p" });
	});

	it("mapping wins over the flat convention when both are present", async () => {
		const { env, agentRequests } = baseEnv();
		await dispatchTrigger(env, taskTrigger({ mapping: { title: "lead.name" } }), "webhook", { title: "generic", lead: { name: "Acme" } });
		const body = await agentRequests[0].clone().json() as { title: string };
		expect(body.title).toBe("Acme");
	});
});

describe("trigger action: run_browse (#172)", () => {
	afterEach(() => vi.clearAllMocks());

	function baseEnv() {
		const DB = {
			prepare() {
				const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) };
				return stmt;
			},
		};
		const AGENT = { idFromName: (name: string) => ({ name }), get: () => ({ fetch: async () => Response.json({}, { status: 200 }) }) };
		return { DB, AGENT } as unknown as Env;
	}
	const browseTrigger = (config: Record<string, unknown>): TriggerRow => ({ ...trigger(config), action: "run_browse" });

	it("fires startBrowserTask with the configured url + dryRun", async () => {
		const env = baseEnv();
		(startBrowserTask as Mock).mockResolvedValue({ workflowId: "wf-1", taskId: "task-1" });
		const res = await dispatchTrigger(env, browseTrigger({ url: "https://x.test/go", dryRun: true }), "cron", {});
		expect(res.ok).toBe(true);
		expect(startBrowserTask).toHaveBeenCalledWith(env, "inst-1", "user-1", { url: "https://x.test/go", dryRun: true });
	});

	it("without a url refuses rather than guessing", async () => {
		const env = baseEnv();
		await expect(dispatchTrigger(env, browseTrigger({}), "cron", {})).rejects.toThrow(/requires config\.url/);
	});

	it("SKIPS (does not fail the trigger) when the runner is offline (503)", async () => {
		const env = baseEnv();
		(startBrowserTask as Mock).mockRejectedValue(Object.assign(new Error("No runner connected. Start it with: pags up"), { status: 503 }));
		// A scheduled run with no runner online is a skip, not a failure — dispatch resolves ok.
		const res = await dispatchTrigger(env, browseTrigger({ url: "https://x.test/go" }), "cron", {});
		expect(res.ok).toBe(true);
	});

	it("SKIPS when a run is already in progress (409)", async () => {
		const env = baseEnv();
		(startBrowserTask as Mock).mockRejectedValue(Object.assign(new Error("A run is already in progress"), { status: 409 }));
		const res = await dispatchTrigger(env, browseTrigger({ url: "https://x.test/go" }), "cron", {});
		expect(res.ok).toBe(true);
	});

	it("a real error (not 503/409) still fails the trigger", async () => {
		const env = baseEnv();
		(startBrowserTask as Mock).mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
		await expect(dispatchTrigger(env, browseTrigger({ url: "https://x.test/go" }), "cron", {})).rejects.toThrow(/boom/);
	});

	// #358: the skip notification used to name `pags up` unconditionally. On a cloud-only agent
	// that is a false remedy — `pags up` skips instances whose capabilities.runtime is null, so
	// the user runs it, reads "None of your agents need a local runner", and the trigger keeps
	// skipping. Every fire. Forever.
	it("a 503 skip on a CLOUD-ONLY agent does not tell the user to run pags up", async () => {
		const agent = { slug: "lead-finder", category: "sales", config: JSON.stringify({ capabilities: { surfaces: [], runtime: null, workflow: null } }) };
		const env = {
			DB: {
				prepare() {
					const stmt = { bind: () => stmt, first: async () => agent, all: async () => ({ results: [] }), run: async () => ({}) };
					return stmt;
				},
			},
			AGENT: { idFromName: (name: string) => ({ name }), get: () => ({ fetch: async () => Response.json({}, { status: 200 }) }) },
		} as unknown as Env;
		(startBrowserTask as Mock).mockRejectedValue(Object.assign(new Error("No runner connected. Start it with: pags up"), { status: 503 }));
		const res = await dispatchTrigger(env, browseTrigger({ url: "https://x.test/go" }), "cron", {});
		expect(res.ok).toBe(true);
		const body = (notifyUser as Mock).mock.calls.at(-1)?.[4] as string;
		expect(body).not.toContain("pags up");
		expect(body).toContain("needs no runner");
	});
});

describe("applyJitter (#172 schedule jitter)", () => {
	it("returns the exact time when jitter is 0 / absent", () => {
		const iso = new Date(Date.now() + 3_600_000).toISOString();
		expect(applyJitter(iso)).toBe(iso);
		expect(applyJitter(iso, 0)).toBe(iso);
	});

	it("offsets within ± the jitter window and never schedules in the past", () => {
		const base = Date.now() + 3_600_000;
		const iso = new Date(base).toISOString();
		for (let i = 0; i < 50; i++) {
			const t = Date.parse(applyJitter(iso, 30));
			expect(Math.abs(t - base)).toBeLessThanOrEqual(30 * 60_000 + 1000);
			expect(t).toBeGreaterThan(Date.now());
		}
	});
});

describe("a failed trigger becomes durable (#17)", () => {
	/** Captures writes so we can assert the outbox row, and fails the action to force the path. */
	function envFailing() {
		const writes: Array<{ sql: string; args: unknown[] }> = [];
		const env = {
			DB: {
				prepare(sql: string) {
					return {
						bind(...args: unknown[]) {
							return {
								async first() { return null; },
								async all() { return { results: [] }; },
								async run() { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
							};
						},
					};
				},
			},
			// No AGENT binding → executeTriggerAction throws, which is the failure we want.
		} as unknown as Env;
		return { env, writes };
	}

	const row = {
		id: "trg-1", user_id: "u1", instance_id: "i1", name: "Nightly sweep",
		type: "cron", action: "run_pipeline", config: JSON.stringify({ pipeline: "sweep" }),
		enabled: 1, schedule: "0 2 * * *", next_run_at: null, last_run_at: null,
		failure_count: 0, last_error: null, token: null, created_at: "", updated_at: "",
	} as never;

	it("enqueues the failure into the SAME outbox connections use", async () => {
		// Before this a failed cron was simply lost, so durability depended on which kind of
		// edge fired — with nothing in the UI saying which.
		const { env, writes } = envFailing();
		await expect(dispatchTrigger(env, row, "cron", { a: 1 })).rejects.toThrow();
		const enqueued = writes.find((w) => w.sql.includes("INSERT OR IGNORE INTO agent_connection_deliveries"));
		expect(enqueued, "no outbox row was written").toBeTruthy();
	});

	it("marks the row as trigger-sourced so a stuck trigger is distinguishable", async () => {
		const { env, writes } = envFailing();
		await expect(dispatchTrigger(env, row, "cron", { a: 1 })).rejects.toThrow();
		const enqueued = writes.find((w) => w.sql.includes("agent_connection_deliveries"));
		expect((enqueued as { args: unknown[] }).args).toContain("trigger");
		// The producing edge id is the TRIGGER, so replay targets the right thing.
		expect((enqueued as { args: unknown[] }).args).toContain("trg-1");
	});

	it("still records the failure on the trigger itself and rethrows", async () => {
		// The outbox is additional durability, not a replacement for the existing accounting —
		// runDueTriggers counts the failure and the console still shows last_error.
		const { env, writes } = envFailing();
		await expect(dispatchTrigger(env, row, "cron", {})).rejects.toThrow();
		expect(writes.some((w) => w.sql.includes("failure_count = failure_count + 1"))).toBe(true);
	});

	it("writes NOTHING to the outbox on a successful dispatch", async () => {
		// The happy path must stay free of an extra write — the vast majority of dispatches
		// succeed, and only a failure needs to become durable.
		const writes: Array<{ sql: string }> = [];
		const env = {
			DB: {
				prepare(sql: string) {
					return { bind() { return { async first() { return null; }, async all() { return { results: [] }; }, async run() { writes.push({ sql }); return { meta: { changes: 1 } }; } }; } };
				},
			},
			AGENT: { idFromName: () => "id", get: () => ({ fetch: async () => new Response("{}", { status: 200 }) }) },
		} as unknown as Env;
		await dispatchTrigger(env, { ...(row as object), action: "create_task" } as never, "cron", { title: "x" }).catch(() => undefined);
		expect(writes.some((w) => w.sql.includes("agent_connection_deliveries"))).toBe(false);
	});
});
