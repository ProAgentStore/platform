/**
 * Stash / discard a repo's local changes on the machine that holds it, and the auto-stash policy (#1324).
 *
 *   POST /:instanceId/coding/repos/:repoId/checkout/stash    — `git stash -u` with a labelled message, then (default) `pull --ff-only`
 *   POST /:instanceId/coding/repos/:repoId/checkout/discard  — backup patch + untracked list, then reset --hard + clean -fd (never -x), then `pull --ff-only`
 *   GET|PUT /:instanceId/coding/auto-stash                   — whether runs may stash a dirty checkout themselves to get past a blocked pull
 *
 * The logic is `lib/checkout-actions.ts`; this half is auth, the discard confirmation and the HTTP
 * status of each named failure (an unreachable machine is a 502 that says so, not a 500).
 */
import type { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { autoStashApproved, readAutoStashPolicy, runCheckoutAction, uniqueCheckoutLabel, type CheckoutActionFailure } from "../lib/checkout-actions.js";
import { patchInstanceConfig } from "../lib/instance-config.js";
import { tryDequeueAndStart } from "../lib/objective-queue-start.js";
import { clearRepoBlocker } from "../lib/repo-admission-blocker.js";
import { requireOwned } from "./coding-shared.js";
import type { Env } from "../types.js";

// `unreachable` is a determinate answer (no runner connection, so nothing ran) and must not look like a gateway's lost
// reply, which MCP clients read as an unknown outcome and which is 502/504 (#1514). Only `unconfirmed` — the machine went
// away MID-call — is 502.
const STATUS: Record<CheckoutActionFailure, 404 | 409 | 422 | 502 | 503 | 500> = { no_repo: 404, busy: 409, unreachable: 503, unconfirmed: 502, old_runner: 422, refused: 422, failed: 500 };

export function registerCheckoutActionRoutes(codingRoutes: Hono<{ Bindings: Env }>) {
	codingRoutes.post("/:instanceId/coding/repos/:repoId/checkout/:action", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const action = c.req.param("action");
		if (action !== "stash" && action !== "discard") throw new HttpError(404, "Unknown checkout action");
		const body = (await c.req.json().catch(() => ({}))) as { label?: unknown; pull?: unknown; runner_node?: unknown; confirm?: unknown };
		// A discard throws work away (after backing it up); the caller must say so in words.
		if (action === "discard" && body.confirm !== "discard_checkout") throw new HttpError(400, 'discard needs confirm: "discard_checkout"');
		const out = await runCheckoutAction(c.env, {
			instanceId,
			userId: uid,
			repoId: c.req.param("repoId") ?? "",
			action,
			label: typeof body.label === "string" && body.label.trim() ? body.label : uniqueCheckoutLabel(`owner ${action}`),
			pull: body.pull !== false,
			node: typeof body.runner_node === "string" && body.runner_node.trim() ? body.runner_node.trim() : null,
		});
		if (out.ok) {
			// #1515: the checkout is clean and current — the blocker that held this repo's queue is gone, so the queue resumes (one entry,
			// the same rate as any drain). `tryDequeueAndStart` never throws; a failed drain is the queue's own next attempt, not this answer's.
			if (out.result.clean && !out.result.pulled?.error && !out.result.pulled?.refused) {
				const key = { instanceId, userId: uid, repoId: c.req.param("repoId") ?? "" };
				if (await clearRepoBlocker(c.env, key)) await tryDequeueAndStart(c.env, instanceId, key.repoId, uid);
			}
			return c.json(out);
		}
		return c.json(out, STATUS[out.reason]);
	});

	codingRoutes.get("/:instanceId/coding/auto-stash", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		return c.json({ enabled: await readAutoStashPolicy(c.env, instanceId, uid) });
	});

	codingRoutes.put("/:instanceId/coding/auto-stash", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
		if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
		if (!(await patchInstanceConfig(c.env, instanceId, uid, "autoStashDirty", body.enabled))) throw new HttpError(404, "Instance not found");
		return c.json({ enabled: autoStashApproved({ autoStashDirty: body.enabled }) });
	});
}
