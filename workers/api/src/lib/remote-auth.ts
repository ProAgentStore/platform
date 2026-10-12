/**
 * PAS remote MCP sign-in requests, the PAGS side (#1005) — the PURE half: what a relay may contain, which
 * state reports are allowed, and what the owner's page shows.
 *
 * Design A (#1006, owner decision): the PAS companion client on the owner's machine creates the request at
 * PAS (broker v2, PAS #355) and relays its public details through the `pags` CLI. PAGS never holds a PAS
 * credential and never calls PAS. So everything here is a check on what the MACHINE reported:
 *
 * - The resource must be the PAS MCP endpoint (`/mcp` or `/mcp/apps/:appId` on the PAS MCP origin), the
 *   scopes `[]` (PAS has no scope taxonomy; its broker refuses anything else), the approval URL an https
 *   page on a PAS origin with no credential-shaped parameter — never a token, code, verifier or callback.
 * - A state report moves forward only: a terminal state is final, `connected` follows an approval (PAS
 *   reports connected only after a real authenticated MCP read), and an unknown state is refused.
 * - A request past its expiry reads `expired` whatever was last reported, so a dead link never shows
 *   "Sign in".
 */

export const REMOTE_AUTH_STATES = ["pending", "approving", "approved_awaiting_machine", "consumed", "connected", "denied", "expired", "cancelled", "failed"] as const;
export type RemoteAuthState = (typeof REMOTE_AUTH_STATES)[number];
const TERMINAL: ReadonlySet<RemoteAuthState> = new Set(["connected", "denied", "expired", "cancelled", "failed"]);
export const isTerminal = (s: RemoteAuthState) => TERMINAL.has(s);

/** Where each state may move. `connected` only after the machine redeemed an approval. */
const NEXT: Record<RemoteAuthState, readonly RemoteAuthState[]> = {
	pending: ["approving", "approved_awaiting_machine", "denied", "expired", "cancelled", "failed"],
	approving: ["approved_awaiting_machine", "denied", "expired", "cancelled", "failed"],
	approved_awaiting_machine: ["consumed", "connected", "expired", "cancelled", "failed"],
	consumed: ["connected", "failed", "expired"],
	connected: [],
	denied: [],
	expired: [],
	cancelled: [],
	failed: [],
};

export interface RemoteAuthRequestView {
	id: string;
	pasRequestId: string;
	agent: { id: string; label: string };
	machine: { id: string; label: string };
	/** The PAGS machine that relayed it — the `pags` CLI's own identity, not a label the PAS client chose. */
	relayedBy: { node: string | null; machineId: string | null };
	service: "ProAppStore MCP";
	resource: string;
	scopes: string[];
	approvalUrl: string;
	/** As stored from the machine's reports — `effectiveState` is what the page shows. */
	state: RemoteAuthState;
	effectiveState: RemoteAuthState;
	expiresAt: string;
	lastReportedAt: string;
	createdAt: string;
	history: Array<{ at: number; state: RemoteAuthState }>;
}

/** `GET /v1/remote-auth/requests/:id`. */
export interface RemoteAuthRequestResponse {
	request: RemoteAuthRequestView;
}

