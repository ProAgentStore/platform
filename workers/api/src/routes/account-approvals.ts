// Owner API for the account approval gate (#1268): the held changes, their decision, and the gate's own settings.
//
// Deciding is the OWNER's act at the console or from the push link. MCP carries `X-PAGS-Client: mcp` on every call it
// makes, and an approve or deny that arrives that way is refused: an agent that asked for a change cannot approve it,
// whatever token it holds. (Cancel is allowed — withdrawing your own request needs no protection.)
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import {
	type ChangeRequest,
	approveChange,
	cancelChange,
	changeView,
	claimApply,
	denyChange,
	expireDueFor,
	expireIfDue,
	failApproved,
	finishApply,
	getChange,
	listChanges,
	listEvents,
	openPayload,
} from "../lib/account-change-requests.js";
import { GATE_BYPASS_HEADER, mintReplayToken, isGateReplay } from "../lib/approval-gate-middleware.js";
import { GATED_ACTIONS, actionById, beforeFingerprint, DEFAULT_ACTIONS, loadGate, matchRoute, MAX_EXPIRY_SECONDS, MIN_EXPIRY_SECONDS, parseGateUpdate, saveGate, weakensGate } from "../lib/approval-gate.js";
import { clipMarked } from "../lib/clip-marked.js";
import { isMcpRequest } from "../lib/coding-api-policy.js";
import type { Env } from "../types.js";

export const accountApprovalRoutes = new Hono<{ Bindings: Env }>();

type Replay = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
let replay: Replay | null = null;
/** index.ts hands the app's own fetch in, so an approved change runs through exactly the routes everything else uses. */
export function setGateReplay(fn: Replay): void {
	replay = fn;
}

const idleContext = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

function ownerOnly(c: { req: { header: (n: string) => string | undefined } }): void {
	if (isMcpRequest(c.req.header("X-PAGS-Client"))) {
		throw new HttpError(403, "An approval can only be decided by the owner in the console or from the push link, not through MCP.");
	}
}

const deviceOf = (c: { req: { header: (n: string) => string | undefined } }, body: Record<string, unknown>): string =>
	clipMarked(typeof body.device === "string" && body.device.trim() ? body.device.trim() : (c.req.header("User-Agent") ?? "unknown device"), 120);

async function requireChange(env: Env, id: string, userId: string): Promise<ChangeRequest> {
	const found = await getChange(env, id, userId);
	if (!found) throw new HttpError(404, "Approval request not found");
	return found;
}

const detailOf = async (env: Env, req: ChangeRequest) => ({ ...changeView(req), events: await listEvents(env, req.id, req.userId) });

/** GET /v1/approvals — pending and recent requests for this account. */
accountApprovalRoutes.get("/approvals", async (c) => {
	const session = await requireUser(c);
	await expireDueFor(c.env, session.uid);
	const rows = await listChanges(c.env, session.uid, Math.min(100, Math.max(1, Number(c.req.query("limit")) || 30)));
	return c.json({ approvals: rows.map((r) => changeView(r)), pending: rows.filter((r) => r.status === "pending").length });
});

/** GET /v1/approvals/:id — the poll: status, the diff, the audit trail and, once it ran, what the change answered. */
accountApprovalRoutes.get("/approvals/:id", async (c) => {
	const session = await requireUser(c);
	const req = await expireIfDue(c.env, await requireChange(c.env, c.req.param("id"), session.uid));
	return c.json(await detailOf(c.env, req));
});

accountApprovalRoutes.post("/approvals/:id/deny", async (c) => {
	const session = await requireUser(c);
	ownerOnly(c);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const req = await expireIfDue(c.env, await requireChange(c.env, c.req.param("id"), session.uid));
	const done = await denyChange(c.env, req, deviceOf(c, body));
	const now = await requireChange(c.env, req.id, session.uid);
	return c.json({ ...(await detailOf(c.env, now)), changed: done }, done || now.status === "denied" ? 200 : 409);
});

accountApprovalRoutes.post("/approvals/:id/cancel", async (c) => {
	const session = await requireUser(c);
	const req = await expireIfDue(c.env, await requireChange(c.env, c.req.param("id"), session.uid));
	const done = await cancelChange(c.env, req, session.uid);
	const now = await requireChange(c.env, req.id, session.uid);
	return c.json({ ...(await detailOf(c.env, now)), changed: done }, done || now.status === "cancelled" ? 200 : 409);
});

/**
 * POST /v1/approvals/:id/approve — decide, check, run once.
 *
 *   expired                → 410
 *   already decided/ran    → 200 with the recorded outcome (a duplicate tap is a no-op, never a second apply)
 *   target moved           → 409 drift_detected, nothing applied
 *   otherwise              → the stored request is replayed once; the response carries what it answered
 */
