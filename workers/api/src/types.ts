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
	/** Remote LLM brain that drives the runner through a job application. */
	JOB_APPLY: Workflow;
	/** Remote LLM brain that drives a local coding CLI toward an objective (AgentCoder port). */
	CODING_SESSION: Workflow;
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
}

export interface SessionPayload {
	uid: string;
	roles: string[]; // 'user', 'creator', 'admin'
	iat: number;
	exp: number;
}
