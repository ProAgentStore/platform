import { Hono } from "hono";
import { cors } from "hono/cors";
import { HttpError } from "./lib/auth.js";
import { setServerBuild } from "./lib/error-log.js";
import { REQUEST_ID_HEADER, currentRequestId, requestIdFor, requestRecorded, withRequestId } from "./lib/request-context.js";
import { isTransientInfraError, logReturnedFailure, logUnhandled } from "./lib/on-error.js";
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
import { httpBindingRoutes, httpProfileRoutes } from "./routes/http-profiles.js";
import { secureInputRoutes } from "./routes/secure-input.js";
import { profileRoutes } from "./routes/profile.js";
import { preferenceRoutes } from "./routes/preferences.js";
import { keysRoutes } from "./routes/keys.js";
import { emailRoutes } from "./routes/email.js";
import { pruneStaleRuntimeNodes } from "./lib/runtime-nodes.js";
import { emailWorkerManageRoutes } from "./routes/email-worker-manage.js";
import { gmailIdentityRoutes } from "./routes/gmail-identity.js";
import { emailWorkerInboundRoutes, emailWorkerInstanceRoutes, emailWorkerRoutes } from "./routes/email-worker.js";
import { driveRoutes } from "./routes/drive.js";
import { discordRoutes } from "./routes/discord.js";
import { slackRoutes } from "./routes/slack.js";
import { instanceReleaseNotesRoutes } from "./routes/instances-release-notes.js";
import { instanceActionsRunnerRoutes } from "./routes/instances-actions-runner.js";
import { workdriveRoutes } from "./routes/workdrive.js";
import { errorRoutes } from "./routes/errors.js";
import { auditRoutes } from "./routes/audit.js";
import { siteBuilderBrokerRoutes } from "./routes/site-builder-broker.js";
import { feedbackRoutes } from "./routes/feedback.js";
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
import { terminalNativeRoutes } from "./routes/terminals-native.js";
import { usageRoutes } from "./routes/usage.js";
import { remoteAuthRoutes } from "./routes/remote-auth.js";
import { deviceAuthRoutes, sessionRoutes } from "./routes/device-auth.js";
import { budgetRoutes } from "./routes/budget.js";
import { statsRoutes } from "./routes/stats.js";
import { controllerAiSettingsRoutes } from "./routes/controller-ai-settings.js";
import { mcpAuditRoutes } from "./routes/mcp-audit.js";
import { runAuditLedgerBackfill } from "./lib/mcp-audit-ledger.js";
import { drainTelemetrySpool } from "./lib/telemetry-spool.js";
import { sweepExpiredPermissionRequests } from "./lib/instance-permission-resume.js";
import { triggerRoutes } from "./routes/triggers.js";
import { adminRoutes } from "./routes/admin.js";
import { adminInstanceDetailRoutes } from "./routes/admin-instance-detail.js";
import { adminModerationRoutes } from "./routes/admin-moderation.js";
import { adminTraceRoutes } from "./routes/admin-trace.js";
import { adminCodingSessionRoutes } from "./routes/admin-coding-session.js";
import { adminMcpAuditRoutes } from "./routes/admin-mcp-audit.js";
import { adminOpsRoutes } from "./routes/admin-ops.js";
import { adminTriggersRoutes } from "./routes/admin-triggers.js";
import { adminSettingsRoutes } from "./routes/admin-settings.js";
import { toolRoutes } from "./routes/tools.js";
import { agentTypeToolRoutes } from "./routes/agent-type-tools.js";
import { ticketRoutes } from "./routes/instances-tickets.js";
import { runEventRoutes } from "./routes/instances-run-events.js";
import { connectorRoutes } from "./routes/connectors.js";
import { mcpRoutes } from "./routes/mcp.js";
import { cloudflareAccessGate, cloudflareAccessMode } from "./lib/cf-access.js";
import { runDueTriggers } from "./lib/triggers.js";
import { runDueDeliveries } from "./lib/connections.js";
import { runSpendAlerts } from "./lib/spend-alerts.js";
import { runIssueSync } from "./lib/issue-sync.js";
import { syncActiveLocalBrowserRuns } from "./lib/local-browser/sync.js";
import { sweepExpiredBrowserArtifacts } from "./lib/browser-artifacts.js";
import { syncActiveTailorRuns } from "./lib/local-artifact/tailor.js";
import { syncActiveApplyReconciliations, syncActiveApplyRuns } from "./lib/local-apply/apply.js";
import { failStaleUpdateOps } from "./lib/runner-update-ops.js";
import { failSilentUpdates } from "./lib/machine-policy.js";
import { notifySilentMachines } from "./lib/machine-silence.js";
import { expireStaleTakeovers } from "./lib/browser-takeovers.js";
import { runLeadBrowserVerification } from "./lib/job-lead-browser-verification.js";
import { dispatchQueuedRunnerUpdates } from "./lib/runner-update.js";
import { syncLeadWritebacks } from "./lib/local-artifact/store.js";
import { routeRunEvents } from "./lib/run-event-routing.js";
import { runTicketQueue } from "./lib/ticket-queue.js";
import { runDueGmailScoutScans } from "./lib/gmail-scout/scan.js";
import { runDueCoderQuestions } from "./lib/coder-question-sweep.js";
import { runDueOverloadRetries } from "./lib/objective-queue-start.js";
import { runCommitCloseWatch } from "./lib/commit-close-watch.js";
import { runDeployWatch } from "./lib/deploy-watch.js";
import { runCiHealthWatch } from "./lib/repo-ci-health.js";
import { runStaleRunSweep } from "./lib/run-sweeper.js";
import { sweepAutoPickup } from "./lib/auto-pickup.js";
import { runCodingSessionSweep } from "./lib/coding-session-sweeper.js";
import { runReauthExpiryWatch } from "./lib/engine-reauth-expiry.js";
import { runStatsRollup } from "./lib/stats-rollup.js";
import { sweepTerminalSnapshots } from "./lib/coding-timeline.js";
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
export { RunnerUpdateWorkflow } from "./lib/runner-update-workflow.js";
// Re-export the WebSocket relay DO for wrangler
export { RelayDO } from "./relay-do.js";

