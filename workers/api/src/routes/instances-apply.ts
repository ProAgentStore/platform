import { endCardTakeover, fillGate, fillRunForCard, relayCardTakeover } from "../lib/local-apply/fill-handoff.js";
import { closeLiveTakeoverFor, LIVE_TAKEOVER_STATES, latestTakeoverFor, transitionTakeover } from "../lib/browser-takeovers.js";
import { browserScreenshotsEnabled } from "../lib/browser-screenshots.js";
import { takeoverGate } from "./instances-browser-takeovers.js";
import { recordAnswer } from "../lib/coder-question-store.js";
import { answerDecision, markDecisionsApplied, pendingAnswersFor } from "../lib/owner-decisions.js";
import { wakeParkedRunDetailed } from "../lib/coding-park.js";
import { recoverDeadParkedRun } from "../lib/park-recovery.js";
import { isMcpRequest } from "../lib/coding-api-policy.js";
import { logEvent } from "../lib/events.js";
import { postIssueComment } from "../lib/github-issues.js";
import { clipMarked } from "../lib/clip-marked.js";
import { overLimit } from "../lib/write-limits.js";
import type { Hono } from "hono";
import { decisionRunForCard, resolveCodingPause } from "../lib/coding-answer.js";
import { codingCardId } from "../lib/coding-board.js";
import { HttpError, requireUser } from "../lib/auth.js";
import { requirePro } from "../lib/billing.js";
import { capabilitiesForInstance } from "../lib/agent-capabilities.js";
import { deriveJobPassword, listAtsCache } from "../lib/apply-cache.js";
import { findCredentialForHost } from "../lib/credentials.js";
import { openBudget } from "../lib/delegation-budget-store.js";
import { createLoopRun } from "../lib/agent-loop-store.js";
import { BROWSER_RUN_ROUNDS, browserRunObjective } from "../lib/browser-run.js";
import { getProfile, profileToCandidate, profileToPreferences, profileCustomAnswers, saveAskAndHoldAnswer } from "../lib/profile.js";
import { parseResumeIntoProfile } from "../lib/resume-parse.js";
import { timingSafeEqualStr } from "../lib/crypto.js";
import { runShotKey } from "../lib/run-shots.js";
import type { Env } from "../types.js";
import { createBrowserRuntimeTask } from "./browser-workflows.js";
import { deriveFromUrl } from "../lib/board.js";
import { logError } from "../lib/error-log.js";
import { callRuntime, getLiveRuntime, requireOwnedInstance, requireLiveRuntime, runtimeJson, runtimeStatus } from "./instances-runtime.js";
import { patchInstanceConfig, touchInstanceActivity } from "../lib/instance-config.js";
import { sqlTime } from "../lib/sql-time.js";

/** Every coding session's board card id starts with this (`codingCardId`). */
const CODING_CARD_PREFIX = codingCardId("");

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
 * The single entry point for the LLM-driven JOB_APPLY job application: builds the job from the
 * structured Profile + credentials vault + Special Instructions, creates the agent-driven runner
 * task, and starts the JobApplyWorkflow brain. Used by the /apply route, the chat agent's apply tool
 * and MCP `apply_to_job` (through the route).
 *
 * A SUPPORTED browser-work path alongside Scout → Tailor → Runner (#1062; it was wrongly refused as
 * "retired" from 2026-10-08). Only an instance whose agent declares `workflow: "JOB_APPLY"` can start
 * one — any other agent has no JobApplyWorkflow to drive — and every start keeps the same guards:
 * a résumé on file, a live runner, ONE application per instance at a time, a spend pool and a run
 * row, and candidate values from the owner's Profile.
 */
