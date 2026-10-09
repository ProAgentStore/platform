/**
 * The DO routes that are nothing but the storage engine — collections, records, files,
 * vector search, activity, summaries, user context.
 *
 * Each one is a pure function of (engine, input) → Response: it reads no DO state, holds
 * none of its own, and never touches the conversation, the in-flight turn markers or the
 * WebSockets. That is why it can live outside AgentDO — the caller resolves the engine (and
 * answers 404 for an uninitialised DO), these decide the request shape, the status codes and
 * the response body. Each takes the NARROWEST slice of the engine it uses (`Pick<…>`), so a
 * test can hand it a two-line fake instead of a Durable Object.
 *
 * The `https://agent/*` route contract is unchanged: the paths and methods still live in the
 * one routing table in `agent-do.ts`.
 */
import type { AgentStorageEngine } from "./agent-storage.js";
import { decodeBase64Upload, guessMimeType } from "./agent-storage-utils.js";
import type { ActivityEvent, CollectionField } from "./agent-storage-types.js";
import { json } from "./lib/do-json.js";
import {
	JOB_LEAD_COLLECTION,
	JOB_LEAD_TRIAGE_ACTIONS,
	duplicateApplyOf,
	jobLeadStatus,
	jobLeadVersion,
	planApplicationWriteback,
	planJobLeadTriage,
	type JobLeadTriageAction,
} from "./lib/job-lead-triage.js";
import type { CollectionRecord } from "./agent-storage-types.js";

// ── Collections ─────────────────────────────────────────────────────────────

export async function listCollections(
	engine: Pick<AgentStorageEngine, "collectionList">,
): Promise<Response> {
	const collections = await engine.collectionList();
	return json({ collections });
}

export async function createCollection(
	engine: Pick<AgentStorageEngine, "collectionCreate">,
	request: Request,
): Promise<Response> {
	const { name, fields } = await request.json<{ name: string; fields: unknown[] }>();
	if (!name || !fields) return json({ error: "name and fields required" }, 400);
	const schema = await engine.collectionCreate(name, fields as CollectionField[]);
	return json(schema, 201);
}

export async function getCollection(
	engine: Pick<AgentStorageEngine, "collectionGet">,
	name: string,
): Promise<Response> {
	const schema = await engine.collectionGet(decodeURIComponent(name));
	return schema ? json(schema) : json({ error: "Not found" }, 404);
}

export async function deleteCollection(
	engine: Pick<AgentStorageEngine, "collectionDelete">,
	name: string,
): Promise<Response> {
	await engine.collectionDelete(decodeURIComponent(name));
	return json({ success: true });
}

// ── Records ─────────────────────────────────────────────────────────────────

export async function queryRecords(
	engine: Pick<AgentStorageEngine, "recordQuery">,
	collection: string,
	url: URL,
): Promise<Response> {
	const where = url.searchParams.get("where");
	const result = await engine.recordQuery(decodeURIComponent(collection), {
		where: where ? JSON.parse(where) : undefined,
		orderBy: url.searchParams.get("order_by") || undefined,
		orderDir: (url.searchParams.get("order_dir") as "asc" | "desc") || undefined,
		limit: Number(url.searchParams.get("limit")) || 50,
		offset: Number(url.searchParams.get("offset")) || 0,
	});
	return json(result);
}

export async function insertRecord(
	engine: Pick<AgentStorageEngine, "recordInsert"> & Partial<Pick<AgentStorageEngine, "recordCreateOrGetJobLead">>,
	collection: string,
	request: Request,
): Promise<Response> {
	const { data } = await request.json<{ data: Record<string, unknown> }>();
	if (!data) return json({ error: "data required" }, 400);
	if (decodeURIComponent(collection) === JOB_LEAD_COLLECTION) {
		// Route/unit seams predating the specialized engine pass only recordInsert. Production
		// AgentStorageEngine always exposes the idempotent method; retaining this narrow fallback
		// keeps those storage-only fakes from claiming a concurrency guarantee they cannot model.
		if (!engine.recordCreateOrGetJobLead) return json(await engine.recordInsert(JOB_LEAD_COLLECTION, data), 201);
		const result = await engine.recordCreateOrGetJobLead(data);
		// A duplicate is successful but deliberately not a second mutation.  200 makes that
		// distinction observable to source ingest without requiring a follow-up read.
		return json({ ...result.record, created: result.created }, result.created ? 201 : 200);
	}
	const record = await engine.recordInsert(decodeURIComponent(collection), data);
	return json(record, 201);
}

