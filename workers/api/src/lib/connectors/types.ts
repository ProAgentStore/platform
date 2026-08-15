/**
 * The tool/connector CONTRACT — what a tool and a connector *are*, with nothing that
 * executes one (#293).
 *
 * Why this module exists. Three concerns had grown into two files:
 *
 *   contract  — the shapes (`ToolDef`, `Connector`, `RegistryToolCtx`, …)
 *   catalog   — WHICH connectors exist (`connectors/registry.ts`, still the single
 *               source of truth: one entry per connector, everything derives from it)
 *   runtime   — what DISPATCHES a tool call (`lib/tool-registry.ts`)
 *
 * Every connector module needs the contract and nothing else, but the contract lived
 * inside the runtime, so all thirteen of them imported `lib/tool-registry.js` — the
 * module that imports the catalog that imports *them*. Twenty import cycles, all of
 * them type-only and therefore invisible at runtime, but they made "does a connector
 * depend on tool execution?" unanswerable from the import graph, which is exactly the
 * question a reviewer (or a model) asks before adding a connector.
 *
 * So: this file is a LEAF. It imports only `Env` and `ConnectorGrant`, both as types,
 * neither of which reaches back here. Adding a value import to this module re-creates
 * the cycles it exists to remove; `import-graph.test.ts` fails if you do.
 *
 * The old homes re-export these names, so `import type { ToolDef } from
 * "../tool-registry.js"` still compiles — nothing had to be rewritten at once.
 */
import type { Env } from "../../types.js";
import type { ConnectorGrant } from "../connector-grants.js";
import type { ConversationTransfer } from "../conversation-transfer.js";

// ── The tool contract (was lib/tool-registry.ts) ─────────────────────────────

export interface RegistryToolCtx {
	env: Env;
	userId?: string;
	agentId?: string;
	instanceId?: string;
	/**
	 * The run this tool call belongs to (a pipeline run id). Carried so a step that emits an
	 * agent-to-agent event can stamp the emitting run onto the delivery — choreography is
	 * otherwise undebuggable, because nothing links the source run to the run it set off.
	 */
	traceId?: string;
	/**
	 * Audit ONLY: the instance that asked for this work, when a supervisor delegated it (#185).
	 * Never consulted for permission — consent and token-minting resolve against `instanceId`,
	 * the EXECUTOR. If this were ever read as an authority, supervision would become a consent
	 * bypass: wire a low-trust agent under a high-trust one and it inherits reach by
	 * configuration alone. See lib/execution-authority.ts.
	 */
	onBehalfOf?: string;
	/**
	 * The delegation budget this work draws against (#184), when a supervisor's run is driving.
	 * `delegate_goal` forwards it so a subordinate SHARES the tree's pool instead of opening a
	 * fresh one — without it the bound is per-edge, which is the fanout blowup it exists to stop.
	 */
	budgetId?: string;
	/**
	 * The agent's declared tool allowlist (`capabilities.tools`), when the CALLER resolved one
	 * (#381). `runRegistryTool` refuses a connector-provided tool that is not in it.
	 *
	 * Set by callers that have no other gate — today the pipeline runner, which builds its context
	 * by hand and whose steps are stored DATA. Absent means "not asserted", which is what every
	 * surface with its own gate wants: the chat runtime already hands the model only
	 * `toolNamesFor`, and the /tools invoker already consults `resolveToolPolicy`.
	 *
	 * It lives on the ctx rather than being looked up per call because the nested case is the one
	 * that matters: `enrich` re-dispatches a tool named in its INPUTS, and it forwards this ctx.
	 */
	declaredTools?: readonly string[];
	/**
	 * The pipeline STEP this dispatch happens under (#396) — the step's own `tool` name.
	 *
	 * Audit + phrasing only, never a permission. `geocode`, `fan_out` and `enrich` dispatch a
	 * registry tool from INSIDE their handler and forward this ctx, so when the declared-tools gate
	 * refuses one of those the refusal can say WHICH STEP needs it. Without it the author reads
	 * `"http_request" is not one of this agent's tools` against a definition that never mentions
	 * `http_request`, and goes looking for a step that does not exist.
	 */
	stepTool?: string;
	/**
	 * The connector client factory (issue #86) — handlers call
	 * `ctx.connectorClient(provider)` to mint the provider's token and enforce
	 * grant/scope, instead of importing token-minting fns directly. Injected by
	 * runRegistryTool; optional so tests can construct a ctx without it.
	 */
	connectorClient?: (provider: string) => ConnectorClient;
}