const app = new Hono<{ Bindings: Env }>();

// ── Middleware ──────────────────────────────────────────────────────────────

// Every request runs inside an id (#1135), FIRST, so everything after it — CORS, the rate limiter,
// the route and `app.onError` — writes its error and trace rows under the request that caused them.
app.use("*", async (c, next) => {
	const requestId = requestIdFor(c.req.raw.headers);
	await withRequestId(requestId, async () => {
		await next();
		c.header(REQUEST_ID_HEADER, requestId);
		// A 5xx the route RETURNED without recording it (#1134). Never for the error endpoints
		// themselves: a failing log must not report itself.
		if (c.res.status >= 500 && !requestRecorded() && !c.req.path.startsWith("/v1/errors")) {
			await logReturnedFailure(c.env, { response: c.res, path: c.req.path, method: c.req.method, userId: await uidFromRequest(c) });
		}
	});
});

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
		exposeHeaders: [REQUEST_ID_HEADER],
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
app.use("/v1/instances/*/apply", rateLimitStrict()); // workflow + LLM + browser
app.use("/v1/push/test", rateLimitStrict());
app.use("/v1/errors/client", rateLimitStrict()); // browser-driven writes to the durable log — throttle hard
app.use("/v1/keys/*/reveal", rateLimitStrict()); // hands out a raw decrypted key — throttle hard
// The vault reveal holds a SUPERSET of that: password + PIN + recovery codes for a real
// employer/ATS account, and it sat in the 240/min default bucket for want of this line (#639).
// The threat is not the owner — it is a leaked session token or an XSS on the console origin,
// for which 240/min is "walk every credential on every instance in seconds". Deliberately NOT
// exposed over MCP at all, which is the same judgement written down; this makes the console
// route agree with it.
app.use("/v1/instances/*/credentials/*/reveal", rateLimitStrict());
// Fetches a URL the CALLER supplied. safeFetch already refuses internal targets, but an
// authenticated "make the Worker request this" button is still the shape of an SSRF/scanning
// primitive, so it is throttled like the expensive routes rather than the read routes.
app.use("/v1/instances/*/mcp/test", rateLimitStrict());
// Same shape, one step further: starting an MCP authorization makes the Worker fetch a
// caller-named server's metadata AND register a client with it. safeFetch guards where it can
// point; this bounds how often, so the flow cannot be used to spray registrations across the net.
app.use("/v1/mcp/oauth/start", rateLimitStrict());

