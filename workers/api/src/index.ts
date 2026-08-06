import { Hono } from "hono";
import { cors } from "hono/cors";
import { HttpError } from "./lib/auth.js";
import { isTransientInfraError, logUnhandled } from "./lib/on-error.js";
import { verifySession } from "./lib/session.js";
import { rateLimitAdmin, rateLimitDefault, rateLimitStrict } from "./lib/rate-limit.js";
import { agentRoutes } from "./routes/agents.js";
import { agentBuilderRoutes } from "./routes/agent-builder.js";
import { batchRoutes } from "./routes/batch.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { authRoutes } from "./routes/auth.js";
import { billingRoutes } from "./routes/billing.js";
import { chatRoutes } from "./routes/chat.js";
import { instanceRoutes } from "./routes/instances.js";
import { credentialRoutes } from "./routes/credentials.js";
import { profileRoutes } from "./routes/profile.js";
import { preferenceRoutes } from "./routes/preferences.js";
import { keysRoutes } from "./routes/keys.js";
import { emailRoutes } from "./routes/email.js";
import { driveRoutes } from "./routes/drive.js";
import { workdriveRoutes } from "./routes/workdrive.js";
import { errorRoutes } from "./routes/errors.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { notificationRoutes } from "./routes/notifications.js";
import { pushRoutes } from "./routes/push.js";
import { exportRoutes } from "./routes/export.js";
import { versionRoutes } from "./routes/versions.js";
import { publicRoutes } from "./routes/public.js";
import { runRoutes } from "./routes/run.js";
import { storageRoutes, instanceStorageRoutes } from "./routes/storage.js";
import { codingRoutes } from "./routes/coding.js";
import { githubRoutes } from "./routes/github.js";
import { relayRoutes } from "./routes/relay.js";
import { terminalRoutes } from "./routes/terminals.js";
import { usageRoutes } from "./routes/usage.js";
import { triggerRoutes } from "./routes/triggers.js";
import { adminRoutes } from "./routes/admin.js";
import { adminInstanceDetailRoutes } from "./routes/admin-instance-detail.js";
import { adminTraceRoutes } from "./routes/admin-trace.js";
import { adminCodingSessionRoutes } from "./routes/admin-coding-session.js";
import { adminMcpAuditRoutes } from "./routes/admin-mcp-audit.js";
import { adminOpsRoutes } from "./routes/admin-ops.js";
import { adminTriggersRoutes } from "./routes/admin-triggers.js";
import { toolRoutes } from "./routes/tools.js";
import { connectorRoutes } from "./routes/connectors.js";
import { cloudflareAccessGate } from "./lib/cf-access.js";
import { runDueTriggers } from "./lib/triggers.js";
import { runDueDeliveries } from "./lib/connections.js";
import { runDeployWatch } from "./lib/deploy-watch.js";
import { runStaleRunSweep } from "./lib/run-sweeper.js";
import type { Env } from "./types.js";

// Re-export Durable Object class for wrangler
export { AgentDO } from "./agent-do.js";
// Re-export the job-application Workflow class for wrangler
export { JobApplyWorkflow } from "./workflows/job-apply.js";
// Re-export the coding-orchestrator Workflow class for wrangler (AgentCoder port)
export { CodingSessionWorkflow } from "./workflows/coding-session.js";
// Re-export the declarative-pipeline Workflow class for wrangler (issue #97)
export { PipelineRunWorkflow } from "./workflows/pipeline-run.js";
// Re-export the generic browser-task Workflow class for wrangler (#69/#71)
export { BrowserTaskWorkflow } from "./workflows/browser-task.js";
// Re-export the durable agent-loop Workflow class for wrangler (#158)
export { AgentLoopWorkflow } from "./workflows/agent-loop.js";
// Re-export the WebSocket relay DO for wrangler
export { RelayDO } from "./relay-do.js";

const app = new Hono<{ Bindings: Env }>();

// ── Middleware ──────────────────────────────────────────────────────────────

app.use(
	"*",
	cors({
		origin: [
			"https://proagentstore.online",
			"https://console.proagentstore.online",
			"http://localhost:5173",
			"http://localhost:4173",
		],
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
		maxAge: 86400,
		// Required for the OAuth state-binding cookie (lib/oauth-nonce.ts): the `/start` calls
		// are cross-origin XHR from the console, and a browser DISCARDS Set-Cookie on those
		// unless the request is credentialed and the response allows credentials. Safe with an
		// explicit origin allowlist (never `*`), and inert for everything else — this API
		// authenticates with a Bearer token and has no session cookie to send.
		credentials: true,
	}),
);

