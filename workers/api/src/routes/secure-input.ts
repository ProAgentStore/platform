// Secure input request endpoints (#906)
//
// These endpoints are called by:
// 1. Agents (via MCP tools) to create/check/inject secure input requests
// 2. The console UI (owner-facing) to display pending requests and submit secret values
//
// Critical invariant: plaintext secrets are NEVER returned by any route.
// All responses are metadata-only.

import { Hono, type Context } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { commandApproved, countSecureInputRequests, createSecureInputRequest, getSecureInputStatus, listSecureInputRequests, pendingOwnerInputs, storeSecretValue } from "../lib/secure-input.js";
import { deepLinkFor, secureInputLink } from "../lib/console-links.js";
import { instanceListName } from "../lib/instance-config.js";
import { notifyUser } from "./push.js";
import { injectSecureInputToTmux } from "../lib/secure-input-inject.js";
import { commandLine, runSecureInputSudo, validateSudoCommand } from "../lib/secure-input-sudo.js";
import type { Env } from "../types.js";

export const secureInputRoutes = new Hono<{ Bindings: Env }>();

/** Confirm the caller owns the instance. */
async function requireOwned(c: Context<{ Bindings: Env }>): Promise<{ uid: string; instanceId: string }> {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId") ?? c.req.param("id") ?? "";
	const owned = await c.env.DB.prepare("SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, session.uid).first();
	if (!owned) throw new HttpError(404, "Instance not found");
	return { uid: session.uid, instanceId };
}

/**
 * POST /:instanceId/secure-inputs
 * Create a new secure input request (agent calls this via MCP tool).
 * Returns the request ID (opaque reference for later use).
 */
secureInputRoutes.post("/:instanceId/secure-inputs", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

	const label = typeof body.label === "string" ? body.label.trim() : "";
	const purpose = typeof body.purpose === "string" ? body.purpose.trim() : undefined;
	const destinationScope = body.destinationScope as string | undefined;

	if (!label || !["tmux", "env", "stdin", "file", "sudo"].includes(destinationScope ?? "")) {
		throw new HttpError(400, "label and destinationScope (tmux|env|stdin|file|sudo) are required");
	}
	// A `sudo` request names the exact command the owner will be asked to approve (#1131) — and only a `sudo` request does.
	let command: string[] | undefined;
	if (destinationScope === "sudo") {
		const checked = validateSudoCommand(body.command);
		if (!checked.ok) throw new HttpError(400, checked.error);
		command = checked.argv;
	} else if (body.command !== undefined && body.command !== null) {
		throw new HttpError(400, "command is for a sudo-scoped request only");
	}

	const target = targetOf(body.target);
	if (target === false) throw new HttpError(400, TARGET_RULE);
	if (target && destinationScope !== "tmux") throw new HttpError(400, "target names a tmux session — only a tmux-scoped request takes one");

	const requestId = await createSecureInputRequest(c.env, {
		instanceId,
		userId: uid,
		label,
		purpose,
		destinationScope: destinationScope as "tmux" | "env" | "stdin" | "file" | "sudo",
		oneShot: body.oneShot !== false,
		...(target ? { target } : {}),
		...(command ? { command } : {}),
	});

	const consoleUrl = secureInputLink(instanceId, requestId);
	// The owner is TOLD (#934): the URL above reaches only the agent, so a request used to sit unseen
	// for up to a day while the run that asked for it waited. An alert — a blocked run is waiting on
	// a human — deep-linked to the request. The label only; there is no value yet, and never would be.
	// Best-effort: failing to notify must not fail the request the agent is about to wait on.
	await notifyOwner(c.env, uid, instanceId, requestId, label).catch(() => undefined);
	return c.json({ id: requestId, consoleUrl }, 201);
});

async function notifyOwner(env: Env, uid: string, instanceId: string, requestId: string, label: string): Promise<void> {
	const row = await env.DB.prepare("SELECT i.config, a.name FROM agent_instances i JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1 AND i.user_id = ?2")
		.bind(instanceId, uid)
		.first<{ config: string | null; name: string | null }>();
	const agent = instanceListName(row?.config, row?.name) ?? "Your agent";
	await notifyUser(env, uid, "secure-input", `🔐 ${agent} needs a value`, `“${label}” — enter it in the console. The agent never sees it.`, deepLinkFor({ kind: "secure-input", instanceId, requestId }), {
		kind: "alert",
		instanceId,
		key: `secure-input:${requestId}`,
	});
}

/**
 * GET /my/secure-inputs
 * Per instance, the owner-facing requests still waiting for a value (#934) — the instance cards'
 * "waiting for you" count, in one call for the whole account. Registered BEFORE the
 * `/:instanceId/…` routes so `my` is never read as an instance id.
 */
secureInputRoutes.get("/my/secure-inputs", async (c) => {
	const session = await requireUser(c);
	return c.json({ instances: await pendingOwnerInputs(c.env, session.uid) });
});

/**
 * GET /:instanceId/secure-inputs
 * List pending secure input requests (metadata only) — a page with its place in the whole (#954).
 */
