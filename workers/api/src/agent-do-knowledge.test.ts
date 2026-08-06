import { beforeEach, describe, expect, it, vi } from "vitest";

const safeFetch = vi.fn();
vi.mock("./lib/ssrf.js", async (orig) => ({
	...(await orig<typeof import("./lib/ssrf.js")>()),
	safeFetch: (...a: unknown[]) => safeFetch(...a),
}));

import {
	addKnowledge,
	deleteKnowledge,
	getKnowledge,
	ingestUrl,
	readKnowledge,
	updateKnowledge,
	type KnowledgeCtx,
	type KnowledgeEngine,
	type KnowledgeStore,
} from "./agent-do-knowledge.js";
import type { Env } from "./types.js";

/** In-memory stand-in for the DO's storage — the same surface KnowledgeStore declares. */
function memStore(): KnowledgeStore & { map: Map<string, unknown> } {
	const map = new Map<string, unknown>();
	return {
		map,
		async get<T>(key: string) {
			return map.get(key) as T | undefined;
		},
		async put(key: string, value: unknown) {
			map.set(key, value);
		},
		async delete(keyOrKeys: string | string[]) {
			for (const k of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) map.delete(k);
			return true;
		},
		async list<T>(opts?: { prefix?: string }) {
			const out = new Map<string, T>();
			for (const [k, v] of map) if (!opts?.prefix || k.startsWith(opts.prefix)) out.set(k, v as T);
			return out;
		},
	};
}

interface EngineSpy {
	engine: KnowledgeEngine;
	stored: Array<[string, string, string]>;
	deleted: string[];
	events: Array<[string, Record<string, unknown>]>;
}

function spyEngine(opts: {
	indexingEnabled?: boolean;
	storeFails?: boolean;
	deleteFails?: boolean;
} = {}): EngineSpy {
	const stored: Array<[string, string, string]> = [];
	const deleted: string[] = [];
	const events: Array<[string, Record<string, unknown>]> = [];
	const engine = {
		indexingEnabled: opts.indexingEnabled !== false,
		async vectorizeStore(type: string, id: string, text: string) {
			if (opts.storeFails) throw new Error("vectorize down");
			stored.push([type, id, text]);
		},
		async vectorDelete(_type: string, id: string) {
			if (opts.deleteFails) throw new Error("vectorize down");
			deleted.push(id);
		},
		async logEvent(type: string, _userId: unknown, data: Record<string, unknown>) {
			events.push([type, data]);
		},
	} as unknown as KnowledgeEngine;
	return { engine, stored, deleted, events };
}

/** logError/logEvent write to D1; a no-op DB keeps the failure paths quiet in tests. */
const env = {
	DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) },
} as unknown as Env;

function ctxFor(
	storage: KnowledgeStore,
	engine: KnowledgeEngine | null,
): KnowledgeCtx {
	return {
		storage,
		env,
		resolve: async () => (engine ? { agentId: "agent-1", engine } : null),
	};
}

const post = (body: unknown) =>
	new Request("https://agent/knowledge", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
	safeFetch.mockReset();
});