export async function getRecord(
	engine: Pick<AgentStorageEngine, "recordGet">,
	collection: string,
	id: string,
): Promise<Response> {
	const record = await engine.recordGet(decodeURIComponent(collection), decodeURIComponent(id));
	return record ? json(record) : json({ error: "Not found" }, 404);
}

export async function updateRecord(
	engine: Pick<AgentStorageEngine, "recordUpdate">,
	collection: string,
	id: string,
	request: Request,
): Promise<Response> {
	const { data } = await request.json<{ data: Record<string, unknown> }>();
	if (!data) return json({ error: "data required" }, 400);
	const record = await engine.recordUpdate(
		decodeURIComponent(collection),
		decodeURIComponent(id),
		data,
	);
	return record ? json(record) : json({ error: "Not found" }, 404);
}

export async function deleteRecord(
	engine: Pick<AgentStorageEngine, "recordDelete">,
	collection: string,
	id: string,
): Promise<Response> {
	const deleted = await engine.recordDelete(
		decodeURIComponent(collection),
		decodeURIComponent(id),
	);
	return deleted ? json({ success: true }) : json({ error: "Not found" }, 404);
}

/**
 * Apply one explicit human triage decision to a Job Search Scout lead.
 *
 * This is deliberately not folded into `updateRecord`: an ordinary collection update must never
 * create an application handoff. Because it runs inside the instance's Durable Object, the
 * read → lifecycle validation → write is serialized with every other write to that instance.
 */
export async function triageJobLead(
	engine: Pick<AgentStorageEngine, "recordGet" | "recordUpdate" | "recordQuery">,
	id: string,
	request: Request,
): Promise<Response> {
	const body = await request.json<{ action?: unknown; defer_until?: unknown; note?: unknown; expected_status?: unknown; expected_version?: unknown; source_instance_id?: unknown }>();
	if (typeof body.action !== "string" || !JOB_LEAD_TRIAGE_ACTIONS.includes(body.action as JobLeadTriageAction)) {
		return json({ error: `action must be one of ${JOB_LEAD_TRIAGE_ACTIONS.join(", ")}` }, 400);
	}
	if (body.expected_version !== undefined && !(typeof body.expected_version === "number" && Number.isInteger(body.expected_version) && body.expected_version >= 0)) {
		return json({ error: "expected_version must be the lead's lifecycle_version — a whole number from 0" }, 400);
	}
	// The instance this DO serves, named by the authenticated route (#955) — the event's source.
	if (typeof body.source_instance_id !== "string" || !body.source_instance_id) return json({ error: "source_instance_id required" }, 400);
	const record = await engine.recordGet(JOB_LEAD_COLLECTION, decodeURIComponent(id));
	if (!record) return json({ error: "Not found" }, 404);
	// One application per job (#953): a FIRST Apply on a lead whose job another lead already applied
	// for is refused — the same posting found twice must not become two applications. A repeat Apply
	// of this lead is not a first one, so it still returns its stored handoff below.
	if (body.action === "apply" && jobLeadStatus(record.data) !== "apply_requested") {
		const duplicateOf = duplicateApplyOf(record, await allLeads(engine));
		if (duplicateOf) return json({ error: `Already applied for this job through lead ${duplicateOf}. Skip or archive this one.`, duplicate: true, duplicateOf }, 409);
	}
	const plan = planJobLeadTriage(record, {
		action: body.action as JobLeadTriageAction,
		deferUntil: typeof body.defer_until === "string" ? body.defer_until : undefined,
		note: typeof body.note === "string" ? body.note : undefined,
		expectedStatus: typeof body.expected_status === "string" ? body.expected_status : undefined,
		expectedVersion: typeof body.expected_version === "number" ? body.expected_version : undefined,
		sourceInstanceId: body.source_instance_id,
	});
	if (!plan.ok) return json({ error: plan.error, ...(plan.stale ? { stale: true } : {}) }, 409);
	const updated = plan.patch
		? await engine.recordUpdate(JOB_LEAD_COLLECTION, record.id, plan.patch)
		: record;
	if (!updated) return json({ error: "Not found" }, 404);
	return json({ record: updated, action: body.action, transitioned: plan.transitioned, event: plan.event });
}