export interface RegistryToolResult {
	content: string;
	success: boolean;
	/**
	 * A destination for the CLIENT to move the conversation to (#279) — the one tool result that
	 * acts on the browser rather than on the world.
	 *
	 * Optional and unread by every surface but one: the chat runtime lifts it onto the response the
	 * browser is already awaiting, and the `/v1/instances/:id/tools` route, the pipeline binder and
	 * MCP all keep only `content`/`success` and drop it. That is not an oversight — a transfer is
	 * only meaningful when a person is on the other end of the request, and dropping it everywhere
	 * else is what stops it becoming a general "agent steers the app" channel. See
	 * lib/conversation-transfer.ts for why the response is the whole security argument.
	 */
	transfer?: ConversationTransfer;
}

/** A draft-07 JSON Schema for a tool's input — an object schema with typed properties.
 *  A property carries `type`/`description` plus whatever else draft-07 allows (`enum`,
 *  `items`, `default`, …); the schema is passed to the model verbatim, so constraining
 *  properties to two keys only meant a tool couldn't express a closed value set.
 *
 *  `type` is a string OR an array of them, because draft-07 says so and because this codebase
 *  ALREADY emits the array form: `behaviourToolSchema` writes `["number","null"]` on every
 *  field, so that "go back to how you were" is expressible and a setting can be undone rather
 *  than only changed (#224). Declaring it as a bare `string` made a legal schema this repo
 *  produces fail to satisfy the type meant to describe it — invisible until #599 put worker
 *  sources under `tsc`, and papered over at the two use sites with an `as` cast and a
 *  double-`unknown` in a test. Widening the declaration is what removes both (#608). */
export interface JsonSchema {
	type: "object";
	properties: Record<string, { type: string | string[]; description?: string; [k: string]: unknown }>;
	required?: string[];
	[k: string]: unknown;
}

/**
 * The ONE tool definition shape (issue #85). A tool is declared once with its JSON
 * Schema and handler; the same def surfaces to the agent runtime (via
 * `registryToolDefs` → buildAgentToolDefinitions), the generic tool-call API
 * (routes/tools), and — later — MCP. `jsonSchema` is the source of truth for the tool's
 * inputs; the runtime passes it through verbatim (no more rebuilding from an ad-hoc map).
 */