describe("addKnowledge", () => {
	it("requires a title but allows empty content (title-first drafts)", async () => {
		const store = memStore();
		const spy = spyEngine();
		expect((await addKnowledge(ctxFor(store, spy.engine), post({ content: "x" }))).status).toBe(400);
		const res = await addKnowledge(ctxFor(store, spy.engine), post({ title: "Notes" }));
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ title: "Notes", content: "", vectorized: true });
	});

	it("rejects a document over 100KB", async () => {
		const store = memStore();
		const res = await addKnowledge(
			ctxFor(store, spyEngine().engine),
			post({ title: "big", content: "x".repeat(100_001) }),
		);
		expect(res.status).toBe(400);
		expect(store.map.size).toBe(0);
	});

	it("caps the knowledge base at 20 documents", async () => {
		const store = memStore();
		for (let i = 0; i < 20; i++) store.map.set(`kb:${i}`, { id: String(i) });
		const res = await addKnowledge(ctxFor(store, spyEngine().engine), post({ title: "21st" }));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Knowledge base full (max 20 documents)" });
	});

	it("indexes the document and logs the event", async () => {
		const store = memStore();
		const spy = spyEngine();
		const doc = (await (
			await addKnowledge(ctxFor(store, spy.engine), post({ title: "CV", content: "hire me" }))
		).json()) as { id: string };
		expect(spy.stored).toEqual([["knowledge", doc.id, "CV\n\nhire me"]]);
		expect(spy.events[0][0]).toBe("knowledge.added");
		expect(spy.events[0][1]).toMatchObject({ vectorized: true });
	});

	it("saves the doc but reports vectorized:false when indexing is off (#22)", async () => {
		const store = memStore();
		const spy = spyEngine({ indexingEnabled: false });
		const res = await addKnowledge(ctxFor(store, spy.engine), post({ title: "CV", content: "x" }));
		expect(await res.json()).toMatchObject({ vectorized: false });
		expect(store.map.size).toBe(1); // the document itself is kept
		expect(spy.stored).toEqual([]);
	});

	it("saves the doc but reports vectorized:false when the index throws", async () => {
		const store = memStore();
		const spy = spyEngine({ storeFails: true });
		const res = await addKnowledge(ctxFor(store, spy.engine), post({ title: "CV", content: "x" }));
		expect(await res.json()).toMatchObject({ vectorized: false });
		expect(store.map.size).toBe(1);
		expect(spy.events[0][1]).toMatchObject({ vectorized: false });
	});
});

describe("readKnowledge / getKnowledge", () => {
	it("lists what's stored and reads one document back by id", async () => {
		const store = memStore();
		store.map.set("kb:a b", { id: "a b", title: "One" });
		store.map.set("mem:x", { key: "x" }); // a different prefix must not leak in
		expect(await (await getKnowledge(ctxFor(store, null))).json()).toEqual({
			documents: [{ id: "a b", title: "One" }],
		});
		const res = await readKnowledge(ctxFor(store, null), "a%20b");
		expect(await res.json()).toEqual({ document: { id: "a b", title: "One" } });
		expect((await readKnowledge(ctxFor(store, null), "missing")).status).toBe(404);
	});
});

describe("updateKnowledge", () => {
	it("404s an unknown document and rejects an oversized body", async () => {
		const store = memStore();
		expect((await updateKnowledge(ctxFor(store, null), "nope", post({}))).status).toBe(404);
		store.map.set("kb:1", { id: "1", title: "T", content: "c" });
		expect(
			(await updateKnowledge(ctxFor(store, null), "1", post({ content: "x".repeat(100_001) })))
				.status,
		).toBe(400);
	});

	it("keeps the old title when the new one is blank, and re-indexes (delete then store)", async () => {
		const store = memStore();
		store.map.set("kb:1", { id: "1", title: "Original", content: "old" });
		const spy = spyEngine();
		const res = await updateKnowledge(
			ctxFor(store, spy.engine),
			"1",
			post({ title: "   ", content: "new" }),
		);
		expect(await res.json()).toMatchObject({ title: "Original", content: "new", vectorized: true });
		expect(spy.deleted).toEqual(["1"]);
		expect(spy.stored).toEqual([["knowledge", "1", "Original\n\nnew"]]);
	});

	it("reports vectorized:false when indexing is off (#22)", async () => {
		const store = memStore();
		store.map.set("kb:1", { id: "1", title: "T", content: "c" });
		const spy = spyEngine({ indexingEnabled: false });
		const res = await updateKnowledge(ctxFor(store, spy.engine), "1", post({ content: "new" }));
		expect(await res.json()).toMatchObject({ vectorized: false });
		expect(spy.stored).toEqual([]);
	});
});