/** Every lead in the collection, page by page (the engine caps a page at 200). */
async function allLeads(engine: Pick<AgentStorageEngine, "recordQuery">): Promise<CollectionRecord[]> {
	const out: CollectionRecord[] = [];
	for (let offset = 0; ; offset += 200) {
		const page = await engine.recordQuery(JOB_LEAD_COLLECTION, { limit: 200, offset }).catch(() => null);
		if (!page) return out;
		out.push(...page.records);
		if (!page.records.length || out.length >= page.total) return out;
	}
}

/**
 * Record an application's status on the lead it came from (#953) — called by the API whenever an
 * application moves. Version-guarded (`planApplicationWriteback`), so retries and out-of-order
 * calls are harmless; `application_*` fields only, never the triage `status`, never the outbox.
 */
export async function writeJobLeadApplication(engine: Pick<AgentStorageEngine, "recordGet" | "recordUpdate">, id: string, request: Request): Promise<Response> {
	const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
	const str = (v: unknown) => (typeof v === "string" && v ? v : null);
	const applicationId = str(b?.application_id);
	const status = str(b?.status);
	const version = num(b?.version);
	const leadVersion = num(b?.lead_version);
	if (!applicationId || !status || version === null || leadVersion === null) return json({ error: "application_id, status, version and lead_version are required" }, 400);
	const record = await engine.recordGet(JOB_LEAD_COLLECTION, decodeURIComponent(id));
	if (!record) return json({ error: "Not found" }, 404);
	const patch = planApplicationWriteback(record, {
		applicationId,
		leadVersion,
		status,
		version,
		blockReason: str(b?.block_reason),
		submittedAt: str(b?.submitted_at),
		submittedUrl: str(b?.submitted_url),
		at: str(b?.at) ?? new Date().toISOString(),
	});
	// A Runner preflight is an observation of the source lead, not merely an application detail.
	// Keep it version-bound to the Apply action that requested it: a later human triage must never
	// be overwritten by a late Runner answer or a retry from the cross-store backstop.
	const disposition = str(b?.disposition);
	const dispositionReason = str(b?.disposition_reason);
	const isVerified = disposition === "verified" && dispositionReason === "live";
	const isExpired = disposition === "expired" && dispositionReason === "job_unavailable";
	const isUnverifiable = disposition === "unverifiable" && !!dispositionReason;
	if (!isVerified && !isExpired && !isUnverifiable) {
		if (!patch) return json({ applied: false });
		await engine.recordUpdate(JOB_LEAD_COLLECTION, record.id, patch);
		return json({ applied: true });
	}
	const at = str(b?.at) ?? new Date().toISOString();
	const heldLead = typeof record.data.application_lead_version === "number" ? record.data.application_lead_version : -1;
	const heldVersion = typeof record.data.application_version === "number" ? record.data.application_version : -1;
	// A later application/lead generation owns the record now. A stale terminal report may still
	// write nothing, but must never archive that newer opportunity.
	const current = jobLeadStatus(record.data);
	const sameReportedDisposition = (isExpired && current === "archived" && record.data.expired_application_id === applicationId && record.data.expired_application_version === version)
		|| (isUnverifiable && current === "unverifiable" && record.data.unverifiable_application_id === applicationId && record.data.unverifiable_application_version === version);
	if (leadVersion < heldLead || (leadVersion === heldLead && record.data.application_id !== applicationId) || (leadVersion === heldLead && version < heldVersion) || (jobLeadVersion(record.data) > leadVersion && !sameReportedDisposition)) return json({ applied: false, stale: true });
	const history = Array.isArray(record.data.lifecycle) ? record.data.lifecycle : [];
	const evidence = b?.disposition_evidence;
	const attempts = Array.isArray(record.data.preflight_history) ? record.data.preflight_history : [];
	const sameAttempt = attempts.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).application_id === applicationId && (item as Record<string, unknown>).application_version === version && (item as Record<string, unknown>).state === disposition);
	const observation = {
		state: disposition,
		reason: dispositionReason,
		at,
		application_id: applicationId,
		application_version: version,
		lead_version: leadVersion,
		...(evidence === undefined ? {} : { evidence }),
	};
	const provenance = {
		preflight: observation,
		preflight_history: sameAttempt ? attempts : [...attempts.slice(-19), observation],
	};
	if (isVerified) {
		if (!patch && sameAttempt) return json({ applied: false, disposition: "verified" });
		await engine.recordUpdate(JOB_LEAD_COLLECTION, record.id, { ...(patch ?? {}), ...provenance });
		return json({ applied: true, disposition: "verified" });
	}
	if (isExpired) {
		const sameDisposition = current === "archived" && record.data.expired_application_id === applicationId && record.data.expired_application_version === version;
		if (sameDisposition && !patch && sameAttempt) return json({ applied: false, disposition: "expired" });
		const nextVersion = current === "archived" ? jobLeadVersion(record.data) : jobLeadVersion(record.data) + 1;
		const transition = current === "archived" ? {} : {
			status: "archived",
			lifecycle_version: nextVersion,
			lifecycle: [...history, { from: current, to: "archived", action: "archive", version: nextVersion, at, note: "Job unavailable" }],
			triage_action: "archive",
			triaged_at: at,
		};
		await engine.recordUpdate(JOB_LEAD_COLLECTION, record.id, {
			...(patch ?? {}), ...transition, ...provenance,
			expired_at: at, expired_reason: "job_unavailable", expired_application_id: applicationId, expired_application_version: version,
			...(evidence === undefined ? {} : { expired_evidence: evidence }),
		});
		return json({ applied: true, disposition: "expired" });
	}
	// Unverifiable is deliberately not an archive: it records that the current posting could not
	// be established as live and leaves the owner free to defer, skip, or archive it.
	if (current !== "apply_requested" && current !== "unverified" && current !== "unverifiable") return json({ applied: false, stale: true });
	const sameDisposition = current === "unverifiable" && record.data.unverifiable_application_id === applicationId && record.data.unverifiable_application_version === version;
	if (sameDisposition && !patch && sameAttempt) return json({ applied: false, disposition: "unverifiable" });
	const nextVersion = current === "unverifiable" ? jobLeadVersion(record.data) : jobLeadVersion(record.data) + 1;
	const transition = current === "unverifiable" ? {} : {
		status: "unverifiable",
		lifecycle_version: nextVersion,
		lifecycle: [...history, { from: current, to: "unverifiable", action: "verify", version: nextVersion, at, note: "Live job page could not be verified" }],
		triage_action: "verify",
		triaged_at: at,
	};
	await engine.recordUpdate(JOB_LEAD_COLLECTION, record.id, {
		...(patch ?? {}), ...transition, ...provenance,
		unverifiable_at: at, unverifiable_reason: dispositionReason, unverifiable_application_id: applicationId, unverifiable_application_version: version,
		...(evidence === undefined ? {} : { unverifiable_evidence: evidence }),
	});
	return json({ applied: true, disposition: "unverifiable" });
}

