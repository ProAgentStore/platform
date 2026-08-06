// Connector registry (issue #86). A connector is DECLARED once — its auth model,
// scopes, grant model, and the tools it provides — and everything else (the tool
// REGISTRY, the connectorClient auth dispatch, the catalog groups) derives from it.
// Adding a connector = add an entry here; no bespoke routes.
import type { Env } from "../../types.js";
import type { ToolDef } from "../tool-registry.js";
import { BROWSER_TOOLS } from "./browser.js";
import { GITHUB_CONNECTOR } from "./github.js";
import { HTTP_TOOLS } from "./http.js";
import { MCP_TOOLS } from "./mcp.js";
import { REPO_LOCAL_TOOLS } from "./repo-local.js";
import { SUPERVISION_TOOLS } from "./supervision.js";
import { META_CONNECTOR } from "./meta.js";
import { GOOGLE_SHEETS_CONNECTOR } from "./google-sheets.js";
import { TERMINAL_TOOLS } from "./terminal.js";
import { TMUX_TOOLS } from "./tmux.js";
import { WEB_SEARCH_CONNECTOR } from "./web-search.js";
import type { UnattendedClass } from "./unattended.js";

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

// Assert a key of Env exists (compile-time guard for tokenEnv values).
type _AssertEnvKey = EnvTokenKey extends keyof Env ? true : never;
const _assertEnvKey: _AssertEnvKey = true;
void _assertEnvKey;

export const CONNECTORS: Connector[] = [
	// github is a declarative manifest (#146): shape as data, tools keep their custom logic
	// (repo validation, per_page clamp, issue delegation, create-issue POST) via the handler
	// escape hatch. auth "app" → GitHub-App installation token (owner-scoped).
	GITHUB_CONNECTOR,
	// meta is a declarative manifest (#146): shape as data, tools keep their Graph-API logic
	// via the handler escape hatch. auth "platform-token" → Connector.auth "token" + tokenEnv.
	META_CONNECTOR,
	{
		id: "terminal",
		label: "Terminal (local runner)",
		// Generic terminal connector over the runner relay. Backend-specific local adapters
		// currently include tmux, kitty remote control, and iTerm2 AppleScript.
		auth: "none",
		scopes: { read: true, write: true },
		grantModel: "user",
		tools: TERMINAL_TOOLS,
	},
	{
		id: "tmux",
		label: "tmux (local runner)",
		auth: "none", // reached over the runner relay; no cloud credential
		scopes: { read: true, write: true },
		grantModel: "user",
		tools: TMUX_TOOLS,
	},
	{
		id: "browser",
		label: "Browser (local runner, experimental)",
		// auth:"none" — reached over the runner relay like tmux; no cloud credential. The tools
		// are additionally inert unless env BROWSER_TOOLS_ENABLED is set (first-party/self-use
		// only, #103) and writes need the instance's "browser" write-consent (#90).
		auth: "none",
		scopes: { read: true, write: true },
		grantModel: "user",
		tools: BROWSER_TOOLS,
	},
	{
		id: "repo-local",
		label: "Local repository (read-only, via the runner)",
		// auth:"none" — like tmux/browser, reached over the runner relay, so the credential is
		// simply that the user's own machine is connected. The repo is never copied into
		// platform storage: only the excerpts a tool call returns cross the wire, and access is
		// whatever the local checkout already has (so a private repo needs no GitHub App).
		//
		// scopes.write is FALSE, which is the point of a separate connector rather than folding
		// these into tmux: a read-only connector can never be write-consented, so this agent
		// cannot be talked into running a command. Driving the machine stays tmux's job.
		auth: "none",
		scopes: { read: true, write: false },
		grantModel: "user",
		tools: REPO_LOCAL_TOOLS,
	},
	{
		id: "supervision",
		label: "Supervision (delegate to agents you oversee)",
		// auth:"none" — internal to the platform and to ONE owner (both instances are theirs),
		// so there is no external system and no credential. What governs it is the configured
		// supervision graph (#183), re-checked inside delegate_goal on every call rather than
		// trusted from the caller.
		auth: "none",
		scopes: { read: true, write: true },
		grantModel: "user",
		tools: SUPERVISION_TOOLS,
	},
	{
		id: "http",
		label: "HTTP / REST (generic)",
		// auth:"token", no tokenEnv → connectorClient.token() reads the user's vault key
		// (user_api_keys, provider "http") for api-key mode; http_request injects it into
		// the configured header/query param itself (not as a Bearer header).
		auth: "token",
		scopes: { read: true, write: true },
		grantModel: "user",
		tools: HTTP_TOOLS,
	},
	{
		id: "mcp",
		label: "MCP server (generic, outbound)",
		// auth:"token" describes the SHAPE of the credential (an opaque bearer), not where it is
		// found. Since #286 the MCP tools do NOT resolve through connectorClient's vault slot:
		// `user_api_keys` is keyed (user_id, provider), which gave one token to every MCP server a
		// user could name, and the server here is a tool input. They resolve per normalized
		// endpoint instead (lib/mcp-credentials.ts) — the same key consent uses — with no fallback
		// to the provider-wide slot. Deliberately generic: the SERVER is a tool input, so no
		// sibling store or third party is a dependency of this Worker; a configured endpoint is
		// user data.
		auth: "token",
		// unattended is DERIVED as "yes", which is right for the credential this connector
		// actually holds: a vault bearer the user pasted does not expire on us. The fragile case
		// is a property of the ENDPOINT, not of the connector — a server that turns out to be
		// OAuth-protected with no refresh grant is interactive-only — and that can only be known
		// by asking the server, which `discoverAuthServer` does at call time (#180/#181).
		scopes: { read: true, write: true },
		grantModel: "user",
		tools: MCP_TOOLS,
	},
	// web-search is the first connector defined as a declarative manifest (#146) — its shape is
	// data (`WEB_SEARCH_MANIFEST`), compiled to this Connector; the tool keeps its custom output
	// via the manifest `handler` escape hatch. Behavior-identical to the old hand-written form.
	WEB_SEARCH_CONNECTOR,
	// google_sheets (#89): the first oauth2 manifest connector — connected via the generic
	// /v1/connectors/:id/oauth flow (#147), read + append rows. Inert until the Google OAuth app
	// has the spreadsheets scope + the connector callback registered.
	GOOGLE_SHEETS_CONNECTOR,
];

const BY_ID: ReadonlyMap<string, Connector> = new Map(CONNECTORS.map((c) => [c.id, c] as const));

export function getConnector(id: string): Connector | undefined {
	return BY_ID.get(id);
}

/**
 * Every connector's tools, with `connector`, `tier:"connector"`, and a default `scope`
 * stamped from the connector definition (so a tool declared without them still lands
 * correctly). Flattened for the tool REGISTRY.
 */
export function connectorTools(): ToolDef[] {
	return CONNECTORS.flatMap((c) =>
		c.tools.map((t) => ({
			...t,
			connector: t.connector ?? c.id,
			tier: t.tier ?? "connector",
			scope: t.scope ?? "read",
		})),
	);
}