export interface ToolDef {
	name: string;
	description: string;
	/** Draft-07 object schema for the tool's input. Passed to the LLM + validated on the API. */
	jsonSchema: JsonSchema;
	/** base = always granted · standard = creator-selectable · runtime = needs a local runner · connector = external system. */
	tier: "base" | "standard" | "runtime" | "connector";
	/** Which connector provides it (e.g. "github"). Present for connector-tier tools. */
	connector?: string;
	/**
	 * Registry tools this handler may dispatch from INSIDE itself (#396) — declared here, beside
	 * the handler that does it, because anywhere else is a second list somebody has to remember.
	 *
	 * The pre-flight (`pipeline-tool-policy.ts`) unions these with the step names it already reads,
	 * so a definition built entirely from exempt-looking steps is refused at attach/kick rather than
	 * mid-run. Before this, `geocode` and `fan_out` named `http_request` NOWHERE in the definition —
	 * no author could know their pipeline depended on it, and no static reading could tell them.
	 *
	 * "May", not "will": `fan_out` only dispatches in its `pages` mode. Over-declaring costs a
	 * refusal the author can fix by declaring a read-scoped tool; under-declaring is the mid-run
	 * refusal this exists to remove, so the honest reading is the conservative one.
	 *
	 * `step-dispatch.test.ts` derives the same table from the handler SOURCE and fails when the two
	 * disagree — that test, not this comment, is what keeps it from being forgotten.
	 */
	dispatches?: readonly string[];
	/**
	 * The input key whose value NAMES a registry tool this handler dispatches (#396). `enrich` is
	 * the case: `{"tool":"enrich","inputs":{"tool":"web_search"}}` re-dispatches per record.
	 *
	 * Dynamic by construction, so the pre-flight resolves it only when the value is a literal
	 * string — which is every reference pipeline, and the authoring mistake. A `$param`-supplied
	 * name stays unknowable until the run, which is exactly why the enforcing gate lives in
	 * `runRegistryTool` and this one is an early warning.
	 */
	dispatchesFromInput?: string;
	/**
	 * Does this tool need the owner's WRITE CONSENT for its connector (#90)?
	 *
	 * `read` = no consent gate applies. `write` = `runRegistryTool` refuses the call until the
	 * owner has granted write on `connector`.
	 *
	 * It is NOT the answer to "does this change anything" — that is {@link ToolDef.mutates}, and
	 * conflating the two is #563. `scope` is an INSTRUCTION TO A GATE: a write-scoped tool with no
	 * connector has nothing to consent to and is refused outright (`tool-registry.ts`, "unreachable
	 * rather than silently ungated"), so `start_work` — which spends the owner's tokens on an
	 * autonomous run — cannot be marked `write` without breaking it. Nine tools sat in exactly that
	 * position and the listing reported all nine as `read`.
	 */
	scope?: "read" | "write";
	/**
	 * Can a call to this tool CHANGE something — the external system, the owner's machine, or this
	 * instance's own stored data?
	 *
	 * REQUIRED, because this is the question an auditor asks ("is this agent read-only before I
	 * trust it with sensitive data") and a default is not a decision. `scope` has a default and has
	 * to keep one: it drives a gate, and the gate's answer for an undeclared tool is "no gate". This
	 * field drives nothing — it is reported — so the compiler can insist on it, and does.
	 *
	 * Answer it "can", not "will", and answer it fail-closed. `http_request` is `scope:"read"`
	 * because the CALLER picks the verb, and `mutates:true` because one of the verbs it can pick is
	 * POST. Over-reporting a read as a mutation costs an auditor a question; under-reporting a
	 * mutation as a read is the bug this field exists to close — the same fail direction, and for
	 * the same reason, as `scopeOfBuiltin` in `lib/builtin-tool-policy.ts`.
	 *
	 * Reach is a SEPARATE question and has its own field: `connector` names the external system a
	 * tool touches, so "does it mutate" and "does it leave the platform" stay independently
	 * filterable. A tool that reads someone's private repo mutates nothing.
	 */
	mutates: boolean;
	handler: (ctx: RegistryToolCtx, input: Record<string, unknown>) => Promise<RegistryToolResult>;
}

/**
 * @deprecated Use {@link ToolDef}. Kept as an alias so existing connector modules that
 * annotate their arrays as `RegistryTool[]` keep compiling during the migration.
 */
export type RegistryTool = ToolDef;

// ── The connector contract (was lib/connectors/registry.ts) ──────────────────

