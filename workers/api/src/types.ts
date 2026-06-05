export interface Env {
  DB: D1Database;
  AI: Ai;
  STORAGE: R2Bucket;
  AGENT: DurableObjectNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SIGNING_KEY: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

export interface SessionPayload {
  uid: string;
  roles: string[];  // 'user', 'creator', 'admin'
  iat: number;
  exp: number;
}
