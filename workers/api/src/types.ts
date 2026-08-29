export interface Env {
	DB: D1Database;
	STORAGE: R2Bucket;
	AGENT: DurableObjectNamespace;
	AI: Ai;
	VECTORIZE: VectorizeIndex;
	/**
	 * The deployed git SHA for this Worker build (#735), injected by CI at deploy time
	 * (`wrangler deploy --var API_BUILD:<sha>`). Used to stamp server-side `error_log` rows
	 * so an investigator can tell whether a row predates a fix without cross-referencing
	 * `git log`. `"dev"` when running locally (the wrangler.toml default). Read once per
	 * isolate by `setServerBuild(env.API_BUILD)` in `index.ts`.
	 */
	API_BUILD?: string;
	/**
	 * Master switch for platform-paid internal AI (knowledge embeddings + conversation
	 * summary, billed to the platform's Workers AI). "true" = allowed for all users;
	 * anything else (default) = BYOK-only, the platform never spends tokens.
	 * LLM chat is always BYOK regardless of this flag.
	 */
	PLATFORM_AI_ENABLED?: string;
	/** Experimental (#103): when "1"/"true", the browser connector's registry tools
	 *  (browser_navigate / browser_snapshot / browser_act) are live. Unset = inert
	 *  (fail-closed) — first-party/self-use only until the browser trust model (#75). */
	BROWSER_TOOLS_ENABLED?: string;
	/** Custom (agent-published) console surfaces, #186: when "1"/"true" a creator may declare
	 *  `capabilities.customSurfaces` and the console will load those bundles. Unset = inert
	 *  (fail-closed). OFF in production — a surface bundle is code in the console origin with
	 *  the viewer's session, the platform serves no bundles, and the isolation model (sandboxed
	 *  iframe) is unbuilt. See lib/agent-capabilities.ts `customSurfacesEnabled`. */
	CUSTOM_SURFACES_ENABLED?: string;
	/** Remote LLM brain that drives the runner through a job application. */
	JOB_APPLY: Workflow;
	/** Remote LLM brain that drives a local coding CLI toward an objective (AgentCoder port). */
	CODING_SESSION: Workflow;
	/** Durable runner for declarative data pipelines (issue #97) — walks a pipeline's steps. */
	PIPELINE_RUN: Workflow;
	/** Generic browser brain (#69/#71): drives the runner toward an objective on any site. */
	BROWSER_TASK: Workflow;
	/** Durable, agent-generic autonomous loop (#158). */
	AGENT_LOOP: Workflow;
	/** WebSocket relay DO — one per instance, bridges cloud→runner without tunnels. */
	RELAY: DurableObjectNamespace;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	GITHUB_ORG?: string;
	GITHUB_TOKEN?: string;
	/** GitHub App (repo access for the coding workspace) — distinct from the OAuth client above. */
	GITHUB_APP_ID?: string;
	GITHUB_APP_PRIVATE_KEY?: string;
	GITHUB_APP_SLUG?: string;
	SESSION_SIGNING_KEY: string;
	KEY_ENCRYPTION_KEY?: string;
	STRIPE_SECRET_KEY?: string;
	STRIPE_WEBHOOK_SECRET?: string;
	/** price_… id of the $5/mo Pro subscription (non-secret, wrangler [vars]). */
	STRIPE_PRICE_ID?: string;
	/** "1"/"true" = require Pro for signed-in platform APIs. Unset = soft launch:
	 *  billing works but no platform gate blocks anything. */
	PAYWALL_ENFORCE?: string;
	/** "1"/"true" = the account daily circuit breakers (charged $ + tokens) block over-ceiling
	 *  runs. Unset (default) = observe-only: usage is metered but never stopped — see #485. Turn on
	 *  at paid launch, when subscription-pool token spend becomes real platform cost. */
	BUDGET_ENFORCE?: string;
	/**
	 * This deployment's OWN MCP server endpoint, e.g. `https://mcp.proagentstore.online/mcp` (#287).
	 * Drives the first-party MCP preset in the console (lib/mcp-presets.ts) — resolved from
	 * deployment config, never hardcoded in the connector, so local/staging/production each point
	 * at their own server and an unset var means simply "no preset offered" rather than production
	 * leaking into a developer's build.
	 */
	MCP_SELF_URL?: string;
	/** Google OAuth client used for the Gmail email-access connection. */
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	/** Zoho OAuth client used for the WorkDrive read-only connector. */
	ZOHO_CLIENT_ID?: string;
	ZOHO_CLIENT_SECRET?: string;
	/** Optional Zoho DC overrides, e.g. https://accounts.zoho.com.au and https://www.zohoapis.com.au/workdrive. */
	ZOHO_ACCOUNTS_BASE?: string;
	ZOHO_WORKDRIVE_API_BASE?: string;
	ZOHO_WORKDRIVE_DOWNLOAD_BASE?: string;
	/** Web Push (VAPID). Public key is non-secret; private key is a secret. */
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	VAPID_SUBJECT?: string;
	/**
	 * Admin/operator portal (issue #28).
	 * ADMIN_ALLOWLIST: comma-separated session uids granted admin as a break-glass
	 * fallback, checked in requireAdmin in addition to users.roles.
	 * CF_ACCESS_*: the /v1/admin/* Cloudflare Access perimeter (defense-in-depth, #108).
	 * Setting TEAM_DOMAIN + AUD turns the gate on in AUDIT mode — it verifies the edge's
	 * `Cf-Access-Jwt-Assertion` and logs what it found (source `cf-access`) but allows the
	 * request. CF_ACCESS_ENFORCE ("1"/"true"/"yes"/"on") is what makes a missing or invalid
	 * token a 403. Enforcing before the audit log is silent locks the operator out of the
	 * portal, so the two steps are deliberately separate secrets. Inert until configured.
	 */
	ADMIN_ALLOWLIST?: string;
	CF_ACCESS_TEAM_DOMAIN?: string;
	CF_ACCESS_AUD?: string;
	CF_ACCESS_ENFORCE?: string;
	/**
	 * Meta connector (WhatsApp Business Cloud + Instagram Messaging). Platform-level
	 * business credentials; inert until set (after Meta app + business setup + review).
	 * META_ACCESS_TOKEN: system-user / long-lived token. WHATSAPP_PHONE_NUMBER_ID: the
	 * WABA phone-number id. META_IG_ID: the connected Instagram business account id.
	 */
	META_ACCESS_TOKEN?: string;
	WHATSAPP_PHONE_NUMBER_ID?: string;
	META_IG_ID?: string;
	/** MCP worker's audit KV (read-only from the API worker) — powers the admin MCP-audit
	 *  page. Same namespace the MCP worker writes to; optional so it's inert if unbound. */
	OAUTH_KV?: KVNamespace;
	/** Web-search connector (issue #99): the Google Custom Search engine id (cx). NOT a
	 *  secret — it identifies the search engine, not the account (non-secret wrangler [vars]).
	 *  The API KEY is vault-stored (user_api_keys, provider "web-search"), never here.
	 *  A per-call `cx` tool input overrides this default. */
	WEB_SEARCH_CX?: string;
	/**
	 * Deploy-time fallback for the account-wide daily charged-spend circuit breaker
	 * (issue #474, migration 0113). Slots in at tier 3 — below per-account and
	 * platform-default D1 overrides, above the hard constant ($50 = 50_000_000).
	 * Value in USD micros (1_000_000 = $1). Unset = hard constant governs.
	 */
	ACCOUNT_DAILY_CHARGED_MICROS_CEILING?: string;
	/**
	 * Deploy-time fallback for the account-wide daily token circuit breaker (issue #474,
	 * migration 0113). Slots in at tier 3 — below per-account and platform-default D1
	 * overrides, above the hard constant (250_000_000). Unset = hard constant governs.
	 */
	ACCOUNT_DAILY_TOKEN_CEILING?: string;
}

export interface SessionPayload {
	uid: string;
	roles: string[]; // 'user', 'creator', 'admin'
	iat: number;
	exp: number;
}