app.use("*", async (c, next) => {
	c.header("X-Content-Type-Options", "nosniff");
	c.header("X-Frame-Options", "DENY");
	c.header("Referrer-Policy", "strict-origin-when-cross-origin");
	await next();
});

// Rate limiting: 60 req/min default, 10 req/min for expensive routes
app.use("/v1/*", rateLimitDefault());
app.use("/v1/agents/*/chat", rateLimitStrict());
app.use("/v1/agents/*/run", rateLimitStrict());
app.use("/v1/instances/*/chat", rateLimitStrict());
app.use("/v1/instances/*/loop-decide", rateLimitStrict());
app.use("/v1/instances/*/coding/sessions/*/agent", rateLimitStrict()); // LLM: answer-or-drive
app.use("/v1/instances/*/coding/sessions/*/explain", rateLimitStrict()); // LLM: co-pilot summary
app.use("/v1/instances/*/coding/overseer", rateLimitStrict()); // LLM: cross-repo
app.use("/v1/instances/*/apply", rateLimitStrict()); // workflow + LLM + browser
app.use("/v1/push/test", rateLimitStrict());
app.use("/v1/errors/client", rateLimitStrict()); // browser-driven writes to the durable log — throttle hard
app.use("/v1/keys/*/reveal", rateLimitStrict()); // hands out a raw decrypted key — throttle hard

// Admin perimeter: Cloudflare Access gate in front of the whole operator API
// (defense-in-depth). Inert until CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD are set;
// the admin ROLE is still enforced per-handler behind this.
app.use("/v1/admin/*", cloudflareAccessGate());
// Dedicated admin throttle (issue #109): clamps unauthenticated enumeration hard while
// leaving room for the authenticated admin SPA's polling. Behind the CF Access gate.
app.use("/v1/admin/*", rateLimitAdmin());

// ── Routes ─────────────────────────────────────────────────────────────────

app.route("/v1/auth", authRoutes);
app.route("/v1/agent-builder", agentBuilderRoutes);
app.route("/v1/agents", agentRoutes);
app.route("/v1/agents", chatRoutes); // /v1/agents/:id/chat, /ws, /messages, /memory, /tasks
app.route("/v1/agents", runRoutes); // /v1/agents/:id/run, /executions
app.route("/v1/instances", instanceRoutes); // /v1/instances/:agentId/subscribe, /my/instances, /:id/chat, etc.
app.route("/v1/instances", credentialRoutes); // /v1/instances/:id/credentials (vault)
app.route("/v1/profile", profileRoutes); // structured candidate profile
app.route("/v1/preferences", preferenceRoutes); // account-wide voice + translation defaults (#211)
app.route("/v1/agents", analyticsRoutes); // /v1/agents/:id/analytics
app.route("/v1/dashboard", dashboardRoutes);
app.route("/v1/notifications", notificationRoutes);
app.route("/v1/push", pushRoutes);
app.route("/v1/agents", versionRoutes);     // /v1/agents/:id/versions, /:versionId/rollback
app.route("/v1/agents", exportRoutes);
app.route("/v1/agents", storageRoutes); // /v1/agents/:id/collections, /files, /search, /activity, /summaries
app.route("/v1/instances", instanceStorageRoutes); // /v1/instances/:id/collections, /files, /search, /activity
app.route("/v1/instances", codingRoutes); // /v1/instances/:id/coding/repos, /sessions (AgentCoder port)
app.route("/v1/instances", toolRoutes); // /v1/instances/:id/tools, /tools/:name (connector/registry tools)
app.route("/v1/connectors", connectorRoutes); // generic OAuth2 authorize/callback for manifest oauth connectors (#147)
app.route("/v1/github", githubRoutes); // GitHub App: /status, /install-url, /installations, /callback
app.route("/v1/relay", relayRoutes); // WebSocket relay: /connect, /status
app.route("/v1/terminals", terminalRoutes); // platform: /v1/terminals/nodes — all the user's CLIs
app.route("/v1/usage", usageRoutes); // platform: /v1/usage — token/cost transparency across agents
app.route("/v1/batch", batchRoutes);       // /v1/batch/bulk-visibility, /bulk-delete     // /v1/agents/:id/export, /import
app.route("/v1/keys", keysRoutes); // /v1/keys/providers, /status, /:provider, /proxy/:host/*
app.route("/v1/email", emailRoutes); // /v1/email/google/start, /callback, /status, DELETE /google
app.route("/v1/drive", driveRoutes); // /v1/drive/google/start, /callback, /status, /files, /instances/:id/import
app.route("/v1/workdrive", workdriveRoutes); // /v1/workdrive/zoho/start, /callback, /status, /folder, /instances/:id/import
app.route("/v1/triggers", triggerRoutes); // instance webhook + cron triggers
app.route("/v1/errors", errorRoutes); // GET /v1/errors — durable error log read-back
app.route("/v1/public", publicRoutes); // /v1/public/agents/:id, /agents/:id/try, /webhook/:id/ingest
app.route("/v1/billing", billingRoutes);
app.route("/v1/admin", adminRoutes); // operator portal: /me, /audit (+ users, agents, usage, moderation)
app.route("/v1/admin", adminInstanceDetailRoutes); // /instances/:id/detail
app.route("/v1/admin", adminTraceRoutes); // /trace/:instanceId
app.route("/v1/admin", adminCodingSessionRoutes); // /coding-sessions/:sid
app.route("/v1/admin", adminMcpAuditRoutes); // /mcp-audit
app.route("/v1/admin", adminOpsRoutes); // /ops
app.route("/v1/admin", adminTriggersRoutes); // /triggers