describe("deleteKnowledge (#242 — vectors first)", () => {
	it("removes the vectors before the record", async () => {
		const store = memStore();
		store.map.set("kb:1", { id: "1" });
		const spy = spyEngine();
		const res = await deleteKnowledge(ctxFor(store, spy.engine), "1");
		expect(res.status).toBe(200);
		expect(spy.deleted).toEqual(["1"]);
		expect(store.map.has("kb:1")).toBe(false);
		expect(spy.events[0][0]).toBe("knowledge.removed");
	});

	it("KEEPS the document when its vectors can't be removed, so the user can retry", async () => {
		const store = memStore();
		store.map.set("kb:1", { id: "1" });
		const spy = spyEngine({ deleteFails: true });
		const res = await deleteKnowledge(ctxFor(store, spy.engine), "1");
		expect(res.status).toBe(503);
		expect(store.map.has("kb:1")).toBe(true);
	});

	it("just drops the record when the DO was never initialised (no index to reconcile)", async () => {
		const store = memStore();
		store.map.set("kb:1", { id: "1" });
		const res = await deleteKnowledge(ctxFor(store, null), "1");
		expect(res.status).toBe(200);
		expect(store.map.has("kb:1")).toBe(false);
	});
});

describe("ingestUrl", () => {
	it("requires a url and shares the 20-document ceiling", async () => {
		const store = memStore();
		expect((await ingestUrl(ctxFor(store, null), post({}))).status).toBe(400);
		for (let i = 0; i < 20; i++) store.map.set(`kb:${i}`, { id: String(i) });
		const res = await ingestUrl(ctxFor(store, null), post({ url: "https://example.com" }));
		expect(await res.json()).toEqual({ error: "Knowledge base full (max 20 documents)" });
		expect(safeFetch).not.toHaveBeenCalled();
	});

	it("strips scripts/styles/markup from HTML and indexes the text", async () => {
		const store = memStore();
		const spy = spyEngine();
		safeFetch.mockResolvedValue(
			new Response("<html><script>evil()</script><style>a{}</style><p>Hello  world</p></html>", {
				headers: { "content-type": "text/html" },
			}),
		);
		const res = await ingestUrl(
			ctxFor(store, spy.engine),
			post({ url: "https://example.com/about" }),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { title: string; content: string; vectorized: boolean };
		expect(body.title).toBe("example.com"); // defaults to the hostname
		expect(body.content).toBe("Hello world");
		expect(body.vectorized).toBe(true);
		expect(spy.stored[0][2]).toBe("example.com\n\nHello world");
	});

	it("truncates a huge page to 50KB", async () => {
		const store = memStore();
		safeFetch.mockResolvedValue(new Response("z".repeat(60_000)));
		const res = await ingestUrl(ctxFor(store, null), post({ url: "https://example.com" }));
		const body = (await res.json()) as { content: string };
		expect(body.content.endsWith("\n...[truncated]")).toBe(true);
		expect(body.content.length).toBe(50_000 + "\n...[truncated]".length);
	});

	it("reports a blocked or failing fetch as a 400 and stores nothing", async () => {
		const store = memStore();
		safeFetch.mockRejectedValueOnce(new Error("blocked: private address"));
		expect(
			(await ingestUrl(ctxFor(store, null), post({ url: "https://127.0.0.1" }))).status,
		).toBe(400);
		safeFetch.mockResolvedValueOnce(new Response("nope", { status: 404 }));
		expect((await ingestUrl(ctxFor(store, null), post({ url: "https://example.com" }))).status).toBe(
			400,
		);
		expect(store.map.size).toBe(0);
	});

	it("saves the page but reports vectorized:false when the index throws", async () => {
		const store = memStore();
		const spy = spyEngine({ storeFails: true });
		safeFetch.mockResolvedValue(new Response("plain text"));
		const res = await ingestUrl(ctxFor(store, spy.engine), post({ url: "https://example.com" }));
		expect(await res.json()).toMatchObject({ vectorized: false });
		expect(store.map.size).toBe(1);
	});
});
