import { describe, expect, it } from "vitest";
import type { AgentStorageEngine } from "./agent-storage.js";
import * as routes from "./agent-do-storage-routes.js";

/** A fake of just the engine methods one route touches — these routes need nothing else. */
function fakeEngine<K extends keyof AgentStorageEngine>(
	impl: Record<string, unknown>,
): Pick<AgentStorageEngine, K> {
	return impl as unknown as Pick<AgentStorageEngine, K>;
}

const post = (body: unknown) =>
	new Request("https://agent/x", { method: "POST", body: JSON.stringify(body) });

describe("collections routes", () => {
	it("lists collections under a `collections` key", async () => {
		const res = await routes.listCollections(
			fakeEngine<"collectionList">({ collectionList: async () => [{ name: "jobs" }] }),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ collections: [{ name: "jobs" }] });
	});

	it("rejects a create with no name or fields, without calling the engine", async () => {
		let called = false;
		const engine = fakeEngine<"collectionCreate">({
			collectionCreate: async () => {
				called = true;
				return {};
			},
		});
		expect((await routes.createCollection(engine, post({ fields: [] }))).status).toBe(400);
		expect((await routes.createCollection(engine, post({ name: "x" }))).status).toBe(400);
		expect(called).toBe(false);
	});

	it("creates a collection with 201", async () => {
		const res = await routes.createCollection(
			fakeEngine<"collectionCreate">({
				collectionCreate: async (name: string) => ({ name, fields: [] }),
			}),
			post({ name: "jobs", fields: [{ name: "company", type: "string" }] }),
		);
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ name: "jobs" });
	});

	it("decodes the collection name out of the path, and 404s an unknown one", async () => {
		const seen: string[] = [];
		const engine = fakeEngine<"collectionGet">({
			collectionGet: async (name: string) => {
				seen.push(name);
				return name === "my jobs" ? { name } : null;
			},
		});
		expect((await routes.getCollection(engine, "my%20jobs")).status).toBe(200);
		expect((await routes.getCollection(engine, "nope")).status).toBe(404);
		expect(seen).toEqual(["my jobs", "nope"]);
	});
});

describe("record routes", () => {
	it("parses the `where` filter and defaults limit/offset", async () => {
		let opts: Record<string, unknown> = {};
		const res = await routes.queryRecords(
			fakeEngine<"recordQuery">({
				recordQuery: async (_c: string, o: Record<string, unknown>) => {
					opts = o;
					return { records: [], total: 0 };
				},
			}),
			"jobs",
			new URL('https://agent/collections/jobs/records?where={"status":"queued"}'),
		);
		expect(res.status).toBe(200);
		expect(opts).toEqual({
			where: { status: "queued" },
			orderBy: undefined,
			orderDir: undefined,
			limit: 50,
			offset: 0,
		});
	});

	it("propagates a malformed `where` as a throw (the DO's catch turns it into a 500)", async () => {
		await expect(
			routes.queryRecords(
				fakeEngine<"recordQuery">({ recordQuery: async () => ({ records: [], total: 0 }) }),
				"jobs",
				new URL("https://agent/collections/jobs/records?where=not-json"),
			),
		).rejects.toThrow();
	});

	it("requires `data` on insert and update", async () => {
		const insert = fakeEngine<"recordInsert">({ recordInsert: async () => ({ id: "1" }) });
		const update = fakeEngine<"recordUpdate">({ recordUpdate: async () => ({ id: "1" }) });
		expect((await routes.insertRecord(insert, "jobs", post({}))).status).toBe(400);
		expect((await routes.updateRecord(update, "jobs", "1", post({}))).status).toBe(400);
	});

	it("inserts with 201 and 404s an update/get/delete of a missing record", async () => {
		expect(
			(await routes.insertRecord(
				fakeEngine<"recordInsert">({ recordInsert: async () => ({ id: "1" }) }),
				"jobs",
				post({ data: { company: "Acme" } }),
			)).status,
		).toBe(201);
		expect(
			(await routes.getRecord(
				fakeEngine<"recordGet">({ recordGet: async () => null }),
				"jobs",
				"1",
			)).status,
		).toBe(404);
		expect(
			(await routes.updateRecord(
				fakeEngine<"recordUpdate">({ recordUpdate: async () => null }),
				"jobs",
				"1",
				post({ data: {} }),
			)).status,
		).toBe(404);
		expect(
			(await routes.deleteRecord(
				fakeEngine<"recordDelete">({ recordDelete: async () => false }),
				"jobs",
				"1",
			)).status,
		).toBe(404);
	});

	it("decodes both the collection and the record id", async () => {
		let seen: string[] = [];
		await routes.getRecord(
			fakeEngine<"recordGet">({
				recordGet: async (c: string, id: string) => {
					seen = [c, id];
					return null;
				},
			}),
			"my%20jobs",
			"a%2Fb",
		);
		expect(seen).toEqual(["my jobs", "a/b"]);
	});
});

