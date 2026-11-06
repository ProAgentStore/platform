import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareApplyDocuments } from "./documents.js";
import { LocalApplyRuntime } from "./runtime.js";
import { FullApplyTools } from "./full-tools.js";
import type { ApplyBridgeHost } from "./bridge.js";
import { parseLocalApplyEvent, type LocalApplyTaskEnvelope } from "./contract.js";
import { parseLocalApplyEvent as parseApiEvent } from "../../../../workers/api/src/lib/local-apply/contract.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const fakePdf = async (text: string) => Buffer.from(`%PDF-1.7\n${text}\n%%EOF`);
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "pags-pdf-preflight-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function envelope(): LocalApplyTaskEnvelope {
	const cloudDocuments = (["resume", "cover_letter", "profile"] as const).map((role) => {
		const bytes = Buffer.from(`Approved ${role} source`);
		return { role, name: `${role}.md`, mimeType: "text/markdown" as const, sha256: sha(bytes), bytes: bytes.length, contentBase64: bytes.toString("base64") };
	});
	return { type: "local_browser.apply", runId: "run-1", instanceId: "runner-1", requestId: "request-1", applicationId: "app-1", engine: "claude", authMode: "machine", browserProfile: "isolated", applicationUrl: "https://employer.example/job", job: { title: "Engineer" }, workspace: "~/jobs", sources: [], cloudDocuments, artifacts: cloudDocuments.filter((d) => d.role !== "profile").map((d) => ({ kind: d.role as "resume" | "cover_letter", path: `~/jobs/applications/${d.name}`, sha256: d.sha256 })), policy: { mode: "fill_and_review", allowDomains: ["employer.example"] }, limits: { maxMinutes: 10, maxActions: 20, maxPages: 10 } };
}

it("Stop aborts a pending PDF preparation, cleans private sources, and never starts the employer browser or model", async () => {
	const dir = temp(), browserFor = vi.fn(), spawn = vi.fn();
	let finish: (value: Buffer) => void = () => {}, entered = false, signal: AbortSignal | undefined;
	const runtime = new LocalApplyRuntime({ dataDir: dir, selfUrl: () => "http://127.0.0.1:4999", browserFor, spawn: spawn as never, renderPdf: async (_text, _markdown, stopped) => { entered = true; signal = stopped; return new Promise((resolve) => { finish = resolve; }); } });
	runtime.start(envelope());
	await expect.poll(() => entered).toBe(true);
	const folder = join(dir, "local-apply/runner-1/run-1/documents");
	expect(existsSync(folder)).toBe(true);
	runtime.cancel({ runId: "run-1" });
	const cancelled = runtime.status({ runId: "run-1" }).result;
	expect(signal?.aborted).toBe(true); expect(existsSync(folder)).toBe(false);
	finish(await fakePdf("late result must never be staged"));
	await new Promise((resolve) => setImmediate(resolve));
	expect(runtime.status({ runId: "run-1" }).result).toEqual(cancelled);
	expect(cancelled).toMatchObject({ outcome: "failed", error: "Cancelled by the owner" }); expect(cancelled?.preflightFailure).toBeUndefined();
	expect(existsSync(folder)).toBe(false); expect(browserFor).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
	runtime.closeAll();
});

it("render failure or source changes clean partial staging and cannot fall back to a text attachment", async () => {
	for (const failure of ["renderer", "source"] as const) {
		const dir = temp();
		await expect(prepareApplyDocuments(envelope(), dir, dir, () => {}, async () => {
			if (failure === "renderer") throw new Error("renderer unavailable");
			writeFileSync(join(dir, "documents/resume.source.md"), "changed source");
			return fakePdf("wrong source");
		})).rejects.toHaveProperty("reason", failure === "renderer" ? "source_unavailable" : "artifact_changed");
		expect(existsSync(join(dir, "documents"))).toBe(false);
	}
});