accountApprovalRoutes.post("/approvals/:id/approve", async (c) => {
	const session = await requireUser(c);
	ownerOnly(c);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	let req = await expireIfDue(c.env, await requireChange(c.env, c.req.param("id"), session.uid));
	if (req.status === "expired") return c.json({ ...(await detailOf(c.env, req)), status: "expired", message: "This request expired before it was approved, so nothing was changed. Ask for the change again." }, 410);
	if (req.status !== "pending") return c.json({ duplicate: true, ...(await detailOf(c.env, req)) });

	if (!(await approveChange(c.env, req, deviceOf(c, body)))) {
		req = await expireIfDue(c.env, await requireChange(c.env, req.id, session.uid));
		return c.json({ ...(await detailOf(c.env, req)), duplicate: req.status !== "expired" }, req.status === "expired" ? 410 : 200);
	}
	req = await requireChange(c.env, req.id, session.uid);

	const action = actionById(req.action);
	const payload = await openPayload(c.env, req.bodyEncrypted);
	const [pathname] = req.path.split("?");
	let parsed: Record<string, unknown> = {};
	try {
		const p = payload?.body ? (JSON.parse(payload.body) as unknown) : {};
		if (p && typeof p === "object" && !Array.isArray(p)) parsed = p as Record<string, unknown>;
	} catch {
		parsed = {};
	}
	const match = matchRoute(req.method, pathname, parsed);
	if (!action || !payload || !match) {
		await failApproved(c.env, req, "The stored change could not be read back, so it was not applied.");
		return c.json({ ...(await detailOf(c.env, await requireChange(c.env, req.id, session.uid))), message: "The stored change could not be read back, so it was not applied." }, 500);
	}

	// Drift: the target must still be what the owner was shown. A moved target is never "the same change, later".
	const now = await beforeFingerprint(action, { env: c.env, userId: session.uid, params: match.params, body: parsed });
	if (now.fingerprint !== req.beforeFingerprint) {
		const message = "The thing this change would modify has changed since it was requested, so it was not applied. Review the current state and ask again.";
		await failApproved(c.env, req, message);
		return c.json({ ...(await detailOf(c.env, await requireChange(c.env, req.id, session.uid))), status: "drift_detected", message }, 409);
	}

	if (!(await claimApply(c.env, req))) return c.json({ duplicate: true, ...(await detailOf(c.env, await requireChange(c.env, req.id, session.uid))) });

	if (!replay) {
		await finishApply(c.env, req, { ok: false, status: 500, result: "The apply step is not available." });
		throw new HttpError(500, "The apply step is not available.");
	}
	const origin = new URL(c.req.url).origin;
	const headers: Record<string, string> = {
		Authorization: c.req.header("Authorization") ?? "",
		"X-PAGS-Client": payload.client ?? "approval-replay",
		[GATE_BYPASS_HEADER]: mintReplayToken(req.method, pathname, session.uid),
	};
	if (payload.contentType) headers["Content-Type"] = payload.contentType;
	let ctx: ExecutionContext = idleContext;
	try {
		ctx = c.executionCtx;
	} catch {
		ctx = idleContext;
	}
	const res = await replay(new Request(`${origin}${req.path}`, { method: req.method, headers, ...(req.method === "DELETE" && !payload.body ? {} : { body: payload.body || undefined }) }), c.env, ctx);
	const text = await res.text();
	await finishApply(c.env, req, { ok: res.ok, status: res.status, result: clipMarked(text, 2000) });
	const final = await requireChange(c.env, req.id, session.uid);
	return c.json(await detailOf(c.env, final), res.ok ? 200 : 502);
});

// ── The gate's settings ──────────────────────────────────────────────────────

const gateView = async (env: Env, userId: string) => {
	const settings = await loadGate(env, userId);
	await expireDueFor(env, userId);
	const pending = (await listChanges(env, userId, 100)).filter((r) => r.status === "pending").length;
	return {
		...settings,
		pending,
		limits: { minExpirySeconds: MIN_EXPIRY_SECONDS, maxExpirySeconds: MAX_EXPIRY_SECONDS },
		defaultActions: DEFAULT_ACTIONS,
		available: GATED_ACTIONS.map((a) => ({ id: a.id, label: a.label, description: a.description, defaultOn: a.defaultOn })),
	};
};

accountApprovalRoutes.get("/approval-gate", async (c) => {
	const session = await requireUser(c);
	return c.json(await gateView(c.env, session.uid));
});

/**
 * PUT /v1/approval-gate { enabled?, actions?, expirySeconds? }. While the gate is on, a change that WEAKENS it (turning it
 * off, dropping an action) is held by the middleware like any other gated change and only runs from an approval. The check
 * below is the same rule written a second time, so a request that somehow got past the middleware still cannot weaken it.
 */
accountApprovalRoutes.put("/approval-gate", async (c) => {
	const session = await requireUser(c);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const current = await loadGate(c.env, session.uid);
	const parsed = parseGateUpdate(body, current);
	if (!parsed.ok) throw new HttpError(400, parsed.error);
	if (weakensGate(current, parsed.next) && !isGateReplay(c.req.raw)) {
		throw new HttpError(403, "Weakening the approval gate needs the owner's approval from their phone.");
	}
	await saveGate(c.env, session.uid, parsed.next);
	return c.json({ success: true, gate: await gateView(c.env, session.uid) });
});
