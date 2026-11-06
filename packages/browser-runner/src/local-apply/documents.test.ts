import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { PortableDocument } from "../local-artifact/document-contract.js";
import type { LocalApplyTaskEnvelope } from "./contract.js";
import { clearCloudDocuments, documentFileName, parseCloudDocuments, prepareApplyDocuments } from "./documents.js";
import { LocalApplyRuntime, parseApplyEnvelope } from "./runtime.js";

const fakePdf = async (text: string) => Buffer.from(`%PDF-1.7\n${text}\n%%EOF`);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function document(role: PortableDocument["role"], text = `Private ${role} exact owner text`): PortableDocument {
	const bytes = Buffer.from(text);
	return { role, name: `${role}.md`, mimeType: "text/markdown", sha256: hash(bytes), bytes: bytes.length, contentBase64: bytes.toString("base64") };
}
function envelope(): LocalApplyTaskEnvelope {
	const cloudDocuments = [document("resume"), document("cover_letter"), document("profile")];
	return {
		type: "local_browser.apply", runId: "run-1", instanceId: "runner-1", requestId: "application-1", applicationId: "app-1", engine: "claude", authMode: "machine", browserProfile: "isolated",
		applicationUrl: "https://example.com/apply", job: { title: "Engineer" }, workspace: "~/missing-workspace", sources: [], cloudDocuments,
		artifacts: cloudDocuments.filter((d) => d.role !== "profile").map((d) => ({ kind: d.role as "resume" | "cover_letter", path: `~/other-machine/applications/${d.name}`, sha256: d.sha256 })),
		policy: { mode: "fill_and_review", allowDomains: ["example.com"] }, limits: { maxMinutes: 10, maxActions: 20, maxPages: 10 },
	};
}
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "pags-documents-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("attachment filenames (#1574)", () => {
	const facts = (identity: Record<string, string>) => ({ schemaVersion: 1 as const, source: "account_profile" as const, instanceId: "runner-1", applicationId: "app-1", runId: "run-1", capturedAt: "2026-11-07T00:00:00.000Z", revision: "r", identity, savedAnswers: {} });

	it("names each document after the candidate and the job", () => {
		const input = { job: { title: "Program Director" }, ownerFacts: facts({ firstName: "Sergey", lastName: "Ivochkin" }) };
		expect(documentFileName("resume", input)).toBe("Sergey-Ivochkin-Resume-Program-Director.pdf");
		expect(documentFileName("cover_letter", input)).toBe("Sergey-Ivochkin-Cover-Letter-Program-Director.pdf");
	});

	it("keeps the generic name when the candidate's name is unknown", () => {
		expect(documentFileName("resume", { job: { title: "Program Director" } })).toBe("resume.pdf");
		expect(documentFileName("cover_letter", { job: { title: "Program Director" }, ownerFacts: facts({}) })).toBe("cover-letter.pdf");
	});

	it("never yields a path, accents or punctuation, and bounds a long title by whole words", () => {
		const input = { job: { title: "Sr. Engineer / Team Lead (Café) — Platform & Infrastructure, Observability and Reliability Engineering" }, ownerFacts: facts({ firstName: "José", lastName: "O'Brien" }) };
		const name = documentFileName("resume", input);
		expect(name).toBe("Jose-O-Brien-Resume-Sr-Engineer-Team-Lead-Cafe-Platform-Infrastructure.pdf");
		expect(name).toMatch(/^[A-Za-z0-9-]+\.pdf$/);
	});

	it("stages the PDF under that name", async () => {
		const dir = temp();
		const input = { ...parseApplyEnvelope(envelope()), job: { title: "Program Director" }, ownerFacts: facts({ firstName: "Sergey", lastName: "Ivochkin" }) };
		const prepared = await prepareApplyDocuments(input, dir, join(dir, "no-home"), () => {}, fakePdf);
		expect(prepared.artifactPath("resume")).toMatchObject({ path: expect.stringMatching(/\/Sergey-Ivochkin-Resume-Program-Director\.pdf$/) });
	});
});

