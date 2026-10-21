import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types.js";
import type { RegistryToolCtx } from "./types.js";
import { saveEmailWorkerConnection } from "../email-worker-connections.js";
import { createEmailWorkerFixture } from "./email-worker.fixture.js";
import { EMAIL_WORKER_CONNECTOR } from "./email-worker.js";

const KEK = "3".repeat(64);
const EP = "https://mail.example.com";
const SECRET = "s3cr3t-token";

interface LoggedEvent {
	source: string;
	level: string;
	event: string;
	context: Record<string, unknown>;
}

/** A fake D1 covering exactly the tables this connector's handlers touch, plus agent_events so
 *  the audit receipt (AC4) is assertable rather than merely "didn't throw". */
interface ConnRecord {
	user_id: string;
	endpoint: string;
	account_id: string;
	secret_ciphertext: Uint8Array;
	secret_dek_wrapped: Uint8Array;
	secret_iv: Uint8Array;
	account_label: string | null;
	webhook_token: string;
}

function makeEnv() {
	const conns = new Map<string, ConnRecord>();
	const instances = new Map<string, string>();
	const events: LoggedEvent[] = [];
	const key = (u: string, e: string, a: string) => `${u}${e}${a}`;

	const DB = {
		prepare: (sql: string) => ({
			bind: (...a: unknown[]) => ({
				first: async () => {
					if (sql.includes("FROM email_worker_connections")) return conns.get(key(String(a[0]), String(a[1]), String(a[2] ?? ""))) ?? null;
					if (sql.includes("FROM agent_instances")) {
						const cfg = instances.get(String(a[0]));
						return cfg === undefined ? null : { config: cfg };
					}
					return null;
				},
				all: async () => {
					if (sql.includes("FROM email_worker_connections")) {
						const uid = String(a[0]);
						return { results: [...conns.values()].filter((r) => r.user_id === uid) };
					}
					return { results: [] };
				},
				run: async () => {
					if (sql.startsWith("INSERT INTO email_worker_connections")) {
						const [user_id, endpoint, account_id, secret_ciphertext, secret_dek_wrapped, secret_iv, account_label, , webhook_token] = a as never[];
						conns.set(key(String(user_id), String(endpoint), String(account_id ?? "")), {
							user_id: String(user_id),
							endpoint: String(endpoint),
							account_id: String(account_id ?? ""),
							secret_ciphertext,
							secret_dek_wrapped,
							secret_iv,
							account_label: (account_label ?? null) as string | null,
							webhook_token: String(webhook_token),
						});
						return { success: true, meta: { changes: 1 } };
					}
					if (sql.includes("INSERT INTO agent_events")) {
						const [, , , , , source, level, event, , context] = a as string[];
						events.push({ source, level, event, context: context ? JSON.parse(context) : {} });
						return { success: true };
					}
					return { success: true, meta: { changes: 0 } };
				},
			}),
		}),
	};

	const env = { DB, KEY_ENCRYPTION_KEY: KEK } as unknown as Env;
	return { env, instances, events };
}

async function seededCtx(opts: { instanceId?: string; pin?: boolean } = {}): Promise<{ ctx: RegistryToolCtx; events: LoggedEvent[] }> {
	const { env, instances, events } = makeEnv();
	await saveEmailWorkerConnection(env, { userId: "user-1", endpoint: EP, secret: SECRET });
	const instanceId = opts.instanceId ?? "inst-1";
	if (opts.pin !== false) instances.set(instanceId, JSON.stringify({ emailWorkerAccount: { endpoint: EP, accountId: "" } }));
	const ctx = { env, userId: "user-1", instanceId } as unknown as RegistryToolCtx;
	return { ctx, events };
}

const toolDef = (name: string) => {
	const t = EMAIL_WORKER_CONNECTOR.tools.find((x) => x.name === name);
	if (!t?.handler) throw new Error(`no handler for ${name}`);
	return t;
};
const tool = (name: string) => toolDef(name).handler!;

beforeEach(() => {
	vi.unstubAllGlobals();
});

describe("email_worker_list_messages / email_worker_read_message", () => {
	it("lists then reads a message through the fixture adapter", async () => {
		vi.stubGlobal("fetch", createEmailWorkerFixture({ secret: SECRET, messages: [{ id: "m1", threadId: "t1", from: "a@example.com", to: "me@example.com", subject: "Hi", date: "2026-01-01T00:00:00Z", body: "hello" }] }));
		const { ctx } = await seededCtx();
		const listed = await tool("email_worker_list_messages")(ctx, {});
		expect(listed.success).toBe(true);
		expect(JSON.parse(listed.content).messages[0].id).toBe("m1");

		const read = await tool("email_worker_read_message")(ctx, { message_id: "m1" });
		expect(read.success).toBe(true);
		expect(JSON.parse(read.content).body).toBe("hello");
	});

	it("requires message_id", async () => {
		const { ctx } = await seededCtx();
		const res = await tool("email_worker_read_message")(ctx, {});
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/message_id is required/);
	});
});

