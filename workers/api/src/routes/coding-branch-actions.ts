/**
 * Branch and stash inventory, integration and removal for a repo on the machine that holds it (#1700, #1701).
 *
 *   GET  /:instanceId/coding/repos/:repoId/branches              inventory, or `?compare=<branch>[&base=]` one branch against the default
 *   POST /:instanceId/coding/repos/:repoId/branches/integrate    fast-forward the default branch to a local branch's tip
 *   POST /:instanceId/coding/repos/:repoId/branches/delete       delete one exact local or remote branch
 *   GET  /:instanceId/coding/repos/:repoId/stashes               inventory, or `?sha=<40-hex>` one stash inspected
 *   POST /:instanceId/coding/repos/:repoId/stashes/drop          drop one stash by its immutable SHA
 *
 * The git is the runner's (`packages/browser-runner/src/coding/branches.ts`, `stashes.ts`); the transport and
 * its named failures are `lib/branch-actions.ts`. This half is auth and the contract that makes a mutation
 * exact: the machine must be NAMED (`runner_node`), execution needs the tip or SHA the caller read, and a
 * mutation previews unless `dry_run` is exactly `false`.
 */
import type { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { callBranchRunner, type BranchFailure, type BranchRunnerPath } from "../lib/branch-actions.js";
import { requireOwned } from "./coding-shared.js";
import type { Env } from "../types.js";

// `unreachable` is a determinate answer (nothing ran) and is not a gateway's lost reply; only `unconfirmed` — the machine went away
// MID-call — is 502 (same reading as the checkout actions, #1514).
const STATUS: Record<BranchFailure, 404 | 422 | 502 | 503 | 500> = { no_repo: 404, unreachable: 503, unconfirmed: 502, old_runner: 422, refused: 422, failed: 500 };
/** A refusal the runner reports as a value: the request was understood and declined, so 409 and the reason, never a 200 that looks like success. */
const REFUSED = 409;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function registerBranchActionRoutes(codingRoutes: Hono<{ Bindings: Env }>) {
	/** Tenant gate first (a stranger learns nothing from a 400), then the request is read and validated, then the machine is called. */
	const run = async (c: Parameters<typeof requireOwned>[0], path: BranchRunnerPath, mutating: boolean, prep: () => Promise<{ body: Record<string, unknown>; node: string | undefined }>) => {
		const { uid, instanceId } = await requireOwned(c);
		const { body, node } = await prep();
		const out = await callBranchRunner<{ ok?: boolean; reason?: string }>(c.env, { instanceId, userId: uid, repoId: c.req.param("repoId") ?? "", path, body, node, mutating });
		if (!out.ok) return c.json(out, STATUS[out.reason]);
		// A mutation the runner declined answers `ok:false` + `reason` as a VALUE; surface it as 409 with the whole receipt.
		if (mutating && out.result && out.result.ok === false) return c.json(out, REFUSED);
		return c.json(out);
	};

	// `?preview=integrate|delete_local|delete_remote&branch=` asks the machine what that mutation would do — the same dry run the POST
	// routes do, as a GET so a read-only caller can have it. It changes nothing.
	codingRoutes.get("/:instanceId/coding/repos/:repoId/branches", (c) => {
		const preview = c.req.query("preview");
		const runnerNode = str(c.req.query("runner_node"));
		if (preview) {
			return run(c, preview === "integrate" ? "/coding/branch-integrate" : "/coding/branch-delete", true, async () => {
				if (preview !== "integrate" && preview !== "delete_local" && preview !== "delete_remote") throw new HttpError(400, "preview must be integrate, delete_local or delete_remote");
				if (!runnerNode || !str(c.req.query("branch"))) throw new HttpError(400, "preview needs runner_node and branch");
				return { body: { dryRun: true, branch: str(c.req.query("branch")), ...(preview === "integrate" ? {} : { scope: preview === "delete_local" ? "local" : "remote" }) }, node: runnerNode };
			});
		}
		return run(c, "/coding/branches", false, async () => {
			const compare = str(c.req.query("compare"));
			return { body: compare ? { compare, base: str(c.req.query("base")) } : {}, node: runnerNode };
		});
	});

	codingRoutes.get("/:instanceId/coding/repos/:repoId/stashes", (c) => run(c, "/coding/stashes", false, async () => ({ body: { sha: str(c.req.query("sha")) }, node: str(c.req.query("runner_node")) })));

	const mutation = (action: "branches/integrate" | "branches/delete" | "stashes/drop", path: BranchRunnerPath) =>
		codingRoutes.post(`/:instanceId/coding/repos/:repoId/${action}`, (c) =>
			run(c, path, true, async () => {
				const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
				const node = str(body.runner_node);
				// The checkout that holds the refs is one machine's: a mutation does not guess which.
				if (!node) throw new HttpError(400, "runner_node is required: name the machine that holds the checkout (list_runner_nodes)");
				const dryRun = body.dry_run !== false;
				const tip = str(body.expected_tip);
				const sha = str(body.sha);
				if (!dryRun && !(tip ?? sha)) throw new HttpError(400, action === "stashes/drop" ? "sha is required to drop: inspect it first and pass the stash's full commit SHA" : "expected_tip is required to execute: preview first and pass the tip it returned");
				const scope = body.scope === "local" || body.scope === "remote" ? body.scope : undefined;
				if (action === "branches/delete" && !scope) throw new HttpError(400, 'scope must be "local" or "remote"');
				return { body: { dryRun, branch: str(body.branch), expectedTip: tip, sha, scope }, node };
			}),
		);
	mutation("branches/integrate", "/coding/branch-integrate");
	mutation("branches/delete", "/coding/branch-delete");
	mutation("stashes/drop", "/coding/stash-drop");
}
