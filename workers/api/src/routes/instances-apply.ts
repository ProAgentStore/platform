import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { deriveJobPassword, listAtsCache } from "../lib/apply-cache.js";
import { findCredentialForHost } from "../lib/credentials.js";
import { getProfile, profileToCandidate, profileToPreferences, profileCustomAnswers } from "../lib/profile.js";
import { parseResumeIntoProfile } from "../lib/resume-parse.js";
import { timingSafeEqualStr } from "../lib/crypto.js";
import { runShotKey } from "../lib/run-shots.js";
import type { Env } from "../types.js";
import { createBrowserRuntimeTask } from "./browser-workflows.js";
import { deriveFromUrl } from "../lib/board.js";
import { callRuntime, requireOwnedInstance, requireRuntime, runtimeJson, runtimeStatus } from "./instances-runtime.js";

/** An apply failure with an HTTP-ish status so callers can map it. */
export class ApplyError extends Error {
	constructor(message: string, readonly status = 400) {
		super(message);
	}
}

// ── Résumé transfer mechanism ────────────────────────────────────────────────
// The runner can be on a remote machine that doesn't have the user's résumé. So
// the user uploads it once via the web (stored in R2), and the runner DOWNLOADS
// it from a short-lived signed URL when an application needs a file upload.
const API_PUBLIC_BASE = "https://api.proagentstore.online";
const resumeKey = (userId: string, instanceId: string) => `apply-resume/${userId}/${instanceId}`;

