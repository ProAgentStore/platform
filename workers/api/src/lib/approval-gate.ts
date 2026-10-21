// Per-account approval gate (#1268): which configuration changes wait for the owner's approval from their phone.
//
// This module is the DECISION half and is deliberately free of Hono: a registry that maps a mutating request (method +
// path + body) to a named action, the account's stored gate settings, the redacted diff the owner reads, and the
// before-state fingerprint that lets an approval refuse a target that moved. The enforcement point is
// `approval-gate-middleware.ts`; the store and the apply step are `account-change-requests.ts`.
//
// ── Why a registry of ROUTES and not a flag in each handler
//
// A change is gated at the server-side request layer so the console, REST and every MCP tool (which are all REST
// calls) share one decision. A per-handler `if (gate)` is the thing the next route forgets; a table the tests walk is
// not. `approval-gate.test.ts` fails if a registered route does not match a real handler.
import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";
import { stableStringify } from "./stable-json.js";
import { approvalFingerprint, buildApprovalCard } from "./tool-approval.js";

export const MIN_EXPIRY_SECONDS = 60;
export const MAX_EXPIRY_SECONDS = 7 * 86_400;
export const DEFAULT_EXPIRY_SECONDS = 86_400;
/** A held request keeps its body so it can be replayed once; bigger than this is refused rather than half-held. */
export const MAX_HELD_BODY_BYTES = 128 * 1024;

/** The pseudo-action for changes to the gate itself. Always gated while enabled, whatever the checklist says. */
export const GATE_CHANGE_ACTION = "gate_change";

export interface GateContext {
	env: Env;
	userId: string;
	params: Record<string, string>;
	body: Record<string, unknown>;
}

interface GateRoute {
	method: "POST" | "PUT" | "DELETE" | "PATCH";
	/** `/v1/instances/:id/coding/repos` — `:name` captures one segment. */
	pattern: string;
	/** Narrows a route to the bodies that are the gated change (`PUT /state` is only gated when it sets `model`). */
	when?: (body: Record<string, unknown>) => boolean;
}

export interface GatedAction {
	id: string;
	label: string;
	description: string;
	/** On when the owner first enables the gate. */
	defaultOn: boolean;
	routes: GateRoute[];
	target(params: Record<string, string>, body: Record<string, unknown>): string;
	/** The part of the target's current state this change depends on. Re-read at approval: a different answer = drift. */
	snapshot(gc: GateContext): Promise<unknown>;
}

// ── Before-state readers ─────────────────────────────────────────────────────