export async function startJobApply(env: Env, instanceId: string, userId: string, input: StartApplyInput): Promise<{ workflowId: string; taskId: string }> {
	const caps = await capabilitiesForInstance(env, instanceId, userId);
	if (caps?.workflow !== "JOB_APPLY") {
		throw new ApplyError("This agent does not run the JOB_APPLY job-application workflow. Apply from a Job Application Assistant instance, or use the Scout → Tailor → Runner pipeline.", 409);
	}

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
	// Both the value written and the bound cutoff are in the COLUMN's format (#634). They have to
	// move together: the guard below compares `updated_at > ?5`, so the moment the mirror writer
	// started storing `datetime('now')`'s shape, an ISO cutoff would have read every live card as
	// stale — and single-flight is the one thing standing between a double-click and two
	// concurrent applications.
	const nowSql = sqlTime();
	const staleCutoff = sqlTime(Date.now() - STALE_APPLY_MS);
	const claim = await env.DB.prepare(
		`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
		 SELECT ?1, ?2, ?3, 'job.apply_agent', 'queued', '{"claim":true}', ?4, ?4
		 WHERE NOT EXISTS (
		   SELECT 1 FROM instance_runtime_tasks
		   WHERE instance_id = ?2 AND type = 'job.apply_agent'
		     AND status IN ('queued','running','needs_human') AND hidden = 0
		     AND updated_at > ?5
		 )`,
	).bind(claimId, instanceId, userId, nowSql, staleCutoff).run();
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
		const decided = await pendingAnswersFor(env, { instanceId, userId, kind: "job_apply", scope: url }).catch(() => []);
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
			// …and (#1079) answers the owner gave to THIS posting after an earlier run stopped waiting.
			providedAnswers: { ...profileCustomAnswers(rawProfile), ...Object.fromEntries(decided.map((d) => [d.field ?? d.question, d.answer as string])) },
			today: new Date().toISOString().slice(0, 10),
		};

		// The owner's screenshot switch, fixed into this task as it starts (#1064): recorded on the task's
		// input (the storage guard and the console read it there) and handed to the workflow.
		const screenshotsOn = await browserScreenshotsEnabled(env, instanceId, userId);
		let taskId: string;
		try {
			// Give the board card a real title up front (best-effort from the job URL),
			// so it reads e.g. "Business Ai Group… Head Of Engineering / employmenthero.com"
			// instead of a derived-at-render guess.
			const card = deriveFromUrl(url);
			({ taskId } = await createBrowserRuntimeTask(env, instanceId, userId, {
				type: "job.apply_agent",
				input: { url, resumePath, ...(screenshotsOn ? {} : { screenshots: false }) },
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
		if (decided.length) await markDecisionsApplied(env, decided.map((d) => d.id), taskId).catch(() => undefined);
		const instance = await env.JOB_APPLY.create({ params: { instanceId, userId, taskId, job, budgetId, depth: 0, loopRunId, ...(screenshotsOn ? {} : { screenshots: false as const }) } });
		return { workflowId: instance.id, taskId };
	} finally {
		await dropClaim();
	}
}


/** Special Instructions (Rules & Tips): refused above this, never cut (#898). */
export const SPECIAL_INSTRUCTIONS_MAX_CHARS = 4000;

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
		// No `.catch` (#1134): the parse records its own failures, and anything that still escapes is
		// recorded by the Worker's `waitUntil` wrapper (`index.ts`) instead of being dropped here.
		c.executionCtx.waitUntil(parseResumeIntoProfile(c.env, instanceId, session.uid, new Uint8Array(body), mime));
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
		c.executionCtx.waitUntil(parseResumeIntoProfile(c.env, instanceId, session.uid, bytes, mime)); // no `.catch` — see the upload route (#1134)
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
		// #1031: no remote view without a durable takeover; showing the frame opens it (→ active).
		const fill = await fillRunForCard(c.env, instanceId, session.uid, taskId);
		const takeover = await takeoverGate(c.env, session.uid, instanceId, runtime, taskId, { open: true, device: c.req.query("device"), fill: fillGate(fill) });
		// #1100: an application card's live page is its fill's handoff — or, once that fill has ended
		// blocked on a sign-in, a sign-in page with no run — never a runner task takeover.
		if (fill) return c.json((await relayCardTakeover(c.env, session.uid, instanceId, fill, takeover, "frame")) as object);
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
		const fill = await fillRunForCard(c.env, instanceId, session.uid, taskId);
		const takeover = await takeoverGate(c.env, session.uid, instanceId, runtime, taskId, { open: true, device: c.req.query("device"), fill: fillGate(fill) });
		const body = await c.req.text();
		if (fill) return c.json((await relayCardTakeover(c.env, session.uid, instanceId, fill, takeover, "input", JSON.parse(body || "null"))) as object);
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
		const fill = await fillRunForCard(c.env, instanceId, session.uid, taskId);
		const takeover = await takeoverGate(c.env, session.uid, instanceId, runtime, taskId, { open: false, fill: fillGate(fill) });
		if (fill) {
			const resumed = await relayCardTakeover(c.env, session.uid, instanceId, fill, takeover, "resume");
			await transitionTakeover(c.env, session.uid, instanceId, takeover.id, "resumed").catch(() => undefined);
			return c.json(resumed as object);
		}
		const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(taskId)}/resume`, { method: "POST" });
		if (res.ok) await transitionTakeover(c.env, session.uid, instanceId, takeover.id, "resumed").catch(() => undefined);
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
		// Refused past the limit, as the operator manual is (#898): this sliced to 4,000 and said `ok`,
		// so the rules the owner wrote last were the ones silently gone.
		const instructions = String(body.instructions ?? "");
		const tooLong = overLimit({ instructions: [instructions, SPECIAL_INSTRUCTIONS_MAX_CHARS] });
		if (tooLong) return c.json({ error: tooLong }, 400);
		await patchInstanceConfig(c.env, instanceId, session.uid, "specialInstructions", instructions);
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

	/**
	 * Supply the value an agent asked for (ask-and-hold / needs_input handoff), routed by RUN KIND
	 * (#960): a coding question is answered on its `coder_questions` row; anything else is the apply
	 * agent's browser handoff, as before.
	 *
	 * #1075: a coding answer is WRITTEN TO THE ROW FIRST, in any state the question is in, and only then
	 * pushed to a live run, best-effort — the parked run reads the row, so a push the runner missed still
	 * lands. The console and MCP `answer_instance_input` both come here: one write, one reply. The reply
	 * always says what happened (`outcome`): delivered to a live run, stored for it, recorded after the
	 * run stopped, or recorded as a second answer to one already applied.
	 */
	router.post("/:instanceId/input", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { taskId?: string; value?: string };
		if (!body.taskId) return c.json({ error: "taskId required" }, 400);
		const value = String(body.value ?? "");
		const via = isMcpRequest(c.req.header("X-PAGS-Client")) ? "mcp" : "console";
		// #1025: a person's answer wins at any point — written before delivery, so a brain decision in
		// flight loses its compare-and-swap and is discarded.
		const recorded = await recordAnswer(c.env, { instanceId, userId: session.uid, taskId: body.taskId, value, via });
		const q = recorded?.question;
		// #1256: recordAnswer, above, already committed the write — the owner's answer is safe on the
		// question's row. A failure in THIS lookup (which run, if any, is waiting on it) used to bubble
		// straight to app.onError as a bare 500, telling the console the answer was lost when it was not.
		// Report the degraded step instead: the run still reads the row on its next check or the minute
		// backstop's re-send, so nothing here is actually lost, only not delivered on this request.
		let coding: Awaited<ReturnType<typeof decisionRunForCard>>;
		try {
			coding = await decisionRunForCard(c.env, instanceId, session.uid, body.taskId);
		} catch (e) {
			if (!recorded) throw e;
			await logError(c.env, {
				source: "coder-question",
				level: "warn",
				status: 202,
				message: `answer recorded (${q?.id ?? "?"}), but looking up the run waiting on it failed: ${e instanceof Error ? e.message : String(e)}`,
				userId: session.uid,
				context: { instanceId, taskId: body.taskId, questionId: q?.id ?? null },
			}).catch(() => undefined);
			return c.json(
				{ ok: true, kind: "coding", outcome: "stored", delivered: false, recorded: true, questionId: q?.id ?? null, message: "Saved on the question. Something went wrong finding the run waiting on it just now; it reads your answer automatically within a minute." },
				202,
			);
		}
		if (recorded?.outcome === "already_applied" && coding && (coding.parkedSince ?? 0) > (q?.appliedAt ?? Number.POSITIVE_INFINITY)) {
			// #1234: the card's latest question was consumed, yet a run parked on this card AFTER that — a new
			// wait, on an ask with no row of its own (its capture failed). Reporting "already applied" left that
			// run parked with the owner's answer in hand; the runner's pause is the one thing still waiting, so
			// the answer goes there, and a failed delivery is said as one. A park from BEFORE the application is
			// the one that answer ended, clearing as the run resumes, and keeps the already-applied reply.
			const delivered = await resolveCodingPause(c.env, instanceId, session.uid, coding.sessionId, value).then(() => true, () => false);
			const base = { kind: "coding", runId: coding.runId, sessionId: coding.sessionId, recorded: false, questionId: null };
			if (delivered) return c.json({ ok: true, ...base, outcome: "delivered", delivered: true, message: "Delivered to the waiting run." });
			return c.json({ ok: false, ...base, outcome: "not_delivered", delivered: false, next: "retry", error: "The run is waiting on this card, but the coding runner could not be reached to hand it your answer. Make sure `pags up` is running on its machine and answer again." }, 409);
		}
		if (recorded?.outcome === "already_applied") {
			return c.json({ ok: true, kind: "coding", outcome: "already_applied", delivered: false, recorded: true, questionId: q?.id, appliedRunId: q?.appliedRunId ?? null, message: `That question was already answered, and run ${q?.appliedRunId ?? "(unknown)"} acted on the earlier answer. Your new answer is saved on the question's history, but nothing applied it.` }, 202);
		}
		if (coding) {
			const base = { kind: "coding", runId: coding.runId, sessionId: coding.sessionId, recorded: !!recorded, questionId: q?.id ?? null };
			// #1076: a run PARKED on the question is woken and reads the answer from the row. #1231: only a LIVE
			// Workflow counts as delivered — one that died while parked accepted the event and never read it.
			const wake = recorded ? await wakeParkedRunDetailed(c.env, coding.runId, "answer") : "not_parked";
			if (wake === "woken") {
				return c.json({ ok: true, ...base, outcome: "delivered", delivered: true, applied: false, message: "Delivered to the parked run, which is resuming with it. The question shows appliedAt once the run has taken your answer; if its repository is busy, it resumes as soon as that frees." });
			}
			if (wake === "gone") {
				await recoverDeadParkedRun(c.env, coding.runId).catch(() => false);
				return c.json({ ok: false, ...base, outcome: "run_gone", delivered: false, next: "continue_run", error: "The run that asked is no longer running: its workflow stopped while it was parked, so it cannot take your answer. Your answer is saved on the question and posted on its issue, and the run was closed so its queue can move. Continue the run (continue_instance_run, or Continue on its card); the continuation reads your answer." }, 409);
			}
			if (wake === "failed") {
				return c.json({ ok: true, ...base, outcome: "stored", delivered: false, message: "Saved on the question, but the parked run could not be signalled just now. The platform signals it again within a minute; nothing else is needed from you." }, 202);
			}
			// Not a zero-compute park: a live wait that polls. It reads the row on its next check; the runner push
			// wakes it sooner. With nothing on the row (a question that was never captured) the push is the only
			// delivery, so its failure is the reply.
			const delivered = await resolveCodingPause(c.env, instanceId, session.uid, coding.sessionId, value).then(
				() => true,
				(e: unknown) => {
					if (!recorded) throw e;
					return false;
				},
			);
			if (delivered) return c.json({ ok: true, ...base, outcome: "delivered", delivered: true, message: "Delivered to the waiting run." });
			return c.json({ ok: true, ...base, outcome: "stored", delivered: false, message: "Saved on the question. The coding runner could not be reached just now; the waiting run reads your answer from the question on its next check." }, 202);
		}
		if (recorded && q) {
			// #1256: a byte-identical resubmission of an answer already on this question's row (a retry
			// after a timeout, a double-click) is reported plainly and does not repeat the issue comment
			// or the "answered_late" log event below — nothing about the question changed.
			if (recorded.outcome === "already_answered") {
				return c.json({ ok: true, kind: "coding_late", outcome: "already_answered", delivered: false, recorded: true, questionId: q.id, message: "That's the same answer already on record for this question — nothing changed." });
			}
			// #1074: the run stopped waiting, but the owner's answer is still their decision. It is on the row
			// (unapplied, for a resume), and posted under the question on its issue, which the next run reads.
			const issue = q.repo && q.issueNumber ? q.issueNumber : null;
			const posted = issue && q.decision
				? await postIssueComment(c.env, session.uid, q.repo as string, issue, `**Answer received after the run stopped waiting.** The question was: ${clipMarked(q.question, 300, { within: true })}\n\n> ${q.decision}\n\nThe run that asked had already stopped, so this was not delivered to it. It is recorded here for the next run on this issue.`).catch(() => false)
				: false;
			await logEvent(c.env, { source: "tool", event: "coder_question.answered_late", message: "an answer arrived after the run stopped waiting; recorded, not delivered", userId: session.uid, instanceId, level: "info", context: { questionId: q.id, sessionId: q.sessionId, issue, postedToIssue: posted, via, state: q.state } }).catch(() => undefined);
			return c.json({ ok: true, kind: "coding_late", outcome: "recorded", delivered: false, recorded: true, questionId: q.id, postedToIssue: posted ? issue : null, message: `The run had already stopped waiting, so your answer was not delivered to it. It is saved on the question${posted ? ` and posted on issue #${issue}, where the next run on that issue will read it` : ""}.` }, 202);
		}
		// A coding session's card with no question on it is not a lost BROWSER session — say what it is.
		if (body.taskId.startsWith(CODING_CARD_PREFIX)) {
			return c.json({ ok: false, next: "reread", error: "No question was asked on that coding session, so there is nothing to answer. Re-read the board (instance_board) for the card that is waiting." }, 409);
		}
		// #1079: a browser (JOB_APPLY) question is a durable decision too — the answer is written to it
		// FIRST, then delivered. If the run has stopped waiting, it is kept and used next time, not refused.
		const decided = await answerDecision(c.env, { instanceId, userId: session.uid, taskId: body.taskId, value, via });
		if (decided?.outcome === "already_applied") {
			return c.json({ ok: true, kind: "job_apply", outcome: "already_applied", delivered: false, recorded: true, decisionId: decided.decision.id, message: `That question was already answered, and ${decided.decision.appliedRef ?? "a run"} used the earlier answer. Your new answer is saved on the question's history, but nothing applied it.` }, 202);
		}
		const keepForNextRun = async () => {
			const d = decided?.decision as NonNullable<typeof decided>["decision"];
			await saveAskAndHoldAnswer(c.env, session.uid, d.field ?? d.question, value).catch(() => undefined);
			await logEvent(c.env, { source: "apply", event: "apply.answered_late", message: "an answer arrived after the application stopped waiting; recorded for the next run", userId: session.uid, instanceId, level: "info", traceId: body.taskId, context: { decisionId: d.id, via } }).catch(() => undefined);
			return c.json({ ok: true, kind: "job_apply_late", outcome: "recorded", delivered: false, recorded: true, decisionId: d.id, message: "The application had already stopped waiting, so this was not delivered to it. It is saved — on the question and in your Profile — and the next application to this posting uses it (Retry it from the board)." }, 202);
		};
		const runtime = await getLiveRuntime(c.env, instanceId, session.uid).catch(() => null);
		if (!runtime && decided) return keepForNextRun();
		// #1243: say that nothing was delivered and that the same answer is safe to send again.
		if (!runtime) return c.json({ ok: false, delivered: false, next: "retry", error: "No runner is connected, so nothing was delivered. Start it with `pags up` on its machine, then send the same answer again." }, 503);
		const res = await callRuntime(c.env, runtime, "/browser/input", {
			method: "POST",
			body: JSON.stringify({ taskId: body.taskId, value }),
		});
		const payload = (await runtimeJson(res)) as { ok?: boolean } | null;
		if (payload && payload.ok === false && decided) return keepForNextRun();
		// The runner reports a LOST handoff as `{ok:false}` with HTTP 200 (its own comment says
		// "so the console can say session expired"), and this route passed the 200 straight
		// through — so the console, which only alerts on a thrown error, showed success and
		// cleared the box. The value was never delivered, the workflow polled a dead session for
		// the remaining 15 minutes, and the run closed "needs_input not resolved in time" with
		// the answer the user typed recorded nowhere.
		if (payload && payload.ok === false) {
			return c.json(
				{ ...payload, next: "rerun", error: "That takeover session is gone (the runner restarted). Re-run the application and answer again." },
				409,
			);
		}
		// The runner refused or could not be reached (a 503 when its relay is down, #1243): nothing was
		// delivered, and the same answer is safe to send again once it is back.
		if (!res.ok) return c.json({ ...(payload ?? {}), ok: false, delivered: false, next: "retry", error: `The runner did not take the answer (HTTP ${res.status}), so nothing was delivered. Send the same answer again once \`pags up\` is running on its machine.` }, runtimeStatus(res, 200));
		return c.json((payload ?? {}) as object, runtimeStatus(res, 200));
	});

	/** End a human-takeover session. */
	router.post("/:instanceId/takeover/:taskId/end", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const taskId = c.req.param("taskId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		// #1100: a card's page is its fill's handoff or a post-run sign-in, never in the runner's task map.
		const fill = await fillRunForCard(c.env, instanceId, session.uid, taskId);
		if (fill) {
			const live = await latestTakeoverFor(c.env, session.uid, instanceId, "runtime_task", taskId);
			if (live && LIVE_TAKEOVER_STATES.includes(live.state)) await endCardTakeover(c.env, session.uid, instanceId, fill, live);
			await closeLiveTakeoverFor(c.env, session.uid, instanceId, "runtime_task", taskId, "ended", Date.now(), "declined").catch(() => undefined);
			return c.json({ ok: true });
		}
		const runtime = await requireLiveRuntime(c.env, instanceId, session.uid);
		const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(taskId)}/end`, { method: "POST" });
		// Ending is never gated — a person must always be able to let go — but it is recorded (#1031).
		if (res.ok) await closeLiveTakeoverFor(c.env, session.uid, instanceId, "runtime_task", taskId, "ended", Date.now(), "declined").catch(() => undefined);
		return c.json((await runtimeJson(res)) as object, runtimeStatus(res, 200));
	});

	/** Start the LLM-driven JOB_APPLY application (#1062: supported). dryRun fills everything but never submits. */
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
			if (e instanceof ApplyError) return c.json({ error: e.message }, e.status === 409 ? 409 : e.status === 502 ? 502 : 400);
			throw e;
		}
	});
}
