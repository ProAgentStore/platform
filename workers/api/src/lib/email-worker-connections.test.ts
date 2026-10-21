import { describe, expect, it } from "vitest";
import type { Env } from "../types.js";
import {
	connectionForWebhookToken,
	deleteEmailWorkerConnection,
	listEmailWorkerConnections,
	normalizeEmailWorkerEndpoint,
	pinnedEmailWorkerConnectionFor,
	pinnedEmailWorkerConnectionFrom,
	recordInboundEventOnce,
	resolveEmailWorkerConnection,
	resolveEmailWorkerConnectionFrom,
	resolveEmailWorkerSecret,
	saveEmailWorkerConnection,
	updateEmailWorkerContractVersion,
} from "./email-worker-connections.js";

const KEK = "2".repeat(64);
const EP = "https://mail.freeappstore.online";
const USER = "user-1";

interface ConnRecord {
	user_id: string;
	endpoint: string;
	account_id: string;
	secret_ciphertext: Uint8Array;
	secret_dek_wrapped: Uint8Array;
	secret_iv: Uint8Array;
	account_label: string | null;
	contract_version: string | null;
	webhook_token: string;
	created_at: string;
	updated_at: string;
}

function fakeEnv(): Env & { instances: Map<string, string> } {
	const conns = new Map<string, ConnRecord>();
	const inbound = new Set<string>();
	const instances = new Map<string, string>();
	const key = (u: string, e: string, a: string) => `${u}${e}${a}`;

	const DB = {
		prepare: (sql: string) => ({
			bind: (...a: unknown[]) => ({
				first: async () => {
					if (sql.includes("FROM email_worker_connections WHERE webhook_token")) {
						const token = String(a[0]);
						for (const row of conns.values()) if (row.webhook_token === token) return row;
						return null;
					}
					if (sql.includes("FROM email_worker_connections")) {
						return conns.get(key(String(a[0]), String(a[1]), String(a[2] ?? ""))) ?? null;
					}
					if (sql.includes("FROM agent_instances")) {
						const cfg = instances.get(String(a[0]));
						return cfg === undefined ? null : { config: cfg };
					}
					return null;
				},
				all: async () => {
					if (sql.includes("FROM email_worker_connections")) {
						const uid = String(a[0]);
						return { results: [...conns.values()].filter((r) => r.user_id === uid).sort((x, y) => x.endpoint.localeCompare(y.endpoint)) };
					}
					return { results: [] };
				},
				run: async () => {
					if (sql.startsWith("INSERT INTO email_worker_connections")) {
						const [user_id, endpoint, account_id, secret_ciphertext, secret_dek_wrapped, secret_iv, account_label, contract_version, webhook_token] = a as never[];
						conns.set(key(String(user_id), String(endpoint), String(account_id ?? "")), {
							user_id: String(user_id),
							endpoint: String(endpoint),
							account_id: String(account_id ?? ""),
							secret_ciphertext,
							secret_dek_wrapped,
							secret_iv,
							account_label: (account_label ?? null) as string | null,
							contract_version: (contract_version ?? null) as string | null,
							webhook_token: String(webhook_token),
							created_at: new Date().toISOString(),
							updated_at: new Date().toISOString(),
						});
						return { success: true, meta: { changes: 1 } };
					}
					if (sql.startsWith("UPDATE email_worker_connections SET contract_version")) {
						const row = conns.get(key(String(a[0]), String(a[1]), String(a[2] ?? "")));
						if (row) row.contract_version = String(a[3]);
						return { success: true, meta: { changes: row ? 1 : 0 } };
					}
					if (sql.startsWith("DELETE FROM email_worker_connections")) {
						const k = key(String(a[0]), String(a[1]), String(a[2] ?? ""));
						const existed = conns.delete(k);
						return { success: true, meta: { changes: existed ? 1 : 0 } };
					}
					if (sql.startsWith("INSERT OR IGNORE INTO email_worker_inbound_events")) {
						const dedupeKey = `${a[0]}${a[1]}${a[2]}${a[3]}`;
						if (inbound.has(dedupeKey)) return { success: true, meta: { changes: 0 } };
						inbound.add(dedupeKey);
						return { success: true, meta: { changes: 1 } };
					}
					return { success: true, meta: { changes: 0 } };
				},
			}),
		}),
	};

	return { DB, KEY_ENCRYPTION_KEY: KEK, instances } as unknown as Env & { instances: Map<string, string> };
}