// ── Files ───────────────────────────────────────────────────────────────────

export async function listFiles(
	engine: Pick<AgentStorageEngine, "fileList">,
	url: URL,
): Promise<Response> {
	const tags = url.searchParams.get("tags")?.split(",").filter(Boolean);
	const files = await engine.fileList({
		userId: url.searchParams.get("user_id") || undefined,
		tags: tags?.length ? tags : undefined,
		mimeType: url.searchParams.get("mime_type") || undefined,
	});
	return json({ files });
}

export async function uploadFile(
	engine: Pick<AgentStorageEngine, "fileUpload">,
	request: Request,
): Promise<Response> {
	const body = await request.json<{
		name: string;
		content: string;
		contentBase64?: string;
		mime_type?: string;
		path?: string;
		tags?: string[];
		user_id?: string;
		extract_text?: boolean;
	}>();
	if (!body.name || (!body.content && !body.contentBase64))
		return json({ error: "name and content or contentBase64 required" }, 400);
	if (body.content && body.contentBase64) return json({ error: "provide content or contentBase64, not both" }, 400);
	// The same cap and decode as the upload_file tool (#762): MCP's upload_agent_file and the Gmail
	// downloader reach this route directly. Bytes are typed by their name, never as text/plain,
	// which would send a .docx through the text extractor as UTF-8 noise.
	let data: string | ArrayBuffer = body.content;
	if (body.contentBase64) {
		const decoded = decodeBase64Upload(body.contentBase64);
		if ("error" in decoded) return json({ error: `contentBase64: ${decoded.error}` }, decoded.status);
		data = decoded.bytes.slice().buffer;
	}
	const meta = await engine.fileUpload({
		name: body.name,
		path: body.path,
		mimeType: body.mime_type || (body.contentBase64 ? guessMimeType(body.name) : "text/plain"),
		data,
		userId: body.user_id,
		tags: body.tags,
		extractText: body.extract_text !== false,
	});
	return json(meta, 201);
}