describe("file routes", () => {
	it("drops an empty tags param rather than filtering on ['']", async () => {
		let opts: Record<string, unknown> = {};
		await routes.listFiles(
			fakeEngine<"fileList">({
				fileList: async (o: Record<string, unknown>) => {
					opts = o;
					return [];
				},
			}),
			new URL("https://agent/files?tags=&user_id=u1"),
		);
		expect(opts).toEqual({ userId: "u1", tags: undefined, mimeType: undefined });
	});

	it("requires a name and some content", async () => {
		const engine = fakeEngine<"fileUpload">({ fileUpload: async () => ({ id: "f1" }) });
		expect((await routes.uploadFile(engine, post({ content: "hi" }))).status).toBe(400);
		expect((await routes.uploadFile(engine, post({ name: "a.txt" }))).status).toBe(400);
	});

	it("decodes base64 uploads to bytes and defaults mime + text extraction", async () => {
		let opts: Record<string, unknown> = {};
		const res = await routes.uploadFile(
			fakeEngine<"fileUpload">({
				fileUpload: async (o: Record<string, unknown>) => {
					opts = o;
					return { id: "f1" };
				},
			}),
			post({ name: "a.bin", content: "", contentBase64: btoa("hello") }),
		);
		expect(res.status).toBe(201);
		expect(opts.mimeType).toBe("text/plain");
		expect(opts.extractText).toBe(true);
		expect(new TextDecoder().decode(opts.data as ArrayBuffer)).toBe("hello");
	});

	it("honours extract_text:false", async () => {
		let opts: Record<string, unknown> = {};
		await routes.uploadFile(
			fakeEngine<"fileUpload">({
				fileUpload: async (o: Record<string, unknown>) => {
					opts = o;
					return { id: "f1" };
				},
			}),
			post({ name: "a.txt", content: "hi", extract_text: false }),
		);
		expect(opts.extractText).toBe(false);
	});

	it("register requires id/name/r2_key and 404s an object that isn't in R2", async () => {
		expect(
			(await routes.registerFile(
				fakeEngine<"fileRegister">({ fileRegister: async () => null }),
				post({ id: "1", name: "a" }),
			)).status,
		).toBe(400);
		expect(
			(await routes.registerFile(
				fakeEngine<"fileRegister">({ fileRegister: async () => null }),
				post({ id: "1", name: "a", r2_key: "k" }),
			)).status,
		).toBe(404);
	});

	it("streams a file with its metadata in headers", async () => {
		const res = await routes.getFile(
			fakeEngine<"fileGet">({
				fileGet: async () => ({
					meta: { id: "f1", name: "cv.pdf", size: 12, tags: ["resume"], mimeType: "application/pdf" },
					body: new Response("x").body,
				}),
			}),
			"f1",
		);
		expect(res.headers.get("Content-Type")).toBe("application/pdf");
		expect(res.headers.get("Content-Disposition")).toBe('inline; filename="cv.pdf"');
		expect(JSON.parse(res.headers.get("X-File-Meta") || "{}")).toEqual({
			id: "f1",
			name: "cv.pdf",
			size: 12,
			tags: ["resume"],
		});
	});

	it("404s a missing file on read and delete", async () => {
		expect(
			(await routes.getFile(fakeEngine<"fileGet">({ fileGet: async () => null }), "f1")).status,
		).toBe(404);
		expect(
			(await routes.deleteFile(fakeEngine<"fileDelete">({ fileDelete: async () => false }), "f1"))
				.status,
		).toBe(404);
	});
});

describe("search, activity, summaries, context", () => {
	it("requires a query and defaults top_k to 5", async () => {
		const args: unknown[] = [];
		const engine = fakeEngine<"vectorSearch">({
			vectorSearch: async (...a: unknown[]) => {
				args.push(...a);
				return [];
			},
		});
		expect((await routes.vectorSearch(engine, post({}))).status).toBe(400);
		expect(args).toHaveLength(0);
		await routes.vectorSearch(engine, post({ query: "hi" }));
		expect(args[0]).toBe("hi");
		expect(args[1]).toBe(5);
	});

	it("defaults activity limit to 50 and summaries limit to 20", async () => {
		let activityOpts: Record<string, unknown> = {};
		await routes.getActivity(
			fakeEngine<"getEvents">({
				getEvents: async (o: Record<string, unknown>) => {
					activityOpts = o;
					return [];
				},
			}),
			new URL("https://agent/activity"),
		);
		expect(activityOpts.limit).toBe(50);

		let summaryLimit = 0;
		await routes.getSummaries(
			fakeEngine<"getSummaries">({
				getSummaries: async (n: number) => {
					summaryLimit = n;
					return [];
				},
			}),
			new URL("https://agent/summaries"),
		);
		expect(summaryLimit).toBe(20);
	});

	it("says so plainly when there isn't enough conversation to summarize", async () => {
		const res = await routes.forceSummarize(
			fakeEngine<"maybeSummarize">({ maybeSummarize: async () => null }),
			"claude-sonnet-4-6",
		);
		expect(await res.json()).toEqual({ message: "Not enough messages to summarize" });
	});

	it("passes the agent's model through to the summarizer", async () => {
		let model = "";
		await routes.forceSummarize(
			fakeEngine<"maybeSummarize">({
				maybeSummarize: async (m: string) => {
					model = m;
					return { id: "s1" };
				},
			}),
			"claude-sonnet-4-6",
		);
		expect(model).toBe("claude-sonnet-4-6");
	});

	it("decodes the user id for per-user context", async () => {
		let seen = "";
		await routes.getUserContext(
			fakeEngine<"getUserContext">({
				getUserContext: async (u: string) => {
					seen = u;
					return { userId: u };
				},
			}),
			"user%40example.com",
		);
		expect(seen).toBe("user@example.com");
	});
});
