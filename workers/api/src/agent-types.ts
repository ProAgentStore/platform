export interface AgentMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	channel: string; // 'chat', 'api', 'cron', 'webhook'
	userId?: string;
	toolCalls?: ToolCall[];
	toolResults?: ToolResult[];
	/** R2 key (a per-turn id) for this message's saved voice audio, if any — the
	 *  console fetches + replays it from the message's speaker button. Set for voice turns. */
	audioKey?: string;
	/** What the LIVE recognizer heard at end-of-turn, when it differs from `content` (#319).
	 *  Small text, so it is stored inline rather than behind a key like `audioKey` — there is
	 *  no blob to point at, and a pointer would cost a fetch to read two sentences. Living ON
	 *  the message is also what gives it the transcript's retention for free: clearing the chat
	 *  deletes the record, and the dictation with it. Absent for typed turns. */
	dictation?: string;
	/** The platform observed the live recognizer replacing or truncating what was heard before
	 *  the final transcript was delivered (#626). The message is still sent — nothing dropped —
	 *  but the agent is told the transcript may not match what was said so it can ask rather than
	 *  act on a substitution the user never made. Absent on non-suspect turns (the common case). */
	suspect?: boolean;
	/** The turn this message belongs to, matching `agent_events.trace_id` for the same turn (#514).
	 *  Stamped on the user message and the assistant reply by the caller that minted the id — the
	 *  console chat route and the Loop both do. Before this the ONLY join between a transcript and
	 *  its trace was a timestamp, and the trace's timestamp was wrong (see routes/instances-chat.ts).
	 *  Optional and additive: a message written before this existed, or over a channel that mints no
	 *  turn id (the WS chat path), simply has none. */
	traceId?: string;
	/** Stamped by `/messages` on an assistant message that claims a tool result the platform never
	 *  wrote (#406). NEVER persisted — it is computed from the message's own text on every read, so
	 *  it reaches rows written before the guard that catches this at generation time (#395) existed,
	 *  in a DO that has been asleep since. The console renders a stamped message as what it is; the
	 *  model does not read its content at all. See lib/fabricated-history.ts. */
	fabricated?: true;
	createdAt: string;
}

export interface ToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface ToolResult {
	toolCallId: string;
	name: string;
	content: string;
	success: boolean;
}

export interface MemoryEntry {
	key: string;
	type: "identity" | "knowledge" | "preference" | "skill" | "context";
	content: string;
	updatedAt: string;
	/** Who wrote this entry. Absent on legacy entries (treated as agent-written). */
	source?: "agent" | "user" | "summary";
	/**
	 * Server-computed on GET /memory: true when this entry is currently being injected into the
	 * prompt, false when it has aged out or been displaced by the SUMMARY_MEMORY_CAP (#618).
	 * Non-summary entries (user-set, agent-written) are always true.
	 * Absent on stored rows — only present in the API response shape.
	 */
	injected?: boolean;
	/**
	 * When this belief was FIRST recorded, as distinct from when it was last restated (#495).
	 *
	 * `updatedAt` is rewritten on every re-extraction, so a stale belief the agent keeps repeating in
	 * chat gets summarised again and its age resets to zero: `fact:Write access to terminal
	 * connector:is not enabled` existed on 7 Aug and read `updatedAt: 2026-08-10` three days later.
	 * An entry that has been believed for two weeks and restated yesterday then looked one day old.
	 *
	 * Written only by the summariser (the only writer that can re-write an entry it did not author);
	 * absent on every entry made before this existed, which reads as "not measured" and falls back to
	 * `updatedAt`.
	 */
	firstSeenAt?: string;
}

export interface AgentTask {
	id: string;
	title: string;
	description: string;
	status: "pending" | "in_progress" | "blocked" | "complete";
	assignedBy: "user" | "self" | "system" | "trigger";
	createdAt: string;
	updatedAt: string;
}

export interface Guardrails {
	topicRestrictions: string; // "Only answer about cooking, nutrition, and recipes"
	blockedTerms: string[]; // Words/phrases the agent should never use
	responseStyle: string; // "professional", "casual", "concise", etc.
	maxResponseLength: number; // 0 = unlimited
	requireCitations: boolean; // Must cite knowledge sources
}