async function instanceConfig(gc: GateContext, id: string | undefined, keys: readonly string[]): Promise<unknown> {
	if (!id) return { missing: true };
	const row = await gc.env.DB.prepare("SELECT status, config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(id, gc.userId).first<{ status: string | null; config: string | null }>();
	if (!row) return { missing: true };
	let cfg: Record<string, unknown> = {};
	try {
		cfg = row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
	} catch {
		cfg = {};
	}
	return { status: row.status ?? null, config: Object.fromEntries(keys.map((k) => [k, cfg[k] ?? null])) };
}

const instanceStatus = (gc: GateContext, id = gc.params.id ?? gc.params.instanceId) => instanceConfig(gc, id, []);

async function agentExists(gc: GateContext, id: string | undefined): Promise<unknown> {
	if (!id) return { note: "new" };
	const row = await gc.env.DB.prepare("SELECT owner_id FROM agents WHERE id = ?1").bind(id).first<{ owner_id: string }>();
	return row ? { exists: true, owned: row.owner_id === gc.userId } : { missing: true };
}

async function consentRows(gc: GateContext): Promise<unknown> {
	const id = gc.params.id;
	const connector = await gc.env.DB.prepare("SELECT connector, scope, mode FROM instance_connector_consent WHERE instance_id = ?1 AND user_id = ?2 ORDER BY connector, scope").bind(id, gc.userId).all();
	const mcp = await gc.env.DB.prepare("SELECT * FROM instance_mcp_consent WHERE instance_id = ?1 ORDER BY rowid").bind(id).all().catch(() => ({ results: [] }));
	return { connector: connector.results ?? [], mcp: mcp.results ?? [] };
}

const bodyKeys = (...keys: string[]) => (body: Record<string, unknown>) => keys.some((k) => body[k] !== undefined);

// ── The registry ─────────────────────────────────────────────────────────────

export const GATED_ACTIONS: readonly GatedAction[] = [
	{
		id: "coder_create",
		label: "Create a coder or agent type",
		description: "A new agent type, or a clone of one.",
		defaultOn: true,
		routes: [
			{ method: "POST", pattern: "/v1/agents" },
			{ method: "POST", pattern: "/v1/agents/:id/clone" },
		],
		target: (p, b) => (p.id ? `Clone agent ${p.id}` : `New agent ${typeof b.name === "string" ? `“${b.name}”` : ""}`.trim()),
		snapshot: (gc) => agentExists(gc, gc.params.id),
	},
	{
		id: "instance_create",
		label: "Create a coder instance",
		description: "Subscribing to an agent creates a running instance under your account.",
		defaultOn: true,
		routes: [{ method: "POST", pattern: "/v1/instances/:agentId/subscribe" }],
		target: (p) => `Subscribe to agent ${p.agentId}`,
		snapshot: (gc) => agentExists(gc, gc.params.agentId),
	},
	{
		id: "repo_add",
		label: "Add a repo to a coder instance",
		description: "Gives the coder access to another repository.",
		defaultOn: true,
		routes: [{ method: "POST", pattern: "/v1/instances/:id/coding/repos" }],
		target: (p, b) => `Add ${typeof b.repo === "string" ? b.repo : typeof b.path === "string" ? b.path : "a repo"} to instance ${p.id}`,
		snapshot: (gc) => instanceStatus(gc),
	},
	{
		id: "runner_repin",
		label: "Repin an instance's runner machine",
		description: "Moves where an instance runs, including repo retargeting.",
		defaultOn: false,
		routes: [
			{ method: "PUT", pattern: "/v1/instances/:id/runner-node" },
			{ method: "POST", pattern: "/v1/instances/:id/coding/repos/:repoId/retarget" },
		],
		target: (p, b) => `Instance ${p.id} → ${typeof b.runnerNode === "string" && b.runnerNode ? b.runnerNode : "(unpin)"}`,
		snapshot: (gc) => instanceConfig(gc, gc.params.id, ["runnerNode", "runnerMachineId"]),
	},
	{
		id: "engine_model",
		label: "Change an instance's engine or model",
		description: "The coding engine presets and default, the engine choice, or the model.",
		defaultOn: false,
		routes: [
			{ method: "PUT", pattern: "/v1/instances/:id/coding/engines" },
			{ method: "PUT", pattern: "/v1/instances/:id/coding/engine-choice" },
			{ method: "PUT", pattern: "/v1/instances/:id/state", when: bodyKeys("model") },
		],
		target: (p) => `Engine/model of instance ${p.id}`,
		snapshot: (gc) => instanceConfig(gc, gc.params.id, ["codingEngines", "defaultEngineId", "apiCodingOptIns", "model"]),
	},
	{
		id: "connector_pin",
		label: "Change a connector account pin",
		description: "Which connected account an instance uses for Gmail, MCP servers or worker mail.",
		defaultOn: false,
		routes: [
			{ method: "PUT", pattern: "/v1/instances/:id/connector-accounts" },
			{ method: "PUT", pattern: "/v1/instances/:id/mcp/accounts" },
			{ method: "PUT", pattern: "/v1/instances/:id/email-worker/account" },
			{ method: "PUT", pattern: "/v1/instances/:id/gmail/identity" },
		],
		target: (p) => `Connector account pin of instance ${p.id}`,
		snapshot: (gc) => instanceConfig(gc, gc.params.id, ["connectorAccounts", "mcpAccounts", "emailWorkerAccount", "gmailIdentity"]),
	},
	{
		id: "grants_consent",
		label: "Change connector grants or write consent",
		description: "Write consent for a connector or MCP server, and channel/folder grants.",
		defaultOn: false,
		routes: [
			{ method: "PUT", pattern: "/v1/instances/:id/connectors/:connector/consent" },
			{ method: "PUT", pattern: "/v1/instances/:id/mcp/consent" },
			{ method: "POST", pattern: "/v1/discord/instances/:id/grants" },
			{ method: "POST", pattern: "/v1/slack/instances/:id/grants" },
			{ method: "POST", pattern: "/v1/drive/instances/:id/grants" },
			{ method: "POST", pattern: "/v1/workdrive/instances/:id/grants" },
			{ method: "DELETE", pattern: "/v1/discord/instances/:id/grants/:grantId" },
			{ method: "DELETE", pattern: "/v1/slack/instances/:id/grants/:grantId" },
			{ method: "DELETE", pattern: "/v1/drive/instances/:id/grants/:grantId" },
			{ method: "DELETE", pattern: "/v1/workdrive/instances/:id/grants/:grantId" },
		],
		target: (p) => `Grants/consent of instance ${p.id}${p.connector ? ` (${p.connector})` : ""}`,
		snapshot: async (gc) => ({ consent: await consentRows(gc), instance: await instanceStatus(gc) }),
	},
	{
		id: "instance_cancel_delete",
		label: "Cancel or delete an instance or agent",
		description: "Cancelling an instance, removing its runtime, or deleting an agent type.",
		defaultOn: false,
		routes: [
			{ method: "POST", pattern: "/v1/instances/:id/cancel" },
			{ method: "DELETE", pattern: "/v1/instances/:id/runtime" },
			{ method: "DELETE", pattern: "/v1/agents/:id" },
		],
		target: (p) => `Cancel/delete ${p.id}`,
		snapshot: async (gc) => ({ instance: await instanceStatus(gc), agent: await agentExists(gc, gc.params.id) }),
	},
	{
		id: "tool_allowlist",
		label: "Change an agent's tool allowlist",
		description: "An agent type's capabilities, or a tool switched on or off for an instance.",
		defaultOn: false,
		routes: [
			{ method: "PUT", pattern: "/v1/agents/:id/capabilities" },
			{ method: "PUT", pattern: "/v1/instances/:id/tools/:name" },
		],
		target: (p) => `Tools of ${p.name ? `instance ${p.id}: ${p.name}` : `agent ${p.id}`}`,
		snapshot: async (gc) => ({ instance: await instanceConfig(gc, gc.params.id, ["disabledTools"]), agent: await agentExists(gc, gc.params.id) }),
	},
];

/** The gate's own settings change: held (while enabled) only when it weakens the gate. */
export const GATE_ACTION: GatedAction = {
	id: GATE_CHANGE_ACTION,
	label: "Weaken the approval gate",
	description: "Turning the gate off or removing gated actions.",
	defaultOn: true,
	routes: [{ method: "PUT", pattern: "/v1/approval-gate" }],
	target: () => "Approval gate settings",
	snapshot: async (gc) => loadGate(gc.env, gc.userId),
};

export const ACTION_IDS: readonly string[] = GATED_ACTIONS.map((a) => a.id);
export const DEFAULT_ACTIONS: readonly string[] = GATED_ACTIONS.filter((a) => a.defaultOn).map((a) => a.id);
export const actionById = (id: string): GatedAction | undefined => (id === GATE_CHANGE_ACTION ? GATE_ACTION : GATED_ACTIONS.find((a) => a.id === id));

// ── Route matching ───────────────────────────────────────────────────────────

export function matchPattern(pattern: string, path: string): Record<string, string> | null {
	const want = pattern.split("/");
	const got = path.replace(/\/+$/, "").split("/");
	if (want.length !== got.length) return null;
	const params: Record<string, string> = {};
	for (let i = 0; i < want.length; i++) {
		if (want[i].startsWith(":")) {
			if (!got[i]) return null;
			try {
				params[want[i].slice(1)] = decodeURIComponent(got[i]);
			} catch {
				return null;
			}
		} else if (want[i] !== got[i]) return null;
	}
	return params;
}

export interface RouteMatch {
	action: GatedAction;
	params: Record<string, string>;
}

/** The registered action a request is, before its body is considered. Pure. */
export function matchRoute(method: string, path: string, body: Record<string, unknown> = {}): RouteMatch | null {
	const m = method.toUpperCase();
	for (const action of [...GATED_ACTIONS, GATE_ACTION]) {
		for (const route of action.routes) {
			if (route.method !== m) continue;
			const params = matchPattern(route.pattern, path);
			if (params && (!route.when || route.when(body))) return { action, params };
		}
	}
	return null;
}

/** Could this method + path be a gated route for SOME body? Lets the middleware skip reading a body it will not use. */
export function mayBeGated(method: string, path: string): boolean {
	const m = method.toUpperCase();
	return [...GATED_ACTIONS, GATE_ACTION].some((a) => a.routes.some((r) => r.method === m && matchPattern(r.pattern, path)));
}

// ── Settings ─────────────────────────────────────────────────────────────────

export interface GateSettings {
	enabled: boolean;
	actions: string[];
	expirySeconds: number;
}

export const GATE_OFF: GateSettings = { enabled: false, actions: [], expirySeconds: DEFAULT_EXPIRY_SECONDS };

export async function loadGate(env: Env, userId: string): Promise<GateSettings> {
	const row = await env.DB.prepare("SELECT enabled, actions, expiry_seconds FROM account_approval_gate WHERE user_id = ?1").bind(userId).first<{ enabled: number; actions: string; expiry_seconds: number }>();
	if (!row) return { ...GATE_OFF };
	let actions: string[] = [];
	try {
		const parsed = JSON.parse(row.actions) as unknown;
		if (Array.isArray(parsed)) actions = parsed.filter((a): a is string => typeof a === "string" && ACTION_IDS.includes(a));
	} catch {
		actions = [];
	}
	return { enabled: row.enabled === 1, actions, expirySeconds: row.expiry_seconds };
}

export async function saveGate(env: Env, userId: string, s: GateSettings, now = Date.now()): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO account_approval_gate (user_id, enabled, actions, expiry_seconds, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
		 ON CONFLICT(user_id) DO UPDATE SET enabled = ?2, actions = ?3, expiry_seconds = ?4, updated_at = ?5`,
	).bind(userId, s.enabled ? 1 : 0, JSON.stringify(s.actions), s.expirySeconds, now).run();
}

/** Validate a settings body against the current settings. Absent fields keep their value. */
export function parseGateUpdate(body: Record<string, unknown>, current: GateSettings): { ok: true; next: GateSettings } | { ok: false; error: string } {
	const unknown = Object.keys(body).filter((k) => !["enabled", "actions", "expirySeconds"].includes(k));
	if (unknown.length) return { ok: false, error: `Unknown field: ${unknown[0]}.` };
	let enabled = current.enabled;
	if (body.enabled !== undefined) {
		if (typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be true or false." };
		enabled = body.enabled;
	}
	let actions = current.actions;
	if (body.actions !== undefined) {
		if (!Array.isArray(body.actions) || body.actions.some((a) => typeof a !== "string")) return { ok: false, error: "actions must be a list of action ids." };
		const bad = (body.actions as string[]).find((a) => !ACTION_IDS.includes(a));
		if (bad) return { ok: false, error: `Unknown action "${bad}". Known: ${ACTION_IDS.join(", ")}.` };
		actions = [...new Set(body.actions as string[])];
	}
	let expirySeconds = current.expirySeconds;
	if (body.expirySeconds !== undefined) {
		const n = body.expirySeconds;
		if (typeof n !== "number" || !Number.isInteger(n) || n < MIN_EXPIRY_SECONDS || n > MAX_EXPIRY_SECONDS) {
			return { ok: false, error: `expirySeconds must be a whole number from ${MIN_EXPIRY_SECONDS} to ${MAX_EXPIRY_SECONDS}.` };
		}
		expirySeconds = n;
	}
	// Turning the gate on with an empty checklist would gate nothing and look protected: start from the defaults.
	if (enabled && actions.length === 0 && body.actions === undefined) actions = [...DEFAULT_ACTIONS];
	if (enabled && actions.length === 0) return { ok: false, error: "Choose at least one action to gate, or turn the gate off." };
	return { ok: true, next: { enabled, actions, expirySeconds } };
}

/** Does moving from `current` to `next` make the gate easier to get around? Disabling, or dropping an action. */
export function weakensGate(current: GateSettings, next: GateSettings): boolean {
	if (!current.enabled) return false;
	if (!next.enabled) return true;
	return current.actions.some((a) => !next.actions.includes(a));
}

// ── The decision ─────────────────────────────────────────────────────────────

export type GateDecision =
	| { gated: false }
	| { gated: true; action: GatedAction; params: Record<string, string>; settings: GateSettings };

/**
 * Is this request held for approval? Not when the gate is off (behaviour is then unchanged, byte for byte), not for an
 * action the owner left unticked, and — for the gate's own settings — only when the change weakens it.
 */
export async function decide(env: Env, input: { method: string; path: string; body: Record<string, unknown>; userId: string }): Promise<GateDecision> {
	const match = matchRoute(input.method, input.path, input.body);
	if (!match) return { gated: false };
	const settings = await loadGate(env, input.userId);
	if (!settings.enabled) return { gated: false };
	if (match.action.id === GATE_CHANGE_ACTION) {
		const parsed = parseGateUpdate(input.body, settings);
		// An invalid body is the handler's 400 to give; only a valid weakening is held.
		return parsed.ok && weakensGate(settings, parsed.next) ? { gated: true, action: match.action, params: match.params, settings } : { gated: false };
	}
	return settings.actions.includes(match.action.id) ? { gated: true, action: match.action, params: match.params, settings } : { gated: false };
}

// ── What the owner reads ─────────────────────────────────────────────────────

const SECRET_KEY = /token|secret|password|passwd|credential|api[_-]?key|authorization|cookie|private/i;

/** The body with anything secret-looking masked, so a preview — and the push — never carries a credential. */
export function redactForPreview(value: unknown, depth = 0): unknown {
	if (value === null || typeof value !== "object") return typeof value === "string" ? clipMarked(value, 400) : value;
	if (depth > 4) return "[nested]";
	if (Array.isArray(value)) return value.filter((_, i) => i < 20).map((v) => redactForPreview(v, depth + 1));
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[hidden]" : redactForPreview(v, depth + 1)]));
}

export interface DiffPreview {
	action: string;
	label: string;
	method: string;
	path: string;
	target: string;
	before: unknown;
	change: unknown;
	/** Plain text for the card and the push — the arguments in the order given, long values marked when cut. */
	summary: string;
}

export function buildDiffPreview(action: GatedAction, input: { method: string; path: string; params: Record<string, string>; body: Record<string, unknown>; before: unknown }): DiffPreview {
	const change = redactForPreview(input.body) as Record<string, unknown>;
	const card = buildApprovalCard({ toolName: action.id, connectorLabel: "your account", schema: null, args: change && typeof change === "object" ? change : {} });
	return {
		action: action.id,
		label: action.label,
		method: input.method.toUpperCase(),
		path: input.path,
		target: action.target(input.params, input.body),
		before: redactForPreview(input.before),
		change,
		summary: card.description,
	};
}

/** The identity of one exact requested change — the same request twice is one pending approval. */
export const requestFingerprintInput = (method: string, path: string, body: Record<string, unknown>): string => approvalFingerprint(`${method.toUpperCase()} ${path}`, body);

export async function sha256Hex(text: string): Promise<string> {
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function beforeFingerprint(action: GatedAction, gc: GateContext): Promise<{ fingerprint: string; before: unknown }> {
	const before = await action.snapshot(gc);
	return { fingerprint: await sha256Hex(stableStringify(before)), before };
}
