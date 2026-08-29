import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * Account-level reads that are not scoped to any one instance — plan, spend, which BYOK
 * keys exist, whether Gmail is connected — plus the candidate Profile write.
 *
 * They live with the instance tools because that is what a caller is doing when it needs
 * them ("chat says BYOK is required — do I have a key?"). Nothing here can reveal a secret
 * value; `keys_status` returns provider names only, by design.
 */
export function registerAccountTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

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
		"Gmail connection status for the email-access tool (configured? connected?). Connect/disconnect happens in the console.",
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
		"Update your structured candidate Profile / Job Preferences (string fields only; used by the apply pipeline). Read get_profile first.",
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
		"Patch your per-account AI-spend limits — the two daily circuit breakers and the four per-tree run knobs. Only the fields you pass are changed; anything you omit keeps its stored value. Pass null for a field to clear that override so it inherits from the platform default. Values are clamped server-side to the platform maximum ($10 000 / 100B tokens per 24h). Returns the re-resolved effective limits after the write — same shape as get_budget_limits. Read get_budget_limits first to see the current state.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			token_ceiling: z.coerce.number().nullable().optional().describe("Daily token ceiling. null clears the override (inherit); omit to leave unchanged."),
			charged_micros_ceiling: z.coerce.number().nullable().optional().describe("Daily charged-cost ceiling in micros (1 000 000 = $1). null clears the override; omit to leave unchanged."),
			per_tree_cost_micros: z.coerce.number().nullable().optional().describe("Spend budget for one autonomous run tree, in micros. null clears the override; omit to leave unchanged."),
			per_tree_delegations: z.coerce.number().nullable().optional().describe("Max delegations in one run tree. null clears the override; omit to leave unchanged."),
			per_tree_max_depth: z.coerce.number().nullable().optional().describe("Max delegation depth in one run tree. null clears the override; omit to leave unchanged."),
			loop_max_iterations: z.coerce.number().nullable().optional().describe("Cap on Loop iterations. null clears the override; omit to leave unchanged."),
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
}

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
] as const;
