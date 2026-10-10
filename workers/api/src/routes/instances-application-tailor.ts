/**
 * Application Tailor (#956) — settings and the application records it produces.
 *
 * Tailoring normally starts from a connection: the Scout's `job.lead.apply_requested` (#955)
 * routed to this instance with the `generate_application_materials` action. `POST …/applications`
 * is the same start path for an owner (or a test) holding the event; replaying either returns the
 * existing application. Reading an application pulls its run from the runner first (#944's PULL —
 * the runner cannot reach the API).
 *
 * Owner-scoped throughout; every store call is `user_id`-scoped as well. Responses carry artifact
 * HANDLES (owner-visible path + sha256), never résumé or profile content.
 */
import type { Context, Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { readInstanceConfigPair, patchInstanceConfig } from "../lib/instance-config.js";
import { cancelTailoring, startTailoring, syncTailorRun } from "../lib/local-artifact/tailor.js";
import {
	APPLICATION_STATUSES,
	type ApplicationStatus,
	TAILOR_DEFAULTS,
	TAILOR_SETTINGS_KEY,
	effectiveTailorSettings,
	getApplication,
	getTailorRun,
	listApplications,
	mergeTailorSettings,
} from "../lib/local-artifact/store.js";
import {
	clearUploadedTailorSource,
	isUploadedTailorSourceRole,
	listUploadedTailorSourceSelections,
	selectUploadedTailorSource,
	type UploadedTailorFileSnapshot,
} from "../lib/local-artifact/uploaded-sources.js";
import type { Env } from "../types.js";
import { getLiveRuntime, requireOwnedInstance } from "./instances-runtime.js";

type C = Context<{ Bindings: Env }>;

async function owned(c: C): Promise<{ uid: string; instanceId: string }> {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId") ?? "";
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return { uid: session.uid, instanceId };
}


async function storedSettings(c: C, instanceId: string, uid: string): Promise<unknown> {
	const pair = await readInstanceConfigPair(c.env, instanceId, uid);
	return (pair?.config as Record<string, unknown> | undefined)?.[TAILOR_SETTINGS_KEY];
}

const FILE_EXTRACTION_STATUSES = ["none", "extracted", "unsupported", "failed"] as const;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * The Agent DO remains the source of truth for Files. Selection is allowed only from the owned
 * instance's user-filtered list, never from a file name or an R2 key supplied by the client.
 */
async function ownedUploadedFiles(c: C, instanceId: string, uid: string): Promise<UploadedTailorFileSnapshot[]> {
	if (!c.env.AGENT) throw new HttpError(503, "Instance Files are unavailable");
	const response = await c.env.AGENT.get(c.env.AGENT.idFromName(instanceId)).fetch(
		new Request(`https://agent/files?user_id=${encodeURIComponent(uid)}`),
	);
	if (!response.ok) throw new HttpError(503, "Could not verify the selected uploaded file");
	const body = await response.json().catch(() => null) as { files?: unknown } | null;
	if (!Array.isArray(body?.files)) throw new HttpError(503, "Could not verify the selected uploaded file");
	const optionalLength = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
	return body.files.flatMap((raw) => {
		if (!raw || typeof raw !== "object") return [];
		const file = raw as Record<string, unknown>;
		if (typeof file.id !== "string" || typeof file.name !== "string" || typeof file.mimeType !== "string" || typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.createdAt !== "string" || typeof file.updatedAt !== "string") return [];
		const extractionStatus = typeof file.extractionStatus === "string" && (FILE_EXTRACTION_STATUSES as readonly string[]).includes(file.extractionStatus)
			? file.extractionStatus as UploadedTailorFileSnapshot["extractionStatus"]
			: undefined;
		return [{
			id: file.id,
			name: file.name,
			mimeType: file.mimeType,
			size: file.size,
			...(extractionStatus ? { extractionStatus } : {}),
			...(optionalLength(file.extractedTextLength) === undefined ? {} : { extractedTextLength: optionalLength(file.extractedTextLength) }),
			...(optionalLength(file.indexedTextLength) === undefined ? {} : { indexedTextLength: optionalLength(file.indexedTextLength) }),
			...(file.textTruncated === true ? { textTruncated: true } : {}),
			...(typeof file.extractionError === "string" ? { extractionError: file.extractionError } : {}),
			...(typeof file.r2Version === "string" && file.r2Version ? { fileVersion: file.r2Version } : {}),
			...(typeof file.r2Etag === "string" && file.r2Etag ? { fileEtag: file.r2Etag } : {}),
			...(typeof file.originalSha256 === "string" && SHA256_HEX.test(file.originalSha256) ? { originalSha256: file.originalSha256 } : {}),
			...(typeof file.extractedTextSha256 === "string" && SHA256_HEX.test(file.extractedTextSha256) ? { extractedTextSha256: file.extractedTextSha256 } : {}),
			...(typeof file.extractedAt === "string" ? { extractedAt: file.extractedAt } : {}),
			createdAt: file.createdAt,
			updatedAt: file.updatedAt,
		}];
	});
}

async function ownedUploadedFile(c: C, instanceId: string, uid: string, fileId: unknown): Promise<UploadedTailorFileSnapshot> {
	if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(fileId)) throw new HttpError(400, "fileId must be an uploaded file id");
	const file = (await ownedUploadedFiles(c, instanceId, uid)).find((candidate) => candidate.id === fileId);
	if (!file) throw new HttpError(404, "Uploaded file not found on this instance");
	return file;
}

