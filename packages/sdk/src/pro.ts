import type { AiClient } from "./ai.js";
import type { DbClient } from "./db.js";
import type { StorageClient } from "./storage.js";
import type { SubscriptionClient } from "./subscription.js";
import type { UsageClient } from "./usage.js";

export interface ProAgentConfig {
	agentId: string;
	token: string;
	apiBase?: string;
}

export interface ProAgentStore {
	readonly agentId: string;
	readonly ai: AiClient;
	readonly db: DbClient;
	readonly storage: StorageClient;
	readonly subscription: SubscriptionClient;
	readonly usage: UsageClient;
	/** Send a chat message to this agent. */
	chat(message: string): Promise<{ response: string }>;
	/** Get conversation history. */
	messages(limit?: number): Promise<unknown[]>;
	/** Get/set agent memory. */
	memory: {
		list(): Promise<unknown[]>;
		set(key: string, type: string, content: string): Promise<void>;
		delete(key: string): Promise<void>;
	};
	/** Get/create/update tasks. */
	tasks: {
		list(): Promise<unknown[]>;
		create(title: string, description?: string): Promise<unknown>;
		update(id: string, status: string): Promise<void>;
	};
}

const DEFAULT_API = "https://api.proagentstore.online";

export function initPro(config: ProAgentConfig): ProAgentStore {
	const base = config.apiBase || DEFAULT_API;
	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${config.token}`,
	};

	async function api<T>(path: string, opts?: RequestInit): Promise<T> {
		const res = await fetch(`${base}${path}`, {
			...opts,
			headers: { ...headers, ...opts?.headers },
		});
		if (!res.ok) {
			const body = (await res
				.json()
				.catch(() => ({ error: res.statusText }))) as { error?: string };
			throw new Error(body.error || `API error ${res.status}`);
		}
		return res.json() as Promise<T>;
	}

	const agentId = config.agentId;

	const ai: AiClient = {
		async run(model, input) {
			const result = await api<{ result: unknown }>(
				`/v1/agents/${agentId}/run`,
				{
					method: "POST",
					body: JSON.stringify({ input: { ...input, model } }),
				},
			);
			return result.result;
		},
		async embed(model, text) {
			const input = Array.isArray(text) ? { text } : { text: [text] };
			const result = await api<{ result: { data: number[][] } }>(
				`/v1/agents/${agentId}/run`,
				{
					method: "POST",
					body: JSON.stringify({ input: { ...input, model } }),
				},
			);
			return result.result.data;
		},
	};

	const db: DbClient = {
		async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
			// D1 queries go through the agent's DO — not exposed via REST yet
			throw new Error(
				"Direct D1 queries not yet supported via SDK. Use the agent API.",
			);
		},
		async execute(_sql: string, _params?: unknown[]) {
			throw new Error(
				"Direct D1 queries not yet supported via SDK. Use the agent API.",
			);
		},
		async batch(_statements) {
			throw new Error(
				"Direct D1 queries not yet supported via SDK. Use the agent API.",
			);
		},
	};

	const storage: StorageClient = {
		async put(key, data) {
			// R2 operations go through the agent's DO
			await api(`/v1/agents/${agentId}/memory`, {
				method: "PUT",
				body: JSON.stringify({
					key: `file:${key}`,
					type: "context",
					content: String(data),
				}),
			});
		},
		async get(key) {
			const mem = await api<{
				memory: Array<{ key: string; content: string }>;
			}>(`/v1/agents/${agentId}/memory`);
			const entry = mem.memory.find((m) => m.key === `file:${key}`);
			return entry
				? new ReadableStream({
						start(c) {
							c.enqueue(new TextEncoder().encode(entry.content));
							c.close();
						},
					})
				: null;
		},
		async delete(key) {
			await fetch(
				`${base}/v1/agents/${agentId}/memory/file:${encodeURIComponent(key)}`,
				{
					method: "DELETE",
					headers,
				},
			);
		},
		async list(prefix) {
			const mem = await api<{
				memory: Array<{ key: string; content: string; updatedAt: string }>;
			}>(`/v1/agents/${agentId}/memory`);
			return mem.memory
				.filter(
					(m) =>
						m.key.startsWith("file:") &&
						(!prefix || m.key.startsWith(`file:${prefix}`)),
				)
				.map((m) => ({
					key: m.key.replace("file:", ""),
					size: m.content.length,
					uploaded: m.updatedAt,
				}));
		},
	};

	const subscription: SubscriptionClient = {
		async checkout() {
			return api("/v1/billing/checkout", { method: "POST" });
		},
		async portal() {
			return api("/v1/billing/portal", { method: "POST" });
		},
		async status() {
			return api("/v1/billing/status");
		},
	};

	const usage: UsageClient = {
		async track(event, metadata) {
			await api(`/v1/agents/${agentId}/run`, {
				method: "POST",
				body: JSON.stringify({ input: { event, metadata } }),
			});
		},
	};

	return {
		agentId,
		ai,
		db,
		storage,
		subscription,
		usage,
		async chat(message: string) {
			const res = await api<{ message: { content: string } }>(
				`/v1/agents/${agentId}/chat`,
				{
					method: "POST",
					body: JSON.stringify({ message }),
				},
			);
			return { response: res.message.content };
		},
		async messages(limit = 50) {
			const res = await api<{ messages: unknown[] }>(
				`/v1/agents/${agentId}/messages?limit=${limit}`,
			);
			return res.messages;
		},
		memory: {
			async list() {
				const res = await api<{ memory: unknown[] }>(
					`/v1/agents/${agentId}/memory`,
				);
				return res.memory;
			},
			async set(key, type, content) {
				await api(`/v1/agents/${agentId}/memory`, {
					method: "PUT",
					body: JSON.stringify({ key, type, content }),
				});
			},
			async delete(key) {
				await fetch(
					`${base}/v1/agents/${agentId}/memory/${encodeURIComponent(key)}`,
					{
						method: "DELETE",
						headers,
					},
				);
			},
		},
		tasks: {
			async list() {
				const res = await api<{ tasks: unknown[] }>(
					`/v1/agents/${agentId}/tasks`,
				);
				return res.tasks;
			},
			async create(title, description) {
				return api(`/v1/agents/${agentId}/tasks`, {
					method: "POST",
					body: JSON.stringify({ title, description }),
				});
			},
			async update(id, status) {
				await api(`/v1/agents/${agentId}/tasks/${id}`, {
					method: "PUT",
					body: JSON.stringify({ status }),
				});
			},
		},
	};
}
