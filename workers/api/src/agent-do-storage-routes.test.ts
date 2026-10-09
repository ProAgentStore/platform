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

	it("returns an existing job lead unchanged instead of creating a second work item", async () => {
		const existing = { id: "lead-1", data: { status: "blocked", lifecycle: [{ at: "earlier" }], work_key: "seek:94872937" } };
		const res = await routes.insertRecord(
			fakeEngine<"recordInsert" | "recordCreateOrGetJobLead">({
				recordInsert: async () => { throw new Error("must not insert a duplicate"); },
				recordCreateOrGetJobLead: async () => ({ record: existing, created: false }),
			}),
			"job_leads",
			post({ data: { url: "https://www.seek.com.au/job/94872937", status: "new" } }),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ id: "lead-1", created: false, data: { status: "blocked", lifecycle: [{ at: "earlier" }] } });
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

describe("job lead triage route", () => {
	it("writes an explicit apply lifecycle patch and returns its handoff", async () => {
		let patch: Record<string, unknown> | undefined;
		const record = { id: "lead-1", collection: "job_leads", data: { title: "Head of Engineering" }, createdAt: "x", updatedAt: "x" };
		const res = await routes.triageJobLead(
			fakeEngine<"recordGet" | "recordUpdate" | "recordQuery">({
				recordQuery: async () => ({ records: [record], total: 1 }),
				recordGet: async () => record,
				recordUpdate: async (_collection: string, _id: string, data: Record<string, unknown>) => {
					patch = data;
					return { ...record, data: { ...record.data, ...data } };
				},
			}),
			"lead-1",
			post({ action: "apply", source_instance_id: "scout-1" }),
		);
		expect(res.status).toBe(200);
		expect(patch).toMatchObject({ status: "apply_requested", apply_handoff: { eventType: "job.lead.apply_requested", sourceInstanceId: "scout-1" } });
		expect((await res.json()) as Record<string, unknown>).toMatchObject({ transitioned: true, event: { eventType: "job.lead.apply_requested" } });
	});

	it("does not create a handoff for skip/defer/archive", async () => {
		for (const action of ["skip", "defer", "archive"]) {
			let patch: Record<string, unknown> | undefined;
			const record = { id: "lead-1", collection: "job_leads", data: {}, createdAt: "x", updatedAt: "x" };
			const res = await routes.triageJobLead(
				fakeEngine<"recordGet" | "recordUpdate" | "recordQuery">({
					recordQuery: async () => ({ records: [record], total: 1 }),
					recordGet: async () => record,
					recordUpdate: async (_collection: string, _id: string, data: Record<string, unknown>) => {
						patch = data;
						return { ...record, data };
					},
				}),
				"lead-1",
				post({ action, source_instance_id: "scout-1" }),
			);
			expect(res.status).toBe(200);
			expect(patch?.apply_handoff).toBeUndefined();
			expect((await res.json()) as Record<string, unknown>).toMatchObject({ event: null });
		}
	});
});

describe("job lead triage — compare-and-set and the instance it speaks for (#955)", () => {
	const engineFor = (data: Record<string, unknown>) => {
		const record = { id: "lead-1", collection: "job_leads", data, createdAt: "x", updatedAt: "x" };
		const writes: Record<string, unknown>[] = [];
		const engine = fakeEngine<"recordGet" | "recordUpdate" | "recordQuery">({
			recordQuery: async () => ({ records: [{ ...record, data: Object.assign({}, record.data, ...writes) }], total: 1 }),
			recordGet: async () => ({ ...record, data: Object.assign({}, record.data, ...writes) }),
			recordUpdate: async (_c: string, _id: string, patch: Record<string, unknown>) => {
				writes.push(patch);
				return { ...record, data: Object.assign({}, record.data, ...writes) };
			},
		});
		return { engine, writes };
	};

	it("answers a stale action 409 with stale:true, writing nothing", async () => {
		const { engine, writes } = engineFor({ status: "deferred", lifecycle_version: 3 });
		const res = await routes.triageJobLead(engine, "lead-1", post({ action: "skip", expected_status: "new", source_instance_id: "scout-1" }));
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ stale: true });
		expect(writes).toEqual([]);
	});

	it("two Apply clicks, serialised by the DO: one transition, one event identity", async () => {
		const { engine, writes } = engineFor({ title: "Role" });
		const click = () => routes.triageJobLead(engine, "lead-1", post({ action: "apply", expected_status: "new", expected_version: 0, source_instance_id: "scout-1" }));
		const a = (await (await click()).json()) as { transitioned: boolean; event: { eventId: string } };
		const b = (await (await click()).json()) as { transitioned: boolean; event: { eventId: string } };
		expect([a.transitioned, b.transitioned]).toEqual([true, false]);
		expect(b.event.eventId).toBe(a.event.eventId);
		expect(writes).toHaveLength(1);
	});

	it("refuses a request that does not name its source instance, and a malformed version", async () => {
		const { engine } = engineFor({});
		expect((await routes.triageJobLead(engine, "lead-1", post({ action: "apply" }))).status).toBe(400);
		expect((await routes.triageJobLead(engine, "lead-1", post({ action: "apply", source_instance_id: "s", expected_version: -1 }))).status).toBe(400);
	});
});