// Admin perimeter: Cloudflare Access gate in front of the whole operator API
// (defense-in-depth). Inert until CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD are set, and
// setting those alone only turns on AUDIT — it records whether the edge is injecting a
// valid Access JWT without blocking anything. Enforcement is a separate secret
// (CF_ACCESS_ENFORCE), because enforcing before that evidence exists locks the operator
// out of the portal they would use to notice. Runbook: docs/admin-access-perimeter.md.
// The admin ROLE is still enforced per-handler behind this.
app.use("/v1/admin/*", cloudflareAccessGate());
// Dedicated admin throttle (issue #109): clamps unauthenticated enumeration hard while
// leaving room for the authenticated admin SPA's polling. Behind the CF Access gate.
app.use("/v1/admin/*", rateLimitAdmin());

// ── Routes ─────────────────────────────────────────────────────────────────

app.route("/v1/auth/device", deviceAuthRoutes); // #1157: `pags login --device` — sign a machine in from any device
app.route("/v1/auth/session", sessionRoutes); // #1157: a running `pags up` keeps its session fresh
app.route("/v1/auth", authRoutes);
app.route("/v1/agent-builder", agentBuilderRoutes);
app.route("/v1/agents", agentRoutes);
app.route("/v1/agents", chatRoutes); // /v1/agents/:id/chat, /ws, /messages, /memory, /tasks
app.route("/v1/agents", runRoutes); // /v1/agents/:id/run, /executions
app.route("/v1/instances", instanceRoutes); // /v1/instances/:agentId/subscribe, /my/instances, /:id/chat, etc.
app.route("/v1/instances", credentialRoutes); // /v1/instances/:id/credentials (vault)
app.route("/v1/instances", httpBindingRoutes); // /v1/instances/:id/http-bindings — which HTTP credential profiles an instance may use (#1123)
app.route("/v1/http-profiles", httpProfileRoutes); // owner's named HTTP credential profiles — metadata out, secrets never (#1123)
app.route("/v1/instances", secureInputRoutes); // /v1/instances/:id/secure-inputs (#906)
app.route("/v1/instances", controllerAiSettingsRoutes); // /v1/instances/:id/controller-ai — provider-stall recovery settings (#907)
app.route("/v1/profile", profileRoutes); // structured candidate profile
app.route("/v1/preferences", preferenceRoutes); // account-wide voice + translation defaults (#211)
app.route("/v1/agents", analyticsRoutes); // /v1/agents/:id/analytics
app.route("/v1/dashboard", dashboardRoutes);
app.route("/v1/notifications", notificationRoutes);
app.route("/v1/push", pushRoutes);
app.route("/v1/agents", versionRoutes);     // /v1/agents/:id/versions, /:versionId/rollback
app.route("/v1/agents", exportRoutes);
app.route("/v1/agents", storageRoutes); // /v1/agents/:id/collections, /files, /search, /activity, /summaries
app.route("/v1/agents", agentTypeToolRoutes); // /v1/agents/:slug/tools — an agent type's declared tools (#771)
app.route("/v1/instances", instanceStorageRoutes); // /v1/instances/:id/collections, /files, /search, /activity
app.route("/v1/instances", codingRoutes); // /v1/instances/:id/coding/repos, /sessions (AgentCoder port)
app.route("/v1/instances", instanceActionsRunnerRoutes); // /v1/instances/:id/actions-runner — the Actions runner on the pinned machine (#1208, #1209)
app.route("/v1/instances", instanceReleaseNotesRoutes); // /v1/instances/:id/release-notes (+ /test) (#1217)
app.route("/v1/instances", toolRoutes); // /v1/instances/:id/tools, /tools/:name (connector/registry tools)
app.route("/v1/instances", emailWorkerInstanceRoutes); // /v1/instances/:id/email-worker/account — pin this instance to one worker-backed mail connection (#1269)
app.route("/v1/instances", emailWorkerManageRoutes); // /v1/instances/:id/email-worker/{status,enrollments,test} — MCP management of worker-backed mail; the owner enters the secret in the console (#1277)
app.route("/v1/instances", gmailIdentityRoutes); // /v1/instances/:id/gmail/identity — the verified send-as sender and inbound-recipient scope an instance is pinned to; read and set by MCP (#1279)
app.route("/v1/instances", ticketRoutes); // /v1/instances/:id/board/items/:jobKey/ticket, /tickets/:ticketId (#757)
app.route("/v1/instances", runEventRoutes); // /v1/instances/:id/run-events?since= (#579)
app.route("/v1/connectors", connectorRoutes); // generic OAuth2 authorize/callback for manifest oauth connectors (#147)
app.route("/v1/mcp", mcpRoutes); // outbound MCP: DCR+PKCE authorize/callback (#180/#258) + first-party presets (#287)
app.route("/v1/github", githubRoutes); // GitHub App: /status, /install-url, /installations, /callback
app.route("/v1/discord", discordRoutes); // owner bot discovery + per-instance channel grants
app.route("/v1/slack", slackRoutes); // owner Slack bot + per-instance channel grants, for release notes (#1217)
app.route("/v1/relay", relayRoutes); // WebSocket relay: /connect, /status
app.route("/v1/terminals", terminalRoutes); // platform: /v1/terminals/nodes — all the user's CLIs
app.route("/v1/terminals", terminalNativeRoutes); // per-machine native-control opt-in (#1057)
app.route("/v1/usage", usageRoutes); // platform: /v1/usage — token/cost transparency across agents
app.route("/v1/remote-auth", remoteAuthRoutes); // #1005: PAS remote sign-in requests relayed by the owner's machine (PAGS never calls PAS)
app.route("/v1/budget", budgetRoutes); // platform: /v1/budget/limits — account daily circuit breakers
app.route("/v1", statsRoutes); // per-agent stats cards: /v1/stats/sources, /v1/instances/:id/stats, /v1/agents/:id/stats-schema
app.route("/v1", mcpAuditRoutes); // platform: /v1/mcp-audit — the caller's OWN MCP tool-call history
app.route("/v1/batch", batchRoutes);       // /v1/batch/bulk-visibility, /bulk-delete     // /v1/agents/:id/export, /import
app.route("/v1/keys", keysRoutes); // /v1/keys/providers, /status, /:provider, /proxy/:host/*
app.route("/v1/email", emailRoutes); // /v1/email/google/start, /callback, /status, DELETE /google
app.route("/v1/email-worker", emailWorkerRoutes); // /v1/email-worker/connections (add/test/revoke), /connections/test (#1269)
app.route("/v1/email-worker/inbound", emailWorkerInboundRoutes); // POST /v1/email-worker/inbound/:token — public, Worker-called-back delivery events (#1269)
app.route("/v1/drive", driveRoutes); // /v1/drive/google/start, /callback, /status, /files, /instances/:id/import
app.route("/v1/workdrive", workdriveRoutes); // /v1/workdrive/zoho/start, /callback, /status, /folder, /instances/:id/import
app.route("/v1/triggers", triggerRoutes); // instance webhook + cron triggers
app.route("/v1/errors", errorRoutes); // GET /v1/errors — durable error log read-back
app.route("/v1/audit", auditRoutes); // admin-only MCP + admin-action audit readers, outside the Access perimeter for the MCP Worker (#1090)
app.route("/v1/site-builder/broker", siteBuilderBrokerRoutes); // the Website Builder's local author → FreeWebStore, authorized per run (#841)
app.route("/v1/feedback", feedbackRoutes); // owner's in-session complaints, turn-anchored (#514)
app.route("/v1/public", publicRoutes); // /v1/public/agents/:id, /agents/:id/try, /webhook/:id/ingest
app.route("/v1/billing", billingRoutes);
app.route("/v1/admin", adminRoutes); // operator portal: /me, /audit (+ users, agents, usage, moderation)
app.route("/v1/admin", adminInstanceDetailRoutes); // /instances/:id/detail
app.route("/v1/admin", adminModerationRoutes); // moderation: suspend/roles/keys, unpublish/delete, instance cancel
app.route("/v1/admin", adminTraceRoutes); // /trace/:instanceId
app.route("/v1/admin", adminCodingSessionRoutes); // /coding-sessions/:sid
app.route("/v1/admin", adminMcpAuditRoutes); // /mcp-audit
app.route("/v1/admin", adminOpsRoutes); // /ops
app.route("/v1/admin", adminTriggersRoutes); // /triggers
app.route("/v1/admin", adminSettingsRoutes); // /settings/platform-ai — runtime kill switch

