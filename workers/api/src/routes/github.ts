import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import {
	appIdentifier,
	authorizeInstallation,
	githubAppConfigured,
	listInstallationRepos,
	listUserInstallations,
} from "../lib/github-app.js";
import { syncUserInstallations } from "../lib/github-installation-sync.js";
import type { GithubInstallationSyncResponse } from "../agent-types.js";
import { logEvent } from "../lib/events.js";
import { clipMarked } from "../lib/clip-marked.js";
import type { Env } from "../types.js";

/**
 * GitHub App routes (the AgentCoder port) — install flow + repo listing for the
 * coding workspace. Inert when the App isn't configured (`configured:false`),
 * mirroring the Gmail email tool: the feature simply stays off until the owner
 * sets GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY (+ optional GITHUB_APP_SLUG).
 */
export const githubRoutes = new Hono<{ Bindings: Env }>();

/** Is the GitHub App wired up on this deployment? */
githubRoutes.get("/status", (c) => c.json({ configured: githubAppConfigured(c.env) }));

/** The URL to send a user to so they install the App and grant repo access. */
githubRoutes.get("/install-url", async (c) => {
	if (!githubAppConfigured(c.env)) return c.json({ error: "GitHub App not configured" }, 503);
	await requireUser(c);
	const repoId = c.req.query("repoId") ?? "";
	const state = btoa(JSON.stringify({ repoId })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	const app = await appIdentifier(c.env);
	return c.json({ installUrl: `https://github.com/apps/${app}/installations/new?state=${state}` });
});

/** The App's installations (the orgs/users that granted access). */
githubRoutes.get("/installations", async (c) => {
	if (!githubAppConfigured(c.env)) return c.json({ error: "GitHub App not configured" }, 503);
	const session = await requireUser(c);
	// Only the installations this user has a VERIFIED binding to — never the
	// global App installation list (that enumeration was the recon step of the
	// cross-tenant IDOR).
	const installs = await listUserInstallations(c.env, session.uid);
	return c.json({ installations: installs });
});

/**
 * Bind the App installations this account controls but has no binding to yet (#1081) — e.g. an org
 * the App was installed on AFTER the last Connect GitHub. Same proof as `/callback`
 * (`syncUserInstallations`); `owner` checks one account and names its exact outcome; `dry_run`
 * runs every check and binds nothing. Never names an installation this user is not part of.
 */
githubRoutes.post("/installations/sync", async (c) => {
	if (!githubAppConfigured(c.env)) return c.json({ error: "GitHub App not configured" }, 503);
	const session = await requireUser(c);
	const body = (await c.req.json().catch(() => ({}))) as { owner?: unknown; dry_run?: unknown };
	const owner = typeof body.owner === "string" ? body.owner.trim() : "";
	if (owner && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) return c.json({ error: "owner must be a GitHub account or organisation login" }, 400);
	let result: Awaited<ReturnType<typeof syncUserInstallations>>;
	try {
		result = await syncUserInstallations(c.env, session.uid, { owner: owner || null, dryRun: body.dry_run === true });
	} catch (e) {
		return c.json({ error: `GitHub could not be reached to list the App's installations: ${e instanceof Error ? clipMarked(e.message, 120) : "unknown error"}` }, 502);
	}
	await logEvent(c.env, { source: "tool", event: "github.installations_sync", level: "info", message: `GitHub installation sync${result.dryRun ? " (dry run)" : ""}: ${result.bound} bound`, userId: session.uid, context: { owner: result.owner, dryRun: result.dryRun, orgs: result.orgs, unnamed: result.unnamed, appCannotReadMembers: result.appCannotReadMembers } }).catch(() => undefined);
	const body2: GithubInstallationSyncResponse = { ...result, linkStart: "/v1/auth/github/link/start" };
	return c.json(body2);
});

/** The repos an installation can access (for importing into a workspace). */
githubRoutes.get("/installations/:installationId/repos", async (c) => {
	if (!githubAppConfigured(c.env)) return c.json({ error: "GitHub App not configured" }, 503);
	const session = await requireUser(c);
	const installationId = Number(c.req.param("installationId"));
	if (!Number.isFinite(installationId)) return c.json({ error: "bad installationId" }, 400);
	const repos = await listInstallationRepos(c.env, session.uid, installationId);
	return c.json({
		repos: repos.map((r) => ({
			fullName: r.full_name,
			name: r.name,
			cloneUrl: r.clone_url,
			defaultBranch: r.default_branch,
			private: r.private,
			description: r.description,
		})),
	});
});

/**
 * Install callback: GitHub redirects here after the user installs the App.
 * We record the installation (minting + caching its token), then bounce the user
 * back to the console. `installation_id` + `state` arrive as query params.
 */
githubRoutes.get("/callback", async (c) => {
	if (!githubAppConfigured(c.env)) return c.json({ error: "GitHub App not configured" }, 503);
	const session = await requireUser(c);
	const installationId = Number(c.req.query("installation_id"));
	if (!Number.isFinite(installationId)) return c.json({ error: "missing installation_id" }, 400);
	// SECURITY: verify the user actually controls this installation's account
	// before binding it (personal → login match; org → active membership). The
	// installation_id query param is attacker-controlled, so it must be proven —
	// not trusted — before we mint/cache a token for it. This is the only path
	// that creates a github_installations row.
	// Prefer the explicitly LINKED GitHub username over github_login: Google sign-in stores
	// the user's email in github_login (migration 0049), which can't verify org membership.
	// `linked_github_login` (set via /v1/auth/github/link) holds the real GitHub login.
	const user = await c.env.DB.prepare("SELECT github_login, linked_github_login FROM users WHERE id = ?1")
		.bind(session.uid)
		.first<{ github_login: string | null; linked_github_login: string | null }>();
	const login = user?.linked_github_login ?? user?.github_login ?? null;
	const result = await authorizeInstallation(c.env, session.uid, login, installationId);
	if (!result.ok) return c.json({ ok: false, error: result.reason, installationId }, 403);
	return c.json({ ok: true, installationId });
});