describe("unavailable application settlement", () => {
	it("archives the matching Scout lead as expired with one lifecycle audit, and a replay is a no-op", async () => {
		let record = {
			id: "lead-1",
			collection: "job_leads",
			data: {
				status: "apply_requested",
				lifecycle_version: 1,
				lifecycle: [{ from: "new", to: "apply_requested", action: "apply", version: 1, at: "2026-10-07T00:00:00.000Z" }],
				application_id: "app-1",
				application_lead_version: 1,
				application_status: "filling",
				application_version: 2,
			},
			createdAt: "x",
			updatedAt: "x",
		};
		let writes = 0;
		const engine = fakeEngine<"recordGet" | "recordUpdate">({
			recordGet: async () => record,
			recordUpdate: async (_collection: string, _id: string, patch: Record<string, unknown>) => {
				writes++;
				record = { ...record, data: { ...record.data, ...patch } };
				return record;
			},
		});
		const body = {
			application_id: "app-1",
			lead_version: 1,
			status: "archived",
			version: 3,
			disposition: "expired",
			disposition_reason: "job_unavailable",
			disposition_evidence: { reason: "expired", url: "https://jobs.example.test/1", observedAt: "2026-10-07T00:05:00.000Z", source: "page_notice" },
			at: "2026-10-07T00:06:00.000Z",
		};
		expect(await (await routes.writeJobLeadApplication(engine, "lead-1", post(body))).json()).toMatchObject({ applied: true, disposition: "expired" });
		expect(record.data).toMatchObject({
			status: "archived",
			lifecycle_version: 2,
			application_status: "archived",
			application_version: 3,
			expired_reason: "job_unavailable",
			expired_application_id: "app-1",
			expired_application_version: 3,
			expired_evidence: body.disposition_evidence,
		});
		expect(record.data.lifecycle).toEqual(expect.arrayContaining([expect.objectContaining({ from: "apply_requested", to: "archived", action: "archive", note: "Job unavailable" })]));

		expect(await (await routes.writeJobLeadApplication(engine, "lead-1", post(body))).json()).toMatchObject({ applied: false, disposition: "expired" });
		expect(writes).toBe(1);
	});

	it("records a live preflight without changing triage, and makes an unverifiable retry explicit exactly once", async () => {
		let record = {
			id: "lead-1",
			collection: "job_leads",
			data: {
				status: "apply_requested",
				lifecycle_version: 1,
				lifecycle: [{ from: "unverified", to: "apply_requested", action: "apply", version: 1, at: "2026-10-07T00:00:00.000Z" }],
				application_id: "app-1",
				application_lead_version: 1,
				application_status: "tailoring",
				application_version: 0,
			},
			createdAt: "x",
			updatedAt: "x",
		};
		let writes = 0;
		const engine = fakeEngine<"recordGet" | "recordUpdate">({
			recordGet: async () => record,
			recordUpdate: async (_collection: string, _id: string, patch: Record<string, unknown>) => {
				writes++;
				record = { ...record, data: { ...record.data, ...patch } };
				return record;
			},
		});
		const live = { application_id: "app-1", lead_version: 1, status: "tailoring", version: 0, disposition: "verified", disposition_reason: "live", disposition_evidence: { state: "live", evidence: "apply_control_present" }, at: "2026-10-07T00:01:00.000Z" };
		expect(await (await routes.writeJobLeadApplication(engine, "lead-1", post(live))).json()).toMatchObject({ applied: true, disposition: "verified" });
		expect(record.data).toMatchObject({ status: "apply_requested", lifecycle_version: 1, preflight: expect.objectContaining({ state: "verified", reason: "live" }) });

		const unverifiable = { application_id: "app-1", lead_version: 1, status: "blocked", version: 1, disposition: "unverifiable", disposition_reason: "access_blocked", disposition_evidence: { state: "unverifiable", reason: "access_blocked" }, at: "2026-10-07T00:02:00.000Z" };
		expect(await (await routes.writeJobLeadApplication(engine, "lead-1", post(unverifiable))).json()).toMatchObject({ applied: true, disposition: "unverifiable" });
		expect(record.data).toMatchObject({ status: "unverifiable", lifecycle_version: 2, unverifiable_reason: "access_blocked" });
		expect((record.data as Record<string, unknown>).preflight_history).toHaveLength(2);
		expect(await (await routes.writeJobLeadApplication(engine, "lead-1", post(unverifiable))).json()).toMatchObject({ applied: false, disposition: "unverifiable" });
		expect(writes).toBe(2);

		const newer = { ...unverifiable, version: 2, lead_version: 1 };
		record = { ...record, data: { ...record.data, status: "deferred", lifecycle_version: 3 } };
		expect(await (await routes.writeJobLeadApplication(engine, "lead-1", post(newer))).json()).toMatchObject({ applied: false, stale: true });
		expect(record.data.status).toBe("deferred");
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

	it("decodes base64 uploads to bytes, typed by name — never text/plain — with text extraction on (#762)", async () => {
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
		expect(opts.mimeType).toBe("application/octet-stream");
		expect(opts.extractText).toBe(true);
		expect(new TextDecoder().decode(opts.data as ArrayBuffer)).toBe("hello");
	});

	describe("base64 uploads over HTTP match the upload_file tool (#762)", () => {
		const recording = () => {
			const calls: Array<Record<string, unknown>> = [];
			return { calls, engine: fakeEngine<"fileUpload">({ fileUpload: async (o: Record<string, unknown>) => { calls.push(o); return { id: "f1" }; } }) };
		};

		it("a .docx with no mime_type is stored as a Word document; text content keeps text/plain", async () => {
			const { calls, engine } = recording();
			await routes.uploadFile(engine, post({ name: "Club Championships.docx", contentBase64: btoa("PK\x03\x04") }));
			await routes.uploadFile(engine, post({ name: "notes", content: "hi" }));
			expect(calls.map((c) => c.mimeType)).toEqual(["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain"]);
		});

		it("an explicit mime_type still wins", async () => {
			const { calls, engine } = recording();
			await routes.uploadFile(engine, post({ name: "form.docx", contentBase64: btoa("x"), mime_type: "application/pdf" }));
			expect(calls[0].mimeType).toBe("application/pdf");
		});

		it("over the 12MB cap is a 413 naming the limit, refused before decoding — nothing stored", async () => {
			const { calls, engine } = recording();
			const res = await routes.uploadFile(engine, post({ name: "big.bin", contentBase64: "A".repeat(17 * 1024 * 1024) }));
			expect(res.status).toBe(413);
			expect(((await res.json()) as { error: string }).error).toMatch(/over the 12MB limit/);
			expect(calls).toEqual([]);
		});

		it("exactly at the cap is accepted", async () => {
			const { calls, engine } = recording();
			const res = await routes.uploadFile(engine, post({ name: "max.bin", contentBase64: "A".repeat((12 * 1024 * 1024 * 4) / 3) }));
			expect(res.status).toBe(201);
			expect((calls[0].data as ArrayBuffer).byteLength).toBe(12 * 1024 * 1024);
		});

		it("malformed base64 is a 400 saying so, not a 500 — nothing stored", async () => {
			const { calls, engine } = recording();
			const res = await routes.uploadFile(engine, post({ name: "x.pdf", contentBase64: "not*base64!" }));
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toMatch(/not valid standard base64/);
			expect(calls).toEqual([]);
		});

		it("content and contentBase64 together are refused, naming both", async () => {
			const { calls, engine } = recording();
			const res = await routes.uploadFile(engine, post({ name: "x.txt", content: "hi", contentBase64: btoa("hi") }));
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toMatch(/content or contentBase64, not both/);
			expect(calls).toEqual([]);
		});
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
			fakeEngine<"getEventsPage">({
				getEventsPage: async (o: Record<string, unknown>) => {
					activityOpts = o;
					return { events: [], total: 0 };
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
