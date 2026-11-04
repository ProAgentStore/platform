import type { BrowserArtifactPageResponse } from "../lib/browser-artifact-response-types.js";
/**
 * Replay screenshots of an instance's browser runs (#1063) — owner-only, by subject.
 *
 * `GET …/browser-artifacts?subject_kind=&subject_id=` lists a run's screenshots (metadata only), and
 * `GET …/browser-artifacts/:artifactId` serves one. Both check the instance is the caller's, and the
 * bytes route also checks the artifact row AND the run it belongs to: a screenshot of a run that is not
 * this owner's on this instance is a 404, never a different owner's pixels. Served `no-store` — replay
 * frames show the owner's pages, so no shared cache keeps a copy.
 */
import type { Hono } from "hono";
import type { BrowserArtifactListResponse } from "../agent-types.js";
import { HttpError, requireUser } from "../lib/auth.js";
import { isBrowserArtifactSubject, listBrowserArtifacts, pageBrowserArtifacts, readBrowserArtifact, subjectBelongsTo, subjectScreenshotsOff } from "../lib/browser-artifacts.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import { browserArtifactCoverage, type BrowserArtifactCoverage } from "../lib/browser-artifact-coverage.js";

export function registerBrowserArtifactRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/browser-artifacts", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const subjectKind = c.req.query("subject_kind");
		const subjectId = c.req.query("subject_id") ?? "";
		if (!isBrowserArtifactSubject(subjectKind)) throw new HttpError(400, "subject_kind must be runtime_task, local_browser_run or local_apply_run");
		if (!subjectId) throw new HttpError(400, "subject_id required");
		if (!(await subjectBelongsTo(c.env, session.uid, instanceId, subjectKind, subjectId))) throw new HttpError(404, "Run not found");
		if (c.req.query("limit") !== undefined || c.req.query("cursor") !== undefined) {
			const limit = Number(c.req.query("limit") ?? 25); const cursor = c.req.query("cursor"); const after = cursor === undefined ? -1 : Number(cursor);
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(after) || after < -1) throw new HttpError(400, "Invalid screenshot page limit or cursor");
			const page: BrowserArtifactPageResponse = { subjectKind, subjectId, ...await pageBrowserArtifacts(c.env, session.uid, instanceId, subjectKind, subjectId, after, limit), coverage: await browserArtifactCoverage(c.env, session.uid, instanceId, subjectKind, subjectId), screenshotsOff: await subjectScreenshotsOff(c.env, session.uid, subjectKind, subjectId) };
			return c.json(page, 200, { "Cache-Control": "no-store" });
		}
		const body: BrowserArtifactListResponse & { coverage: BrowserArtifactCoverage } = {
			subjectKind,
			subjectId,
			artifacts: await listBrowserArtifacts(c.env, session.uid, instanceId, subjectKind, subjectId),
			coverage: await browserArtifactCoverage(c.env, session.uid, instanceId, subjectKind, subjectId),
			screenshotsOff: await subjectScreenshotsOff(c.env, session.uid, subjectKind, subjectId),
		};
		return c.json(body, 200, { "Cache-Control": "no-store" });
	});

	router.get("/:instanceId/browser-artifacts/:artifactId", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const artifact = await readBrowserArtifact(c.env, session.uid, instanceId, c.req.param("artifactId"));
		if (!artifact || !(await subjectBelongsTo(c.env, session.uid, instanceId, artifact.subjectKind, artifact.subjectId))) throw new HttpError(404, "Screenshot not found");
		if (c.req.query("metadata") === "true") {
			const { r2Key: _storageKey, ...metadata } = artifact;
			return c.json(metadata, 200, { "Cache-Control": "no-store" });
		}
		const obj = await c.env.STORAGE?.get(artifact.r2Key);
		if (!obj) throw new HttpError(404, "Screenshot not found");
		return new Response(obj.body, { headers: { "Content-Type": artifact.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
	});
}
