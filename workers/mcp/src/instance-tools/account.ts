import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { probeHealth } from "../health.js";
import { authRequired, authedCall, jsonText } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * Account-level reads that are not scoped to any one instance — plan, spend, which BYOK
 * keys exist, whether Gmail is connected — plus the candidate Profile write, the budget
 * limits, and (#613) the notification feed and account-wide preferences.
 *
 * They live with the instance tools because that is what a caller is doing when it needs
 * them ("chat says BYOK is required — do I have a key?"). Nothing here can reveal a secret
 * value; `keys_status` returns provider names only, by design.
 */
export function registerAccountTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"get_creator_dashboard",
		"Read your creator dashboard: how many agents you own, their active subscribers, total recorded usage, and the per-agent ranking. Account-wide and owner-scoped — an agent with no subscribers still appears with zeroes.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			return jsonText(await authedCall("/v1/dashboard/creator", sessionToken, {}, env));
		},
	);

	server.tool(
		"get_usage_dashboard",
		"Read your subscriber usage dashboard: active instances, chat and AI-call totals, plus the last 30 days by day and by agent. This is a usage measurement, not billing; it does not replace usage_summary's cost and provider detail.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			return jsonText(await authedCall("/v1/dashboard/usage", sessionToken, {}, env));
		},
	);

	server.tool(
		"whoami",
		"Which account this connection is signed in as: id, login, sign-in provider — the string `github` or `google` — plus a display label, email (only when signed in with Google — a GitHub login is a username, not an address, and comes back as `login`), roles, account createdAt, and this token's tokenExpiry. Answers 'who am I connected as?' — nothing here is a secret. For plan/billing use billing_status; for BYOK keys use keys_status.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall("/v1/auth/me/account", sessionToken, {}, env);
			return jsonText(data);
		},
	);

	// #198: the read-only diagnostic. Works WITHOUT a session (gateway, API and connector
	// probes need none) and measures auth when one is present — an unauthenticated caller
	// asking "is the platform slow or is it me?" must not be answered with `authRequired`.
	server.tool(
		"platform_health",
		"Is the platform healthy right now, and where is the time going? Read-only, safe to call at any time, no side effects. Returns one verdict per component — `gateway` (this MCP worker), `auth` (session verification), `state` (the API that hydrates your account), `runner` (local-runner dispatch), `coding_loop` (autonomous-run orchestration) and `connectors.github` — each `ok`, `degraded`, `down`, `unauthenticated` or `unknown`, with the live probe's own milliseconds where one exists and this session's recent p50/p95/p99 per stage beside the budget it is held to. `unknown` means nothing was measured (no probe exists and no recent calls), not `ok`. Carries a `traceId` and `timestamp`. Call it FIRST when several unrelated tools are slow or time out: a slow `gateway` with fast `state` and `connectors` is the edge or the Worker's start, not a dependency; a slow `state` is the API. The same measurements are public at https://mcp.proagentstore.online/status. Never returns a secret, a token, an instance id or any tenant data.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in; omit entirely to probe without measuring auth."),
		},
		async ({ token }) => {
			const report = await probeHealth({ env, token: tokenFor(token) });
			return jsonText(report);
		},
	);

	server.tool(
		"billing_status",
		"Read your billing/plan status (free vs Pro, whether the paywall is enforced, whether a billing account exists). Upgrades happen in the console (browser redirect).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall("/v1/billing/status", sessionToken, {}, env);
			return jsonText(data);
		},
	);

	/**
	 * The description names every top-level key `/v1/usage` returns, in backticks, and
	 * `account.test.ts` derives that key list from the API worker's own code and fails
	 * when one is missing (#565).
	 *
	 * It did not, and the omission was not cosmetic. The old text said the coverage gap was
	 * calls BEFORE `firstAttributedAt` and that `payerCoverage.unattributedBefore` was "by
	 * how much" — which points a reader at a WINDOW problem whose implied remedy is to
	 * narrow the range. On the account that prompted this, the other gap —
	 * `unattributedSince`, calls sitting alongside attributed ones, which narrowing cannot
	 * reach — was $9,494 against $92, i.e. 99% of the unattributed value and 103x the slice
	 * the tool named. `usage-coverage.ts:58-71` splits the two precisely because they have
	 * different remedies (a no-backfill you cannot undo, vs. #551's machine-login coding
	 * engine, which one stored token fixes); a description that names only the first
	 * tells the caller to blame the date for all of it.
	 *
	 * Two things the prose must NOT say, both of which the issue's own suggested wording
	 * said and both of which contradict the module being described. `attributed` is not
	 * "what `chargedCostMicros` counts" — `usage-coverage.ts:118-126` gates it on
	 * `hasPayer`, not `isCharged`, and calls that difference the one the module turns on: a
	 * `subscription` row is attributed and charged to nobody, so `attributed` is a strict
	 * superset. And `unattributedBefore` is not "calls predating the payer column" — that
	 * is the confident cause `usage-coverage.ts:24-28` refuses, since the two NULL causes
	 * are indistinguishable per row and a machine-login row older than the boundary lands
	 * there too. Both slices are defined by the boundary and by nothing else.
	 */
	server.tool(
		"usage_summary",
		"Token usage + ESTIMATED value across all your agents over a time `range`: `totals`, a per-day `daily` series, and breakdowns `byModel`, `byKind` (chat/apply/coding/voice/…), `byAgent` (the published template — every copy of one agent is one row), `byInstance` (the subscriber's own unit: what did THIS workspace cost me) and `byPayer`. Every dollar figure is tokens x published list price — ours for platform calls, Claude Code's own arithmetic for coding-engine rows — so none of it is a bill. `totals.chargedCostMicros` is the part someone is actually charged, and `payerCoverage` splits the range in three because the two gaps have different remedies: `attributed` is every call whose payer is KNOWN — a superset of the charged figure, since a `subscription` row is attributed and charged to nobody; `unattributedBefore` is unattributed calls older than `firstAttributedAt`, so a wider range understates charged spend and a narrower one does not; `unattributedSince` is unattributed calls alongside attributed ones — typically a coding engine on the machine's own login, so narrowing the range recovers none of it and one stored `claude setup-token` fixes it (#551). Read both: on a heavy coding account `unattributedSince` is the larger by two orders of magnitude. `unmetered` counts work never metered at all (tmux/CLI drives the platform did not observe) over the last `windowDays`, not value.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			range: z.enum(["7d", "30d", "90d", "all"]).optional().describe("Time window (default 30d)."),
		},
		async ({ token, range }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const q = range ? `?range=${encodeURIComponent(range)}` : "";
			const data = await authedCall(`/v1/usage${q}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	// #1040: what is DRIVING spend, and whether a change saved anything — the two questions after
	// usage_summary's "what did I spend". Read-only; ids, labels and counts, never prompt text.
	server.tool(
		"usage_drivers",
		"What is driving your AI spend, and did a change save anything (#1040). view `drivers` (default): one window's top spend by instance, model, phase (`source · phase`, e.g. `copilot · decide`), objective (trace id — pass it to agent_trace) and day; totals with cache-read share, tool-call turns, retried calls and duplicated calls; and `opportunities`, each with an ESTIMATED saving in micros, the basis of the estimate and where to act — retries, duplicated calls, uncached repeated context, and advisory calls repriced on a cheaper Brain (never the Pilot, an approval or a submission). Nothing is changed. view `savings`: a baseline window against the current one, per objective (per call when objectives were not recorded), with `savedMicros` (positive = saved), `verdict` and a one-line `summary` — use it to verify a saving against a baseline. All figures are list-price estimates; prompt and reply text are never recorded. Set limits and the daily spend alert with set_budget_limits.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			view: z.enum(["drivers", "savings"]).optional().describe("`drivers` (default) or `savings`."),
			days: z.coerce.number().optional().describe("Current window: the last N days (1–90, default 7). The default baseline is the N days before it."),
			from: z.string().optional().describe("Current window start, YYYY-MM-DD (UTC). Overrides `days`."),
			to: z.string().optional().describe("Current window end, YYYY-MM-DD (UTC), exclusive. Default now."),
			baseline_from: z.string().optional().describe("savings only: baseline start, YYYY-MM-DD — e.g. the week before a change."),
			baseline_to: z.string().optional().describe("savings only: baseline end, YYYY-MM-DD, exclusive. Default the current window's start."),
		},
		async ({ token, view, days, from, to, baseline_from, baseline_to }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const q = new URLSearchParams();
			if (days !== undefined) q.set("days", String(days));
			if (from) q.set("from", from);
			if (to) q.set("to", to);
			if (baseline_from) q.set("baselineFrom", baseline_from);
			if (baseline_to) q.set("baselineTo", baseline_to);
			const qs = q.toString() ? `?${q.toString()}` : "";
			const data = view === "savings" ? await authedCall(`/v1/usage/savings${qs}`, sessionToken, {}, env) : await authedCall(`/v1/usage/drivers${qs}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"keys_status",
		"Which AI providers have a BYOK key stored for your account (names only — values are never exposed). Useful when chat says BYOK is required.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall("/v1/keys/status", sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"email_status",
		"Report whether your Gmail account is connected for the email-access tool. Use it before relying on an agent that reads or sends mail; connecting and disconnecting happen in the console, not here. For a Job Search Scout's mailbox use gmail_scout_status instead; keys_status covers AI provider keys. Takes no arguments besides the optional `token`. Example: {}. Returns `{connected, email, connectedAt, configured, canSend, accounts:[{accountId, label, connectedAt, canSend}]}`; `configured:false` means the platform has no Google OAuth client, so nothing can connect. `email` and `connectedAt` are filled only when exactly one account is connected.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall("/v1/email/status", sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"update_profile",
		"Update fields of your structured candidate Profile and Job Preferences, which the job-apply pipeline reads when filling forms. Call get_profile first to see the current field names and values; this changes only the fields you send and leaves the rest alone. Required: `fields`, an object of field name to string value; an empty string clears that field. `dry_run: true` previews which fields would change. Example: {\"fields\":{\"phone\":\"+61 400 000 000\",\"city\":\"Sydney\"}}. Returns `{ok:true, profile}` with the full profile after the write.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			fields: z.record(z.string()).describe("Field name → value (e.g. full_name, phone, city; empty string clears a field)"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, fields, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { fields: Object.keys(fields) };
			const denied = await requirePermission(safetyFor(token), "write", "update_profile", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "update_profile", "update candidate profile fields", input, {
					endpoint: "/v1/profile",
					method: "PUT",
				});
			}
			const data = await authedCall(
				"/v1/profile",
				sessionToken,
				{ method: "PUT", body: JSON.stringify(fields) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "update_profile", action: "completed", input, result: { ok: true } });
			return jsonText(data);
		},
	);

	server.tool(
		"get_budget_limits",
		"Read your AI-spend circuit breakers: effective daily ceilings (charged micros + token count), which tier each was resolved from (account / platform / env / default), current rolling 24h consumption, and distance to limit. Use this before raising or lowering limits with set_budget_limits.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall("/v1/budget/limits", sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_budget_limits",
		"Patch your per-account AI-spend limits — the two daily circuit breakers, the four per-tree run knobs and the daily spend alert. Only the fields you pass are changed; anything you omit keeps its stored value. Pass null for a field to clear that override so it inherits from the platform default. Values are clamped server-side to the platform maximum ($10 000 / 100B tokens per 24h). Returns the re-resolved effective limits after the write — same shape as get_budget_limits. Read get_budget_limits first to see the current state.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			token_ceiling: z.coerce.number().nullable().optional().describe("Daily token ceiling. null clears the override (inherit); omit to leave unchanged."),
			charged_micros_ceiling: z.coerce.number().nullable().optional().describe("Daily charged-cost ceiling in micros (1 000 000 = $1). null clears the override; omit to leave unchanged."),
			per_tree_cost_micros: z.coerce.number().nullable().optional().describe("Spend budget for one autonomous run tree, in micros. null clears the override; omit to leave unchanged."),
			per_tree_delegations: z.coerce.number().nullable().optional().describe("Max delegations in one run tree. null clears the override; omit to leave unchanged."),
			per_tree_max_depth: z.coerce.number().nullable().optional().describe("Max delegation depth in one run tree. null clears the override; omit to leave unchanged."),
			loop_max_iterations: z.coerce.number().nullable().optional().describe("Cap on Loop iterations. null clears the override; omit to leave unchanged."),
			spend_alert_micros: z.coerce.number().nullable().optional().describe("Daily spend ALERT in micros: a notification when 24h charged spend reaches it, at most once a day. Never stops anything. null clears it; omit to leave unchanged."),
			dry_run: z.boolean().optional(),
		},
		async (args) => {
			const sessionToken = tokenFor(args.token);
			if (!sessionToken) return authRequired();

			/**
			 * Send ONLY the fields the caller actually supplied.
			 *
			 * This tool used to send all four of its arguments coerced through `?? null`, i.e. an
			 * explicit null for anything the caller left out — and the route was a full replace, so
			 * "raise my token ceiling" also wiped the per-tree limits and the Loop iteration cap the
			 * owner had set in the console, and deleted the row outright when both its fields were
			 * null (#501). The route now patches (absent = leave alone), which only helps if the
			 * client stops manufacturing absent fields as nulls.
			 */
			const body: Record<string, number | null> = {};
			for (const [arg, field] of BUDGET_LIMIT_FIELDS) {
				const value = args[arg];
				if (value !== undefined) body[field] = value;
			}

			const denied = await requirePermission(safetyFor(args.token), "write", "set_budget_limits", body);
			if (denied) return denied;
			if (args.dry_run) {
				return dryRun(safetyFor(args.token), "set_budget_limits", "update account AI budget limits", body, {
					endpoint: "/v1/budget/limits",
					method: "PUT",
					body,
					unchanged: BUDGET_LIMIT_FIELDS.map(([, field]) => field).filter((f) => !(f in body)),
				});
			}
			const data = await authedCall("/v1/budget/limits", sessionToken, { method: "PUT", body: JSON.stringify(body) }, env);
			if (!(data as { error?: string }).error) {
				await audit(safetyFor(args.token), { tool: "set_budget_limits", action: "completed", input: body, result: { ok: true } });
			}
			return jsonText(data);
		},
	);

	// ── Notifications and account preferences (#613) ─────────────────────────────
	//
	// The console's bell and Preferences page, which MCP had no path to: a caller could not tell an
	// owner what their agents had been trying to tell them, nor read the timezone every run is
	// narrated in. Account-scoped like everything above — no instance id, because neither the feed
	// nor the preferences blob belongs to one.

	server.tool(
		"list_notifications",
		"Read your notification feed — what your agents and runs have been telling you (a run finished, stopped, or needs you; a deploy; an application). Newest first, each with `id`, `type`, `title`, `body`, `read` (0/1), `created_at`, `url`, `kind` (`alert` = somebody has to act), and `instance_id` when it is about one instance; plus `unreadCount` across the whole feed, not just the page. Account-wide, not per instance. To clear items use mark_notification_read with an `id` from here, or mark_all_notifications_read.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			unread_only: z.boolean().optional().describe("Only unread notifications."),
			limit: z.coerce.number().optional().describe("How many to return, newest first (default 50, max 200)."),
			offset: z.coerce.number().int().min(0).optional().describe("Skip this many of the newest — the previous reply's `nextOffset` while `hasMore` is true."),
		},
		async ({ token, unread_only, limit, offset }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const qs = [unread_only ? "unread=true" : "", limit !== undefined ? `limit=${encodeURIComponent(String(limit))}` : "", offset ? `offset=${offset}` : ""].filter(Boolean).join("&");
			const data = await authedCall(`/v1/notifications${qs ? `?${qs}` : ""}`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"mark_notification_read",
		"Mark ONE notification read, by the `id` list_notifications returned. Fails with `Notification not found` for an id that is not one of yours — it never reports success for something it did not clear. Marking an already-read notification succeeds. Read-state only: it dismisses nothing the agent is waiting on, and answers no `alert`.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			notification_id: z.string().describe("Notification `id` from list_notifications — copy it exactly."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, notification_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { notification_id };
			const denied = await requirePermission(safetyFor(token), "write", "mark_notification_read", input);
			if (denied) return denied;
			const endpoint = `/v1/notifications/${encodeURIComponent(notification_id)}/read`;
			if (dry_run) {
				return dryRun(safetyFor(token), "mark_notification_read", "mark one notification read", input, { endpoint, method: "POST" });
			}
			const data = await authedCall(endpoint, sessionToken, { method: "POST" }, env);
			if (!(data as { error?: string }).error) {
				await audit(safetyFor(token), { tool: "mark_notification_read", action: "completed", input, result: { ok: true } });
			}
			return jsonText(data);
		},
	);

	server.tool(
		"mark_all_notifications_read",
		"Mark EVERY unread notification in your feed read — account-wide, across all instances, not just one page of list_notifications. Read-state only; it answers nothing. Call list_notifications with unread_only:true first if you need to see what you are clearing: there is no undo.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "write", "mark_all_notifications_read", {});
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "mark_all_notifications_read", "mark every unread notification read", {}, {
					endpoint: "/v1/notifications/read-all",
					method: "POST",
				});
			}
			const data = await authedCall("/v1/notifications/read-all", sessionToken, { method: "POST" }, env);
			if (!(data as { error?: string }).error) {
				await audit(safetyFor(token), { tool: "mark_all_notifications_read", action: "completed", input: {}, result: { ok: true } });
			}
			return jsonText(data);
		},
	);

	server.tool(
		"get_account_preferences",
		"Read your account-wide preferences — the defaults that follow you across every agent: `preferences.timezone` (IANA name; ABSENT means never set, which is not the same as UTC), `preferences.notifications` (`muted`: notification type ids that should not interrupt you; `instances`: when present, only these instances may interrupt), `preferences.coding.defaultEngineId` (the inherited coding CLI engine for coders without their own explicit engine), `preferences.voice` and `preferences.translation` (per-instance overrides can still differ). Also returns the vocabularies a write needs: `notificationTypes` (each type's `id`, and `alerts` — an alert is never muted), `attentionEvents` (the kinds of attention an agent can ask you for, and which pushes you may turn off), `codingEngineOptions`, and `languages`. Read this before set_account_preferences.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall("/v1/preferences", sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_account_preferences",
		"Change your account-wide preferences. Patches by SECTION: pass only the sections you mean to change and the rest are left exactly as stored. `timezone` is an IANA zone (e.g. Australia/Sydney) — an invalid name is REJECTED, never coerced; null clears it back to unset. `notifications` REPLACES that whole section: to mute one more type, read get_account_preferences, add it to the existing `muted`, and send both `muted` and any `instances` scope back — an unknown type id is rejected. `coding.defaultEngineId` sets the inherited coding CLI engine for coders without their own explicit engine. `voice` and `translation` are merged into what is stored, and an unknown voice field is rejected. `attention.pushOff` turns OFF the push for a kind of attention an agent asks for (`approval_required`, `input_required`, …) across every agent — the in-app notification is still written, and an event id that is not one of `attentionEvents` is rejected. `releaseNotes.enabled` is the default every CODER instance's release notes follow until that instance sets its own (other agents have no release notes). Returns the saved preferences.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			timezone: z.string().nullable().optional().describe("IANA timezone name. null clears it to unset; omit to leave unchanged."),
			notifications: z
				.object({
					muted: z.array(z.string()).optional().describe("Notification type ids (from get_account_preferences.notificationTypes) that should not interrupt you."),
					instances: z.array(z.string()).optional().describe("When present, ONLY these instance ids may interrupt you. Omit for every instance."),
				})
				.optional()
				.describe("Replaces the whole notifications section. Omit to leave it unchanged."),
			voice: z.record(z.unknown()).optional().describe("Account voice defaults (fields as get_account_preferences returns them), merged into what is stored. Omit to leave unchanged."),
			translation: z.record(z.unknown()).optional().describe("Account translation defaults (fields as get_account_preferences returns them), merged into what is stored. Omit to leave unchanged."),
			coding: z
				.object({
					defaultEngineId: z.string().nullable().optional().describe("Coding engine id from get_account_preferences.codingEngineOptions. null clears it to the platform default."),
					autoResumeOnCredit: z.boolean().nullable().optional().describe("Continue coding runs that stopped on an empty Anthropic balance once the key works again (default on). false turns it off for the account; null returns it to on. An instance can opt out on its own with set_instance_auto_resume."),
				})
				.optional()
				.describe("Account coding defaults. Omit to leave unchanged."),
			attention: z
				.object({
					pushOff: z.array(z.string()).optional().describe("Owner-attention event ids (from get_account_preferences.attentionEvents) whose PUSH should not reach you. The in-app notification is always written. Send the whole list — it replaces the stored one."),
				})
				.optional()
				.describe("Replaces the whole owner-attention section. Omit to leave it unchanged."),
			releaseNotes: z
				.object({ enabled: z.boolean().describe("Whether instances post release notes to their granted channels by default.") })
				.strict()
				.nullable()
				.optional()
				.describe("The release-notes default every instance inherits unless it sets its own (set_instance_release_notes). null clears it to the platform default (on). Omit to leave unchanged."),
			dry_run: z.boolean().optional(),
		},
		async (args) => {
			const sessionToken = tokenFor(args.token);
			if (!sessionToken) return authRequired();
			// Only the sections the caller supplied, for the same reason `set_budget_limits` sends only
			// its supplied fields (#501): the route patches by section, and a section this tool
			// manufactured as absent-but-present would overwrite what the owner set in the console.
			const body: Record<string, unknown> = {};
			for (const section of ACCOUNT_PREFERENCE_SECTIONS) {
				if (args[section] !== undefined) body[section] = args[section];
			}
			const denied = await requirePermission(safetyFor(args.token), "write", "set_account_preferences", body);
			if (denied) return denied;
			if (args.dry_run) {
				return dryRun(safetyFor(args.token), "set_account_preferences", "update account preferences", body, {
					endpoint: "/v1/preferences",
					method: "PUT",
					body,
					unchanged: ACCOUNT_PREFERENCE_SECTIONS.filter((s) => !(s in body)),
				});
			}
			const data = await authedCall("/v1/preferences", sessionToken, { method: "PUT", body: JSON.stringify(body) }, env);
			if (!(data as { error?: string }).error) {
				await audit(safetyFor(args.token), { tool: "set_account_preferences", action: "completed", input: body, result: { ok: true } });
			}
			return jsonText(data);
		},
	);

	// ── The account-level operator manual (#1238) ───────────────────────────────

	server.tool(
		"get_account_operator_manual",
		"Read YOUR account-level operator manual (#1238) — caller-facing operating standards that apply to EVERY template you run (the machine map, main-only with no PRs, the home-relative checkout layout…), kept once instead of copied into each template's manual. Returns { manual, instances }: the text (\"\" when none) and how many of your instances read it. Every instance's get_instance_operator_manual shows it live as the `account` section, FIRST — the precedence is account → template → instance, each later layer an addendum that wins where it conflicts. It is YOUR account's, as the instance's owner: a template creator's account manual never reaches other people's instances. Not an instruction to the agent.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_account_operator_manual", {});
			if (denied) return denied;
			const data = await authedCall("/v1/preferences/operator-manual", sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_account_operator_manual",
		"Replace YOUR account-level operator manual (#1238, max 16000 chars). Every instance you run, of any template, shows it on its next get_instance_operator_manual read as the first section — no resync, no per-template copy. Use it for standards that span templates; a template's manual (set_agent_operator_manual) and an instance's own (set_instance_operator_manual) stay as addenda after it and win where they conflict. Caller-facing guidance, NOT an agent instruction (that is set_instance_instructions). Call with dry_run first.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			manual: z.string().max(16000).describe("The full manual (replaces the old one; \"\" clears it)."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, manual, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { chars: manual.length };
			const denied = await requirePermission(safetyFor(token), "write", "set_account_operator_manual", input);
			if (denied) return denied;
			const endpoint = "/v1/preferences/operator-manual";
			if (dry_run) return dryRun(safetyFor(token), "set_account_operator_manual", "replace your account-level operator manual (shown on every instance you run)", input, { endpoint, method: "PUT" });
			const data = await authedCall(endpoint, sessionToken, { method: "PUT", body: JSON.stringify({ manual }) }, env);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_account_operator_manual", action: "completed", input, result: { ok: true } });
			return jsonText(data);
		},
	);

	server.tool(
		"apply_account_coding_default",
		"Apply your saved account-wide coding CLI default to reachable idle coder sessions now. This is the MCP equivalent of the Preferences page's Apply button: it restarts only coders that inherit the account default, have no active run or queued objective, are reachable, and are idle; it skips coders that are already on the default, offline, busy, running, queued, or explicitly pinned to another engine. Each coder is claimed atomically before its restart, so a run cannot start in between. Before a working session is stopped its machine is asked whether it can run the default engine: a missing binary or subscription login skips it as engine-unavailable, and a runner too old to answer as runner-outdated (call runner_update), each with a `detail` naming the engine and the fix. Never uses an API key.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const body = {};
			const denied = await requirePermission(safetyFor(token), "runtime", "apply_account_coding_default", body);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "apply_account_coding_default", "apply account coding default to idle coders", body, {
					endpoint: "/v1/preferences/coding/default-engine/apply",
					method: "POST",
					body,
				});
			}
			const data = await authedCall("/v1/preferences/coding/default-engine/apply", sessionToken, { method: "POST" }, env);
			if (!(data as { error?: string }).error) {
				await audit(safetyFor(token), { tool: "apply_account_coding_default", action: "completed", input: body, result: { ok: true } });
			}
			return jsonText(data);
		},
	);
}

