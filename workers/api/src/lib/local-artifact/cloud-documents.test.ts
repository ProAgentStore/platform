import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../d1-sqlite.js";
import { sha256Hex } from "../../agent-storage-utils.js";
import { materializeApplicationDocument } from "../../agent-document-routes.js";
import type { Env } from "../../types.js";
import type { LocalArtifactResultEnvelope } from "./contract.js";
import type { PortableDocument } from "./document-contract.js";
import type { JobApplication, TailorRun } from "./store.js";

const { exportCall, runtimeVersion } = vi.hoisted(() => ({ exportCall: vi.fn(), runtimeVersion: { value: "0.4.205" } }));
vi.mock("../../routes/instances-runtime.js", () => ({ callRuntime: exportCall, runtimeJson: (res: Response) => res.json(), getLiveRuntime: async () => ({ runner_version: runtimeVersion.value, runner_node: "mac", instance_id: "apply" }) }));
const { syncTailorRun } = await import("./tailor.js");
const { getTailorRun, getApplication, updateTailorRun } = await import("./store.js");
const { moveApplication } = await import("../local-apply/store.js");
const { startApplicationFill, dispatchNextQueuedFill } = await import("../local-apply/apply.js");
const { persistCloudDocuments, loadCloudDocuments, cloudDocumentsRunnerProblem } = await import("./cloud-documents.js");
let d1: RealSchemaD1;
let docs: PortableDocument[];
let files: Map<string, { meta: Record<string, unknown>; bytes: Uint8Array }>;
let uploads: number;
let failUpload: number;
const run = { id: "tailor-run", instanceId: "tailor", applicationId: "application" } as TailorRun;
let result: LocalArtifactResultEnvelope;
const env = () => ({ DB: d1.DB, AGENT: {
	idFromName: (id: string) => id,
	get: (instance: string) => ({ fetch: async (req: Request) => {
		const url = new URL(req.url);
		if (url.pathname === "/memory") return Response.json({ memory: [] });
		if (url.pathname === "/files") {
			uploads++;
			if (uploads === failUpload) return Response.json({ error: "unavailable" }, { status: 503 });
			const body = await req.json<{ name: string; contentBase64: string; mime_type: string; user_id: string }>();
			const bytes = Uint8Array.from(atob(body.contentBase64), (c) => c.charCodeAt(0));
			const meta = { id: `file-${uploads}`, name: body.name, userId: body.user_id, mimeType: body.mime_type, r2Version: `v-${uploads}`, originalSha256: await sha256Hex(bytes), size: bytes.length };
			files.set(`${instance}/${meta.id}`, { meta, bytes });
			return Response.json(meta, { status: 201 });
		}
		const id = url.pathname.split("/")[2];
		return materializeApplicationDocument({ fileGet: async () => {
			const file = files.get(`${instance}/${id}`);
			return file ? { meta: file.meta, body: new Response(file.bytes).body } : null;
		} } as never, id, req);
	} }),
} }) as unknown as Env;
function app(): JobApplication {
	return { id: run.applicationId, instanceId: run.instanceId, tailoringRunId: run.id, resumeArtifact: result.artifacts[0], coverLetterArtifact: result.artifacts[1] } as JobApplication;
}
beforeEach(async () => {
	runtimeVersion.value = "0.4.205";
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users(id, github_login) VALUES ('owner', 'owner');
	INSERT INTO agents(id, owner_id, slug, name, config) VALUES ('tailor-agent','owner','tailor','Tailor','{"capabilities":{"runtime":"local_artifact","surfaces":[]}}'), ('apply-agent','owner','apply','Apply','{"capabilities":{"runtime":"local_apply","surfaces":[]}}');
	INSERT INTO agent_instances(id, agent_id, user_id, status, config) VALUES ('tailor','tailor-agent','owner','active','{}'), ('apply','apply-agent','owner','active','{}');
	INSERT INTO job_applications(id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead, tailoring_run_id, created_at, updated_at)
	VALUES ('application','tailor','owner','scout','lead',1,'request','tailoring','{"leadUrl":"https://jobs.example.com/job","lead":{"title":"Engineer"}}','tailor-run',1000,1000);
	INSERT INTO local_artifact_runs(id, instance_id, user_id, application_id, request_id, status, policy, created_at, updated_at, started_at)
	VALUES ('tailor-run','tailor','owner','application','request','running','{"cloudDocuments":true,"maxMinutes":10,"engine":"codex","authMode":"machine","workspace":"~/jobs","sources":[],"retainDays":0}',1000,1000,1000);`);
	files = new Map(); uploads = 0; failUpload = 0;
	docs = await Promise.all((["resume", "cover_letter", "profile"] as const).map(async (role) => {
		const text = `Synthetic exact ${role} — owner data\n`;
		const bytes = new TextEncoder().encode(text);
		return { role, name: `${role}.md`, mimeType: "text/markdown" as const, bytes: bytes.length, sha256: await sha256Hex(bytes), contentBase64: btoa(String.fromCharCode(...bytes)) };
	}));
	result = { runId: run.id, outcome: "completed", traceId: run.id, engineAuth: "machine-login", profileVersion: "v", artifacts: docs.slice(0, 2).map((d) => ({ kind: d.role as "resume" | "cover_letter", path: `~/dell/jobs/${d.name}`, sha256: d.sha256, bytes: d.bytes })), sourceHashes: [{ role: "profile", path: "~/dell/profile.md", sha256: docs[2].sha256, bytes: docs[2].bytes }] };
	exportCall.mockImplementation(async () => Response.json({ runId: run.id, instanceId: run.instanceId, documents: docs }));
});
afterEach(() => d1.close());
const persist = () => persistCloudDocuments(env(), {} as never, "owner", run, result, 1);

describe("portable application document storage", () => {
	it("stores exact Files receipts and hydrates a different runner without machine paths or durable bytes", async () => {
		await persist();
		expect(result.artifacts.every((a) => a.cloud?.instanceId === "tailor")).toBe(true);
		const hydrated = await loadCloudDocuments(env(), "owner", app(), "0.4.205");
		expect(hydrated?.map((d) => [d.role, d.sha256, d.contentBase64]).sort()).toEqual(docs.map((d) => [d.role, d.sha256, d.contentBase64]).sort());
		const stored = await d1.DB.prepare("SELECT * FROM application_documents").all();
		expect(stored.results).toHaveLength(3);
		expect(JSON.stringify(stored)).not.toContain("contentBase64");
		expect(JSON.stringify(stored)).not.toContain("Synthetic exact");
		expect(JSON.stringify(result)).not.toContain("contentBase64");
	});
	it("resumes a partial storage failure without uploading already receipted documents again", async () => {
		failUpload = 2;
		await expect(persist()).rejects.toThrow(/store/);
		expect((await d1.DB.prepare("SELECT * FROM application_documents").all()).results).toHaveLength(1);
		failUpload = 0; await persist();
		expect(uploads).toBe(4); // one failed request, three persisted files
		exportCall.mockRejectedValue(new Error("export endpoint unavailable"));
		await persist(); expect(uploads).toBe(4);
	});
	it("never accepts another owner, changed file bytes, deleted files or old runners", async () => {
		await persist();
		await expect(loadCloudDocuments(env(), "other", app(), "0.4.205")).rejects.toThrow(/missing or changed/);
		await expect(loadCloudDocuments(env(), "owner", app(), "0.4.204")).rejects.toThrow(/0.4.205/);
		const file = files.get("tailor/file-1")!;
		file.bytes[0] ^= 1;
		await expect(loadCloudDocuments(env(), "owner", app(), "0.4.205")).rejects.toThrow(/missing or changed/);
		files.clear();
		await expect(loadCloudDocuments(env(), "owner", app(), "0.4.205")).rejects.toThrow(/missing or changed/);
	});
	it("checks Files owner and immutable version independently of document receipt ownership", async () => {
		await persist();
		files.get("tailor/file-1")!.meta.userId = "other";
		await expect(loadCloudDocuments(env(), "owner", app(), "0.4.205")).rejects.toThrow(/missing or changed/);
		files.get("tailor/file-1")!.meta.userId = "owner";
		files.get("tailor/file-1")!.meta.r2Version = "replacement";
		await expect(loadCloudDocuments(env(), "owner", app(), "0.4.205")).rejects.toThrow(/missing or changed/);
	});
	it("requires a complete hash-matching export for this exact run before uploading anything", async () => {
		docs[0].contentBase64 = btoa("different");
		await expect(persist()).rejects.toThrow(/hash/); expect(uploads).toBe(0);
		exportCall.mockResolvedValue(Response.json({ runId: "other", instanceId: "tailor", documents: docs }));
		await expect(persist()).rejects.toThrow(/another run/); expect(uploads).toBe(0);
	});
	it("binds generated and source bytes to the completed run hashes", async () => {
		result.sourceHashes[0].sha256 = "a".repeat(64);
		await expect(persist()).rejects.toThrow(/roles|approved hashes/); expect(uploads).toBe(0);
	});
	it("requires optional answers when the completed run used them", async () => {
		result.sourceHashes.push({ role: "answers", path: "~/answers.md", sha256: "a".repeat(64), bytes: 42 });
		await expect(persist()).rejects.toThrow(/roles/); expect(uploads).toBe(0);
	});
	it("serializes simultaneous polls so each document is uploaded only once", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		exportCall.mockImplementation(async () => { entered(); await blocked; return Response.json({ runId: run.id, instanceId: run.instanceId, documents: docs }); });
		const first = persist(); await started;
		await expect(persist()).rejects.toThrow(/another poll/);
		release(); await first;
		await persist(); expect(uploads).toBe(3);
	});
	it("refuses stripped cloud handles using the producing policy or existing receipts", async () => {
		await expect(loadCloudDocuments(env(), "owner", app(), "0.4.205")).rejects.toThrow(/references are missing/);
		await persist();
		for (const artifact of result.artifacts) delete artifact.cloud;
		d1.exec("UPDATE local_artifact_runs SET policy = json_remove(policy, '$.cloudDocuments')");
		await expect(loadCloudDocuments(env(), "owner", app(), "0.4.205")).rejects.toThrow(/references are missing/);
	});
	it("keeps legacy handles explicitly local and requires the portable capability on new runs", async () => {
		d1.exec("UPDATE local_artifact_runs SET policy = json_remove(policy, '$.cloudDocuments')");
		expect(await loadCloudDocuments(env(), "owner", app(), "0.4.200")).toBeUndefined();
		expect(cloudDocumentsRunnerProblem(undefined)).toContain("0.4.205");
		expect(cloudDocumentsRunnerProblem("0.4.205")).toBeNull();
	});
});


describe("real tailoring settlement and application dispatch", () => {
	function serveCompletedRun() {
		exportCall.mockImplementation(async (_env: unknown, _runtime: unknown, path: string) => path === "/local-artifact/status"
			? Response.json({ state: "ended", lastSeq: 0, events: [], result })
			: Response.json({ runId: run.id, instanceId: run.instanceId, documents: docs }));
	}
	async function sync(now = 2000) {
		return syncTailorRun(env(), "owner", (await getTailorRun(env(), "tailor", "owner", run.id))!, now);
	}
	it("does not publish readiness before storage succeeds; retry completes and clears pending error", async () => {
		serveCompletedRun(); failUpload = 2;
		expect(await sync()).toMatchObject({ status: "running", errorCode: "cloud_documents_pending" });
		expect(await d1.DB.prepare("SELECT status, ready_event FROM job_applications").first()).toEqual({ status: "tailoring", ready_event: null });
		failUpload = 0;
		expect(await sync(3000)).toMatchObject({ status: "completed", errorCode: null, error: null });
		const record = await d1.DB.prepare("SELECT status, ready_event FROM job_applications").first<{ status: string; ready_event: string }>();
		expect(record?.status).toBe("materials_ready");
		expect(JSON.parse(record!.ready_event).artifacts.resume.cloud.fileId).toBeTruthy();
		expect(record?.ready_event).not.toContain("contentBase64");
	});
	it("publishes regenerated materials with a new delivery identity after an earlier ready event", async () => {
		serveCompletedRun(); await sync();
		const previous = (await getApplication(env(), "tailor", "owner", "application"))!;
		d1.exec("UPDATE job_applications SET status='blocked', ready_emitted_at=2000, fill_run_id='old-fill'");
		expect(await moveApplication(env(), { ...previous, status: "blocked" }, "owner", { to: "tailoring", actor: "owner", reason: "retry_tailoring" }, 3000)).toBe(true);
		d1.exec("INSERT INTO local_artifact_runs (id,instance_id,user_id,application_id,request_id,status,policy,created_at,updated_at,started_at) SELECT 'tailor-run-2',instance_id,user_id,application_id,'retry','running',policy,3000,3000,3000 FROM local_artifact_runs WHERE id='tailor-run'; UPDATE job_applications SET tailoring_run_id='tailor-run-2'");
		exportCall.mockImplementation(async (_env: unknown, _runtime: unknown, path: string) => path === "/local-artifact/status"
			? Response.json({ state: "ended", lastSeq: 0, events: [], result: { ...result, runId: "tailor-run-2" } })
			: Response.json({ runId: "tailor-run-2", instanceId: "tailor", documents: docs }));
		await syncTailorRun(env(), "owner", (await getTailorRun(env(), "tailor", "owner", "tailor-run-2"))!, 4000);
		const next = (await getApplication(env(), "tailor", "owner", "application"))!;
		expect(next.status).toBe("materials_ready");
		expect(next.readyEvent?.eventId).toContain("tailor-run-2");
		expect(next.readyEvent?.eventId).not.toBe(previous.readyEvent?.eventId);
		expect(next.fillRunId).toBeNull();
	});
	it("ends permanent mismatches and bounds transient retries by original run time", async () => {
		serveCompletedRun(); docs[0].sha256 = "a".repeat(64);
		expect(await sync()).toMatchObject({ status: "failed", errorCode: "cloud_documents_unavailable" });
		expect(await d1.DB.prepare("SELECT status, ready_event FROM job_applications").first()).toEqual({ status: "blocked", ready_event: null });
		d1.exec("UPDATE local_artifact_runs SET status='running'; UPDATE job_applications SET status='tailoring'");
		exportCall.mockImplementation(async (_env: unknown, _runtime: unknown, path: string) => path === "/local-artifact/status"
			? Response.json({ state: "ended", lastSeq: 0, events: [], result }) : Response.json({}, { status: 503 }));
		expect(await sync(5000)).toMatchObject({ status: "running" });
		expect(await sync(1_202_000)).toMatchObject({ status: "failed", errorCode: "cloud_documents_unavailable" });
	});
	it("persists the validated result durably BEFORE attempting Files storage, so it survives a crash mid-upload (#1469)", async () => {
		serveCompletedRun(); failUpload = 2;
		expect(await sync()).toMatchObject({ status: "running", errorCode: "cloud_documents_pending" });
		// Still non-terminal (storage never finished), but the result that WOULD finish it is
		// already durable — the whole point: a restart before this point still has it.
		const row = await d1.DB.prepare("SELECT result FROM local_artifact_runs WHERE id = ?1").bind(run.id).first<{ result: string }>();
		expect(JSON.parse(row!.result)).toMatchObject({ runId: run.id, outcome: "completed" });
	});
	it("recovers a completed run from its durably persisted result when the runner 404s having lost it — Files already complete, never re-fetched (#1469)", async () => {
		await persist(); // Files fully persisted, as if an earlier attempt got this far...
		await updateTailorRun(env(), (await getTailorRun(env(), "tailor", "owner", run.id))!, { result }, 1000); // ...and its result was durably recorded (settleFromResult's own first step) ...
		// ...but the crash landed before THIS run ever reached `updateTailorRun({ to: "completed", ... })` — it is still "running".
		expect((await getTailorRun(env(), "tailor", "owner", run.id))!.status).toBe("running");
		const uploadsBeforeRecovery = uploads;
		exportCall.mockImplementation(async (_env: unknown, _runtime: unknown, path: string) => path === "/local-artifact/status" ? Response.json({}, { status: 404 }) : Response.json({ error: "should not be called" }, { status: 500 }));
		const recovered = await sync(5000);
		expect(recovered).toMatchObject({ status: "completed", errorCode: null, error: null });
		expect(uploads).toBe(uploadsBeforeRecovery); // the documents endpoint was never asked again
		const app2 = (await getApplication(env(), "tailor", "owner", "application"))!;
		expect(app2.status).toBe("materials_ready");
		expect(app2.readyEvent?.artifacts).toBeTruthy();
		expect(JSON.stringify(app2.readyEvent)).not.toContain("contentBase64");
	});
	it("still ends the run runner_lost on a 404 when no result was ever durably recorded — nothing to recover from (#1469)", async () => {
		exportCall.mockImplementation(async () => Response.json({}, { status: 404 }));
		expect(await sync()).toMatchObject({ status: "failed", errorCode: "runner_lost" });
		expect(await d1.DB.prepare("SELECT status, block_reason FROM job_applications").first()).toEqual({ status: "blocked", block_reason: "runner_lost" });
	});
	it("refuses closed rather than silently succeeding when a durable result exists but its documents never finished storing (#1469)", async () => {
		await updateTailorRun(env(), (await getTailorRun(env(), "tailor", "owner", run.id))!, { result }, 1000); // the result arrived and was recorded...
		// ...but NOTHING was ever uploaded (the crash landed before persistCloudDocuments did any
		// work at all) — application_documents is empty, so the recovery check cannot shortcut, and
		// re-asking the (now 404ing) runner for the documents fails the same way a live mismatch would.
		expect((await d1.DB.prepare("SELECT COUNT(*) AS n FROM application_documents").first<{ n: number }>())!.n).toBe(0);
		exportCall.mockImplementation(async () => Response.json({}, { status: 404 }));
		const settled = await sync(5000);
		expect(settled).toMatchObject({ status: "failed", errorCode: "cloud_documents_unavailable" });
		expect(await d1.DB.prepare("SELECT status, block_reason FROM job_applications").first()).toEqual({ status: "blocked", block_reason: "cloud_documents_unavailable" });
	});
	it.each([false, true])("hydrates exact cloud bytes on dispatch (queued=%s)", async (queued) => {
		serveCompletedRun(); await sync();
		runtimeVersion.value = "0.4.209";
		exportCall.mockImplementation(async (_env: unknown, _runtime: unknown, path: string) => path === "/local-apply/run"
			? Response.json(queued ? { error: "Runner is busy", code: "busy" } : { status: "running" }, { status: queued ? 409 : 202 }) : Response.json({}));
		const started = await startApplicationFill(env(), "apply", "owner", { eventId: "ready", applicationId: "application", tailorInstanceId: "tailor" }, "owner", { review: true });
		if (queued) {
			expect(started.run?.status).toBe("queued");
			exportCall.mockImplementation(async () => Response.json({ status: "running" }, { status: 202 }));
			d1.exec("UPDATE local_apply_runs SET next_attempt_at=0");
			expect(await dispatchNextQueuedFill(env(), "apply", "owner", Date.now() + 60_000)).toBe("dispatched");
		}
		const calls = exportCall.mock.calls.filter((args) => args[2] === "/local-apply/run");
		const envelope = JSON.parse(calls.at(-1)![3].body);
		expect(envelope.cloudDocuments.map((d: PortableDocument) => d.sha256).sort()).toEqual(docs.map((d) => d.sha256).sort());
		expect(envelope.policy.mode).toBe("fill_and_review");
		expect(JSON.stringify(await d1.DB.prepare("SELECT * FROM local_apply_runs").all())).not.toContain("contentBase64");
	});
});

it("refuses nonpositive lengths and cancels an oversized Files stream before reading it fully", async () => {
	const cancel = vi.fn();
	let pulled = 0;
	const engine = { fileGet: async () => ({ meta: { userId: "owner", r2Version: "v", originalSha256: "a", size: 1 }, body: new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(2)); }, cancel }) }) };
	const request = (bytes: number) => new Request("https://agent/file", { method: "POST", body: JSON.stringify({ user_id: "owner", version: "v", sha256: "a", bytes }) });
	expect((await materializeApplicationDocument(engine as never, "id", request(-1))).status).toBe(400);
	expect((await materializeApplicationDocument(engine as never, "id", request(1))).status).toBe(409);
	expect(cancel).toHaveBeenCalledOnce(); expect(pulled).toBeLessThan(4);
});
