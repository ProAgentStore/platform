import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { encryptKey } from "../lib/crypto.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";
import { driveRoutes } from "./drive.js";
import { workdriveRoutes } from "./workdrive.js";

const TEST_SECRET = "test-secret";
const TEST_KEK = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

type Provider = "google_drive" | "zoho_workdrive";

interface KeyRow {
	key_ciphertext: Uint8Array;
	dek_wrapped: Uint8Array;
	iv: Uint8Array;
}

interface GrantRow {
	id: string;
	instance_id: string;
	user_id: string;
	provider: Provider;
	resource_id: string;
	resource_name: string;
	resource_type: string;
	resource_url: string | null;
	created_at: string;
	updated_at: string;
}

interface TestEnvOptions {
	instanceOwner?: string;
	keys?: Partial<Record<Provider, KeyRow>>;
	grants?: GrantRow[];
}

function connectorApp() {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/drive", driveRoutes);
	app.route("/v1/workdrive", workdriveRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	return app;
}

async function authHeaders(userId = "user-1") {
	const token = await signSession(userId, TEST_SECRET);
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};
}

async function keyRow(refreshToken: string): Promise<KeyRow> {
	const encrypted = await encryptKey(refreshToken, TEST_KEK);
	return {
		key_ciphertext: encrypted.ciphertext,
		dek_wrapped: encrypted.dekWrapped,
		iv: encrypted.iv,
	};
}

function grant(provider: Provider, resourceId: string, id = `grant-${provider}`): GrantRow {
	return {
		id,
		instance_id: "inst-1",
		user_id: "user-1",
		provider,
		resource_id: resourceId,
		resource_name: `${provider} folder`,
		resource_type: "folder",
		resource_url: null,
		created_at: "2026-07-11T00:00:00Z",
		updated_at: "2026-07-11T00:00:00Z",
	};
}

function testEnv(opts: TestEnvOptions = {}) {
	const instanceOwner = opts.instanceOwner ?? "user-1";
	const keys = opts.keys ?? {};
	const grants = opts.grants ?? [];
	const agentRequests: Request[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first() {
							if (sql.includes("FROM agent_instances")) {
								const [instanceId, userId] = args;
								if (instanceId === "inst-1" && userId === instanceOwner) {
									return {
										id: "inst-1",
										agent_id: "agent-1",
										user_id: instanceOwner,
										status: "active",
										config: "{}",
										created_at: "2026-07-11T00:00:00Z",
										updated_at: "2026-07-11T00:00:00Z",
									};
								}
								return null;
							}
							if (sql.includes("FROM user_api_keys")) {
								const provider = args[1] as Provider;
								return keys[provider] ?? null;
							}
							if (sql.includes("FROM instance_connector_grants")) {
								if (sql.includes("WHERE id = ?1")) {
									const [id, instanceId, userId, provider] = args;
									return grants.find((g) => (
										g.id === id &&
										g.instance_id === instanceId &&
										g.user_id === userId &&
										g.provider === provider
									)) ?? null;
								}
								if (sql.includes("resource_id = ?4")) {
									const [instanceId, userId, provider, resourceId] = args;
									return grants.find((g) => (
										g.instance_id === instanceId &&
										g.user_id === userId &&
										g.provider === provider &&
										g.resource_id === resourceId
									)) ?? null;
								}
							}
							return null;
						},
						async all() {
							if (sql.includes("FROM instance_connector_grants")) {
								const [instanceId, userId, provider] = args;
								return {
									results: grants.filter((g) => (
										g.instance_id === instanceId &&
										g.user_id === userId &&
										g.provider === provider
									)),
								};
							}
							return { results: [] };
						},
						async run() {
							return {};
						},
					};
				},
			};
		},
	};
	const AGENT = {
		idFromName: (name: string) => ({ name }),
		get: () => ({
			fetch: async (req: Request) => {
				agentRequests.push(req);
				return Response.json({ id: "doc-1", title: "Imported" }, { status: 201 });
			},
		}),
	};
	return {
		env: {
			DB,
			AGENT,
			SESSION_SIGNING_KEY: TEST_SECRET,
			KEY_ENCRYPTION_KEY: TEST_KEK,
			GOOGLE_CLIENT_ID: "google-client",
			GOOGLE_CLIENT_SECRET: "google-secret",
			ZOHO_CLIENT_ID: "zoho-client",
			ZOHO_CLIENT_SECRET: "zoho-secret",
		} as unknown as Env,
		agentRequests,
	};
}

function jsonInit(body: unknown, headers: Record<string, string>) {
	return {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	};
}