/** PAS origins, as configuration (no request is ever made to them — they are only checked and linked). */
export interface RemoteAuthOrigins {
	/** Origins an approval page may be on. */
	approval: readonly string[];
	/** The PAS MCP origin a resource must name. */
	mcp: string;
}
export const DEFAULT_ORIGINS: RemoteAuthOrigins = {
	approval: ["https://api.proappstore.online", "https://proappstore.online"],
	mcp: "https://mcp.proappstore.online",
};
export function originsFrom(env: { REMOTE_AUTH_APPROVAL_ORIGINS?: string; REMOTE_AUTH_MCP_ORIGIN?: string }): RemoteAuthOrigins {
	const approval = (env.REMOTE_AUTH_APPROVAL_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
	return { approval: approval.length ? approval : DEFAULT_ORIGINS.approval, mcp: env.REMOTE_AUTH_MCP_ORIGIN?.trim() || DEFAULT_ORIGINS.mcp };
}

export interface RemoteAuthRelay {
	pasRequestId: string;
	agent: { id: string; label: string };
	machine: { id: string; label: string };
	resource: string;
	scopes: string[];
	approvalUrl: string;
	expiresAt: number;
}

const PAS_REQUEST_ID = /^req_[A-Za-z0-9_-]{16,128}$/;
const ID = /^[A-Za-z0-9._:@-]{1,128}$/;
/** Query parameters that only ever carry a credential or an OAuth leg. An approval page needs none. */
const SECRET_PARAM = /^(?:code|token|access_token|id_token|refresh_token|code_verifier|machine_proof|session|secret|password|jwt|auth)$/i;
/** How far ahead an expiry may be: the broker's own requests live minutes, not days. */
export const MAX_LIFETIME_MS = 60 * 60_000;

const label = (v: unknown) => (typeof v === "string" && v.trim() && v.length <= 120 && !/\p{Cc}|[<>]/u.test(v) ? v.trim() : null);

/** Validate a relay from the machine. A refusal names the field, never echoes a value. */
export function parseRelay(raw: unknown, origins: RemoteAuthOrigins, now = Date.now()): { ok: true; relay: RemoteAuthRelay } | { ok: false; error: string } {
	const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const agent = (b.agent && typeof b.agent === "object" ? b.agent : {}) as Record<string, unknown>;
	const machine = (b.machine && typeof b.machine === "object" ? b.machine : {}) as Record<string, unknown>;
	const pasRequestId = typeof b.request_id === "string" ? b.request_id : "";
	if (!PAS_REQUEST_ID.test(pasRequestId)) return { ok: false, error: "request_id must be the PAS broker's req_… id." };
	if (typeof agent.id !== "string" || !ID.test(agent.id) || !label(agent.label)) return { ok: false, error: "agent must be {id, label}." };
	if (typeof machine.id !== "string" || !ID.test(machine.id) || !label(machine.label)) return { ok: false, error: "machine must be {id, label}." };
	const resource = typeof b.resource === "string" ? b.resource : "";
	if (!isPasMcpResource(resource, origins.mcp)) return { ok: false, error: `resource must be ${origins.mcp}/mcp or ${origins.mcp}/mcp/apps/:appId.` };
	if (!Array.isArray(b.scopes) || b.scopes.length !== 0) return { ok: false, error: "scopes must be [] — PAS grants no other scope." };
	const approvalUrl = typeof b.approval_url === "string" ? b.approval_url : "";
	const why = approvalUrlProblem(approvalUrl, origins.approval);
	if (why) return { ok: false, error: why };
	const expiresAt = typeof b.expires_at === "number" ? b.expires_at : typeof b.expires_at === "string" ? Date.parse(b.expires_at) : Number.NaN;
	if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + MAX_LIFETIME_MS) return { ok: false, error: "expires_at must be in the next hour." };
	return { ok: true, relay: { pasRequestId, agent: { id: agent.id, label: label(agent.label) as string }, machine: { id: machine.id, label: label(machine.label) as string }, resource, scopes: [], approvalUrl, expiresAt } };
}

export function isPasMcpResource(resource: string, mcpOrigin: string): boolean {
	let u: URL;
	try {
		u = new URL(resource);
	} catch {
		return false;
	}
	return u.origin === mcpOrigin && !u.search && !u.hash && !u.username && !u.password && (u.pathname === "/mcp" || /^\/mcp\/apps\/[A-Za-z0-9_-]{1,64}$/.test(u.pathname)) && resource === `${u.origin}${u.pathname}`;
}

/** Why an approval URL is not a PAS approval page PAGS may link to, or null. */
export function approvalUrlProblem(raw: string, allowed: readonly string[]): string | null {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return "approval_url must be a URL.";
	}
	if (u.protocol !== "https:" || !allowed.includes(u.origin)) return "approval_url must be an https page on a PAS origin.";
	if (u.username || u.password || u.hash) return "approval_url must carry no credentials or fragment.";
	if ([...u.searchParams.keys()].some((k) => SECRET_PARAM.test(k))) return "approval_url must not carry a token, code or other credential parameter.";
	if (raw.length > 2048) return "approval_url is too long.";
	return null;
}

/** May a stored request move to `next`? Same state again is an idempotent repeat. */
export function transitionAllowed(from: RemoteAuthState, next: RemoteAuthState): "move" | "same" | "refused" {
	if (from === next) return "same";
	return NEXT[from].includes(next) ? "move" : "refused";
}

/** The state the owner sees: a non-terminal request past its expiry is expired, whatever was last said. */
export function effectiveState(stored: RemoteAuthState, expiresAt: number, now = Date.now()): RemoteAuthState {
	return !isTerminal(stored) && now >= expiresAt ? "expired" : stored;
}

/** May the page offer "Sign in"? Only while PAS can still approve it. */
export const canSignIn = (state: RemoteAuthState) => state === "pending" || state === "approving";
