import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "./auth.js";
import { encryptKey } from "./crypto.js";
import { dispatchTrigger, nextRunAt, normalizeSchedule, publicWebhookUrl, type TriggerRow } from "./triggers.js";
import type { Env } from "../types.js";

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