describe("normalizeEmailWorkerEndpoint", () => {
	it("strips query/fragment, lowercases the host and drops a trailing slash", () => {
		expect(normalizeEmailWorkerEndpoint("https://Mail.Example.com/base/?x=1#frag")).toBe("https://mail.example.com/base");
	});
});

describe("saveEmailWorkerConnection / resolveEmailWorkerSecret", () => {
	it("round-trips a secret through envelope encryption", async () => {
		const env = fakeEnv();
		await saveEmailWorkerConnection(env, { userId: USER, endpoint: EP, secret: "s3cr3t", contractVersion: "email-worker/v1" });
		expect(await resolveEmailWorkerSecret(env, USER, EP)).toBe("s3cr3t");
	});

	it("keeps the SAME webhook token across a replace (AC1) — the owner's pasted inbound URL survives a rotation", async () => {
		const env = fakeEnv();
		const first = await saveEmailWorkerConnection(env, { userId: USER, endpoint: EP, secret: "old-secret" });
		const second = await saveEmailWorkerConnection(env, { userId: USER, endpoint: EP, secret: "new-secret" });
		expect(second.webhookToken).toBe(first.webhookToken);
		expect(await resolveEmailWorkerSecret(env, USER, EP)).toBe("new-secret");
	});

	it("isolates two different endpoints under the same user", async () => {
		const env = fakeEnv();
		await saveEmailWorkerConnection(env, { userId: USER, endpoint: EP, secret: "a" });
		await saveEmailWorkerConnection(env, { userId: USER, endpoint: "https://other.example.com", secret: "b" });
		expect(await resolveEmailWorkerSecret(env, USER, EP)).toBe("a");
		expect(await resolveEmailWorkerSecret(env, USER, "https://other.example.com")).toBe("b");
	});

	it("resolveEmailWorkerSecret returns null for an unconnected endpoint", async () => {
		const env = fakeEnv();
		expect(await resolveEmailWorkerSecret(env, USER, EP)).toBeNull();
	});
});

describe("updateEmailWorkerContractVersion / deleteEmailWorkerConnection", () => {
	it("updates the recorded version without touching the secret", async () => {
		const env = fakeEnv();
		await saveEmailWorkerConnection(env, { userId: USER, endpoint: EP, secret: "s", contractVersion: "email-worker/v1" });
		await updateEmailWorkerContractVersion(env, USER, EP, "", "email-worker/v2");
		const [info] = await listEmailWorkerConnections(env, USER, "https://api.proagentstore.online");
		expect(info.contractVersion).toBe("email-worker/v2");
		expect(await resolveEmailWorkerSecret(env, USER, EP)).toBe("s");
	});

	it("revokes a connection; a repeat revoke reports nothing removed", async () => {
		const env = fakeEnv();
		await saveEmailWorkerConnection(env, { userId: USER, endpoint: EP, secret: "s" });
		expect(await deleteEmailWorkerConnection(env, USER, EP)).toBe(true);
		expect(await deleteEmailWorkerConnection(env, USER, EP)).toBe(false);
		expect(await resolveEmailWorkerSecret(env, USER, EP)).toBeNull();
	});
});

describe("listEmailWorkerConnections", () => {
	it("builds the inbound webhook URL from the stored token, never the secret", async () => {
		const env = fakeEnv();
		await saveEmailWorkerConnection(env, { userId: USER, endpoint: EP, secret: "s" });
		const [info] = await listEmailWorkerConnections(env, USER, "https://api.proagentstore.online");
		expect(info.webhookUrl).toMatch(/^https:\/\/api\.proagentstore\.online\/v1\/email-worker\/inbound\/[0-9a-f]{48}$/);
		expect(JSON.stringify(info)).not.toContain("s3cr3t");
	});
});

