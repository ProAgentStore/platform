/** #1586: tailored applications are mirrored to the Jobs app by the platform, and a Jobs failure never blocks anything. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "../d1-sqlite.js";
import { sha256Hex } from "../../agent-storage-utils.js";
import { materializeApplicationDocument } from "../../agent-document-routes.js";
import type { Env } from "../../types.js";
import type { LocalArtifactResultEnvelope } from "./contract.js";
import type { PortableDocument } from "./document-contract.js";
import type { TailorRun } from "./store.js";
import { pipelineHealth } from "../applications/pipeline-health.js";

const { exportCall } = vi.hoisted(() => ({ exportCall: vi.fn() }));
vi.mock("../../routes/instances-runtime.js", () => ({ callRuntime: exportCall, runtimeJson: (r: Response) => r.json() }));
const calls: Array<{ tool: string; args: Record<string, unknown>; instanceId: string }> = [];
let outcome: { ok: true } | { ok: false; reason: "failed" | "no_grant"; detail: string } = { ok: true };
vi.mock("../jobs-app.js", () => ({
	callJobsTool: async (_env: unknown, who: { instanceId: string }, tool: string, args: Record<string, unknown>) => {
		calls.push({ tool, args, instanceId: who.instanceId });
		return outcome;
	},
}));
const { persistCloudDocuments } = await import("./cloud-documents.js");
const { moveApplication } = await import("../local-apply/store.js");
const { settleApplication, setApplicationMirror } = await import("./store.js");
const { syncApplicationToJobs, syncPendingToJobs, JOBS_SYNC_RETRY_MS } = await import("../jobs-tailored.js");
setApplicationMirror(syncApplicationToJobs); // what index.ts does at startup

let d1: RealSchemaD1;
let files: Map<string, { meta: Record<string, unknown>; bytes: Uint8Array }>;
let uploads = 0;
const run = { id: "tailor-run", instanceId: "tailor", applicationId: "application" } as TailorRun;
const env = () => ({ DB: d1.DB, AGENT: {
	idFromName: (id: string) => id,
	get: (instance: string) => ({ fetch: async (req: Request) => {
		const url = new URL(req.url);
		if (url.pathname === "/files") {
			uploads++;
			const body = await req.json<{ name: string; contentBase64: string; mime_type: string; user_id: string }>();
			const bytes = Uint8Array.from(atob(body.contentBase64), (c) => c.charCodeAt(0));
			const meta = { id: `file-${uploads}`, name: body.name, userId: body.user_id, mimeType: body.mime_type, r2Version: `v-${uploads}`, originalSha256: await sha256Hex(bytes), size: bytes.length };
			files.set(`${instance}/${meta.id}`, { meta, bytes });
			return Response.json(meta, { status: 201 });
		}
		if (url.pathname.startsWith("/job-leads/")) return Response.json({});
		const id = url.pathname.split("/")[2];
		return materializeApplicationDocument({ fileGet: async () => {
			const file = files.get(`${instance}/${id}`);
			return file ? { meta: file.meta, body: new Response(file.bytes).body } : null;
		} } as never, id, req);
	} }),
} }) as unknown as Env;

/** An application settled `materials_ready` with its exact documents stored, through the real settle path. */
async function readyApplication() {
	const docs: PortableDocument[] = await Promise.all((["resume", "cover_letter", "profile"] as const).map(async (role) => {
		const bytes = new TextEncoder().encode(`Synthetic ${role} text\n`);
		return { role, name: `${role}.md`, mimeType: "text/markdown" as const, bytes: bytes.length, sha256: await sha256Hex(bytes), contentBase64: btoa(String.fromCharCode(...bytes)) };
	}));
	const result: LocalArtifactResultEnvelope = { runId: run.id, outcome: "completed", traceId: run.id, engineAuth: "machine-login", profileVersion: "v", artifacts: docs.slice(0, 2).map((d) => ({ kind: d.role as "resume" | "cover_letter", path: `~/jobs/${d.name}`, sha256: d.sha256, bytes: d.bytes })), sourceHashes: [{ role: "profile", path: "~/profile.md", sha256: docs[2].sha256, bytes: docs[2].bytes }] };
	exportCall.mockImplementation(async () => Response.json({ runId: run.id, instanceId: run.instanceId, documents: docs }));
	await persistCloudDocuments(env(), {} as never, "owner", run, result, 1);
	await settleApplication(env(), "tailor", "owner", "application", run.id, { to: "materials_ready", resumeArtifact: result.artifacts[0], coverLetterArtifact: result.artifacts[1], profileVersion: "v", generatedAt: "2026-11-07T00:00:00Z" }, 2000);
}