function okJson(data: unknown) {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("connector route authorization", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("requires a Drive grant before listing instance files", async () => {
		const app = connectorApp();
		const { env } = testEnv();
		const res = await app.request(
			"/v1/drive/instances/inst-1/files",
			{ headers: await authHeaders() },
			env,
		);

		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({ error: "grantId required" });
	});

	it("does not expose Drive grants for instances owned by another user", async () => {
		const app = connectorApp();
		const { env } = testEnv({ instanceOwner: "other-user" });
		const res = await app.request(
			"/v1/drive/instances/inst-1/grants",
			{ headers: await authHeaders() },
			env,
		);

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toMatchObject({ error: "Instance not found" });
	});

	it("returns a clear Drive error when the account is not connected", async () => {
		const app = connectorApp();
		const { env } = testEnv();
		const res = await app.request(
			"/v1/drive/instances/inst-1/grants",
			jsonInit({ resourceId: "rootfolder123456789" }, await authHeaders()),
			env,
		);

		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({ error: "Google Drive is not connected" });
	});

	it("rejects Drive imports outside the granted folder", async () => {
		const app = connectorApp();
		const { env } = testEnv({
			keys: { google_drive: await keyRow("drive-refresh") },
			grants: [grant("google_drive", "rootfolder123456789", "grant-drive")],
		});
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				return okJson({ access_token: "drive-access" });
			}
			if (url.includes("/drive/v3/files/file123456789?")) {
				return okJson({
					id: "file123456789",
					name: "outside.txt",
					mimeType: "text/plain",
					parents: ["outsidefolder123456789"],
				});
			}
			if (url.includes("/drive/v3/files/outsidefolder123456789?")) {
				return okJson({
					id: "outsidefolder123456789",
					name: "Outside",
					mimeType: "application/vnd.google-apps.folder",
					parents: [],
				});
			}
			throw new Error(`unexpected fetch ${url}`);
		}));

		const res = await app.request(
			"/v1/drive/instances/inst-1/import",
			jsonInit({ fileId: "file123456789", grantId: "grant-drive" }, await authHeaders()),
			env,
		);

		expect(res.status).toBe(403);
		await expect(res.json()).resolves.toMatchObject({
			error: "This agent has not been granted access to that Drive file",
		});
	});

	it("requires a WorkDrive grant before browsing instance folders", async () => {
		const app = connectorApp();
		const { env } = testEnv();
		const res = await app.request(
			"/v1/workdrive/instances/inst-1/folder",
			{ headers: await authHeaders() },
			env,
		);

		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({ error: "grantId required" });
	});

	it("browses nested WorkDrive folders under a granted root", async () => {
		const app = connectorApp();
		const { env } = testEnv({
			keys: { zoho_workdrive: await keyRow("workdrive-refresh") },
			grants: [grant("zoho_workdrive", "rootfolder123456789", "grant-workdrive")],
		});
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://accounts.zoho.com/oauth/v2/token") {
				return okJson({ access_token: "workdrive-access" });
			}
			if (url.includes("/workdrive/api/v1/files/rootfolder123456789/files?")) {
				return okJson({
					data: [
						{
							id: "childfolder123456789",
							type: "folders",
							attributes: { name: "Child folder" },
						},
					],
				});
			}
			if (url.includes("/workdrive/api/v1/files/childfolder123456789/files?")) {
				return okJson({
					data: [
						{
							id: "target123456789",
							type: "files",
							attributes: { name: "target.txt", extn: "txt", mime_type: "text/plain" },
						},
					],
				});
			}
			throw new Error(`unexpected fetch ${url}`);
		}));

		const res = await app.request(
			"/v1/workdrive/instances/inst-1/folder?grantId=grant-workdrive&folder=childfolder123456789",
			{ headers: await authHeaders() },
			env,
		);
		const data = await res.json<{ files?: Array<{ id: string }> }>();

		expect(res.status).toBe(200);
		expect(data.files?.map((file) => file.id)).toEqual(["target123456789"]);
	});

	it("imports nested WorkDrive files under a granted root", async () => {
		const app = connectorApp();
		const { env, agentRequests } = testEnv({
			keys: { zoho_workdrive: await keyRow("workdrive-refresh") },
			grants: [grant("zoho_workdrive", "rootfolder123456789", "grant-workdrive")],
		});
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://accounts.zoho.com/oauth/v2/token") {
				return okJson({ access_token: "workdrive-access" });
			}
			if (url.includes("/workdrive/api/v1/files/rootfolder123456789/files?")) {
				return okJson({
					data: [
						{
							id: "childfolder123456789",
							type: "folders",
							attributes: { name: "Child folder" },
						},
					],
				});
			}
			if (url.includes("/workdrive/api/v1/files/childfolder123456789/files?")) {
				return okJson({
					data: [
						{
							id: "target123456789",
							type: "files",
							attributes: { name: "target.txt", extn: "txt", mime_type: "text/plain" },
						},
					],
				});
			}
			if (url.includes("/workdrive/api/v1/files/target123456789")) {
				return okJson({
					data: {
						id: "target123456789",
						type: "files",
						attributes: {
							name: "target.txt",
							extn: "txt",
							mime_type: "text/plain",
							permalink: "https://workdrive.zoho.com/file/target123456789",
						},
					},
				});
			}
			if (url === "https://download.zoho.com/v1/workdrive/download/target123456789") {
				return new Response("Nested WorkDrive notes", {
					status: 200,
					headers: { "content-type": "text/plain" },
				});
			}
			throw new Error(`unexpected fetch ${url}`);
		}));

		const res = await app.request(
			"/v1/workdrive/instances/inst-1/import",
			jsonInit({ resourceId: "target123456789", grantId: "grant-workdrive" }, await authHeaders()),
			env,
		);
		const data = await res.json<{ workdriveFile?: { id: string } }>();
		const knowledgeBody = await agentRequests[0].clone().json() as { content: string; source: string };

		expect(res.status).toBe(201);
		expect(data.workdriveFile?.id).toBe("target123456789");
		expect(knowledgeBody).toMatchObject({
			content: "Nested WorkDrive notes",
			source: "workdrive",
		});
	});
});
