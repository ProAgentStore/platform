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

/**
 * Recover the (fileId, name) that `keyFor` put INTO a key (#217).
 *
 * The create route generates both server-side and embeds them in the R2 key, but complete then
 * read `fileId` and `name` back out of the request BODY, independent of the key — validating
 * only that the key sat under this instance's prefix. So a client could finish a legitimate
 * upload and register the resulting object under any id and name it liked, including an id
 * already in use: the DO writes `file:{id}` unconditionally, so that overwrites another file's
 * metadata and leaves its R2 object orphaned.
 *
 * The key is the server's own statement of what this upload is. Derive from it and the whole
 * class goes away — there is nothing left for the client to disagree with.
 */
export function parseFileKey(instanceId: string, key: string): { fileId: string; name: string } | null {
	const prefix = keyPrefixFor(instanceId);
	if (!key.startsWith(prefix)) return null;
	const rest = key.slice(prefix.length);
	const slash = rest.indexOf("/");
	if (slash <= 0) return null;
	const fileId = rest.slice(0, slash);
	const name = rest.slice(slash + 1);
	// A traversal or a nested path never came from keyFor: the name segment is sanitised at
	// create time and cannot contain a slash.
	if (!fileId || !name || name.includes("/") || fileId.includes("..")) return null;
	return { fileId, name };
}

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
		// Bounded by the CAP, not R2's 10,000-part ceiling. `size` in the create body is a
		// client-declared number that is never used again, so `{"size":1}` followed by 10,000
		// 10MiB parts produced a ~100GB object and the 2GB limit was decorative.
		const maxParts = Math.ceil(MULTIPART_MAX_BYTES / MULTIPART_PART_SIZE);
		if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > maxParts) {
			throw new HttpError(400, `partNumber must be 1..${maxParts}`);
		}
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
		if (!key.startsWith(keyPrefixFor(instanceId))) throw new HttpError(403, "Key does not belong to this instance");
		// Derive identity from the KEY, never from the body (#217). The body's fileId/name are
		// still accepted so existing clients keep working, but only as an assertion to check —
		// they cannot decide what gets registered.
		const derived = parseFileKey(instanceId, key);
		if (!derived) throw new HttpError(400, "Malformed upload key");
		const { fileId, name } = derived;
		const claimedId = typeof body.fileId === "string" ? body.fileId : "";
		const claimedName = typeof body.name === "string" ? sanitizeName(body.name) : "";
		if ((claimedId && claimedId !== fileId) || (claimedName && claimedName !== name)) {
			throw new HttpError(400, "fileId/name do not match the upload key");
		}
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
		if (parts.length > Math.ceil(MULTIPART_MAX_BYTES / MULTIPART_PART_SIZE)) {
			await upload.abort().catch(() => undefined);
			throw new HttpError(413, "File too large (max 2GB)");
		}
		try {
			await upload.complete(parts);
		} catch (e) {
			throw new HttpError(409, `Complete failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		// The REAL size, now that one exists. Everything before this point trusted a number the
		// client supplied at create time, so the cap was never actually enforced against bytes.
		// Over the limit → delete rather than register: an unregistered object is invisible to
		// fileList and unreclaimable through any API this worker exposes.
		const head = await c.env.STORAGE.head(key);
		if (head && head.size > MULTIPART_MAX_BYTES) {
			await c.env.STORAGE.delete(key).catch(() => undefined);
			throw new HttpError(413, "File too large (max 2GB)");
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