/**
 * The sections `PUT /v1/preferences` accepts, which are also this tool's section arguments. Kept
 * complete for the reason `BUDGET_LIMIT_FIELDS` is: a section this tool cannot name is one an MCP
 * caller cannot set. `account-notifications.test.ts` reads the route's own body type and fails when a
 * section is added there and not here.
 */
export const ACCOUNT_PREFERENCE_SECTIONS = ["timezone", "notifications", "voice", "translation", "coding", "attention", "releaseNotes"] as const;

/**
 * Every column of `account_budget_limits`, as [tool argument, API field].
 *
 * Kept complete on purpose: a field this tool does not expose is a field an MCP caller cannot set
 * — and, before #501, one it silently cleared. `budget.test.ts` in the API worker reads this list
 * back out of the source and fails when the route grows a field the tool has not caught up with.
 */
const BUDGET_LIMIT_FIELDS = [
	["token_ceiling", "tokenCeiling"],
	["charged_micros_ceiling", "chargedMicrosCeiling"],
	["per_tree_cost_micros", "perTreeCostMicros"],
	["per_tree_delegations", "perTreeDelegations"],
	["per_tree_max_depth", "perTreeMaxDepth"],
	["loop_max_iterations", "loopMaxIterations"],
	["spend_alert_micros", "spendAlertMicros"],
] as const;
