export interface Env {
	DB: D1Database;
	STORAGE: R2Bucket;
	AGENT: DurableObjectNamespace;
	AI: Ai;
	VECTORIZE: VectorizeIndex;
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
	/** Remote LLM brain that drives the runner through a job application. */
	JOB_APPLY: Workflow;
	/** Remote LLM brain that drives a local coding CLI toward an objective (AgentCoder port). */
	CODING_SESSION: Workflow;
	/** Durable runner for declarative data pipelines (issue #97) — walks a pipeline's steps. */
	PIPELINE_RUN: Workflow;
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
	 * CF_ACCESS_*: when both set, the /v1/admin/* API + /admin UI require a valid
	 * Cloudflare Access token (defense-in-depth). Inert until configured.
	 */
	ADMIN_ALLOWLIST?: string;
	CF_ACCESS_TEAM_DOMAIN?: string;
	CF_ACCESS_AUD?: string;
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
}

export interface SessionPayload {
	uid: string;
	roles: string[]; // 'user', 'creator', 'admin'
	iat: number;
	exp: number;
}
