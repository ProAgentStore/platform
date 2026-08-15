import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { requirePro } from "../lib/billing.js";
import { capabilitiesForInstance } from "../lib/agent-capabilities.js";
import { deriveJobPassword, listAtsCache } from "../lib/apply-cache.js";
import { findCredentialForHost } from "../lib/credentials.js";
import { openBudget } from "../lib/delegation-budget-store.js";
import { createLoopRun } from "../lib/agent-loop-store.js";
import { BROWSER_RUN_ROUNDS, browserRunObjective } from "../lib/browser-run.js";
import { getProfile, profileToCandidate, profileToPreferences, profileCustomAnswers } from "../lib/profile.js";
import { parseResumeIntoProfile } from "../lib/resume-parse.js";
import { timingSafeEqualStr } from "../lib/crypto.js";
import { runShotKey } from "../lib/run-shots.js";
import type { Env } from "../types.js";
import { createBrowserRuntimeTask } from "./browser-workflows.js";
import { deriveFromUrl } from "../lib/board.js";
import { logError } from "../lib/error-log.js";
import { callRuntime, requireOwnedInstance, requireLiveRuntime, runtimeJson, runtimeStatus } from "./instances-runtime.js";
import { patchInstanceConfig, touchInstanceActivity } from "../lib/instance-config.js";

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

	await requireLiveRuntime(env, instanceId, userId); // throws if no runner

	// Single-flight: the runner drives ONE browser page, so a second concurrent application on
	// the same instance would clobber the first (interleaved fills + submits, DUPLICATE real
	// submissions). A plain SELECT-then-create was a TOCTOU race — two triggers (double-click,
	// or the console racing the chat apply-tool) both saw "nothing active" across the awaits
	// below and both launched. Enforce it ATOMICALLY: insert a placeholder claim row in ONE
	// statement that only lands when no non-stale active apply task exists. D1 serializes
	// writes, so of two racers exactly one inserts (changes=1) and the other sees the first's
	// row (changes=0 → 409). The real runner task created next takes over the slot and we drop
	// the placeholder in `finally`; the task's own lifecycle (→ done/failed) releases the slot.
	//
	// Staleness (updated_at cutoff): the orphan reaper exempts apply tasks (the workflow owns
	// their lifecycle), so a workflow that dies mid-run would 409 every future apply forever.
	// A task not touched within the workflow's THEORETICAL max is treated as dead so a new
	// apply can proceed. That ceiling: up to CAPTCHA_WAIT_POLLS (15 min) per handoff round
	// across many rounds (~3h worst case) — 30 min wrongly retired a live multi-handoff run.
	// 4h is safely past it; a genuinely dead task clears sooner via Cancel.
	const STALE_APPLY_MS = 4 * 60 * 60 * 1000;
	const claimId = `apply-claim_${crypto.randomUUID()}`;
	const nowIso = new Date().toISOString();
	const staleCutoff = new Date(Date.now() - STALE_APPLY_MS).toISOString();
	const claim = await env.DB.prepare(
		`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
		 SELECT ?1, ?2, ?3, 'job.apply_agent', 'queued', '{"claim":true}', ?4, ?4
		 WHERE NOT EXISTS (
		   SELECT 1 FROM instance_runtime_tasks
		   WHERE instance_id = ?2 AND type = 'job.apply_agent'
		     AND status IN ('queued','running','needs_human') AND hidden = 0
		     AND updated_at > ?5
		 )`,
	).bind(claimId, instanceId, userId, nowIso, staleCutoff).run();
	if ((claim.meta.changes ?? 0) === 0) {
		throw new ApplyError("An application is already in progress on this agent — finish or cancel it before starting another.", 409);
	}
	// From here on the claim is held; ANY exit path must drop the placeholder (below, in
	// `finally`) so a failed start never wedges the agent for the full stale window.

	// Any exit path after the claim drops the placeholder: on success the REAL runner task
	// (created below) holds the single-flight slot; on failure this frees it immediately.
	// A swallowed DELETE leaves the placeholder `queued`, and every later apply then 409s with
	// "already in progress" until the 4h stale cutoff — the agent wedged by the very row that
	// exists to keep it from wedging. Nothing else can free it, so at minimum the wedge has to be
	// findable: it is the answer to "why does my agent say an application is in progress?".
	const dropClaim = () =>
		env.DB.prepare("DELETE FROM instance_runtime_tasks WHERE id = ?1")
			.bind(claimId)
			.run()
			.catch((e) =>
				logError(env, {
					source: "job-apply",
					userId,
					message: `could not drop the single-flight claim ${claimId}; this agent will refuse new applications until the stale cutoff: ${e instanceof Error ? e.message : String(e)}`,
					context: { instanceId, claimId },
				}).catch(() => undefined),
			);
	try {
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

		// Open the run's spend pool BEFORE handing the work over (#516). An apply is unattended by
		// construction — a durable Workflow driving a browser with BYOK Claude for as long as the
		// ATS takes — and until now it started with no `delegation_budgets` row at all: nothing
		// reserved, nothing settled, and no row for a stop to act on when a run wedged on a handoff.
		//
		// Failing to open one must not fail the application: `JobApplyParams.budgetId` is optional
		// and the gate runs the decide untouched without it, so a D1 blip costs the accounting for
		// one run rather than the run itself. It is logged rather than swallowed, because an apply
		// that silently ran unpooled is exactly the state this ticket exists to end.
		const budgetId = await openBudget(env, userId, instanceId).then(
			(b) => b.id,
			async (e) => {
				await logError(env, {
					source: "job-apply",
					userId,
					message: `could not open a spend pool for this application; it will run unmetered by the budget: ${e instanceof Error ? e.message : String(e)}`,
					context: { instanceId, taskId },
				}).catch(() => undefined);
				return null;
			},
		);
		// The run row #560 was missing, and it is NOT best-effort — the rule `loop-drivers.ts` states
		// for the coding driver, for the reason it gives there, which is this run exactly: "an
		// autonomous run editing the user's repo and spending their tokens that they could not see
		// and could not stop." An apply is unattended by construction and now draws on a pool
		// (#516); without this row `stop_work` resolves nothing (`lib/work-stop.ts` →
		// `requestCancel` → `agent_loop_runs`) and the ONLY cancel path is the runner's own task,
		// which needs `requireLiveRuntime` — so with the machine off the owner could watch the
		// money go and had nothing that could end it.
		//
		// Failing the START is the right failure: the alternative is an application running with no
		// handle on it, which is the state the ticket exists to end. It costs nothing in practice —
		// `createBrowserRuntimeTask` above is also D1, so a database that cannot take this INSERT
		// has already 502'd. The task row is closed on the way out so the board does not keep a
		// "running" card for an application that never started (the wedge `job-apply.ts`'s
		// `no-runner-close` documents).
		const loopRunId = crypto.randomUUID();
		try {
			await createLoopRun(env, {
				runId: loopRunId,
				userId,
				instanceId,
				objective: browserRunObjective("apply", { url }),
				// The OUTER round loop, not the per-round step counter: `runApplyLoop`'s own counter
				// restarts at zero on every handoff, so recording it would make progress go backwards.
				maxIterations: BROWSER_RUN_ROUNDS,
				budgetId,
				startedAt: Date.now(),
			});
		} catch (e) {
			// Close AND hide the task row: `status` is what the single-flight claim above reads, so
			// leaving it `running` would 409 every later application for the full 4h stale window,
			// and `hidden` is what keeps a card for an application that never took a step off the
			// board. Both, because they answer different questions.
			await env.DB.prepare(
				"UPDATE instance_runtime_tasks SET status = 'failed', hidden = 1, updated_at = datetime('now') WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3",
			)
				.bind(taskId, instanceId, userId)
				.run()
				.catch(() => undefined);
			throw new ApplyError(`Could not start the application: ${e instanceof Error ? e.message : String(e)}`, 500);
		}
		const instance = await env.JOB_APPLY.create({ params: { instanceId, userId, taskId, job, budgetId, depth: 0, loopRunId } });
		return { workflowId: instance.id, taskId };
	} finally {
		await dropClaim();
	}
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
		// This is the only way to remove an uploaded CV — name, address, employment history — and
		// `{ok:true}` was unconditional. A failed R2 delete left the object readable by the
		// token-authed download below and by every later run, while the console reported the
		// résumé gone. A deletion endpoint that cannot fail is a retention record that lies.
		const removed = await c.env.STORAGE.delete(resumeKey(session.uid, instanceId)).then(() => true, () => false);
		if (!removed) throw new HttpError(502, "Couldn't delete the stored résumé — it is still on file. Try again.");
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
		const runtime = await requireLiveRuntime(c.env, instanceId, session.uid);
		const res = await callRuntime(c.env, runtime, "/takeover");
		return c.json((await runtimeJson(res)) as object, runtimeStatus(res, 200));
	});

	/** Live JPEG frame of a paused (needs_human) task's browser page. */
	router.get("/:instanceId/takeover/:taskId/frame", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await requireLiveRuntime(c.env, instanceId, session.uid);
		const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(taskId)}/frame`);
		return c.json((await runtimeJson(res)) as object, runtimeStatus(res, 200));
	});

	/** Relay a human's mouse/keyboard input into the taken-over page. */
	router.post("/:instanceId/takeover/:taskId/input", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await requireLiveRuntime(c.env, instanceId, session.uid);
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
		const runtime = await requireLiveRuntime(c.env, instanceId, session.uid);
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
		// Patch just this key (#231). Rules & Tips is edited in the console while other
		// settings are open; a whole-blob write would silently drop whichever landed first.
		await patchInstanceConfig(c.env, instanceId, session.uid, "specialInstructions", String(body.instructions ?? "").slice(0, 4000));
		return c.json({ ok: true });
	});

	/** The agent's learned per-ATS tips (what worked + failed) — full transparency. */
	router.get("/:instanceId/apply-tips", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		// The ATS cache is per-USER (shared across the user's apply runs), so only an agent that
		// actually DOES applying may read it — otherwise it surfaces a user's application history
		// inside unrelated agents (e.g. Coder). Defense-in-depth behind the console gate.
		//
		// Gated on the declared `apply` surface rather than `slug === "job-application-assistant"`:
		// the slug check silently returned an empty list for any OTHER apply agent — a second
		// instance built from config would have had a permanently blank Rules & Tips tab with no
		// error to explain it. Capability, not identity.
		const caps = await capabilitiesForInstance(c.env, instanceId, session.uid);
		if (!caps?.surfaces.includes("apply")) return c.json({ tips: [] });
		return c.json({ tips: await listAtsCache(c.env, session.uid) });
	});

	/** Supply the value the apply agent asked for (ask-and-hold / needs_input handoff). */
	router.post("/:instanceId/input", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await requireLiveRuntime(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { taskId?: string; value?: string };
		if (!body.taskId) return c.json({ error: "taskId required" }, 400);
		const res = await callRuntime(c.env, runtime, "/browser/input", {
			method: "POST",
			body: JSON.stringify({ taskId: body.taskId, value: String(body.value ?? "") }),
		});
		const payload = (await runtimeJson(res)) as { ok?: boolean } | null;
		// The runner reports a LOST handoff as `{ok:false}` with HTTP 200 (its own comment says
		// "so the console can say session expired"), and this route passed the 200 straight
		// through — so the console, which only alerts on a thrown error, showed success and
		// cleared the box. The value was never delivered, the workflow polled a dead session for
		// the remaining 15 minutes, and the run closed "needs_input not resolved in time" with
		// the answer the user typed recorded nowhere.
		if (payload && payload.ok === false) {
			return c.json(
				{ ...payload, error: "That takeover session is gone (the runner restarted). Re-run the application and answer again." },
				409,
			);
		}
		return c.json((payload ?? {}) as object, runtimeStatus(res, 200));
	});

	/** End a human-takeover session. */
	router.post("/:instanceId/takeover/:taskId/end", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const runtime = await requireLiveRuntime(c.env, instanceId, session.uid);
		const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(taskId)}/end`, { method: "POST" });
		return c.json((await runtimeJson(res)) as object, runtimeStatus(res, 200));
	});

	/** Start the LLM-driven job application (the ONLY apply path). dryRun fills everything but never submits. */
	router.post("/:instanceId/apply", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		// The apply workflow drives the local runner — a Pro feature.
		await requirePro(c.env, session);
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
			// Bump last_activity_at — starting an apply run is a real user-driven event.
			void touchInstanceActivity(c.env, instanceId, session.uid);
			return c.json({ workflowId, taskId, status: "running", url }, 202);
		} catch (e) {
			if (e instanceof ApplyError) return c.json({ error: e.message }, e.status === 502 ? 502 : 400);
			throw e;
		}
	});
}
