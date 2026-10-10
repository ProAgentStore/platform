/** Owner-selected uploaded-source provenance (#1004), before runner materialization exists. */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const { registerApplicationTailorRoutes } = await import("./instances-application-tailor.js");

let d1: RealSchemaD1;
let files: Array<Record<string, unknown>>;
let fileListRequests: string[];

function env(): Env {
	return {
		DB: d1.DB,
		AGENT: {
			idFromName: (name: string) => name,
			get: () => ({
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					fileListRequests.push(url.pathname + url.search);
					if (url.pathname !== "/files" || url.searchParams.get("user_id") !== "u1") return Response.json({ error: "unexpected" }, { status: 400 });
					return Response.json({ files });
				},
			}),
		},
	} as unknown as Env;
}

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('a1', 'u1', 'tailor', 'Tailor')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'a1', 'u1', 'active', '{}'), ('i2', 'a1', 'u2', 'active', '{}')`);
	files = [{
		id: "file_resume_1", name: "resume.pdf", mimeType: "application/pdf", size: 1234,
		extractionStatus: "extracted", extractedTextLength: 900, indexedTextLength: 900,
		r2Version: "v1", r2Etag: "etag-1", originalSha256: "a".repeat(64), extractedTextSha256: "b".repeat(64), extractedAt: "2026-10-10T00:00:02.000Z",
		createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:01.000Z",
	}];
	fileListRequests = [];
});
afterEach(() => d1.close());

async function call(method: string, path: string, body?: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	registerApplicationTailorRoutes(app);
	app.onError((error, c) => error instanceof HttpError ? c.json({ error: error.message }, error.status as 400) : c.json({ error: String(error) }, 500));
	const response = await app.request(path, {
		method,
		headers: { "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	}, env());
	return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("Application Tailor uploaded source selection", () => {
	it("records an exact owner-visible Files identity and extraction provenance without starting work", async () => {
		const selected = await call("PUT", "/i1/application-tailor/uploaded-sources/resume", { fileId: "file_resume_1" });
		expect(selected.status).toBe(200);
		expect(selected.body).toMatchObject({ source: { role: "resume", id: "file_resume_1", name: "resume.pdf", extractionStatus: "extracted", extractedTextLength: 900, fileVersion: "v1", originalSha256: "a".repeat(64), extractedTextSha256: "b".repeat(64) } });
		expect(fileListRequests).toEqual(["/files?user_id=u1"]);
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM local_artifact_runs").first<{ n: number }>())?.n).toBe(0);

		const listed = await call("GET", "/i1/application-tailor/uploaded-sources");
		expect(listed.status).toBe(200);
		expect(listed.body).toMatchObject({ sources: [expect.objectContaining({ role: "resume", id: "file_resume_1", name: "resume.pdf" })] });
		expect(JSON.stringify(listed.body)).not.toMatch(/r2Key|https?:\/\/|token/);
	});

	it("replaces only the explicitly named role; it never chooses another candidate", async () => {
		await call("PUT", "/i1/application-tailor/uploaded-sources/resume", { fileId: "file_resume_1" });
		files.push({ id: "file_resume_2", name: "new-resume.pdf", mimeType: "application/pdf", size: 4567, extractionStatus: "unsupported", extractionError: "No readable text", r2Version: "v2", createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z" });
		await call("PUT", "/i1/application-tailor/uploaded-sources/profile", { fileId: "file_resume_2" });
		const listed = await call("GET", "/i1/application-tailor/uploaded-sources");
		expect(listed.body).toMatchObject({ sources: [
			expect.objectContaining({ role: "resume", id: "file_resume_1" }),
			expect.objectContaining({ role: "profile", id: "file_resume_2", extractionStatus: "unsupported" }),
		] });
	});

	it("does not create a selection for an absent file and keeps selections instance/owner scoped", async () => {
		const missing = await call("PUT", "/i1/application-tailor/uploaded-sources/resume", { fileId: "not_uploaded" });
		expect(missing).toMatchObject({ status: 404, body: { error: "Uploaded file not found on this instance" } });
		expect(await call("GET", "/i1/application-tailor/uploaded-sources")).toMatchObject({ body: { sources: [] } });

		const other = await call("PUT", "/i2/application-tailor/uploaded-sources/resume", { fileId: "file_resume_1" });
		expect(other).toMatchObject({ status: 404, body: { error: "Instance not found" } });
	});

	it("only clears on the owner's explicit role request", async () => {
		await call("PUT", "/i1/application-tailor/uploaded-sources/resume", { fileId: "file_resume_1" });
		expect(await call("DELETE", "/i1/application-tailor/uploaded-sources/resume")).toMatchObject({ status: 200, body: { cleared: true } });
		expect(await call("GET", "/i1/application-tailor/uploaded-sources")).toMatchObject({ body: { sources: [] } });
	});

	it("reports selected, extracted, runner, and materialization states without dispatching a run", async () => {
		await call("PUT", "/i1/application-tailor/uploaded-sources/resume", { fileId: "file_resume_1" });
		const readiness = await call("GET", "/i1/application-tailor/uploaded-sources/readiness");
		expect(readiness.status).toBe(200);
		expect(readiness.body).toMatchObject({
			mode: "uploaded", ready: false, runner: { available: false },
			sources: [
				expect.objectContaining({ role: "resume", selected: expect.objectContaining({ id: "file_resume_1" }), uploaded: true, extracted: true, availableToRunner: false, ready: false, isStale: false, provenance: { filename: "resume.pdf", fileId: "file_resume_1", version: "v1", originalHash: "a".repeat(64), extractedHash: "b".repeat(64), extractedAt: "2026-10-10T00:00:02.000Z" }, blockers: ["materialization_unsupported"] }),
				expect.objectContaining({ role: "profile", selected: null, uploaded: false, extracted: false, availableToRunner: false, ready: false, blockers: ["not_selected", "materialization_unsupported"] }),
			],
		});
		expect(readiness.body.blockers).toEqual(expect.arrayContaining(["profile:not_selected", "runner_unavailable", "resume:materialization_unsupported"]));
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM local_artifact_runs").first<{ n: number }>())?.n).toBe(0);
	});

	it("fails readiness closed when the selected file metadata changes", async () => {
		await call("PUT", "/i1/application-tailor/uploaded-sources/resume", { fileId: "file_resume_1" });
		files[0].updatedAt = "2026-10-12T00:00:00.000Z";
		const readiness = await call("GET", "/i1/application-tailor/uploaded-sources/readiness");
		const sources = readiness.body.sources as Array<Record<string, unknown>>;
		expect(sources.find((source) => source.role === "resume")).toMatchObject({ isStale: true, blockers: ["file_changed_reselect_required", "materialization_unsupported"] });
	});

	it("fails readiness closed when the file has no exact extraction provenance", async () => {
		delete files[0].originalSha256;
		const selected = await call("PUT", "/i1/application-tailor/uploaded-sources/resume", { fileId: "file_resume_1" });
		expect(selected.status).toBe(200);
		const readiness = await call("GET", "/i1/application-tailor/uploaded-sources/readiness");
		const sources = readiness.body.sources as Array<Record<string, unknown>>;
		expect(sources.find((source) => source.role === "resume")).toMatchObject({ blockers: ["provenance_unavailable", "materialization_unsupported"] });
	});
});
