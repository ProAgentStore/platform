// Connector registry (issue #86). A connector is DECLARED once — its auth model,
// scopes, grant model, and the tools it provides — and everything else (the tool
// REGISTRY, the connectorClient auth dispatch, the catalog groups) derives from it.
// Adding a connector = add an entry here; no bespoke routes.
import type { Env } from "../../types.js";
import type { ToolDef } from "../tool-registry.js";
import { GITHUB_TOOLS } from "./github.js";
import { HTTP_TOOLS } from "./http.js";
import { META_TOOLS } from "./meta.js";
import { TMUX_TOOLS } from "./tmux.js";

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
	/** The tools this connector provides. Their `connector`/`tier`/`scope` are stamped from here. */
	tools: ToolDef[];
}

/** Env keys usable as a platform token source (all `string | undefined`). */
type EnvTokenKey = "META_ACCESS_TOKEN";

// Assert a key of Env exists (compile-time guard for tokenEnv values).
type _AssertEnvKey = EnvTokenKey extends keyof Env ? true : never;
const _assertEnvKey: _AssertEnvKey = true;
void _assertEnvKey;

export const CONNECTORS: Connector[] = [
	{
		id: "github",
		label: "GitHub",
		auth: "app",
		scopes: { read: true, write: true },
		grantModel: "user", // access scoped by the owner's GitHub-App installation, not a per-resource grant row
		tools: GITHUB_TOOLS,
	},
	{
		id: "meta",
		label: "Meta (WhatsApp + Instagram)",
		auth: "token",
		scopes: { read: false, write: true },
		grantModel: "user",
		tokenEnv: "META_ACCESS_TOKEN",
		tools: META_TOOLS,
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