function sourceBlockers(selected: UploadedTailorFileSnapshot | undefined, live: UploadedTailorFileSnapshot | undefined): string[] {
	if (!selected) return ["not_selected"];
	if (!live) return ["file_deleted"];
	if (live.name !== selected.name || live.mimeType !== selected.mimeType || live.size !== selected.size || live.createdAt !== selected.createdAt || live.updatedAt !== selected.updatedAt || live.fileVersion !== selected.fileVersion || live.fileEtag !== selected.fileEtag || live.originalSha256 !== selected.originalSha256 || live.extractedTextSha256 !== selected.extractedTextSha256) return ["file_changed_reselect_required"];
	if (live.extractionStatus !== "extracted") return [live.extractionStatus === "failed" ? "extraction_failed" : "extraction_unavailable"];
	if (live.textTruncated) return ["extracted_text_truncated"];
	if (!live.extractedTextLength) return ["extracted_text_empty"];
	if (!live.fileVersion || !live.originalSha256 || !live.extractedTextSha256 || !live.extractedAt) return ["provenance_unavailable"];
	return [];
}

export function registerApplicationTailorRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/application-tailor/settings", async (c) => {
		const { uid, instanceId } = await owned(c);
		const effective = effectiveTailorSettings(await storedSettings(c, instanceId, uid));
		return c.json("error" in effective ? { settings: TAILOR_DEFAULTS, error: effective.error } : { settings: effective.settings });
	});

	/** Patch semantics: only the fields sent change; a source set to null/"" is removed. */
	router.put("/:instanceId/application-tailor/settings", async (c) => {
		const { uid, instanceId } = await owned(c);
		const current = effectiveTailorSettings(await storedSettings(c, instanceId, uid));
		const merged = mergeTailorSettings("error" in current ? TAILOR_DEFAULTS : current.settings, await c.req.json().catch(() => null));
		if ("error" in merged) return c.json({ error: merged.error }, 400);
		await patchInstanceConfig(c.env, instanceId, uid, TAILOR_SETTINGS_KEY, merged.settings);
		return c.json({ settings: merged.settings });
	});

	/** Read the owner-approved uploaded Files choices. This never starts a tailoring run. */
	router.get("/:instanceId/application-tailor/uploaded-sources", async (c) => {
		const { uid, instanceId } = await owned(c);
		return c.json({ sources: await listUploadedTailorSourceSelections(c.env, instanceId, uid) });
	});

	/**
	 * Read-only readiness for uploaded mode. It re-reads the owning DO every time, so deletion or
	 * changed File metadata is visible before any future materialization/run path exists.
	 */
	router.get("/:instanceId/application-tailor/uploaded-sources/readiness", async (c) => {
		const { uid, instanceId } = await owned(c);
		const selections = await listUploadedTailorSourceSelections(c.env, instanceId, uid);
		const live = await ownedUploadedFiles(c, instanceId, uid);
		const runner = await getLiveRuntime(c.env, instanceId, uid);
		const byRole = new Map(selections.map((source) => [source.role, source]));
		const sources = (["resume", "profile"] as const).map((role) => {
			const selected = byRole.get(role);
			const current = selected ? live.find((file) => file.id === selected.id) : undefined;
			const blockers = sourceBlockers(selected, current);
			// No source bytes have a runner transfer route yet. Saying that explicitly prevents the
			// selection API from looking like consent to run with an unmaterialized document.
			return {
				role,
				selected: selected ?? null,
				uploaded: !!current,
				extracted: current?.extractionStatus === "extracted",
				availableToRunner: false,
				ready: false,
				isStale: blockers.some((blocker) => blocker === "file_deleted" || blocker === "file_changed_reselect_required"),
				provenance: current ? {
					filename: current.name, fileId: current.id, version: current.fileVersion ?? null,
					originalHash: current.originalSha256 ?? null, extractedHash: current.extractedTextSha256 ?? null,
					extractedAt: current.extractedAt ?? null,
				} : null,
				blockers: [...blockers, "materialization_unsupported"],
			};
		});
		const blockers = [...sources.flatMap((source) => source.blockers.map((blocker) => `${source.role}:${blocker}`)), ...(runner ? [] : ["runner_unavailable"])] as string[];
		return c.json({ mode: "uploaded", sources, runner: { available: !!runner }, ready: false, blockers });
	});

	/** Select one exact uploaded Instance File for a required source role. */
	router.put("/:instanceId/application-tailor/uploaded-sources/:role", async (c) => {
		const { uid, instanceId } = await owned(c);
		const role = c.req.param("role");
		if (!isUploadedTailorSourceRole(role)) throw new HttpError(400, "role must be resume or profile");
		const body = await c.req.json().catch(() => null) as { fileId?: unknown } | null;
		const file = await ownedUploadedFile(c, instanceId, uid, body?.fileId);
		const source = await selectUploadedTailorSource(c.env, { instanceId, userId: uid, role, file, now: Date.now() });
		return c.json({ source });
	});

	/** Clearing a role is an explicit owner action; it cannot silently choose another uploaded file. */
	router.delete("/:instanceId/application-tailor/uploaded-sources/:role", async (c) => {
		const { uid, instanceId } = await owned(c);
		const role = c.req.param("role");
		if (!isUploadedTailorSourceRole(role)) throw new HttpError(400, "role must be resume or profile");
		const cleared = await clearUploadedTailorSource(c.env, instanceId, uid, role);
		return c.json({ cleared });
	});

	router.get("/:instanceId/applications", async (c) => {
		const { uid, instanceId } = await owned(c);
		const status = c.req.query("status");
		if (status && !APPLICATION_STATUSES.includes(status as ApplicationStatus)) return c.json({ error: `status must be one of ${APPLICATION_STATUSES.join(", ")}` }, 400);
		const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
		const applications = await listApplications(c.env, instanceId, uid, { status: status as ApplicationStatus | undefined, limit });
		return c.json({ applications, limit, ...(applications.length === limit ? { note: `Showing the newest ${limit}; pass ?limit= (max 200) or ?status= to see others.` } : {}) });
	});

	/** Start tailoring from an approved lead event — `{ event }`, or the event itself as the body. */
	router.post("/:instanceId/applications", async (c) => {
		const { uid, instanceId } = await owned(c);
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		const event = body && typeof body.event === "object" ? body.event : body;
		const out = await startTailoring(c.env, instanceId, uid, event, "owner");
		return c.json({ outcome: out.kind, application: out.application, run: out.run }, out.kind === "existing" ? 200 : 201);
	});

	router.get("/:instanceId/applications/:applicationId", async (c) => {
		const { uid, instanceId } = await owned(c);
		let application = await getApplication(c.env, instanceId, uid, c.req.param("applicationId"));
		if (!application) throw new HttpError(404, "Application not found");
		let run = application.tailoringRunId ? await getTailorRun(c.env, instanceId, uid, application.tailoringRunId) : null;
		if (run?.status === "running") {
			run = await syncTailorRun(c.env, uid, run);
			application = (await getApplication(c.env, instanceId, uid, application.id)) ?? application;
		}
		return c.json({ application, run });
	});

	/** Stop tailoring. Touches PAGS records and the local CLI only — nothing external. */
	router.post("/:instanceId/applications/:applicationId/cancel", async (c) => {
		const { uid, instanceId } = await owned(c);
		const application = await getApplication(c.env, instanceId, uid, c.req.param("applicationId"));
		if (!application) throw new HttpError(404, "Application not found");
		const run = application.tailoringRunId ? await getTailorRun(c.env, instanceId, uid, application.tailoringRunId) : null;
		if (!run) throw new HttpError(409, `Nothing to cancel: the application is ${application.status}`);
		const cancelled = await cancelTailoring(c.env, uid, run);
		return c.json({ application: await getApplication(c.env, instanceId, uid, application.id), run: cancelled });
	});
}