it("uses the frozen command deadline for PDF preparation and bounds it by the run budget", async () => {
	const input = envelope(); input.policy.browserCommandTimeoutSeconds = 1;
	const renderer = vi.fn(async () => new Promise<Buffer>(() => {}));
	const dir = temp();
	await expect(prepareApplyDocuments(input, dir, dir, () => {}, renderer)).rejects.toHaveProperty("reason", "source_unavailable");
	expect(renderer.mock.calls[0]).toMatchObject([expect.any(String), true, expect.any(AbortSignal), 1000]);
	expect(existsSync(join(dir, "documents"))).toBe(false);
});

it("converts local TXT to PDF, rechecks its approved source, and explicitly refuses pre-existing PDF without text provenance", async () => {
	const home = temp(), appDir = join(home, "jobs/applications"); mkdirSync(appDir, { recursive: true });
	writeFileSync(join(home, "jobs/profile.txt"), "Candidate profile");
	for (const extension of ["txt", "pdf"]) {
		const dir = temp(), source = join(appDir, `resume.${extension}`), bytes = Buffer.from(extension === "pdf" ? "%PDF-1.7\nsource\n%%EOF" : "Approved plain résumé — Україна");
		writeFileSync(source, bytes);
		const input = envelope(); delete input.cloudDocuments; input.sources = [{ role: "profile", path: "profile.txt" }]; input.artifacts = [{ kind: "resume", path: `~/jobs/applications/resume.${extension}`, sha256: sha(bytes) }];
		if (extension === "pdf") { await expect(prepareApplyDocuments(input, dir, home, () => {}, fakePdf)).rejects.toHaveProperty("reason", "source_unavailable"); continue; }
		const prepared = await prepareApplyDocuments(input, dir, home, () => {}, fakePdf), upload = prepared.artifactPath("resume");
		if ("error" in upload) throw new Error(upload.error);
		expect(upload.path.endsWith("resume.pdf")).toBe(true); expect(upload.sourceSha256).toBe(sha(bytes)); expect(upload.sha256).not.toBe(upload.sourceSha256);
		writeFileSync(source, "changed original"); expect(prepared.artifactPath("resume")).toHaveProperty("error");
	}
});

it.each(["browser_file_upload", "browser_drop"])("native %s uses bound relative paths and emits source/PDF identity only after successful selection", async (tool) => {
	const dir = temp(), prepared = await prepareApplyDocuments(envelope(), dir, dir, () => {}, fakePdf), upload = prepared.artifactPath("resume");
	if ("error" in upload) throw new Error(upload.error);
	const events: unknown[] = [], callTool = vi.fn(async () => ({ content: [] }));
	const host = { artifactPath: prepared.artifactPath, resolveUploadPath: (path: string) => resolve(dir, path), emit: (event: unknown) => events.push(event) } as ApplyBridgeHost;
	const full = new FullApplyTools({ listTools: async () => [], callTool }, host, () => ({ actions: 0, filled: 0, uploaded: 0 }), () => {});
	expect((await full.call(tool, { paths: [relative(dir, upload.path)] })).isError).toBeFalsy();
	expect(callTool).toHaveBeenCalledTimes(1);
	const event = { ...(events[0] as object), at: new Date().toISOString() };
	for (const parse of [parseLocalApplyEvent, parseApiEvent]) expect(parse(event)?.detail).toMatchObject({ sha256: sha(readFileSync(upload.path)), sourceSha256: upload.sourceSha256, rendererRevision: "application_pdf_v1", mimeType: "application/pdf", status: "selected", reason: "site_acceptance_unconfirmed" });
	events.length = 0; callTool.mockResolvedValueOnce({ content: [], isError: true } as never);
	await full.call(tool, { paths: [upload.path] }); expect(events).toHaveLength(0);
	expect((await full.call(tool, { paths: ["../unapproved.pdf"] })).isError).toBe(true); expect(callTool).toHaveBeenCalledTimes(2);
	writeFileSync(join(dir, "documents/resume.source.md"), "changed source");
	expect((await full.call(tool, { paths: [upload.path] })).isError).toBe(true); expect(callTool).toHaveBeenCalledTimes(2);
});