export interface Connector {
	/** Stable id, also the `connector` stamped on its tools and the grants/consent key. */
	id: string;
	/** Human label for errors/UI. */
	label: string;
	/**
	 * How connectorClient obtains a token:
	 *  app   — GitHub-App installation token (installationTokenForOwner)
	 *  oauth — refresh-token → access-token mint (Drive-style)
	 *  token — a stored/opaque token (platform env `tokenEnv`, else user_api_keys)
	 *  none  — no cloud auth (e.g. tmux, reached over the runner relay)
	 */
	auth: "oauth" | "token" | "app" | "none";
	/** What the connector can do. A read-only connector rejects write-scoped token requests. */
	scopes: { read: boolean; write: boolean };
	/**
	 *  user             — auth is the user's (installation/oauth/env); no per-resource grant.
	 *  instance-resource — each tool call must target a resource granted to the instance.
	 */
	grantModel: "user" | "instance-resource";
	/** For auth:"token" connectors backed by a platform env var (e.g. Meta). */
	tokenEnv?: EnvTokenKey;
	/**
	 * Whether this connector's credential survives with no human present (#181). Omitted =
	 * derived from `auth` by `unattendedClassOf` (oauth → "refresh", everything else → "yes"),
	 * which is the honest default: the auth type already determines survivability, so deriving
	 * stops the two drifting apart. Declare it only to say something the auth type does not.
	 */
	unattended?: UnattendedClass;
	/**
	 * Env vars that must ALL be set for this connector to be usable on a deployment, when that
	 * cannot be read off `oauth` (#355). Zoho WorkDrive is the case: its authorize/token endpoints
	 * are per data-centre, so it declares no `oauth` block — and without this the catalog would
	 * report it unconfigured on a deployment where `/v1/workdrive/status` says otherwise. Two
	 * answers to "can I connect this?" is the bug the catalog exists to remove, so the one that is
	 * not manifest-derivable is declared rather than inferred.
	 */
	credentialEnv?: string[];
	/** For auth:"oauth" connectors: the OAuth2 config (from the manifest) that drives the
	 *  generic authorize/callback/refresh flow. `clientIdEnv`/`secretEnv` name the Worker env
	 *  vars holding the client credentials (resolved server-side, never in the manifest). */
	oauth?: {
		authUrl: string;
		tokenUrl: string;
		scopes?: string[];
		clientIdEnv?: string;
		secretEnv?: string;
	};
	/** The tools this connector provides. Their `connector`/`tier`/`scope` are stamped from here. */
	tools: ToolDef[];
}

/** Env keys usable as a platform token source (all `string | undefined`). */
export type EnvTokenKey = "META_ACCESS_TOKEN";

// ── Unattended classification (was lib/connectors/unattended.ts) ─────────────

/**
 * How well a connector's credential survives with no human present.
 *
 *  yes              — nothing expires from the user's side. A stored machine token, a
 *                     GitHub-App installation token minted per call, or no credential at all.
 *  refresh          — a durable refresh token mints access tokens unattended. Survives, as long
 *                     as the grant itself is not revoked.
 *  interactive-only — the credential can only be obtained with a human at a browser, and it
 *                     expires. Wiring this into anything automatic schedules a future outage.
 */
export type UnattendedClass = "yes" | "refresh" | "interactive-only";

/**
 * Why a delivery attempt failed, to the only resolution the outbox cares about.
 *
 *  auth      — the credential is rejected. Retrying is pointless: no amount of backoff makes an
 *              expired grant valid, and a replay of the same row will fail identically. Needs a
 *              human to reconnect.
 *  transient — anything else. The dependency may recover; that is what backoff is for.
 */
export type DeliveryFailureKind = "auth" | "transient";

// ── The connector client contract (was lib/connectors/client.ts) ─────────────

export interface ConnectorClientCaller {
	userId?: string;
	instanceId?: string;
}

export interface TokenOpts {
	/** For app-auth connectors (github): the resource whose owner the token is minted for (e.g. "owner/name" or "owner"). For instance-resource grants: the granted resourceId. */
	resourceId?: string;
	/** The scope the caller intends. A "write" against a read-only connector is rejected. */
	scope?: "read" | "write";
}

export interface ConnectorClient {
	/** The resolved connector definition. */
	readonly connector: Connector;
	/** Mint/read the access token for this connector. Returns "" for auth:"none". */
	token(opts?: TokenOpts): Promise<string>;
	/** Fail-closed grant check (instance-resource connectors only). Throws HttpError(403) if not granted. */
	requireGrant(resourceId: string): Promise<ConnectorGrant>;
	/** A Bearer-authorized fetch — the access token is minted and attached for you. */
	fetch(url: string, init?: RequestInit, opts?: TokenOpts): Promise<Response>;
}