export interface KnowledgeDoc {
	id: string;
	title: string;
	content: string;
	source: "upload" | "url" | "paste" | "google-docs" | "webhook";
	sourceUrl?: string;
	addedAt: string;
	updatedAt?: string;
}

export interface AgentState {
	agentId: string;
	name: string;
	personality: string;
	goal: string;
	model: string;
	/**
	 * The OWNER picked `model` as this instance's brain (#852), as opposed to inheriting it from the
	 * template. Only a pick is honoured over the owner's other provider key — an inherited `@cf/` id
	 * on an owner who also holds an Anthropic key keeps running on Sonnet, as it always has.
	 */
	modelChosen?: boolean;
	status: "idle" | "thinking" | "error";
	systemPrompt: string;
	guardrails: Guardrails;
	welcomeMessage: string; // First message shown to users
	isPublished: boolean;
	/** Capabilities the user has explicitly granted this agent. Off by default. */
	permissions?: AgentPermissions;
}

export interface AgentPermissions {
	/** Allow the agent to read the owner's connected Gmail (read-only, scoped). */
	email?: boolean;
}

/** One completed Gmail Job Search Scout ingest, returned by its manual scan endpoint. */
export interface GmailScoutScanResult {
	/** The mailbox label read; null when this answer is a scan already running (`reused`). */
	mailbox: string | null;
	candidates: number;
	added: number;
	deduped: number;
	lastMessageId: string | null;
	/** #1023: why examined messages did not become leads, by category — never their content. */
	rejected: Partial<Record<"missing_fields" | "stale" | "security_alert" | "digest" | "multiple_listings" | "no_specific_job_url" | "no_work_key" | "redirect_unresolved" | "posting_not_live" | "posting_unverifiable" | "posting_mismatch" | "prior_application", number>>;
	/** #1023: the durable receipt for this scan (or for the scan already running, when `reused`). */
	receipt: GmailScoutScanReceiptView;
	/** True when a scan was already running for this Scout and this call returned its receipt instead of reading again. */
	reused: boolean;
	/** A scan hands nothing to the Tailor or Runner; a lead waits for the owner's explicit apply. */
	handoff: "none";
}

/** One Gmail Scout scan receipt (#1023) — counts, rejection categories and the search it ran (#1247), never mail content. */
export interface GmailScoutScanReceiptView {
	id: string;
	instanceId: string;
	trigger: "schedule" | "on_demand" | "reprocess";
	triggeredBy: string | null;
	status: "running" | "completed" | "failed";
	startedAt: string;
	completedAt: string | null;
	hits: number | null;
	candidates: number | null;
	added: number | null;
	deduped: number | null;
	rejected: GmailScoutScanResult["rejected"];
	errorMessage: string | null;
	lastMessageId: string | null;
	/** #1247: the exact Gmail search and the window it covered. */
	query: string | null;
	window: Record<string, unknown> | null;
	handoff: "none";
}

/** `POST /v1/instances/:id/gmail-scout/scan` response. */
export interface GmailScoutScanResponse {
	scan: GmailScoutScanResult;
}

/**
 * Redacted, durable state of one job application's execution (#988).
 *
 * This import-free declaration is the Worker/Console contract. It contains only ids, closed
 * vocabulary, counts and owner-safe status; raw browser payloads, form values, credentials and
 * artifact contents are intentionally not representable here.
 */
export interface ApplicationExecutionProjection {
	schemaVersion: 1;
	lifecycle: { status: string; stateVersion: number; blockReason: string | null; submitAttempted: boolean };
	currentRun: { id: string; kind: "tailor" | "fill"; status: string; instanceId: string; mode: string | null } | null;
	checkpoint: { id: string; phase: "initial" | "post_navigation" | "before_submit" | "uncertain"; facts: { actions: number; filled: number; uploaded: number; blockers: string[]; domain: string | null }; directive: { kind: "continue" | "request_review" | "stop"; delivery: "queued" | "delivery_attempted" | "delivered" | "acknowledged_by_runner" } | null } | null;
	progress: { stage: string; label: string; filled: number; uploaded: number; checkpointPhase: string | null; checkpointId: string | null; submitAttempted: boolean; evidence: "runner_result" | "runner_checkpoint" | "run_status" } | null;
	permittedActions: string[];
	directiveReconciliation: "not_applicable" | "terminal" | "decision_pending" | "delivery_pending" | "retry_pending" | "acknowledged";
}