/** Register an object the multipart upload already placed in R2 (see fileRegister). */
export async function registerFile(
	engine: Pick<AgentStorageEngine, "fileRegister">,
	request: Request,
): Promise<Response> {
	const body = await request.json<{
		id: string;
		name: string;
		r2_key: string;
		mime_type?: string;
		user_id?: string;
	}>();
	if (!body.id || !body.name || !body.r2_key)
		return json({ error: "id, name, r2_key required" }, 400);
	const meta = await engine.fileRegister({
		id: body.id,
		name: body.name,
		r2Key: body.r2_key,
		mimeType: body.mime_type || "application/octet-stream",
		userId: body.user_id,
	});
	if (!meta) return json({ error: "Object not found in storage" }, 404);
	return json(meta, 201);
}

export async function getFile(
	engine: Pick<AgentStorageEngine, "fileGet">,
	id: string,
): Promise<Response> {
	const file = await engine.fileGet(decodeURIComponent(id));
	if (!file) return json({ error: "Not found" }, 404);
	return new Response(file.body, {
		headers: {
			"Content-Type": file.meta.mimeType,
			"Content-Disposition": `inline; filename="${file.meta.name}"`,
			"X-File-Meta": JSON.stringify({
				id: file.meta.id,
				name: file.meta.name,
				size: file.meta.size,
				tags: file.meta.tags,
			}),
		},
	});
}

export async function deleteFile(
	engine: Pick<AgentStorageEngine, "fileDelete">,
	id: string,
): Promise<Response> {
	const deleted = await engine.fileDelete(decodeURIComponent(id));
	return deleted ? json({ success: true }) : json({ error: "Not found" }, 404);
}

// ── Vector search ───────────────────────────────────────────────────────────

export async function vectorSearch(
	engine: Pick<AgentStorageEngine, "vectorSearch">,
	request: Request,
): Promise<Response> {
	const { query, top_k, source_type } = await request.json<{
		query: string;
		top_k?: number;
		source_type?: string;
	}>();
	if (!query) return json({ error: "query required" }, 400);
	const results = await engine.vectorSearch(query, top_k || 5, {
		sourceType: source_type as "knowledge" | "message" | "file" | "collection" | undefined,
	});
	return json({ results });
}

/** What's in the vector store, grouped by source — the Knowledge → Index panel. */
export async function vectorStats(
	engine: Pick<AgentStorageEngine, "vectorStats">,
): Promise<Response> {
	return json(await engine.vectorStats());
}

// ── Activity log ────────────────────────────────────────────────────────────

export async function getActivity(
	engine: Pick<AgentStorageEngine, "getEventsPage">,
	url: URL,
): Promise<Response> {
	const limit = Number(url.searchParams.get("limit")) || 50;
	const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset")) || 0));
	const { events, total } = await engine.getEventsPage({
		limit,
		offset,
		type: url.searchParams.get("type") as ActivityEvent["type"] | undefined,
		userId: url.searchParams.get("user_id") || undefined,
	});
	// `total` and `nextOffset` (#898): the newest 50 read as the whole log, and the rest was unreachable.
	return json({ events, total, offset, nextOffset: offset + events.length < total ? offset + events.length : null });
}

// ── Summaries ───────────────────────────────────────────────────────────────

export async function getSummaries(
	engine: Pick<AgentStorageEngine, "getSummaries">,
	url: URL,
): Promise<Response> {
	const limit = Number(url.searchParams.get("limit")) || 20;
	const summaries = await engine.getSummaries(limit);
	return json({ summaries });
}

export async function forceSummarize(
	engine: Pick<AgentStorageEngine, "maybeSummarize">,
	model: string,
): Promise<Response> {
	const summary = await engine.maybeSummarize(model);
	return summary
		? json({ summary })
		: json({ message: "Not enough messages to summarize" });
}

// ── User context ────────────────────────────────────────────────────────────

export async function getUserContext(
	engine: Pick<AgentStorageEngine, "getUserContext">,
	userId: string,
): Promise<Response> {
	const ctx = await engine.getUserContext(decodeURIComponent(userId));
	return json(ctx);
}
