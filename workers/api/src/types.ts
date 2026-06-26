export interface Env {
	DB: D1Database;
	STORAGE: R2Bucket;
	AGENT: DurableObjectNamespace;
	AI: Ai;
	VECTORIZE: VectorizeIndex;
	/** Remote LLM brain that drives the runner through a job application. */
	JOB_APPLY: Workflow;
	/** Remote LLM brain that drives a local coding CLI toward an objective (AgentCoder port). */
	CODING_SESSION: Workflow;
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
	/** Google OAuth client used for the Gmail email-access connection. */
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
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