/**
 * Owner-safe receipt for one explicit reviewed-material transfer (#1010).
 *
 * It names only durable ids, status and reviewed-artifact provenance.  The receipt deliberately
 * does not expose the retained event payload or any document bytes to the Console.
 */
export interface PreparedApplicationTransferReceipt {
	id: string;
	sourceApplicationId: string;
	destinationApplicationId: string;
	destinationRunnerInstanceId: string;
	connectionId: string;
	stateVersion: number;
	resumeSha256: string;
	coverLetterSha256: string;
	deliveryId: string | null;
	deliveryStatus: string | null;
	runId: string | null;
	status: "queued" | "delivered" | "retrying" | "dead" | "consumed";
}

/**
 * What a granted connector write-consent MEANS for each call (#722, migration 0155).
 *
 *   always — dispatch. What every row written before 0155 does, and the column's default.
 *   ask    — do NOT dispatch: the call goes to the board as a ticket and runs only once the
 *            owner approves that specific call.
 *
 * "Off" is deliberately not a value — off is the ABSENCE of the row, so the gate keeps one way
 * to say no. See `lib/connector-consent.ts` for the store and `lib/tool-registry.ts` for the gate.
 */
export type ConsentMode = "always" | "ask";

/**
 * One connector write-consent row, as `GET /v1/instances/:id/connectors/consent` returns it.
 *
 * It lives HERE, in the import-free types module, rather than beside its queries in
 * `lib/connector-consent.ts` — that file imports `type { Env }`, and `Env` names `D1Database`,
 * `R2Bucket` and friends, so importing it from the console to compare the two declarations drags
 * the whole Workers global namespace into a DOM tsconfig. `types.test.ts` compares console types
 * against their producer by importing the producer, so the producer has to be importable.
 */
export interface ConsentRow {
	instance_id: string;
	user_id: string;
	connector: string;
	scope: string;
	mode: string;
	created_at: string;
}

/** A server visible to the owner's Discord bot in the channel-grant picker. */
export interface DiscordGuild {
	id: string;
	name: string;
}

/** A text or announcement channel visible to the owner's Discord bot. */
export interface DiscordChannel {
	id: string;
	name: string;
}

