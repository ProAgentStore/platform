import { Hono } from "hono";
import type { Env } from "../types.js";
import { registerCopilotRoutes } from "./coding-brains.js";
import { registerDiagnosticsRoutes } from "./coding-diagnostics.js";
import { registerDriveRoutes } from "./coding-drive.js";
import { registerFeedRoutes } from "./coding-feed.js";
import { registerPullRoutes } from "./coding-pulls.js";
import { registerRepoRoutes } from "./coding-repos.js";
import { registerSessionOpenRoutes } from "./coding-sessions-open.js";
import { registerTimelineRoutes } from "./coding-timeline-routes.js";

/**
 * The coding-workspace control plane (the AgentCoder port). A workspace IS the
 * agent instance; these routes manage its repos + coding sessions and proxy the
 * brain-driven controls to the user's local runner. Mounted on `/v1/instances`.
 *
 * ── The shape of this file after #305 and #775
 *
 * This file is now ONLY the registration order. #305 split out the three neighbours whose
 * boundaries the registrations already had; #775 split the session lifecycle that remained into
 * the three phases it was actually made of. Each module is called from the exact position its
 * block occupied — Hono matches in registration ORDER, so moving a block past a sibling pattern
 * would be a behaviour change even where the route SET is unchanged:
 *
 *   `coding-repos.ts`          what the agent is pointed at (repos, builds, issues, work mode)
 *   `coding-pulls.ts`          pull requests (#401)
 *   `coding-feed.ts`           the instance-level cursored timeline feed (#581, #527)
 *   `coding-sessions-open.ts`  open a session, attach it to a machine, watch its terminal
 *   `coding-brains.ts`         the three routes that call a MODEL (Co-pilot, Agent chat, Overseer)
 *   `coding-timeline-routes.ts` the session-scoped conversation (read + clear)
 *   `coding-drive.ts`          drive the engine, hand it to the brain, end or restart it
 *   `coding-diagnostics.ts`    the reconcile-and-explain surface
 *   `coding-shared.ts`         the tenant gate + the things the modules need in common
 *
 * `coding.contract.test.ts` derives the route table, the registration order, and what each
 * module owns by DRIVING the registered handlers — so the split is evidenced rather than
 * described, and a route that loses its tenant gate moves in a pinned table.
 */
export const codingRoutes = new Hono<{ Bindings: Env }>();

// ── Repos ────────────────────────────────────────────────────────────────
registerRepoRoutes(codingRoutes);

// ── Pull requests (#401) ─────────────────────────────────────────────────
// Registered here, directly after the repo block, because that is where the surface it belongs to
// ends — Hono matches in registration ORDER and `coding.contract.test.ts` pins it.
registerPullRoutes(codingRoutes);

// ── The cursored timeline feed (#581, #527) ──────────────────────────────
// Before the session block on purpose: `/:instanceId/coding/timeline` is instance-level and must
// not be reachable only after a caller has resolved a session id. Why it exists at all, and how a
// session is chosen when the caller names none, is in `coding-feed.ts`.
registerFeedRoutes(codingRoutes);

// ── Sessions: open, attach, watch (#775 → coding-sessions-open.ts) ───────
// Ends with `system-message`, which must stay AHEAD of the copilot block below —
// Hono matches in registration order and coding.contract.test.ts pins it.
registerSessionOpenRoutes(codingRoutes);

// ── The model-driven three: Co-pilot, Agent chat, Overseer ───────────────
registerCopilotRoutes(codingRoutes);

// ── The session-scoped conversation (#775 → coding-timeline-routes.ts) ───
registerTimelineRoutes(codingRoutes);

// ── Driving the engine + ending the session (#775 → coding-drive.ts) ─────
registerDriveRoutes(codingRoutes);

// ── Diagnostics: close-sessions / browse / the reconcile-and-explain view ─
registerDiagnosticsRoutes(codingRoutes);