beforeEach(() => {
	calls.length = 0;
	outcome = { ok: true };
	files = new Map();
	uploads = 0;
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users(id, github_login) VALUES ('owner', 'owner');
	INSERT INTO agents(id, owner_id, slug, name, config) VALUES ('tailor-agent','owner','tailor','Tailor','{"capabilities":{"runtime":"local_artifact","surfaces":[]}}');
	INSERT INTO agent_instances(id, agent_id, user_id, status, config) VALUES ('tailor','tailor-agent','owner','active','{}'), ('apply','tailor-agent','owner','active','{}');
	INSERT INTO job_applications(id, instance_id, user_id, source_instance_id, lead_id, lifecycle_version, idempotency_key, status, lead, tailoring_run_id, created_at, updated_at)
	VALUES ('application','tailor','owner','scout','lead',1,'request','tailoring','{"leadUrl":"https://jobs.example.com/job","lead":{"title":"Engineer","company":"Acme","location":"Melbourne"}}','tailor-run',1000,1000);
	INSERT INTO local_artifact_runs(id, instance_id, user_id, application_id, request_id, status, policy, created_at, updated_at, started_at)
	VALUES ('tailor-run','tailor','owner','application','request','running','{"cloudDocuments":true,"maxMinutes":10,"engine":"codex","authMode":"machine","workspace":"~/jobs","sources":[],"retainDays":0}',1000,1000,1000);
	INSERT INTO owner_decisions(id, instance_id, user_id, subject_kind, subject_id, scope, question, answer, answered_via, asked_at, answered_at, history)
	VALUES ('d1','apply','owner','apply_run','run','application','Work rights?','Citizen','console',1,2,'[]');`);
});
afterEach(() => d1.close());

describe("tailoring completion -> Jobs save_tailored_application", () => {
	it("materials_ready causes exactly one save, as the Tailor, with the lead, texts, file names and answers", async () => {
		await readyApplication();
		expect(calls).toHaveLength(1); // made by settling itself
		await syncApplicationToJobs(env(), "owner", "application"); // a repeat changes nothing
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ tool: "save_tailored_application", instanceId: "tailor" });
		expect(calls[0].args).toEqual({
			external_id: "application",
			source_url: "https://jobs.example.com/job",
			title: "Engineer",
			company_name: "Acme",
			location: "Melbourne",
			resume_md: "Synthetic resume text\n",
			cover_letter_md: "Synthetic cover_letter text\n",
			answers: JSON.stringify([{ question: "Work rights?", answer: "Citizen" }]),
			resume_file_name: expect.stringMatching(/resume/),
			cover_letter_file_name: expect.stringMatching(/cover/),
		});
	});

	it("a Jobs error does not fail tailoring; it is recorded, shown in pipeline health, and retried by the sweep", async () => {
		outcome = { ok: false, reason: "failed", detail: "Jobs is down" };
		await readyApplication(); // settle itself must not throw
		const row = () => d1.sqlite.prepare("SELECT status, jobs_synced_key AS k, jobs_sync_error AS e FROM job_applications WHERE id='application'").get() as { status: string; k: string | null; e: string | null };
		expect(row()).toMatchObject({ status: "materials_ready", k: null });
		expect(row().e).toContain("Jobs is down");
		const health = await pipelineHealth(env(), "owner", { scouts: [], tailors: ["tailor"], runners: [] }, [], Date.now());
		expect(health.problems.map((p) => p.code)).toContain("jobs_sync_failing");
		d1.exec(`UPDATE job_applications SET updated_at = ${Date.now()}`); // the fixture settles at epoch 2000, outside the sweep window
		outcome = { ok: true };
		expect(await syncPendingToJobs(env(), Date.now() + 1000)).toBe(0); // backed off
		expect(await syncPendingToJobs(env(), Date.now() + JOBS_SYNC_RETRY_MS + 1000)).toBe(1);
		expect(row()).toMatchObject({ k: "tailor-run|materials_ready", e: null });
	});

	it("an instance with no grant is quiet: nothing fails and health stays clean", async () => {
		outcome = { ok: false, reason: "no_grant", detail: "no grant" };
		await readyApplication();
		const health = await pipelineHealth(env(), "owner", { scouts: [], tailors: ["tailor"], runners: [] }, [], Date.now());
		expect(health.problems.map((p) => p.code)).not.toContain("jobs_sync_failing");
	});
});

describe("Runner outcome -> Jobs set_tailored_status", () => {
	it("a confirmed submit sets status submitted with submitted_at, after the save", async () => {
		await readyApplication();
		calls.length = 0;
		const get = async () => (await d1.DB.prepare("SELECT id, status, state_version AS stateVersion FROM job_applications WHERE id='application'").first()) as { id: string; status: "materials_ready"; stateVersion: number };
		await moveApplication(env(), await get(), "owner", { to: "filling", actor: "runner", actorInstanceId: "apply", runId: "fill", bindRun: "fill" }, 3000);
		await moveApplication(env(), await get() as never, "owner", { to: "submitted", actor: "runner", actorInstanceId: "apply", runId: "fill", expectRun: "fill", submitted: { at: "2026-11-07T01:02:03.000Z", url: "https://jobs.example.com/done" } }, 4000);
		const status = calls.filter((c) => c.tool === "set_tailored_status");
		expect(status).toHaveLength(1);
		expect(status[0]).toMatchObject({ instanceId: "tailor", args: { external_id: "application", status: "submitted", submitted_at: Date.parse("2026-11-07T01:02:03.000Z") } });
		expect(calls.map((c) => c.tool)).toEqual(["save_tailored_application", "set_tailored_status"]);
	});

	it("an archive sets status archived with the reason", async () => {
		await readyApplication();
		calls.length = 0;
		const app = (await d1.DB.prepare("SELECT id, status, state_version AS stateVersion FROM job_applications WHERE id='application'").first()) as never;
		await moveApplication(env(), app, "owner", { to: "archived", actor: "owner", actorInstanceId: "tailor", reason: "not_interested" }, 3000);
		expect(calls.find((c) => c.tool === "set_tailored_status")?.args).toMatchObject({ status: "archived", note: "not_interested" });
	});

	it("a Jobs error does not fail the submission", async () => {
		await readyApplication();
		outcome = { ok: false, reason: "failed", detail: "Jobs is down" };
		const get = async () => (await d1.DB.prepare("SELECT id, status, state_version AS stateVersion FROM job_applications WHERE id='application'").first()) as never;
		await moveApplication(env(), await get(), "owner", { to: "filling", actor: "runner", runId: "fill", bindRun: "fill" }, 3000);
		const moved = await moveApplication(env(), await get(), "owner", { to: "submitted", actor: "runner", runId: "fill", expectRun: "fill", submitted: { at: "2026-11-07T01:02:03.000Z", url: "https://x.example/done" } }, 4000);
		expect(moved).toBe(true);
		expect((d1.sqlite.prepare("SELECT status FROM job_applications WHERE id='application'").get() as { status: string }).status).toBe("submitted");
	});
});