describe("resolveEmailWorkerConnectionFrom (pure)", () => {
	const A = { endpoint: "https://a.example.com", accountId: "", accountLabel: null };
	const B = { endpoint: "https://b.example.com", accountId: "", accountLabel: "Billing inbox" };

	it("refuses when nothing is connected", () => {
		const r = resolveEmailWorkerConnectionFrom([], undefined);
		expect(r).toEqual({ ok: false, reason: "not_connected", message: expect.stringContaining("No worker-backed email connection") });
	});

	it("resolves the lone connection with no pin required", () => {
		const r = resolveEmailWorkerConnectionFrom([A], undefined);
		expect(r).toEqual({ ok: true, endpoint: A.endpoint, accountId: "", label: A.endpoint });
	});

	it("refuses as ambiguous with two connections and no pin — never silently picks one", () => {
		const r = resolveEmailWorkerConnectionFrom([A, B], undefined);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("ambiguous");
			expect(r.message).toContain("Billing inbox");
		}
	});

	it("resolves to the pinned connection among several", () => {
		const r = resolveEmailWorkerConnectionFrom([A, B], { endpoint: B.endpoint, accountId: "" });
		expect(r).toEqual({ ok: true, endpoint: B.endpoint, accountId: "", label: "Billing inbox" });
	});

	it("a stale pin (the connection was revoked) refuses rather than falling back to the other one", () => {
		const r = resolveEmailWorkerConnectionFrom([A], { endpoint: "https://gone.example.com", accountId: "" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("pinned_account_gone");
	});
});

describe("pinnedEmailWorkerConnectionFrom", () => {
	it("reads a well-formed pin and ignores malformed config", () => {
		expect(pinnedEmailWorkerConnectionFrom({ emailWorkerAccount: { endpoint: "https://a.example.com", accountId: "x" } })).toEqual({
			endpoint: "https://a.example.com",
			accountId: "x",
		});
		expect(pinnedEmailWorkerConnectionFrom({})).toBeUndefined();
		expect(pinnedEmailWorkerConnectionFrom(null)).toBeUndefined();
		expect(pinnedEmailWorkerConnectionFrom({ emailWorkerAccount: "nope" })).toBeUndefined();
		expect(pinnedEmailWorkerConnectionFrom({ emailWorkerAccount: { accountId: "x" } })).toBeUndefined();
	});
});

describe("resolveEmailWorkerConnection (D1-backed)", () => {
	it("reads the pin from agent_instances.config and resolves against the owner's connections", async () => {
		const env = fakeEnv();
		await saveEmailWorkerConnection(env, { userId: USER, endpoint: EP, secret: "s" });
		env.instances.set("inst-1", JSON.stringify({ emailWorkerAccount: { endpoint: EP, accountId: "" } }));
		const resolved = await resolveEmailWorkerConnection(env, USER, "inst-1");
		expect(resolved).toEqual({ ok: true, endpoint: EP, accountId: "", label: EP });
	});

	it("with no instanceId, still resolves the lone connection (so a template preview isn't blocked)", async () => {
		const env = fakeEnv();
		await saveEmailWorkerConnection(env, { userId: USER, endpoint: EP, secret: "s" });
		const resolved = await resolveEmailWorkerConnection(env, USER, undefined);
		expect(resolved.ok).toBe(true);
	});
});

describe("pinnedEmailWorkerConnectionFor", () => {
	it("returns undefined for an unknown instance", async () => {
		const env = fakeEnv();
		expect(await pinnedEmailWorkerConnectionFor(env, "nope")).toBeUndefined();
	});
});

describe("connectionForWebhookToken / recordInboundEventOnce", () => {
	it("looks a connection up by its webhook token, never by the secret", async () => {
		const env = fakeEnv();
		const { webhookToken } = await saveEmailWorkerConnection(env, { userId: USER, endpoint: EP, secret: "s", accountLabel: "Support" });
		const found = await connectionForWebhookToken(env, webhookToken);
		expect(found).toEqual({ userId: USER, endpoint: EP, accountId: "", label: "Support" });
		expect(await connectionForWebhookToken(env, "unknown-token")).toBeNull();
	});

	it("dedupes a retried inbound event id — true once, false on every repeat", async () => {
		const env = fakeEnv();
		expect(await recordInboundEventOnce(env, USER, EP, "", "evt-1")).toBe(true);
		expect(await recordInboundEventOnce(env, USER, EP, "", "evt-1")).toBe(false);
		expect(await recordInboundEventOnce(env, USER, EP, "", "evt-1")).toBe(false);
		// A different event id on the same connection is independent.
		expect(await recordInboundEventOnce(env, USER, EP, "", "evt-2")).toBe(true);
	});
});