async function resumeHmac(env: Env, data: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
	return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function signedResumeUrl(env: Env, userId: string, instanceId: string): Promise<string> {
	const exp = Date.now() + 2 * 60 * 60 * 1000; // 2h — long enough for a run
	const token = await resumeHmac(env, `${userId}.${instanceId}.${exp}`);
	const q = new URLSearchParams({ uid: userId, exp: String(exp), token });
	return `${API_PUBLIC_BASE}/v1/instances/${encodeURIComponent(instanceId)}/apply-resume?${q.toString()}`;
}
/** A reference the runner can resolve: a signed URL if a résumé is on the platform, else the legacy local path. */
async function resolveResumeReference(env: Env, instanceId: string, userId: string, resumePath: string): Promise<string> {
	const head = await env.STORAGE?.head?.(resumeKey(userId, instanceId))?.catch(() => null) ?? null;
	if (head) return signedResumeUrl(env, userId, instanceId);
	return resumePath;
}

/** Trim a value to a non-empty string, or undefined. */
function trimmed(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const t = value.trim();
	return t.length > 0 ? t : undefined;
}

export interface StartApplyInput {
	url: string;
	resumePath: string;
	candidate?: Record<string, unknown>;
	coverNote?: string;
	dryRun?: boolean;
}

/**
 * The single entry point for the LLM-driven job application: builds the job from
 * the structured Profile + credentials vault + Special Instructions, creates the
 * agent-driven runner task, and starts the JobApplyWorkflow brain. Used by BOTH
 * the /apply route and the chat agent's apply tool — there is no other apply path.
 */
export async function startJobApply(env: Env, instanceId: string, userId: string, input: StartApplyInput): Promise<{ workflowId: string; taskId: string }> {
	const url = String(input.url ?? "");
	if (!/^https?:\/\//.test(url)) throw new ApplyError("url (http/https) required");
	// Prefer a résumé uploaded to the platform (a signed URL the runner downloads);
	// fall back to a local path only if one was passed.
	const resumePath = await resolveResumeReference(env, instanceId, userId, String(input.resumePath ?? ""));
	if (!resumePath) throw new ApplyError("no résumé on file — upload one in the console (Knowledge → Résumé) so the agent can attach it");

	await requireRuntime(env, instanceId, userId); // throws if no runner

	// Single-flight: the runner drives ONE browser page, so a second concurrent
	// application on the same instance would clobber the first (interleaved fills +
	// submits). Reject while one is still active.
	const active = await env.DB.prepare(
		"SELECT id FROM instance_runtime_tasks WHERE instance_id = ?1 AND user_id = ?2 AND type = 'job.apply_agent' AND status IN ('queued','running','needs_human') AND hidden = 0 LIMIT 1",
	).bind(instanceId, userId).first<{ id: string }>();
	if (active) throw new ApplyError("An application is already in progress on this agent — finish or cancel it before starting another.", 409);

	const cand = input.candidate ?? {};
	const rawProfile = await getProfile(env, userId);
	const prof = profileToCandidate(rawProfile);
	const prefs = profileToPreferences(rawProfile);
	const cfg = await readInstanceConfig(env, instanceId, userId);
	const cred = await findCredentialForHost(env, instanceId, userId, url);
	const fullName = trimmed(cand.fullName) ?? trimmed(cand.full_name) ?? prof.fullName ?? "";
	const email = trimmed(cand.email) ?? cred?.username ?? prof.email ?? "";
	if (!fullName || !email) throw new ApplyError("no candidate name/email in your Profile — fill it in the console (Profile → Candidate Profile)");

	const job = {
		url,
		resumePath,
		candidate: {
			fullName,
			email,
			phone: trimmed(cand.phone) ?? prof.phone,
			location: trimmed(cand.location) ?? prof.location,
			linkedin: trimmed(cand.linkedin) ?? prof.linkedin,
			portfolio: trimmed(cand.portfolio) ?? prof.portfolio,
			workAuthorization: trimmed(cand.workAuthorization ?? cand.work_authorization) ?? prof.workAuthorization,
			salaryExpectation: prof.salaryExpectation,
		},
		coverNote: trimmed(input.coverNote),
		password: cred?.password ?? (await deriveJobPassword(env, userId)),
		hasStoredLogin: !!cred,
		dryRun: input.dryRun === true,
		specialInstructions: trimmed(cfg.specialInstructions),
		preferences: prefs,
		// Reuse answers the agent previously asked for via a ticket (saved to the
		// Profile's custom JSON) so it never re-asks and never falls back to a
		// wrong-country field — e.g. "australian working rights: Australian citizen".
		providedAnswers: profileCustomAnswers(rawProfile),
		today: new Date().toISOString().slice(0, 10),
	};

	let taskId: string;
	try {
		// Give the board card a real title up front (best-effort from the job URL),
		// so it reads e.g. "Business Ai Group… Head Of Engineering / employmenthero.com"
		// instead of a derived-at-render guess.
		const card = deriveFromUrl(url);
		({ taskId } = await createBrowserRuntimeTask(env, instanceId, userId, {
			type: "job.apply_agent",
			input: { url, resumePath },
			title: card.title || undefined,
			subtitle: card.subtitle || undefined,
		}));
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new ApplyError(msg, 502);
	}

	const instance = await env.JOB_APPLY.create({ params: { instanceId, userId, taskId, job } });
	return { workflowId: instance.id, taskId };
}

/** Read the instance's JSON config (client-side settings incl. specialInstructions). */
export async function readInstanceConfig(env: Env, instanceId: string, userId: string): Promise<Record<string, unknown>> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ config: string }>();
	try {
		return JSON.parse(row?.config || "{}") as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * The apply-pipeline support routes: human-takeover proxies (frame/input/resume/
 * end), Special Instructions CRUD, learned per-ATS tips, and the ask-and-hold
 * value channel. Split out of instances.ts to keep that file focused. The heavy
 * `/apply` trigger itself stays in instances.ts next to task creation.
 */
export function registerApplyRoutes(router: Hono<{ Bindings: Env }>): void {
	/** Upload my résumé (binary) — stored in R2 so a remote runner can fetch it. */
	router.put("/:instanceId/apply-resume", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const name = (c.req.query("name") || "resume.pdf").replace(/[^\w.\- ]/g, "_").slice(0, 120);
		const body = await c.req.arrayBuffer();
		if (!body.byteLength) return c.json({ error: "empty file" }, 400);
		if (body.byteLength > 8 * 1024 * 1024) return c.json({ error: "résumé too large (max 8MB)" }, 400);
		// Parse the résumé with the user's BYOK Claude AFTER responding: pre-fill the
		// empty structured Profile fields + seed the vector KB. Best-effort, never
		// blocks or fails the upload. (PDF only — Claude reads PDFs natively.)
		const mime = /\.pdf$/i.test(name) ? "application/pdf" : (c.req.header("content-type") || "application/octet-stream");
		// Persist the content-type so a later re-parse (apply-resume/parse) knows the real
		// format instead of guessing.
		await c.env.STORAGE.put(resumeKey(session.uid, instanceId), body, { customMetadata: { name }, httpMetadata: { contentType: mime } });
		c.executionCtx.waitUntil(parseResumeIntoProfile(c.env, instanceId, session.uid, new Uint8Array(body), mime).catch(() => undefined));
		return c.json({ ok: true, name, size: body.byteLength });
	});

	/** Re-parse the résumé already on file (fill Profile + seed KB) without re-uploading. */
	router.post("/:instanceId/apply-resume/parse", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const obj = await c.env.STORAGE.get(resumeKey(session.uid, instanceId));
		if (!obj) return c.json({ error: "no résumé on file — upload one first" }, 404);
		const name = (obj.customMetadata?.name as string) || "resume.pdf";
		const bytes = new Uint8Array(await obj.arrayBuffer());
		// Use the stored content-type; fall back to the filename. A non-PDF must NOT be
		// mislabeled as application/pdf (that made parseResumeIntoProfile's PDF read fail
		// silently instead of telling the user to re-upload a PDF).
		const mime = obj.httpMetadata?.contentType || (/\.pdf$/i.test(name) ? "application/pdf" : "application/octet-stream");
		c.executionCtx.waitUntil(parseResumeIntoProfile(c.env, instanceId, session.uid, bytes, mime).catch(() => undefined));
		return c.json({ ok: true, parsing: true, name });
	});

	/** Whether a résumé is on file (for the console). */
	router.get("/:instanceId/apply-resume/status", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const head = await c.env.STORAGE.head(resumeKey(session.uid, instanceId)).catch(() => null);
		return c.json({ uploaded: !!head, name: head?.customMetadata?.name || null, size: head?.size || 0 });
	});

	/** Remove the stored résumé. */
	router.delete("/:instanceId/apply-resume", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		await c.env.STORAGE.delete(resumeKey(session.uid, instanceId)).catch(() => undefined);
		return c.json({ ok: true });
	});

	/** Signed résumé download — the runner fetches this (the token is the auth, no session). */
	router.get("/:instanceId/apply-resume", async (c) => {
		const instanceId = c.req.param("instanceId");
		const uid = c.req.query("uid") || "";
		const exp = c.req.query("exp") || "";
		const token = c.req.query("token") || "";
		if (!uid || !exp || !token || Date.now() > Number(exp)) return c.json({ error: "unauthorized" }, 401);
		const expected = await resumeHmac(c.env, `${uid}.${instanceId}.${exp}`);
		if (!timingSafeEqualStr(expected, token)) return c.json({ error: "unauthorized" }, 401);
		const obj = await c.env.STORAGE.get(resumeKey(uid, instanceId));
		if (!obj) return c.json({ error: "no résumé on file" }, 404);
		const name = (obj.customMetadata?.name as string) || "resume.pdf";
		return new Response(obj.body, {
			headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"` },
		});
	});

	/** Serve a per-step run screenshot (for the run-replay timeline). Owner-only. */
	router.get("/:instanceId/tasks/:taskId/shots/:seq", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const taskId = c.req.param("taskId");
		const seq = Number(c.req.param("seq"));
		if (!Number.isFinite(seq)) return c.json({ error: "bad seq" }, 400);
		const obj = await c.env.STORAGE.get(runShotKey(session.uid, instanceId, taskId, seq));
		if (!obj) return c.json({ error: "no screenshot" }, 404);
		return new Response(obj.body, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000" } });
	});

	/** List active human-takeover sessions on my instance's runtime. */
	router.get("/:instanceId/takeover", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await requireRuntime(c.env, instanceId, session.uid);
		const res = await callRuntime(c.env, runtime, "/takeover");
		return c.json((await runtimeJson(res)) as object, runtimeStatus(res, 200));
	});

	/** Live JPEG frame of a paused (needs_human) task's browser page. */
	router.get("/:instanceId/takeover/:taskId/frame", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await requireRuntime(c.env, instanceId, session.uid);
		const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(taskId)}/frame`);
		return c.json((await runtimeJson(res)) as object, runtimeStatus(res, 200));
	});

	/** Relay a human's mouse/keyboard input into the taken-over page. */
	router.post("/:instanceId/takeover/:taskId/input", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await requireRuntime(c.env, instanceId, session.uid);
		const body = await c.req.text();
		const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(taskId)}/input`, { method: "POST", body });
		return c.json((await runtimeJson(res)) as object, runtimeStatus(res, 200));
	});

	/** Resume after a human solved the challenge — re-check + submit. */
	router.post("/:instanceId/takeover/:taskId/resume", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await requireRuntime(c.env, instanceId, session.uid);
		const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(taskId)}/resume`, { method: "POST" });
		return c.json((await runtimeJson(res)) as object, runtimeStatus(res, 200));
	});

	/** Read the instance's special instructions (rules the agent must follow). */
	router.get("/:instanceId/instructions", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
		return c.json({ instructions: typeof cfg.specialInstructions === "string" ? cfg.specialInstructions : "" });
	});

	/** Update the instance's special instructions. */
	router.put("/:instanceId/instructions", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { instructions?: unknown };
		const cfg = await readInstanceConfig(c.env, instanceId, session.uid);
		cfg.specialInstructions = String(body.instructions ?? "").slice(0, 4000);
		await c.env.DB.prepare("UPDATE agent_instances SET config = ?1, updated_at = datetime('now') WHERE id = ?2 AND user_id = ?3")
			.bind(JSON.stringify(cfg), instanceId, session.uid)
			.run();
		return c.json({ ok: true });
	});

	/** The agent's learned per-ATS tips (what worked + failed) — full transparency. */
	router.get("/:instanceId/apply-tips", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const inst = await requireOwnedInstance(c.env, instanceId, session.uid);
		// The ATS cache is per-USER (shared across the user's apply runs). Only the
		// job-application agent may read it — otherwise it would surface a user's
		// application history inside unrelated agents (e.g. Coder). Defense-in-depth
		// behind the console gate.
		const agent = await c.env.DB.prepare("SELECT slug FROM agents WHERE id = ?1").bind(inst.agent_id).first<{ slug: string }>();
		if (agent?.slug !== "job-application-assistant") return c.json({ tips: [] });
		return c.json({ tips: await listAtsCache(c.env, session.uid) });
	});

	/** Supply the value the apply agent asked for (ask-and-hold / needs_input handoff). */
	router.post("/:instanceId/input", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await requireRuntime(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { taskId?: string; value?: string };
		if (!body.taskId) return c.json({ error: "taskId required" }, 400);
		const res = await callRuntime(c.env, runtime, "/browser/input", {
			method: "POST",
			body: JSON.stringify({ taskId: body.taskId, value: String(body.value ?? "") }),
		});
		return c.json((await runtimeJson(res)) as object, runtimeStatus(res, 200));
	});

	/** End a human-takeover session. */
	router.post("/:instanceId/takeover/:taskId/end", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await requireRuntime(c.env, instanceId, session.uid);
		const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(taskId)}/end`, { method: "POST" });
		return c.json((await runtimeJson(res)) as object, runtimeStatus(res, 200));
	});

	/** Start the LLM-driven job application (the ONLY apply path). dryRun fills everything but never submits. */
	router.post("/:instanceId/apply", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const url = String(body.url ?? "");
		try {
			const { workflowId, taskId } = await startJobApply(c.env, instanceId, session.uid, {
				url,
				resumePath: String(body.resumePath ?? body.resume_path ?? ""),
				candidate: (body.candidate ?? {}) as Record<string, unknown>,
				coverNote: typeof body.coverNote === "string" ? body.coverNote : typeof body.cover_note === "string" ? body.cover_note : undefined,
				dryRun: body.dryRun === true || body.dry_run === true,
			});
			return c.json({ workflowId, taskId, status: "running", url }, 202);
		} catch (e) {
			if (e instanceof ApplyError) return c.json({ error: e.message }, e.status === 502 ? 502 : 400);
			throw e;
		}
	});
}
