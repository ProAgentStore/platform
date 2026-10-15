/**
 * Durable browser takeovers, per instance (#1031) — `lib/browser-takeovers.ts`.
 *
 *   GET   /:instanceId/browser-takeovers                      list (filter: state, subject_kind, subject_id)
 *   POST  /:instanceId/browser-takeovers                      ask a person to take over (idempotent per subject)
 *   GET   /:instanceId/browser-takeovers/:takeoverId          one
 *   PATCH /:instanceId/browser-takeovers/:takeoverId          move it: active (opened), resumed, ended
 *
 * And {@link takeoverGate}, which the runner takeover proxy (`instances-apply.ts`) calls before it shows
 * a frame or relays input: no live durable takeover, no remote control. Owner-scoped throughout; every
 * row is ids, a closed vocabulary and times — no URL, frame, cookie, token or session.
 */
import type { Context, Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { readBrowserVerification } from "../lib/browser-verification.js";
import {
	type BrowserTakeover,
	type BrowserTakeoverListResponse,
	type BrowserTakeoverTransitionResponse,
	TAKEOVER_REASONS,
	TAKEOVER_STATES,
	TAKEOVER_SUBJECTS,
	type TakeoverReason,
	type TakeoverState,
	type TakeoverSubject,
} from "../lib/browser-takeover-types.js";
import { getTakeover, latestTakeoverFor, LIVE_TAKEOVER_STATES, listTakeovers, requestTakeover, takeoverReasonOf, transitionTakeover } from "../lib/browser-takeovers.js";
import { deepLinkFor } from "../lib/console-links.js";
import { getLocalBrowserRun } from "../lib/local-browser/store.js";
import { endCardTakeover, fillRunForCard, relayCardTakeover } from "../lib/local-apply/fill-handoff.js";
import { resumeLocalBrowserRun } from "../lib/local-browser/sync.js";
import { callRuntime, type RuntimeRow, requireLiveRuntime, requireOwnedInstance, runtimeJson } from "./instances-runtime.js";
import { notifyUser } from "./push.js";
import type { Env } from "../types.js";

type C = Context<{ Bindings: Env }>;

async function owned(c: C): Promise<{ uid: string; instanceId: string }> {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId") ?? "";
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return { uid: session.uid, instanceId };
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);

/** Tell the owner a takeover is waiting — the event their notification policy decides, a link by id. */
async function notifyRequested(env: Env, uid: string, instanceId: string, takeover: BrowserTakeover): Promise<void> {
	await notifyUser(env, uid, "browser-takeover", "A browser run needs you to take over", `It is waiting on ${takeover.reason.replace(/_/g, " ")}. The request expires at ${takeover.expiresAt.slice(11, 16)} UTC.`, deepLinkFor({ kind: "browser-takeover", instanceId, takeover }), {
		kind: "alert",
		instanceId,
		key: `browser-takeover:${takeover.id}`,
		event: takeover.reason === "write_affordance" ? "approval_required" : "takeover_required",
	});
}

/**
 * The gate in front of a runner task's remote view and input (#1031). A takeover the runner holds with
 * no durable row yet is recorded as `requested` (the runner asking IS the request); a closed one —
 * resumed, ended, expired — is refused with how to ask again rather than silently reopened. `open`
 * moves a requested takeover to `active`: showing the frame is what opening means.
 */
export async function takeoverGate(env: Env, uid: string, instanceId: string, runtime: RuntimeRow, taskId: string, opts: { open: boolean; device?: string; fill?: { waiting: boolean; reason?: TakeoverReason } }): Promise<BrowserTakeover> {
	let takeover = await latestTakeoverFor(env, uid, instanceId, "runtime_task", taskId);
	if (takeover && !LIVE_TAKEOVER_STATES.includes(takeover.state)) {
		throw new HttpError(409, `This takeover is ${takeover.state}. Ask for it again (POST …/browser-takeovers with subjectKind "runtime_task") if the task still needs you.`);
	}
	if (!takeover) {
		// An application card (#1100) is never in the runner's task-takeover list — its page is its fill's
		// handoff — so with no record yet it is admitted only while that fill waits on a person.
		if (opts.fill) {
			if (!opts.fill.waiting) throw new HttpError(404, "No takeover is waiting for this task.");
		} else {
			const listed = (await runtimeJson(await callRuntime(env, runtime, "/takeover")).catch(() => ({}))) as { takeovers?: unknown };
			if (!Array.isArray(listed.takeovers) || !listed.takeovers.includes(taskId)) throw new HttpError(404, "No takeover is waiting for this task.");
		}
		const { settings } = await readBrowserVerification(env, instanceId, uid);
		takeover = (await requestTakeover(env, { userId: uid, instanceId, subjectKind: "runtime_task", subjectId: taskId, reason: opts.fill?.reason ?? "manual", mobileAllowed: settings.allowMobile }))?.takeover ?? null;
		if (!takeover) throw new HttpError(409, "The takeover could not be recorded, so it was not opened.");
	}
	// The owner's mobile preference (#1031), on the remote view itself — `device` is the caller's own statement.
	if (opts.open && opts.device === "mobile" && !takeover.mobileAllowed) {
		throw new HttpError(409, "Taking over from a phone is off for this agent (browser verification allowMobile). Take over at the machine, or allow it in Browser verification.");
	}
	if (opts.open && takeover.state === "requested") {
		const moved = await transitionTakeover(env, uid, instanceId, takeover.id, "active");
		if (moved.ok) takeover = moved.takeover;
	}
	return takeover;
}

export function registerBrowserTakeoverRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/browser-takeovers", async (c) => {
		const { uid, instanceId } = await owned(c);
		const state = c.req.query("state");
		const subjectKind = c.req.query("subject_kind");
		if (state && !oneOf(TAKEOVER_STATES, state)) throw new HttpError(400, `state must be one of ${TAKEOVER_STATES.join(", ")}`);
		if (subjectKind && !oneOf(TAKEOVER_SUBJECTS, subjectKind)) throw new HttpError(400, `subject_kind must be one of ${TAKEOVER_SUBJECTS.join(", ")}`);
		const takeovers = await listTakeovers(c.env, uid, instanceId, {
			...(state ? { state: state as TakeoverState } : {}),
			...(subjectKind ? { subjectKind: subjectKind as TakeoverSubject } : {}),
			...(c.req.query("subject_id") ? { subjectId: c.req.query("subject_id") } : {}),
			limit: Number(c.req.query("limit")) || 20,
		});
		const body: BrowserTakeoverListResponse = { takeovers };
		return c.json(body);
	});

	router.post("/:instanceId/browser-takeovers", async (c) => {
		const { uid, instanceId } = await owned(c);
		const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { subjectKind?: unknown; subjectId?: unknown; reason?: unknown };
		const subjectKind = body.subjectKind ?? "manual";
		if (!oneOf(TAKEOVER_SUBJECTS, subjectKind)) throw new HttpError(400, `subjectKind must be one of ${TAKEOVER_SUBJECTS.join(", ")}`);
		if (body.reason !== undefined && !oneOf(TAKEOVER_REASONS, body.reason)) throw new HttpError(400, `reason must be one of ${TAKEOVER_REASONS.join(", ")}`);
		const { settings } = await readBrowserVerification(c.env, instanceId, uid);
		if (settings.enabled && settings.takeover === "never") throw new HttpError(409, "This instance's browser verification is set never to ask for a takeover. Change takeover to \"prompt\" first.");
		let subjectId = typeof body.subjectId === "string" ? body.subjectId.trim().slice(0, 128) : "";
		let reason: TakeoverReason = takeoverReasonOf(body.reason);
		if (subjectKind === "local_browser_run") {
			const run = subjectId ? await getLocalBrowserRun(c.env, instanceId, uid, subjectId) : null;
			if (!run) throw new HttpError(404, "Local browser run not found");
			if (run.status !== "paused") throw new HttpError(409, `Only a paused run waits for a person; this one is ${run.status}.`);
			if (body.reason === undefined) reason = takeoverReasonOf(run.pauseReason);
		} else if (subjectKind === "runtime_task") {
			if (!subjectId) throw new HttpError(400, "subjectId (the runner task id) is required for a runtime_task takeover.");
		} else {
			subjectId = subjectId || `manual-${crypto.randomUUID()}`;
		}
		const out = await requestTakeover(c.env, { userId: uid, instanceId, subjectKind, subjectId, reason, mobileAllowed: settings.allowMobile });
		if (!out) throw new HttpError(409, "The takeover could not be recorded.");
		if (out.created) await notifyRequested(c.env, uid, instanceId, out.takeover).catch(() => undefined);
		return c.json(out, out.created ? 201 : 200);
	});

	router.get("/:instanceId/browser-takeovers/:takeoverId", async (c) => {
		const { uid, instanceId } = await owned(c);
		const takeover = await getTakeover(c.env, uid, instanceId, c.req.param("takeoverId"));
		if (!takeover) throw new HttpError(404, "Takeover not found");
		return c.json({ takeover });
	});

	/**
	 * Move a takeover. `active` — opened (refused from a phone when the owner's preference forbids it;
	 * `device` is the caller's own statement); `resumed` — hand back to the run, which RESUMES it (a
	 * local browser run, or the runner task); `ended` — declined. `expired` is the cron's alone.
	 */
	router.patch("/:instanceId/browser-takeovers/:takeoverId", async (c) => {
		const { uid, instanceId } = await owned(c);
		const takeover = await getTakeover(c.env, uid, instanceId, c.req.param("takeoverId"));
		if (!takeover) throw new HttpError(404, "Takeover not found");
		const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { state?: unknown; device?: unknown };
		if (!oneOf(["active", "resumed", "ended"] as const, body.state)) throw new HttpError(400, "state must be active, resumed or ended (expired is set when a request runs out of time).");
		if (body.state === "active" && body.device === "mobile" && !takeover.mobileAllowed) {
			throw new HttpError(409, "Taking over from a phone is off for this agent (browser verification allowMobile). Take over at the machine, or allow it in Browser verification.");
		}
		if (body.state === "resumed" && LIVE_TAKEOVER_STATES.includes(takeover.state)) {
			if (takeover.subjectKind === "local_browser_run") {
				const run = await getLocalBrowserRun(c.env, instanceId, uid, takeover.subjectId);
				// Resuming the run closes its takeover — from the run's own state change (store.ts).
				if (run?.status === "paused") await resumeLocalBrowserRun(c.env, instanceId, uid, run);
			} else if (takeover.subjectKind === "runtime_task") {
				// #1100: a card hands back through its fill (or records its post-run sign-in and retries it).
				const fill = await fillRunForCard(c.env, instanceId, uid, takeover.subjectId);
				if (fill) await relayCardTakeover(c.env, uid, instanceId, fill, takeover, "resume");
				else {
					const runtime = await requireLiveRuntime(c.env, instanceId, uid);
					const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(takeover.subjectId)}/resume`, { method: "POST" });
					if (!res.ok) throw new HttpError(409, `The runner did not resume the task (HTTP ${res.status}); the takeover stays ${takeover.state}.`);
				}
			}
		}
		if (body.state === "ended" && takeover.subjectKind === "runtime_task" && LIVE_TAKEOVER_STATES.includes(takeover.state)) {
			const fill = await fillRunForCard(c.env, instanceId, uid, takeover.subjectId);
			if (fill) await endCardTakeover(c.env, uid, instanceId, fill, takeover);
			else {
				const runtime = await requireLiveRuntime(c.env, instanceId, uid).catch(() => null);
				if (runtime) await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(takeover.subjectId)}/end`, { method: "POST" }).catch(() => undefined);
			}
		}
		const out = await transitionTakeover(c.env, uid, instanceId, takeover.id, body.state, body.state === "ended" ? { endReason: "declined" } : {});
		// A resume above may already have closed it (resumed); that is the outcome asked for.
		if (!out.ok && out.takeover?.state !== body.state) throw new HttpError(409, out.error);
		// Past the guard it is never null: a move made carries it, a refused one only gets here with its state.
		const moved: BrowserTakeoverTransitionResponse = { takeover: out.takeover as BrowserTakeover, changed: out.ok ? out.changed : false };
		return c.json(moved);
	});
}