describe("email_worker_send / email_worker_reply", () => {
	it("sends a new message and writes an audit receipt with ids, no body (AC4)", async () => {
		vi.stubGlobal("fetch", createEmailWorkerFixture({ secret: SECRET }));
		const { ctx, events } = await seededCtx();
		const res = await tool("email_worker_send")(ctx, { to: "x@example.com", subject: "Subj", body: "the actual secret body text" });
		expect(res.success).toBe(true);
		const parsed = JSON.parse(res.content);
		expect(parsed.message_id).toMatch(/^msg-/);

		const receipt = events.find((e) => e.event === "email.send");
		expect(receipt).toBeTruthy();
		expect(receipt!.context.outcome).toBe("ok");
		expect(receipt!.context.messageId).toBe(parsed.message_id);
		expect(JSON.stringify(receipt)).not.toContain("the actual secret body text");
		expect(JSON.stringify(receipt)).not.toContain(SECRET);
	});

	it("replies in the parent's thread", async () => {
		vi.stubGlobal("fetch", createEmailWorkerFixture({ secret: SECRET, messages: [{ id: "m1", threadId: "t1", from: "a@example.com", to: "me@example.com", subject: "Hi", date: "2026-01-01T00:00:00Z", body: "hello" }] }));
		const { ctx } = await seededCtx();
		const res = await tool("email_worker_reply")(ctx, { message_id: "m1", body: "thanks" });
		expect(res.success).toBe(true);
		expect(JSON.parse(res.content).thread_id).toBe("t1");
	});

	it("validates required fields before ever resolving a connection", async () => {
		const { ctx } = await seededCtx();
		expect((await tool("email_worker_send")(ctx, { subject: "s", body: "b" })).content).toMatch(/to is required/);
		expect((await tool("email_worker_reply")(ctx, { body: "b" })).content).toMatch(/message_id is required/);
	});
});

describe("AC3 — denied grant / missing consent / wrong pin / adapter failure are distinguishable, and none send", () => {
	it("wrong instance pin (ambiguous — two connections, none pinned) refuses with NO adapter call", async () => {
		const { env, instances } = makeEnv();
		await saveEmailWorkerConnection(env, { userId: "user-1", endpoint: EP, secret: SECRET });
		await saveEmailWorkerConnection(env, { userId: "user-1", endpoint: "https://other.example.com", secret: "other-secret" });
		instances.set("inst-1", JSON.stringify({}));
		const ctx = { env, userId: "user-1", instanceId: "inst-1" } as unknown as RegistryToolCtx;

		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const res = await tool("email_worker_send")(ctx, { to: "x@example.com", subject: "s", body: "b" });
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/not set to use one of them/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("wrong instance pin (stale — pinned connection was revoked) refuses with NO adapter call", async () => {
		const { env, instances } = makeEnv();
		await saveEmailWorkerConnection(env, { userId: "user-1", endpoint: EP, secret: SECRET });
		instances.set("inst-1", JSON.stringify({ emailWorkerAccount: { endpoint: "https://gone.example.com", accountId: "" } }));
		const ctx = { env, userId: "user-1", instanceId: "inst-1" } as unknown as RegistryToolCtx;

		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const res = await tool("email_worker_send")(ctx, { to: "x@example.com", subject: "s", body: "b" });
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/no longer connected/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("not connected at all refuses with NO adapter call", async () => {
		const { env } = makeEnv();
		const ctx = { env, userId: "user-1", instanceId: "inst-1" } as unknown as RegistryToolCtx;
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const res = await tool("email_worker_send")(ctx, { to: "x@example.com", subject: "s", body: "b" });
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/no worker-backed email connection is configured/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("adapter failure (bad secret, HTTP 401) is reported distinctly from a refusal, and only AFTER the pin resolved", async () => {
		vi.stubGlobal("fetch", createEmailWorkerFixture({ secret: "a-different-secret" }));
		const { ctx, events } = await seededCtx();
		const res = await tool("email_worker_send")(ctx, { to: "x@example.com", subject: "s", body: "b" });
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/rejected this connection's secret/);
		const receipt = events.find((e) => e.event === "email.send");
		expect(receipt?.context.outcome).toBe("adapter_error");
		expect(receipt?.context.failureClass).toBe("auth");
	});

	it("a 5xx is classified transient and does not leave the owner guessing at auth", async () => {
		vi.stubGlobal("fetch", createEmailWorkerFixture({ secret: SECRET, forceServerError: true }));
		const { ctx, events } = await seededCtx();
		const res = await tool("email_worker_send")(ctx, { to: "x@example.com", subject: "s", body: "b" });
		expect(res.success).toBe(false);
		const receipt = events.find((e) => e.event === "email.send");
		expect(receipt?.context.failureClass).toBe("transient");
	});
});

describe("idempotent send retry (AC5)", () => {
	it("retries a transient 5xx exactly once, reusing the SAME idempotencyKey", async () => {
		let calls = 0;
		const keys: string[] = [];
		vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
			calls++;
			const req = input instanceof Request ? input : new Request(input, init);
			const body = (await req.clone().json()) as { idempotencyKey?: string };
			if (body.idempotencyKey) keys.push(body.idempotencyKey);
			if (calls === 1) return new Response(JSON.stringify({ error: { code: "internal", message: "flaky" } }), { status: 500 });
			return Response.json({ id: "msg-retried", threadId: "t-retried" });
		});
		const { ctx } = await seededCtx();
		const res = await tool("email_worker_send")(ctx, { to: "x@example.com", subject: "s", body: "b" });
		expect(res.success).toBe(true);
		expect(calls).toBe(2);
		expect(keys).toHaveLength(2);
		expect(keys[0]).toBe(keys[1]);
	});

	it("never retries a 4xx — that is the adapter's considered refusal, not a transient blip", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return new Response(JSON.stringify({ error: { code: "invalid_recipient", message: "bad address" } }), { status: 422 });
		});
		const { ctx } = await seededCtx();
		const res = await tool("email_worker_send")(ctx, { to: "not-an-address", subject: "s", body: "b" });
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/bad address/);
		expect(calls).toBe(1);
	});
});

describe("connector declaration", () => {
	it("takes no endpoint/secret argument on any tool — never shown to the model", () => {
		for (const t of EMAIL_WORKER_CONNECTOR.tools) {
			expect(Object.keys(t.jsonSchema.properties)).not.toContain("endpoint");
			expect(Object.keys(t.jsonSchema.properties)).not.toContain("secret");
		}
	});
});