app.get("/health", (c) => c.json({ ok: true, service: "proagentstore-api" }));

// ── Global error handler ───────────────────────────────────────────────────

app.onError(async (err, c) => {
	// Transient infra (DO reset on deploy, overload) isn't a bug — don't log it as a 500;
	// tell the client to retry. This is what the two "chat → 500" reports actually were.
	if (isTransientInfraError(err)) {
		return c.json({ error: "The service is updating — please try again in a moment." }, 503);
	}
	// Attribute the failure to the signed-in user (when the request carries a valid
	// session) so it appears in THEIR /v1/errors view, not just the admin all-scope read.
	const uid = await uidFromRequest(c);
	// Persist the exception (full message + stack for real bugs) so it shows up in the
	// user's + admin Errors view instead of vanishing into the ephemeral worker console.
	await logUnhandled(c.env, err, { path: c.req.path, method: c.req.method, userId: uid });
	if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
	return c.json({ error: "Internal server error" }, 500);
});

/** Best-effort uid from the request's bearer token — null if absent/invalid. Mirrors
 *  the rate-limiter's subject(); never throws so the error path can't break. */
async function uidFromRequest(c: { req: { header: (n: string) => string | undefined }; env: Env }): Promise<string | null> {
	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer ")) return null;
	const session = await verifySession(header.slice(7), c.env.SESSION_SIGNING_KEY).catch(() => null);
	return session?.uid ?? null;
}

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return app.fetch(request, env, ctx);
	},
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		// Cron doesn't go through app.onError — persist a failure ourselves so a broken
		// trigger sweep is visible in the admin Errors view instead of vanishing.
		ctx.waitUntil(
			runDueTriggers(env).catch((err) => logUnhandled(env, err, { path: "scheduled:triggers", method: "CRON" })),
		);
		// Retry agent-to-agent deliveries whose target failed (migration 0058). Separate
		// waitUntil so a broken trigger sweep can't stop the pump from draining, and vice
		// versa — these are independent failure domains.
		ctx.waitUntil(
			runDueDeliveries(env).catch((err) => logUnhandled(env, err, { path: "scheduled:deliveries", method: "CRON" })),
		);
		// Close runs whose Workflow died mid-step (#207C). A third independent failure domain: a
		// row stuck at `running` forever tells every supervisor its subordinate is still working.
		// `runStaleRunSweep` swallows + logs its own errors.
		ctx.waitUntil(runStaleRunSweep(env));
		// Notify on a finished deploy (#6). A fourth independent failure domain — it reaches an
		// external API (GitHub), which is the most likely of these to be slow or rate-limited,
		// and it must not be able to stop the trigger sweep or the pump from draining.
		ctx.waitUntil(
			runDeployWatch(env).catch((err) => logUnhandled(env, err, { path: "scheduled:deploy-watch", method: "CRON" })),
		);
	},
};
