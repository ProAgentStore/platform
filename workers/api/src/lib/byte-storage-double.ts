/**
 * Test doubles for the file store that keep the EXACT bytes they are given — for tests whose claim is
 * file integrity (#762, #764). A real `AgentStorageEngine` over an in-memory DO storage and an R2
 * that stores a copy of every byte; several engines may share one bucket, as agents share R2.
 */
import { AgentStorageEngine } from "../agent-storage.js";

export function memoryDoStorage() {
	const store = new Map<string, unknown>();
	return {
		get: async <T>(key: string) => (store.get(key) as T) ?? null,
		put: async (key: string, value: unknown) => { store.set(key, value); },
		delete: async (k: string | string[]) => { for (const x of Array.isArray(k) ? k : [k]) store.delete(x); return true; },
		list: async <T>(opts?: { prefix?: string }) => new Map([...store.entries()].filter(([k]) => !opts?.prefix || k.startsWith(opts.prefix))) as Map<string, T>,
	};
}

export function byteR2() {
	const objects = new Map<string, Uint8Array>();
	const bytesOf = (data: unknown) => (typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer).slice());
	return {
		objects,
		put: async (key: string, data: unknown) => { objects.set(key, bytesOf(data)); return {}; },
		head: async (key: string) => (objects.has(key) ? { size: objects.get(key)!.length } : null),
		get: async (key: string) => {
			const b = objects.get(key);
			return b ? { body: new Blob([b]).stream(), arrayBuffer: async () => b.slice().buffer } : null;
		},
		delete: async (key: string) => { objects.delete(key); },
	};
}

export function byteEngine(agentId: string, r2 = byteR2()) {
	const storage = memoryDoStorage();
	return { engine: new AgentStorageEngine(storage as never, r2 as never, null, null, agentId, null), storage, r2 };
}
