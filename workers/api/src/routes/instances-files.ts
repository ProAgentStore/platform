/**
 * Resumable large-file uploads — R2 multipart (Cloudflare's native resumable
 * protocol). The worker streams each part straight into R2; on complete, the
 * instance DO registers the object (metadata + text extraction + vectorize).
 *
 * Why multipart survives everything: the upload session lives in R2 keyed by
 * (key, uploadId) until completed or aborted — the client can lose its
 * connection, pause, or close the tab, then resume by re-sending only the
 * parts it has no etag for. Parts are 10MiB (R2 minimum is 5MiB, all non-last
 * parts must be equal size); a part re-upload simply replaces that part.
 */
import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

/** One part size for every client — server-declared so resume math never drifts. */
export const MULTIPART_PART_SIZE = 10 * 1024 * 1024;
/** R2 caps multipart at 10,000 parts → 100GB with 10MiB parts; we cap far lower. */
export const MULTIPART_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB — generous for a doc catalog

const sanitizeName = (raw: string) =>
	raw.replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "file";

/** The one R2 key shape this API will touch — derived server-side, then validated
 *  on every subsequent call so a client can never write outside its instance. */
const keyFor = (instanceId: string, fileId: string, name: string) =>
	`agents/${instanceId}/files/${fileId}/${name}`;
const keyPrefixFor = (instanceId: string) => `agents/${instanceId}/files/`;

export function registerFileUploadRoutes(router: Hono<{ Bindings: Env }>): void {
	/** Start a resumable upload. Returns the session the client persists for resume. */
	router.post("/:instanceId/files/multipart/create", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		if (!c.env.STORAGE) throw new HttpError(503, "File storage not available");
		const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; mimeType?: unknown; size?: unknown };
		const name = sanitizeName(typeof body.name === "string" ? body.name : "");
		const size = typeof body.size === "number" && Number.isFinite(body.size) ? body.size : 0;
		if (size <= 0) throw new HttpError(400, "size required");
		if (size > MULTIPART_MAX_BYTES) throw new HttpError(413, "File too large (max 2GB)");
		const fileId = crypto.randomUUID();
		const key = keyFor(instanceId, fileId, name);
		const upload = await c.env.STORAGE.createMultipartUpload(key, {
			httpMetadata: { contentType: typeof body.mimeType === "string" && body.mimeType ? body.mimeType : "application/octet-stream" },
			customMetadata: { agentId: instanceId, originalName: name, userId: session.uid },
		});
		return c.json({
			fileId,
			key,
			uploadId: upload.uploadId,
			partSize: MULTIPART_PART_SIZE,
			partCount: Math.max(1, Math.ceil(size / MULTIPART_PART_SIZE)),
		});
	});

	/** Upload ONE part (raw bytes). Re-sending a part number replaces it — retry-safe. */
	router.put("/:instanceId/files/multipart/:uploadId/part", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		if (!c.env.STORAGE) throw new HttpError(503, "File storage not available");
		const uploadId = c.req.param("uploadId");
		const key = c.req.query("key") || "";
		const partNumber = Number(c.req.query("partNumber") || "0");
		if (!key.startsWith(keyPrefixFor(instanceId))) throw new HttpError(403, "Key does not belong to this instance");
		if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) throw new HttpError(400, "partNumber must be 1..10000");
		if (!c.req.raw.body) throw new HttpError(400, "part body required");
		const upload = c.env.STORAGE.resumeMultipartUpload(key, uploadId);
		try {
			const part = await upload.uploadPart(partNumber, c.req.raw.body);
			return c.json({ partNumber: part.partNumber, etag: part.etag });
		} catch (e) {
			// An expired/aborted session surfaces here — tell the client to restart
			// rather than retrying this part forever.
			throw new HttpError(409, `Part upload failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	});

	/** Complete the upload, then register the file with the instance DO
	 *  (metadata + extraction + vectorization) — same end state as a normal upload. */
	router.post("/:instanceId/files/multipart/:uploadId/complete", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		if (!c.env.STORAGE) throw new HttpError(503, "File storage not available");
		const uploadId = c.req.param("uploadId");
		const body = (await c.req.json().catch(() => ({}))) as {
			key?: unknown;
			fileId?: unknown;
			name?: unknown;
			mimeType?: unknown;
			parts?: unknown;
		};
		const key = typeof body.key === "string" ? body.key : "";
		const fileId = typeof body.fileId === "string" ? body.fileId : "";
		const name = sanitizeName(typeof body.name === "string" ? body.name : "");
		if (!key.startsWith(keyPrefixFor(instanceId))) throw new HttpError(403, "Key does not belong to this instance");
		if (!fileId || !name) throw new HttpError(400, "fileId and name required");
		const parts = (Array.isArray(body.parts) ? body.parts : [])
			.flatMap((p) => {
				if (!p || typeof p !== "object") return [];
				const o = p as Record<string, unknown>;
				return typeof o.partNumber === "number" && typeof o.etag === "string"
					? [{ partNumber: o.partNumber, etag: o.etag }]
					: [];
			})
			.sort((a, b) => a.partNumber - b.partNumber);
		if (!parts.length) throw new HttpError(400, "parts required");
		const upload = c.env.STORAGE.resumeMultipartUpload(key, uploadId);
		try {
			await upload.complete(parts);
		} catch (e) {
			throw new HttpError(409, `Complete failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		// Register with the DO so the file appears in the list, gets extracted + vectorized.
		const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
		const doRes = await stub.fetch(
			new Request("https://agent/files/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: fileId,
					name,
					r2_key: key,
					mime_type: typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream",
					user_id: session.uid,
				}),
			}),
		);
		return new Response(doRes.body, { status: doRes.status, headers: { "Content-Type": "application/json" } });
	});

	/** Abort (cancel) an in-progress upload — frees the stored parts in R2. */
	router.delete("/:instanceId/files/multipart/:uploadId", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		if (!c.env.STORAGE) throw new HttpError(503, "File storage not available");
		const key = c.req.query("key") || "";
		if (!key.startsWith(keyPrefixFor(instanceId))) throw new HttpError(403, "Key does not belong to this instance");
		try {
			await c.env.STORAGE.resumeMultipartUpload(key, c.req.param("uploadId")).abort();
		} catch { /* already gone — aborting twice is fine */ }
		return c.json({ aborted: true });
	});
}