secureInputRoutes.get("/:instanceId/secure-inputs", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const limit = Math.max(1, Math.min(50, Number(c.req.query("limit")) || 20));
	const offset = Math.max(0, Math.trunc(Number(c.req.query("offset")) || 0));
	// `?status=all` (#929): the history as well as what is still open.
	const all = c.req.query("status") === "all";
	const [requests, total] = await Promise.all([listSecureInputRequests(c.env, instanceId, uid, limit, offset, all), countSecureInputRequests(c.env, instanceId, uid, all)]);
	return c.json({ requests, total, offset, nextOffset: offset + requests.length < total ? offset + requests.length : null });
});

/**
 * GET /:instanceId/secure-inputs/:requestId
 * Get the status of a specific secure input request (metadata only).
 */
secureInputRoutes.get("/:instanceId/secure-inputs/:requestId", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const requestId = c.req.param("requestId") ?? "";
	const status = await getSecureInputStatus(c.env, requestId, instanceId, uid);
	if (!status) throw new HttpError(404, "Request not found");
	return c.json(status);
});

/**
 * POST /:instanceId/secure-inputs/:requestId/submit
 * Submit the secret value for a pending request (console UI calls this).
 * Encrypts the value and marks request as 'ready'.
 */
secureInputRoutes.post("/:instanceId/secure-inputs/:requestId/submit", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const requestId = c.req.param("requestId") ?? "";
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

	const value = typeof body.value === "string" ? body.value : "";
	if (!value) throw new HttpError(400, "value is required");

	// A sudo request's value is stored only with the owner's approval of the exact command on it (#1131): the console sends back the argv it
	// showed. Said as its own refusal, so a missing or stale approval is not read as "not found".
	const approvedCommand = Array.isArray(body.approvedCommand) && body.approvedCommand.every((a) => typeof a === "string") ? (body.approvedCommand as string[]) : undefined;
	const current = await getSecureInputStatus(c.env, requestId, instanceId, uid);
	if (current?.destinationScope === "sudo" && current.status === "pending" && !commandApproved(JSON.stringify(current.command ?? []), approvedCommand)) {
		throw new HttpError(400, `This request runs ${current.command ? `\`${commandLine(current.command)}\`` : "a command"} as root. Submit the value together with approvedCommand — the exact command shown — to approve it.`);
	}
	const success = await storeSecretValue(c.env, requestId, instanceId, uid, value, { approvedCommand });
	if (!success) throw new HttpError(404, "Request not found or already consumed");

	const status = await getSecureInputStatus(c.env, requestId, instanceId, uid);
	return c.json(status);
});

const TARGET_RULE = "target must be a tmux session name or terminal target: 1-128 characters, no newlines";

/** A tmux session name, `undefined` when none was given, `false` when one was given and is unusable. */
function targetOf(raw: unknown): string | undefined | false {
	if (raw === undefined || raw === null || raw === "") return undefined;
	if (typeof raw !== "string") return false;
	const t = raw.trim();
	return t && t.length <= 128 && !/[\r\n]/.test(t) ? t : false;
}

/**
 * POST /:instanceId/secure-inputs/:requestId/inject  `{ target?, submit?, hiddenPrompt? }`
 * Type a ready `tmux` value into the named session or terminal target (`target`, else the one the
 * request named) and, with `submit` (default true), press Enter — VERIFIED, and restored when not
 * delivered (#966). A pane ending at a password prompt (or `hiddenPrompt: true`, which insists on
 * one) is verified by the prompt's outcome after Enter instead of by echo (#1140); `false` forces echo.
 *
 * Answers `{ delivered, reason?, submitted, consumedValue, target, status, length?, verifiedBy? }`. The value is
 * never in the answer. This REPLACES `…/consume`, which returned the plaintext to its caller: the MCP
 * worker dropped it and reported success while nothing was typed, and any holder of the owner's
 * session could read a secret back out of it — the one route that broke this file's first rule.
 */
secureInputRoutes.post("/:instanceId/secure-inputs/:requestId/inject", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const requestId = c.req.param("requestId") ?? "";
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const target = targetOf(body.target);
	if (target === false) throw new HttpError(400, TARGET_RULE);
	const hp = body.hiddenPrompt;
	if (hp !== undefined && hp !== null && typeof hp !== "boolean") throw new HttpError(400, "hiddenPrompt must be a boolean");
	const hidden = typeof hp === "boolean" ? hp : undefined;
	const result = await injectSecureInputToTmux(c.env, { instanceId, userId: uid, requestId, target, submit: body.submit !== false, hidden });
	if (!result) throw new HttpError(404, "Request not found");
	return c.json(result);
});

/**
 * POST /:instanceId/secure-inputs/:requestId/sudo  `{}`
 * Run the request's owner-approved command under `sudo -S -p '' --` on the agent's machine, with the stored value on sudo's stdin — never
 * typed into a pane (#1131). The body carries NOTHING: the command is the one stored on the request, fixed at creation and approved by
 * the owner when they submitted the value, so a caller cannot point a stored password at a different command.
 *
 * Answers `{ delivered, reason?, consumedValue, status, command, commandLine, exitCode?, timedOut?, stdout?, stderr?, length? }`.
 * `delivered` is true only when sudo exited 0, and only then is the value spent; any other outcome leaves it `ready` and says why, with
 * sudo's words and the value cut out. It is never retried by the platform.
 */
secureInputRoutes.post("/:instanceId/secure-inputs/:requestId/sudo", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const requestId = c.req.param("requestId") ?? "";
	const result = await runSecureInputSudo(c.env, { instanceId, userId: uid, requestId });
	if (!result) throw new HttpError(404, "Request not found");
	return c.json(result);
});