// `adminPerimeter` (#108): the Access gate's state — off / audit / enforce — readable without a
// credential, so a deploy can check it and an inert perimeter is a visible fact, not a silence.
app.get("/health", (c) => c.json({ ok: true, service: "proagentstore-api", adminPerimeter: cloudflareAccessMode(c.env) }));

// ── Global error handler ───────────────────────────────────────────────────

app.onError(async (err, c) => {
	// Attribute the failure to the signed-in user (when the request carries a valid
	// session) so it appears in THEIR /v1/errors view, not just the admin all-scope read.
	const uid = await uidFromRequest(c);
	// Persist the exception (full message + stack for real bugs) so it shows up in the
	// user's + admin Errors view instead of vanishing into the ephemeral worker console.
	// Transient infra (DO reset on deploy, overload) included (#1086): it returned its 503 BEFORE
	// this line, so `logUnhandled`'s own `transient` warn branch was unreachable from a request.
	await logUnhandled(c.env, err, { path: c.req.path, method: c.req.method, userId: uid });
	// #1256: the body carries the request id too, not just the `X-Request-Id` header — a caller that
	// only sees a tool's JSON result (MCP's call_instance_tool, among others) never sees response
	// headers, so a bare `{"error":"Internal server error"}` gave it nothing to correlate against this
	// log or tell a transient blip from a real bug.
	const requestId = currentRequestId();
	// Not a bug, so not a 500 — tell the client to retry. This is what the two "chat → 500" reports were.
	if (isTransientInfraError(err)) return c.json({ error: "The service is updating — please try again in a moment.", requestId }, 503);
	if (err instanceof HttpError) return c.json({ error: err.message, requestId }, err.status as 400);
	return c.json({ error: "Internal server error", requestId }, 500);
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

let _buildStamped = false;

/**
 * The request's execution context, with every `waitUntil` task's rejection recorded (#1134).
 *
 * Work a route hands to `waitUntil` outlives its response, so a rejection reached no handler: the
 * runtime logged it to the ephemeral console at best. Wrapping the context once covers every route's
 * background task, present and future, through `logUnhandled`'s own policy (transient → warn, a
 * genuine throw → error with its stack). The task still runs exactly as before; only its rejection
 * is observed. It runs inside the request, so the row carries the request id (#1135).
 */
export function recordingWaitUntil(ctx: ExecutionContext, env: Env, request: Request): ExecutionContext {
	const path = new URL(request.url).pathname;
	return {
		waitUntil: (task: Promise<unknown>) => ctx.waitUntil(Promise.resolve(task).catch((err) => logUnhandled(env, err, { path, method: `${request.method} waitUntil` }))),
		passThroughOnException: () => ctx.passThroughOnException(),
		props: ctx.props,
	} as ExecutionContext;
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		// Stamp the server build once per isolate (#735). `env.API_BUILD` is the deployed git SHA
		// injected by CI; "dev" in local runs. Called on the first fetch rather than at module
		// evaluation because `env` is not available until a request arrives.
		if (!_buildStamped) { setServerBuild(env.API_BUILD ?? "dev"); _buildStamped = true; }
		return app.fetch(request, env, recordingWaitUntil(ctx, env, request));
	},
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		// A cron isolate may never serve a fetch, and its failures carried no build (#1085).
		if (!_buildStamped) { setServerBuild(env.API_BUILD ?? "dev"); _buildStamped = true; }
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
		// Hand recorded run.finished / run.stalled events to the connection outbox (#579). Its own
		// failure domain: a routing error leaves rows unrouted for the next tick, never the pump.
		ctx.waitUntil(
			routeRunEvents(env).catch((err) => logUnhandled(env, err, { path: "scheduled:run-events", method: "CRON" })),
		);
		// The opt-in ticket queue (#864): only instances whose owner turned it on, only tickets a person
		// released. Its own failure domain — a pickup that fails leaves the ticket for the next tick.
		ctx.waitUntil(
			runTicketQueue(env).catch((err) => logUnhandled(env, err, { path: "scheduled:ticket-queue", method: "CRON" })),
		);
		// Scheduled Gmail Scout scans (#1022): a Scout scanned only when asked, so one stopped finding
		// leads for days unnoticed. Each scan records its own outcome on the Scout's scan state.
		ctx.waitUntil(
			runDueGmailScoutScans(env).catch((err) => logUnhandled(env, err, { path: "scheduled:gmail-scout", method: "CRON" })),
		);
		// The coder brain's timers (#1025): every open question's human / escalation timeout, read from
		// `coder_questions` each tick so they survive a restart. Its own failure domain.
		ctx.waitUntil(
			runDueCoderQuestions(env).catch((err) => logUnhandled(env, err, { path: "scheduled:coder-questions", method: "CRON" })),
		);
		// The runner admission gate's TIMED backoff (#1264): an instance deferred for `runner_overloaded`
		// is woken by no event, only this clock. Its own failure domain, like every sweep above.
		ctx.waitUntil(
			runDueOverloadRetries(env).catch((err) => logUnhandled(env, err, { path: "scheduled:overload-retries", method: "CRON" })),
		);
		// Close runs whose Workflow died mid-step (#207C). A third independent failure domain: a
		// row stuck at `running` forever tells every supervisor its subordinate is still working.
		// `runStaleRunSweep` swallows + logs its own errors.
		ctx.waitUntil(runStaleRunSweep(env));
		// Reap idle coding sessions and reconcile orphans (#275). The counterpart of the sweep
		// above: that one closes a run ROW whose driver died, this one closes an ENGINE PROCESS on
		// the user's machine that nothing is using. Reaping used to happen only as a side effect of
		// a run ending — which #271 correctly stopped — and orphan detection needed a human to open
		// the diagnostics panel. `runCodingSessionSweep` swallows + logs its own errors.
		ctx.waitUntil(runCodingSessionSweep(env));
		// Warn before an unattended device-code sign-in expires (#890). Swallows its own errors.
		ctx.waitUntil(runReauthExpiryWatch(env));
		// Pull local browser research runs from their runners (#944) — the runner cannot push — and
		// end any whose runner lost them. Its own failure domain, like every sweep above.
		ctx.waitUntil(syncActiveLocalBrowserRuns(env).catch((err) => logUnhandled(env, err, { path: "scheduled:local-browser", method: "CRON" })));
		// The same pull for Application Tailor runs (#956), plus the materials_ready outbox backstop.
		ctx.waitUntil(syncActiveTailorRuns(env).catch((err) => logUnhandled(env, err, { path: "scheduled:application-tailor", method: "CRON" })));
		// The same pull for Application Runner fills (#957).
		ctx.waitUntil(syncActiveApplyRuns(env).catch((err) => logUnhandled(env, err, { path: "scheduled:application-runner", method: "CRON" })));
		// Replay screenshots past their retention (#1063): the R2 object and its row, together.
		ctx.waitUntil(sweepExpiredBrowserArtifacts(env).catch((err) => logUnhandled(env, err, { path: "scheduled:browser-artifacts", method: "CRON" })));
		// The Runner owns the ten-minute reconciliation deadline.  Pull the terminal result here so
		// expiry remains durable when the owner closes Console instead of polling its handoff.
		ctx.waitUntil(syncActiveApplyReconciliations(env).catch((err) => logUnhandled(env, err, { path: "scheduled:application-reconciliation", method: "CRON" })));
		// #990: fail any runner update that stopped reporting. `running` is the only non-terminal
		// state, so a row left there by a Worker that died would be the new way for an update to be
		// unknowable — which is the whole defect the operation record exists to end.
		ctx.waitUntil(failStaleUpdateOps(env).catch((err) => logUnhandled(env, err, { path: "scheduled:runner-update-ops", method: "CRON" })));
		// #1141: a machine that reported an install and went silent becomes `failed` with a reason and an error-log row —
		// never `installing` forever, which is how two machines sat dark on 2026-10-17 with nothing saying so.
		ctx.waitUntil(failSilentUpdates(env).catch((err) => logUnhandled(env, err, { path: "scheduled:silent-auto-updates", method: "CRON" })));
		// #1162: and the OWNER is told — once per silence, mid-update or not — instead of finding a grey dot by looking.
		ctx.waitUntil(notifySilentMachines(env).catch((err) => logUnhandled(env, err, { path: "scheduled:silent-machines", method: "CRON" })));
		// #1174: machine registrations unseen for 30 days are expired, so lookups stop probing abandoned hostnames.
		ctx.waitUntil(pruneStaleRuntimeNodes(env).catch((err) => logUnhandled(env, err, { path: "scheduled:prune-runtime-nodes", method: "CRON" })));
		// #1031: a takeover nobody answered before its expiry becomes `expired`, not open forever.
		ctx.waitUntil(expireStaleTakeovers(env).catch((err) => logUnhandled(env, err, { path: "scheduled:browser-takeovers", method: "CRON" })));
		// #1030: settle finished browser verifications of Gmail leads, then dispatch the ones due.
		ctx.waitUntil(runLeadBrowserVerification(env).catch((err) => logUnhandled(env, err, { path: "scheduled:lead-browser-verification", method: "CRON" })));
		ctx.waitUntil(dispatchQueuedRunnerUpdates(env).catch((err) => logUnhandled(env, err, { path: "scheduled:runner-update-workflow", method: "CRON" })));
		// Backstop for the lead writeback (#953): applications that moved in the last 10 minutes.
		ctx.waitUntil(syncLeadWritebacks(env, Date.now() - 10 * 60_000).catch((err) => logUnhandled(env, err, { path: "scheduled:application-lead-writeback", method: "CRON" })));
		// Snapshot yesterday's stats for instances that were active (#313). A sixth independent
		// failure domain, and the one with the weakest claim on the tick: a missed rollup leaves a
		// GAP in a chart, which is a visible and honest outcome, where a missed delivery loses work.
		// `runStatsRollup` swallows + logs its own errors so it can never take the others down.
		ctx.waitUntil(runStatsRollup(env));
		// Prune excess `terminal` rows from `coding_timeline` (#466). Terminal snapshots are 99.5%
		// of the table's bytes; without a cap one long idle session produces ~4.8 MB/hour forever.
		// The dedup fix (same PR) stopped NEW excess rows; this sweep cleans up the historical ones.
		// A missed tick is harmless — the table just stays a bit bigger — but it is recorded (#1119).
		ctx.waitUntil(sweepTerminalSnapshots(env).catch((err) => logUnhandled(env, err, { path: "scheduled:terminal-snapshots", method: "CRON" })));
		// Daily spend alerts (#1040): an owner's 24h charged spend reaching the alert they set. Bounded,
		// at most one push per account per day, and it never stops anything.
		ctx.waitUntil(runSpendAlerts(env).catch((err) => logUnhandled(env, err, { path: "scheduled:spend-alerts", method: "CRON" })));
		// Close permission requests past their expiry (#1009) — every fifth tick; bounded, and never a
		// decided or consumed request. Approve and resume re-check expiry themselves; this is what
		// makes an unattended request read `expired` instead of `pending` forever.
		if (new Date(_event.scheduledTime).getUTCMinutes() % 5 === 0) {
			// #1276: wake idle coders with auto-pickup on, so a refused wake is retried without a run having to end.
			ctx.waitUntil(sweepAutoPickup(env).catch((err) => logUnhandled(env, err, { path: "scheduled:auto-pickup", method: "CRON" })));
			ctx.waitUntil(sweepExpiredPermissionRequests(env).catch((err) => logUnhandled(env, err, { path: "scheduled:permission-request-expiry", method: "CRON" })));
		}
		// Copy legacy MCP audit keys into the time-ordered ledger (#1016): one bounded, resumable,
		// idempotent batch per tick; a single KV read per tick once it has finished.
		if (env.OAUTH_KV) {
			ctx.waitUntil(runAuditLedgerBackfill(env.OAUTH_KV).catch((err) => logUnhandled(env, err, { path: "scheduled:mcp-audit-ledger", method: "CRON" })));
		}
		// Replay telemetry its primary store refused (#1084): spooled error-log, trace and admin-audit
		// rows back into D1, partial MCP audit index writes back into KV. Bounded per sink per tick;
		// it never logs through `logError`, so a D1 outage cannot feed itself.
		if (env.OAUTH_KV) {
			ctx.waitUntil(drainTelemetrySpool(env).catch((err) => console.error("[telemetry] drain failed:", err instanceof Error ? err.message : String(err))));
		}
		// Notify on a finished deploy (#6). A fifth independent failure domain — it reaches an
		// external API (GitHub), which is the most likely of these to be slow or rate-limited,
		// and it must not be able to stop the trigger sweep or the pump from draining.
		ctx.waitUntil(
			runDeployWatch(env).catch((err) => logUnhandled(env, err, { path: "scheduled:deploy-watch", method: "CRON" })),
		);
		// Close an issue a default-branch commit named with a closing keyword (#816). A seventh
		// independent failure domain, and the one with the weakest claim on the tick: GitHub already
		// performs this close natively on a direct push, so the expected yield is zero and a missed
		// tick costs nothing at all. See `lib/commit-close-watch.ts` for the verification behind
		// that sentence. It reaches GitHub and WRITES, so it must not be able to stop the trigger
		// sweep, the pump or the deploy watcher.
		ctx.waitUntil(
			runCommitCloseWatch(env).catch((err) => logUnhandled(env, err, { path: "scheduled:commit-close-watch", method: "CRON" })),
		);
		// Keep coder boards' issue cards in step with GitHub (#895): backlog, labels, closes. Reads only.
		ctx.waitUntil(runIssueSync(env).catch((err) => logUnhandled(env, err, { path: "scheduled:issue-sync", method: "CRON" })));
		// Default-branch CI/deploy health for coding repos (#903): reads GitHub, notifies once per red
		// streak. Its own failure domain for the deploy watcher's reasons.
		ctx.waitUntil(runCiHealthWatch(env).catch((err) => logUnhandled(env, err, { path: "scheduled:ci-health", method: "CRON" })));
	},
};
