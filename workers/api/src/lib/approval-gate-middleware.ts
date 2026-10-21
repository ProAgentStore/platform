// The enforcement point of the account approval gate (#1268): one Hono middleware in front of every /v1 mutation.
//
// Because the console, the REST API and every MCP tool reach the platform through these same routes, deciding here
// covers all of them with no per-handler code to forget. A request the gate holds NEVER reaches its handler: it is
// stored (encrypted, exact), announced to the owner's phone, and answered 202 `approval_pending`.
//
// ── The replay bypass
//
// Approving replays the stored request through the app, in-process, and it must not be held a second time. The marker is
// a header, but it is only honoured when its value is a ONE-TIME token this isolate minted a moment ago for exactly this
// method + path. A header sent from outside carries no such token and is ignored — it is not "stripped at the edge", it is
// worthless: a guessed or replayed value finds nothing in the table.
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../types.js";
import { HttpError, isSuspended } from "./auth.js";
import { buildDiffPreview, beforeFingerprint, decide, MAX_HELD_BODY_BYTES, mayBeGated, requestFingerprintInput, sha256Hex } from "./approval-gate.js";
import { createChange, sealPayload, changeView } from "./account-change-requests.js";
import { notifyApprovalRequested } from "./account-approval-notify.js";
import { verifySession } from "./session.js";

export const GATE_BYPASS_HEADER = "X-Internal-Gate-Bypass";
const TOKEN_TTL_MS = 60_000;

const tokens = new Map<string, { method: string; path: string; userId: string; expires: number }>();
/** Requests the middleware has recognised as an approved replay — handlers ask this, never the header. */
const replayed = new WeakSet<Request>();

export const isGateReplay = (req: Request): boolean => replayed.has(req);

/** A single-use token for one replay of `method path` for `userId`. */
export function mintReplayToken(method: string, path: string, userId: string, now = Date.now()): string {
	for (const [k, v] of tokens) if (v.expires <= now) tokens.delete(k);
	const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
	tokens.set(token, { method: method.toUpperCase(), path, userId, expires: now + TOKEN_TTL_MS });
	return token;
}

function consumeReplayToken(token: string, method: string, path: string, now = Date.now()): boolean {
	const t = tokens.get(token);
	if (!t) return false;
	tokens.delete(token);
	return t.expires > now && t.method === method.toUpperCase() && t.path === path;
}

async function uidOf(c: Context<{ Bindings: Env }>): Promise<string | null> {
	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer ")) return null;
	const session = await verifySession(header.slice(7), c.env.SESSION_SIGNING_KEY).catch(() => null);
	return session?.uid ?? null;
}

const MUTATING = new Set(["POST", "PUT", "DELETE", "PATCH"]);

export function approvalGate(): MiddlewareHandler<{ Bindings: Env }> {
	return async (c, next) => {
		const method = c.req.method.toUpperCase();
		if (!MUTATING.has(method)) return next();
		const url = new URL(c.req.url);
		const bypass = c.req.header(GATE_BYPASS_HEADER);
		if (bypass && consumeReplayToken(bypass, method, url.pathname)) {
			replayed.add(c.req.raw);
			return next();
		}
		if (!mayBeGated(method, url.pathname)) return next();
		const userId = await uidOf(c);
		// No identity, or a suspended one: not this middleware's to answer — the handler's requireUser gives the 401 / 403.
		if (!userId || (await isSuspended(c, userId))) return next();

		const rawBody = await c.req.raw.clone().text();
		let body: Record<string, unknown> = {};
		try {
			const parsed = rawBody ? (JSON.parse(rawBody) as unknown) : {};
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
		} catch {
			body = {};
		}
		const decision = await decide(c.env, { method, path: url.pathname, body, userId });
		if (!decision.gated) return next();

		// Past this line the request is held, and a hold that cannot be kept must refuse — never fall through and apply.
		if (new TextEncoder().encode(rawBody).length > MAX_HELD_BODY_BYTES) {
			throw new HttpError(413, `This change is too large to hold for approval (over ${MAX_HELD_BODY_BYTES / 1024} KB), so it was not applied.`);
		}
		const sealed = await sealPayload(c.env, { body: rawBody, contentType: c.req.header("Content-Type") ?? null, client: c.req.header("X-PAGS-Client") ?? null });
		if (!sealed) throw new HttpError(503, "Approval is required for this change but it cannot be held securely right now, so it was not applied.");

		const { action, params, settings } = decision;
		const before = await beforeFingerprint(action, { env: c.env, userId, params, body });
		const fullPath = `${url.pathname}${url.search}`;
		const preview = buildDiffPreview(action, { method, path: fullPath, params, body, before: before.before });
		const now = Date.now();
		const { request, reused } = await createChange(c.env, {
			userId,
			actorUserId: userId,
			action: action.id,
			targetDescription: preview.target,
			method,
			path: fullPath,
			bodyEncrypted: sealed,
			diffPreview: preview,
			beforeFingerprint: before.fingerprint,
			requestFingerprint: await sha256Hex(requestFingerprintInput(method, fullPath, body)),
			expiresAt: now + settings.expirySeconds * 1000,
		}, now);
		if (!reused) await notifyApprovalRequested(c.env, request, preview);

		const view = changeView(request);
		return c.json(
			{
				status: "approval_pending",
				approval_id: request.id,
				action: action.id,
				action_label: action.label,
				target: view.target,
				diff_preview: preview,
				expires_at: view.expiresAt,
				poll: view.poll,
				message: `Nothing has changed. This account requires the owner's approval from their phone for "${action.label}". Poll ${view.poll} until the status is applied, denied, expired or failed; do not retry the request.`,
			},
			202,
			{ Location: view.poll, "Retry-After": "5" },
		);
	};
}
