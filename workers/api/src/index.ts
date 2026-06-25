import { Hono } from "hono";
import { cors } from "hono/cors";
import { HttpError } from "./lib/auth.js";
import { rateLimitDefault, rateLimitStrict } from "./lib/rate-limit.js";
import { agentRoutes } from "./routes/agents.js";
import { batchRoutes } from "./routes/batch.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { authRoutes } from "./routes/auth.js";
import { billingRoutes } from "./routes/billing.js";
import { chatRoutes } from "./routes/chat.js";
import { instanceRoutes } from "./routes/instances.js";
import { credentialRoutes } from "./routes/credentials.js";
import { profileRoutes } from "./routes/profile.js";
import { keysRoutes } from "./routes/keys.js";
import { emailRoutes } from "./routes/email.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { notificationRoutes } from "./routes/notifications.js";
import { pushRoutes } from "./routes/push.js";
import { exportRoutes } from "./routes/export.js";
import { versionRoutes } from "./routes/versions.js";
import { publicRoutes } from "./routes/public.js";
import { runRoutes } from "./routes/run.js";
import { storageRoutes, instanceStorageRoutes } from "./routes/storage.js";
import type { Env } from "./types.js";

// Re-export Durable Object class for wrangler
export { AgentDO } from "./agent-do.js";
// Re-export the job-application Workflow class for wrangler
export { JobApplyWorkflow } from "./workflows/job-apply.js";

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
app.use("/v1/push/test", rateLimitStrict()); // sends real pushes — abuse-prone

// ── Routes ─────────────────────────────────────────────────────────────────

app.route("/v1/auth", authRoutes);
app.route("/v1/agents", agentRoutes);
app.route("/v1/agents", chatRoutes); // /v1/agents/:id/chat, /ws, /messages, /memory, /tasks
app.route("/v1/agents", runRoutes); // /v1/agents/:id/run, /executions
app.route("/v1/instances", instanceRoutes); // /v1/instances/:agentId/subscribe, /my/instances, /:id/chat, etc.
app.route("/v1/instances", credentialRoutes); // /v1/instances/:id/credentials (vault)
app.route("/v1/profile", profileRoutes); // structured candidate profile
app.route("/v1/agents", analyticsRoutes); // /v1/agents/:id/analytics
app.route("/v1/dashboard", dashboardRoutes);
app.route("/v1/notifications", notificationRoutes);
app.route("/v1/push", pushRoutes);
app.route("/v1/agents", versionRoutes);     // /v1/agents/:id/versions, /:versionId/rollback
app.route("/v1/agents", exportRoutes);
app.route("/v1/agents", storageRoutes); // /v1/agents/:id/collections, /files, /search, /activity, /summaries
app.route("/v1/instances", instanceStorageRoutes); // /v1/instances/:id/collections, /files, /search, /activity
app.route("/v1/batch", batchRoutes);       // /v1/batch/bulk-visibility, /bulk-delete     // /v1/agents/:id/export, /import
app.route("/v1/keys", keysRoutes); // /v1/keys/providers, /status, /:provider, /proxy/:host/*
app.route("/v1/email", emailRoutes); // /v1/email/google/start, /callback, /status, DELETE /google
app.route("/v1/public", publicRoutes); // /v1/public/agents/:id, /agents/:id/try, /webhook/:id/ingest
app.route("/v1/billing", billingRoutes);

app.get("/health", (c) => c.json({ ok: true, service: "proagentstore-api" }));

// ── Global error handler ───────────────────────────────────────────────────

app.onError((err, c) => {
	if (err instanceof HttpError) {
		return c.json({ error: err.message }, err.status as 400);
	}
	console.error("Unhandled error:", err.message, err.stack);
	return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