/** One owner-approved Discord channel for one private agent instance. */
export interface DiscordConnectorGrant {
	id: string;
	instanceId: string;
	userId: string;
	provider: string;
	resourceId: string;
	resourceName: string;
	resourceType: string;
	resourceUrl?: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface DiscordGuildListResponse {
	guilds: DiscordGuild[];
}

export interface DiscordChannelListResponse {
	channels: DiscordChannel[];
}

export interface DiscordGrantListResponse {
	grants: DiscordConnectorGrant[];
}

export interface DiscordGrantResponse {
	grant: DiscordConnectorGrant;
	/** Present when the grant asked for was not made as asked, and why (#1218). */
	note?: string;
}

/** The bot a Discord token authenticates as (#1132). Never the token. */
export interface DiscordBot {
	id: string;
	username: string;
}

/** `GET /v1/discord/bot` — connected, live-validated, and how many channel grants depend on it. */
export interface DiscordBotStatusResponse {
	connected: boolean;
	valid: boolean;
	bot: DiscordBot | null;
	error?: string;
	reach: { grants: number; instances: number };
}

/** `PUT /v1/discord/bot` — `revoked` is non-zero only when the token belongs to a different bot. */
export interface DiscordBotConnectResponse {
	connected: true;
	rotated: boolean;
	bot: DiscordBot;
	revoked: { grants: number; instances: number };
}

/** `DELETE /v1/discord/bot` — the token and every Discord channel grant it carried. */
export interface DiscordBotDisconnectResponse {
	disconnected: boolean;
	revoked: { grants: number; instances: number };
}

// ── Slack + release notes (#1217) ──────────────────────────────────────────────────────────

/** The workspace a Slack bot token belongs to. Never the token. */
export interface SlackBot {
	teamId: string;
	team: string;
	botUserId: string | null;
}

/** A public or private channel the owner's Slack bot can see. */
export interface SlackChannel {
	id: string;
	name: string;
	isPrivate: boolean;
	/** The bot is in the channel — Slack refuses posts from a bot that is not. */
	isMember: boolean;
}

/** `GET /v1/slack/bot`. */
export interface SlackBotStatusResponse {
	oauthConfigured: boolean;
	connected: boolean;
	valid: boolean;
	bot: SlackBot | null;
	error?: string;
	reach: { grants: number; instances: number };
}

/** `PUT /v1/slack/bot` — and what the OAuth callback stores. */
export interface SlackBotConnectResponse {
	connected: true;
	rotated: boolean;
	bot: SlackBot;
	revoked: { grants: number; instances: number };
}

export interface SlackBotDisconnectResponse {
	disconnected: boolean;
	revoked: { grants: number; instances: number };
}

export interface SlackOauthStartResponse {
	url: string;
}

export interface SlackChannelListResponse {
	channels: SlackChannel[];
	hasMore: boolean;
}

/** A Slack channel grant has the same row shape as a Discord one. */
export type SlackConnectorGrant = DiscordConnectorGrant;

export interface SlackGrantListResponse {
	grants: SlackConnectorGrant[];
}

export interface SlackGrantResponse {
	grant: SlackConnectorGrant;
	botInChannel: boolean;
	note: string | null;
}

export type ReleaseNoteProvider = "discord" | "slack";

/** One channel granted to an instance that can receive its release notes. */
export interface ReleaseChannel {
	provider: ReleaseNoteProvider;
	grantId: string;
	/** The provider's channel id. */
	channelId: string;
	name: string;
}

/** Which level decided `enabled`: the instance's own setting, the account default, or the platform's (on). */
export type ReleaseNotesEnabledFrom = "instance" | "account" | "platform";

export interface AccountReleaseNotes {
	enabled: boolean;
}

export interface InstanceReleaseNotes {
	/** Absent: follow the account default. */
	enabled?: boolean;
	/** Grant ids. Absent: every channel granted to the instance. */
	channels?: string[];
	/**
	 * When set, delivery waits for these exact GitHub workflow files on the pushed SHA. The
	 * `production_deploy` item also names the job and step whose success proves the deploy ran
	 * (#1346); a `check` item never carries them.
	 */
	requiredWorkflows?: { path: string; role: "check" | "production_deploy"; jobName?: string; stepName?: string }[];
}

/**
 * Whether the stored gate can make the verified-production claim (#1346). `configuration_required`
 * is an old gate without the deploy job and step: its notes are held, never posted on the weaker proof.
 */
export interface ReleaseGateState {
	state: "none" | "ready" | "configuration_required";
	/** Present for `configuration_required`: what to set. */
	message?: string;
}

export interface ResolvedReleaseNotes {
	enabled: boolean;
	enabledFrom: ReleaseNotesEnabledFrom;
	/** Every channel granted to the instance, each marked whether it receives the notes. */
	channels: Array<ReleaseChannel & { selected: boolean }>;
	/** `instance` when the instance chose its channels, `all` when every granted channel receives them. */
	channelsFrom: "instance" | "all";
	/** Grant ids the instance chose that are no longer granted — they receive nothing. */
	missing: string[];
}

/** `GET`/`PUT /v1/instances/:id/release-notes`. */
export interface InstanceReleaseNotesResponse {
	settings: InstanceReleaseNotes;
	account: AccountReleaseNotes | null;
	effective: ResolvedReleaseNotes;
	gate: ReleaseGateState;
}

/**
 * What an owner sees for one queued release note (#1348). `status` is the stored row status; `state` is the
 * answer to "what is happening to it": `outcome_uncertain` is a send claimed but never confirmed (a crash or
 * an unreadable provider reply) and is never retried automatically.
 */
export type ReleaseDeliveryState = "waiting_for_checks" | "configuration_required" | "configuration_changed" | "sending" | "outcome_uncertain" | "delivery_failed" | "sent" | "expired" | "abandoned";

export interface ReleaseDeliveryAttempt {
	id: string;
	kind: "send" | "retry" | "reconcile_delivered" | "reconcile_abandoned" | "reconcile_retry";
	outcome: string;
	reason: string | null;
	permalink: string | null;
	at: number;
}

export interface ReleaseDelivery {
	id: string;
	repo: string;
	sha: string;
	runId: string;
	sessionId: string;
	/** The channel it goes to. The provider's channel id is not exposed. */
	destination: { provider: ReleaseNoteProvider; name: string } | null;
	status: string;
	state: ReleaseDeliveryState;
	reason: string | null;
	permalink: string | null;
	createdAt: number;
	updatedAt: number;
	/** Which owner actions apply right now. */
	actions: { retry: boolean; reconcile: boolean };
	evidence: { workflowRuns: string[]; deployJob: string | null };
	links: { codingRun: string; permalink: string | null; workflowRuns: string[]; deployJob: string | null };
	attempts: ReleaseDeliveryAttempt[];
}

/** `GET /v1/instances/:id/release-notes/deliveries`. */
export interface ReleaseDeliveriesResponse {
	deliveries: ReleaseDelivery[];
	hasMore: boolean;
	nextCursor: string | null;
	retention: { days: number; horizon: string };
}

/** `POST …/deliveries/:id/retry` and `…/reconcile`. */
export interface ReleaseDeliveryActionResponse {
	delivery: ReleaseDelivery;
	/** True when the same idempotency key had already been applied; nothing changed this time. */
	replayed: boolean;
	/** Reconcile-retry only: the duplicate risk the owner accepted. */
	warning?: string;
}

/** `POST /v1/instances/:id/release-notes/test`. */
export interface ReleaseNoteTestResponse {
	sent: true;
	channel: ReleaseChannel;
	permalink?: string;
}

/**
 * Owner-safe projection of a blocked-operation permission request (#1009).
 *
 * The recovery row also holds owner ids and opaque continuation fingerprints.  Those fields are
 * deliberately not part of the console contract: the console needs the request's explanation
 * and current lifecycle state, not material that could be mistaken for a replay credential.
 */
export type InstancePermissionRequestStatus =
	| "pending"
	| "approved"
	| "claimed"
	| "denied"
	| "expired"
	| "revoked"
	| "cancelled"
	| "stale"
	| "resumed"
	| "failed"
	| "uncertain";

export interface InstancePermissionRequestView {
	id: string;
	/** Which owner control approval writes: `connector_consent` (a connector's write access) or `tool_enabled` (switch one declared tool back on). */
	control: string;
	connector: string | null;
	resourceId: string | null;
	requestedScope: string;
	currentScope: string | null;
	reason: string;
	operationKind: string;
	status: InstancePermissionRequestStatus;
	expiresAt: string;
}

/**
 * One row of `GET /v1/instances/:id/permission-requests` (#1009): the owner-safe view plus what an
 * assistant needs to hand the owner the exact control — the verified console link and, while the
 * request is still open, its structured blocker and remedy. No fingerprint, continuation or owner id.
 */
export interface InstancePermissionRequestListItem extends InstancePermissionRequestView {
	createdAt: string;
	link: string;
	/** Structurally `PermissionBlocker` (lib/connectors/types.ts) — restated so this file stays import-free for the console. */
	blocker: {
		requestId: string;
		controlLink: string;
		control: string;
		currentScope: string | null;
		requestedScope: string;
		reason: string;
		resource: string | null;
		operation: string;
		expiresAt: string;
		remedy: string;
	} | null;
}

/** `GET /v1/instances/:id/permission-requests/:requestId`. */
export interface InstancePermissionRequestResponse {
	request: InstancePermissionRequestView;
}

/** The status rendered after the owner chooses Allow, Ask, or Deny. */
export interface InstancePermissionRequestDecisionResponse {
	status: InstancePermissionRequestStatus;
}

/**
 * One stored replay screenshot (#1063), as `GET /v1/instances/:id/browser-artifacts` lists it. Metadata
 * only — a capture point, a query-free URL, its domain and an action class; the bytes are fetched by `id`
 * through the owner-checked route, and the R2 key never leaves the server.
 */
export interface BrowserArtifactView {
	id: string;
	subjectKind: "runtime_task" | "local_browser_run" | "local_apply_run";
	subjectId: string;
	seq: number;
	contentType: string;
	bytes: number;
	point: string;
	url: string | null;
	domain: string | null;
	action: string | null;
	createdAt: string;
}

/** `GET /v1/instances/:id/browser-artifacts?subject_kind=&subject_id=` (#1063). */
export interface BrowserArtifactListResponse {
	subjectKind: BrowserArtifactView["subjectKind"];
	subjectId: string;
	artifacts: BrowserArtifactView[];
	/** The run started with the owner's screenshot switch OFF (#1064): it has no frames by design. */
	screenshotsOff: boolean;
}

/**
 * `POST /v1/instances/:id/application-runs/:runId/reconciliation` — the owner's read-only "was it sent?"
 * check for one ended `submit_unconfirmed` attempt (#1013; started from the Console since #1068).
 * `runner` is what the owner's machine says about the check right now; a recorded result has none.
 */
export interface ApplicationReconciliationResponse {
	reconciliation: {
		id: string;
		runId: string;
		applicationId: string;
		state: "requested" | "no_submission_proven" | "submission_confirmed" | "ambiguous" | "unavailable" | "rejected";
		proofKind: string | null;
	};
	runner?: { state: "waiting_for_runtime" | "running" | "paused" | "ended"; pauseReason?: "login_required" | "captcha" };
}

/** `POST …/application-runs/:runId/reconciliation/handoff` — the bounded read-only sign-in/CAPTCHA handoff (#1013). */
export interface ApplicationReconciliationHandoffResponse {
	handoff: { id: string; runId: string; applicationId: string; state: "active" | "closed"; expiresAt: string; reason: string | null };
	/** The Console page for this exact handoff; absent when it could not be opened. */
	consoleLink?: string;
}

/**
 * Why a GitHub App installation could not be bound to an account (#1081) — reason codes and GitHub's
 * HTTP status, never a token, a URL or a response body. The meanings are documented beside
 * `membershipVerdict` in `lib/github-app.ts`.
 */
export type GithubInstallationCheckReason =
	| "not_linked"
	| "not_owner"
	| "not_member"
	| "membership_pending"
	| "oauth_app_restricted"
	| "app_cannot_read_members"
	| "access_refused"
	| "check_failed"
	| "mint_failed";

/** One installation's outcome in a link-time bind or a sync (#1081). Ids, logins and reason codes only. */
export interface GithubInstallationOutcome {
	account: string;
	type: string;
	installationId: number;
	result: "bound" | "already_bound" | "would_bind" | "not_bound" | "not_installed";
	reason?: GithubInstallationCheckReason;
	/** GitHub's HTTP status for the refused check, when there was one. */
	status?: number;
}

/** `POST /v1/github/installations/sync` (#1081) — and the MCP tool `sync_github_installations`. */
export interface GithubInstallationSyncResponse {
	/** The GitHub login the checks ran as: `users.linked_github_login`, else the sign-in login. */
	githubLogin: string | null;
	owner: string | null;
	dryRun: boolean;
	/** Installations this account is part of, or the one it named — never another tenant's. */
	orgs: GithubInstallationOutcome[];
	/** Other refusals, counted by reason and never named. */
	unnamed: Partial<Record<GithubInstallationCheckReason, number>>;
	/** The App's own token may not read org membership — true for every org at once. */
	appCannotReadMembers: boolean;
	/** Newly bound by this call. */
	bound: number;
	/** More unbound installations existed than one sync checks. */
	truncated: boolean;
	/** Re-link GitHub with your own token (the browser flow) when the App could not verify an org. */
	linkStart: string;
}

/**
 * `GET /v1/instances/:id/operator-manual` (#739, #1109, #1237). `manual` is the instance's own text;
 * `inherited` its agent template's, read live; `sections` names each layer (null when empty);
 * `combined` is both as one sectioned document; `rules` and `context` as before.
 */
export interface OperatorManualResponse {
	manual: string;
	inherited: string;
	sections: { inherited: string | null; instance: string | null };
	combined: string;
	rules: string;
	context: string;
}

/** `GET /v1/agents/:id/operator-manual` (#1237): the template's manual and how many instances inherit it. */
export interface AgentOperatorManualResponse {
	manual: string;
	instances: number;
}