describe("cloud application documents (#1468)", () => {
	it("works on a second machine without a workspace and rechecks source and rendered PDF", async () => {
		const dir = temp();
		const input = parseApplyEnvelope(envelope());
		const events: unknown[] = [];
		const prepared = await prepareApplyDocuments(input, dir, join(dir, "no-home"), (event) => events.push(event), fakePdf);
		expect(prepared.blocks.map((block) => block.label)).toEqual(["resume", "cover_letter", "profile"]);
		const upload = prepared.artifactPath("resume");
		expect(upload).toHaveProperty("path");
		expect(upload).toMatchObject({ path: expect.stringMatching(/resume\.pdf$/), sha256: hash(await fakePdf("Private resume exact owner text")), sourceSha256: input.artifacts[0].sha256 });
		expect(events).toContainEqual({ type: "artifact.staged", detail: { kind: "resume", source: "resume.md", path: "resume.pdf", sha256: hash(await fakePdf("Private resume exact owner text")), sourceSha256: input.artifacts[0].sha256, rendererRevision: "application_pdf_v1", mimeType: "application/pdf", bytes: (await fakePdf("Private resume exact owner text")).length } });
		if (!("path" in upload)) throw new Error("Expected staged file");
		expect(readFileSync(upload.path)).toEqual(await fakePdf("Private resume exact owner text"));
		expect(statSync(upload.path).mode & 0o777).toBe(0o600);
		expect(JSON.stringify(events)).not.toContain("exact owner text");
		writeFileSync(upload.path, "changed");
		expect(prepared.artifactPath("resume")).toEqual({ error: "The approved source or rendered PDF changed; it will not be uploaded." });
		clearCloudDocuments(input, dir);
		expect(input.cloudDocuments).toBeUndefined();
		expect(existsSync(join(dir, "documents"))).toBe(false);
	});

	it("allows a canonicalized temp ancestor but refuses replacing the upload with a symlink", async () => {
		const dir = temp();
		mkdirSync(join(dir, "real"));
		symlinkSync(join(dir, "real"), join(dir, "alias"));
		const prepared = await prepareApplyDocuments(envelope(), join(dir, "alias"), dir, () => undefined, fakePdf);
		const upload = prepared.artifactPath("resume");
		if (!("path" in upload)) throw new Error("Expected canonical staged file");
		const other = join(dir, "other.md");
		writeFileSync(other, readFileSync(upload.path));
		rmSync(upload.path);
		symlinkSync(other, upload.path);
		expect(prepared.artifactPath("resume")).toHaveProperty("error");
	});

	it.each([
		(d: PortableDocument[]) => d.slice(0, 2),
		(d: PortableDocument[]) => [...d, d[0]],
		(d: PortableDocument[]) => d.map((v, i) => i === 0 ? { ...v, sha256: "a".repeat(64) } : v),
		(d: PortableDocument[]) => d.map((v, i) => i === 0 ? { ...v, bytes: v.bytes + 1 } : v),
		(d: PortableDocument[]) => d.map((v, i) => i === 0 ? { ...v, name: "../resume.md" } : v),
		(d: PortableDocument[]) => d.map((v, i) => i === 0 ? { ...v, contentBase64: `${v.contentBase64}\n` } : v),
		(d: PortableDocument[]) => d.map((v, i) => i === 0 ? document("resume", "x".repeat(256 * 1024 + 1)) : v),
	])("refuses malformed, incomplete or changed bundles before any staging", (change) => {
		const input = envelope();
		expect(() => parseCloudDocuments(change(input.cloudDocuments!), input.artifacts)).toThrow(/cloud documents/);
	});

	it("refuses self-consistent bytes that differ from the approved artifact hash", () => {
		const input = envelope();
		input.cloudDocuments![0] = document("resume", "another candidate");
		expect(() => parseApplyEnvelope(input)).toThrow(/cloud documents/);
	});

	it("cleans terminal staging and excludes bytes from results and restart journals", async () => {
		const dir = temp();
		class Child extends EventEmitter {
			stdout = new PassThrough(); stderr = new PassThrough(); exitCode: number | null = null;
			kill() { this.exitCode = 143; this.emit("close", 143); return true; }
		}
		let spawned = 0;
		const uploaded: string[] = [];
		const deps = {
			renderPdf: fakePdf,
			dataDir: dir, homeDir: join(dir, "no-home"), selfUrl: () => "http://127.0.0.1:4999",
			browserFor: async () => ({ tools: { listTools: async () => [], callTool: async (name: string, args: Record<string, unknown> = {}) => {
				if (name === "browser_file_upload") uploaded.push(readFileSync((args.paths as string[])[0], "utf8"));
				return { content: [] };
			} }, stop: async () => undefined }),
			spawn: (() => { spawned++; return new Child(); }) as never,
		};
		const runtime = new LocalApplyRuntime(deps);
		const input = envelope();
		runtime.start(input);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(spawned).toBe(1);
		const runDir = join(dir, "local-apply/runner-1/run-1");
		expect(existsSync(join(runDir, "documents/resume.pdf"))).toBe(true);
		const checkpoint = runtime.bridge({ runId: "run-1", op: "call", name: "supervisor_checkpoint", args: { checkpointId: "initial:1", phase: "initial" } });
		await new Promise((resolve) => setTimeout(resolve, 20));
		runtime.directive({ runId: "run-1", schemaVersion: 1, checkpointId: "initial:1", directive: "continue" });
		await checkpoint;
		await runtime.bridge({ runId: "run-1", op: "call", name: "upload_artifact", args: { kind: "resume" } });
		expect(uploaded).toEqual([(await fakePdf("Private resume exact owner text")).toString("utf8")]);
		runtime.cancel({ runId: "run-1" });
		expect(existsSync(join(runDir, "documents"))).toBe(false);
		const status = runtime.status({ runId: "run-1" });
		const journal = readFileSync(join(runDir, "terminal-result.json"), "utf8");
		for (const doc of input.cloudDocuments!) {
			expect(JSON.stringify(status)).not.toContain(doc.contentBase64);
			expect(journal).not.toContain(doc.contentBase64);
		}
		expect(journal).not.toContain("exact owner text");
		const restarted = new LocalApplyRuntime(deps);
		expect(restarted.status({ runId: "run-1" }).result).toEqual(status.result);
		expect(restarted.start(envelope())).toMatchObject({ existing: true });
		expect(spawned).toBe(1);
	});
});
