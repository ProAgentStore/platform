/**
 * An emailed Word form in the file store (#756, #764).
 *
 * #764's one decision-independent criterion: whatever is decided about Word forms, an agent handed a
 * `.doc` is never met with silence. The refusal was written at upload (#763) but `read_file` — the
 * tool the model actually calls — dropped it for a generic "not readable as text". These tests drive
 * the real `upload_file` → `read_file` path over a byte-faithful R2, so they also pin that a binary
 * upload lands byte-for-byte.
 */
import { describe, expect, it, vi } from "vitest";
import { executeStorageTool } from "./storage-tools.js";
import { AgentStorageEngine } from "../agent-storage.js";
import type { FileMeta } from "../agent-storage-types.js";
import type { Env } from "../types.js";

function mockDoStorage() {
	const store = new Map<string, unknown>();
	return {
		get: vi.fn(async <T>(key: string) => (store.get(key) as T) ?? null),
		put: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
		delete: vi.fn(async (k: string | string[]) => { for (const x of Array.isArray(k) ? k : [k]) store.delete(x); return true; }),
		list: vi.fn(async <T>(opts?: { prefix?: string }) => new Map([...store.entries()].filter(([k]) => !opts?.prefix || k.startsWith(opts.prefix))) as Map<string, T>),
	};
}

/** R2 that keeps the exact bytes it was given — one bucket may be shared by several agents' engines. */
function byteR2() {
	const objects = new Map<string, Uint8Array>();
	const bytesOf = (data: unknown) => (typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer).slice());
	return {
		objects,
		put: vi.fn(async (key: string, data: unknown) => { objects.set(key, bytesOf(data)); return {}; }),
		head: vi.fn(async (key: string) => (objects.has(key) ? { size: objects.get(key)!.length } : null)),
		get: vi.fn(async (key: string) => {
			const b = objects.get(key);
			return b ? { body: new Blob([b]).stream(), arrayBuffer: async () => b.slice().buffer } : null;
		}),
		delete: vi.fn(async () => undefined),
	};
}

function engine(agentId: string, r2 = byteR2()) {
	const storage = mockDoStorage();
	return { engine: new AgentStorageEngine(storage as never, r2 as never, null, null, agentId, null), storage, r2 };
}

const call = (e: AgentStorageEngine, name: string, input: Record<string, unknown>) =>
	executeStorageTool({ name, input }, e, { env: {} as unknown as Env, agentId: "agent-1", userId: "u1" });

/** An OLE2 header followed by every byte value — base64 of this carries `+`, `/` and padding. */
const DOC_BYTES = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...Array.from({ length: 256 }, (_, i) => i), 0xfb, 0xff]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const storedId = (content: string) => /\(([0-9a-f-]{36}),/.exec(content)![1];

describe("an emailed .doc in the file store (#756, #764)", () => {
	it("upload_file with content_base64 stores the exact bytes, typed application/msword", async () => {
		const { engine: e, r2 } = engine("agent-1");
		const res = await call(e, "upload_file", { name: "Junior Comp Entry Form.doc", content_base64: b64(DOC_BYTES) });
		expect(res.success).toBe(true);
		expect(res.content).toContain(`${DOC_BYTES.length} bytes`);
		const [key, bytes] = [...r2.objects.entries()][0];
		expect(key).toMatch(/^agents\/agent-1\/files\//);
		expect(bytes).toEqual(DOC_BYTES);
		const meta = (await e.fileList())[0];
		expect(meta).toMatchObject({ mimeType: "application/msword", size: DOC_BYTES.length, extractionStatus: "unsupported" });
	});

	it("read_file on it names the format, says it cannot be read, and offers the next step — never a bare 'not readable'", async () => {
		const { engine: e } = engine("agent-1");
		const id = storedId((await call(e, "upload_file", { name: "Junior Comp Entry Form.doc", content_base64: b64(DOC_BYTES) })).content);
		const res = await call(e, "read_file", { id });
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/Junior Comp Entry Form\.doc/);
		expect(res.content).toMatch(/legacy Word \(\.doc\)/);
		expect(res.content).toMatch(/cannot be read/);
		expect(res.content).toMatch(/\.docx or PDF/);
		expect(res.content).toMatch(/build_answer_sheet/);
		expect(res.content).not.toMatch(/not readable as text/);
	});

	it("a binary file with no recorded reason keeps the generic refusal", async () => {
		const { engine: e, storage } = engine("agent-1");
		const id = storedId((await call(e, "upload_file", { name: "photo.png", content_base64: b64(DOC_BYTES) })).content);
		expect(((await storage.get(`file:${id}`)) as FileMeta).extractionError).toBeUndefined();
		const res = await call(e, "read_file", { id });
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/photo\.png is image\/png and has no extracted text — its content is not readable as text/);
	});

	it("another agent sharing the bucket cannot read the file by its id", async () => {
		const shared = byteR2();
		const { engine: mine } = engine("agent-1", shared);
		const { engine: theirs } = engine("agent-2", shared);
		const id = storedId((await call(mine, "upload_file", { name: "form.doc", content_base64: b64(DOC_BYTES) })).content);
		const res = await call(theirs, "read_file", { id });
		expect(res.success).toBe(false);
		expect(res.content).toBe(`File not found: ${id}`);
		expect(res.content).not.toMatch(/Word/);
	});
});
