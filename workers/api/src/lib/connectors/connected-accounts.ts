/**
 * The three connected ACCOUNTS — Google Drive, Zoho WorkDrive, Gmail (#352 Stage 1).
 *
 * These have been connectors in every respect except the registry: each stores its refresh
 * token through `saveConnectorRefreshToken` into `user_api_keys(user_id, provider=<id>)`,
 * which is byte-for-byte the row `connectors/client.ts` reads for an `auth:"oauth"` registry
 * connector, and Drive/WorkDrive already write `instance_connector_grants` under the same ids.
 * So declaring them is a DECLARATION, not a migration: there is no backfill, no rename, no
 * dual-write window. Existing connections keep working because nothing about the stored row
 * changes.
 *
 * `tools: []` is the point, not an omission. None of the three is a thing an agent calls
 * mid-turn:
 *
 *   Drive / WorkDrive are INGESTION SOURCES. The user imports, or a `sync_connector` trigger
 *   does, and the content then lives in the instance's own store where RAG and every other
 *   surface already see it. Inventing `drive_read_file` so `capabilities.tools` has something
 *   to gate would add a second content path into the model that bypasses the vector store, and
 *   a second place the folder grant must be enforced per call — for a connector whose entire
 *   security story today is one grant check at the top of a walk that cannot leave its root.
 *
 *   Gmail's tool (`find_confirmation_link`) exists but is deliberately NOT creator-selectable:
 *   it is granted at runtime by the owner's `AgentState.permissions.email` flag. The registry
 *   has no category for that — `grantModel` is `user | instance-resource` and neither means
 *   "granted by an owner-set permission flag" — so folding it in would mean inventing a third
 *   grant model or softening the gate. It stays where it is.
 *
 * What the declaration buys is that "which connectors exist, and what are they" has ONE answer
 * (`GET /v1/connectors`) instead of five independent copies of "google_drive and zoho_workdrive
 * are the file connectors": two route files, three hand-written console blocks, an MCP
 * `PROVIDERS` map with a matching Zod enum, the `sync_connector` trigger branch, and the
 * apology comment in `client.ts`.
 *
 * A caveat that is real and unchanged from `google_sheets`: declaring `oauth` makes the generic
 * `/v1/connectors/:id/oauth/start` able to build an authorize URL whose `redirect_uri` is
 * `/v1/connectors/<id>/oauth/callback` — a path these providers' OAuth apps do not have
 * registered, so it would fail at the provider. The console does not link it; the dedicated
 * flows (`/v1/drive/google/start`, …) remain the live ones until #352 Stage 2 registers the
 * generic redirect and retires them.
 */
import { DRIVE_SCOPE } from "../drive.js";
import { GMAIL_SCOPE } from "../gmail.js";
import type { Connector } from "./types.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const GOOGLE_DRIVE_CONNECTOR: Connector = {
	id: "google_drive",
	label: "Google Drive",
	auth: "oauth",
	// DRIVE_SCOPE is `drive.readonly`. There is no write path in lib/drive.ts and there is not
	// meant to be one, so `scopes.write:false` is enforceable truth: connectorClient refuses a
	// write-scoped token outright, and a read-only connector can never be write-consented (#90).
	scopes: { read: true, write: false },
	// The grant model this connector already implements by hand: `requireConnectorGrant` on every
	// route, and the sync walk re-checking descent from the granted root.
	grantModel: "instance-resource",
	oauth: {
		authUrl: GOOGLE_AUTH_URL,
		tokenUrl: GOOGLE_TOKEN_URL,
		// `openid email` is what lets the status route say WHICH account is connected.
		scopes: ["openid", "email", DRIVE_SCOPE],
		clientIdEnv: "GOOGLE_CLIENT_ID",
		secretEnv: "GOOGLE_CLIENT_SECRET",
	},
	tools: [],
};

export const ZOHO_WORKDRIVE_CONNECTOR: Connector = {
	id: "zoho_workdrive",
	label: "Zoho WorkDrive",
	auth: "oauth",
	scopes: { read: true, write: false },
	grantModel: "instance-resource",
	// No `oauth` block ON PURPOSE. Zoho's authorize/token endpoints are per data-centre
	// (`workDriveAccountsBase(env)` reads ZOHO_ACCOUNTS_BASE), so there is no static URL to
	// declare and the manifest shape cannot express one. Omitting it keeps the generic OAuth
	// routes answering 404 for this id rather than minting an authorize URL against the wrong
	// DC — the declaration says what is true, including the part that is not yet generic.
	//
	// But "no manifest oauth" is not "cannot be connected": the dedicated flow works whenever
	// these two are set, and `/v1/workdrive/status` has always said so. Declaring them keeps the
	// catalog's `configured` from contradicting it (#355).
	credentialEnv: ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET"],
	tools: [],
};

export const GMAIL_CONNECTOR: Connector = {
	id: "gmail",
	label: "Gmail",
	auth: "oauth",
	scopes: { read: true, write: false },
	// `user`, not `instance-resource`: there is no per-mailbox grant row. Reach is decided by the
	// per-agent `permissions.email` flag, which lives in that agent's own state — see the header.
	grantModel: "user",
	oauth: {
		authUrl: GOOGLE_AUTH_URL,
		tokenUrl: GOOGLE_TOKEN_URL,
		scopes: ["openid", "email", GMAIL_SCOPE],
		clientIdEnv: "GOOGLE_CLIENT_ID",
		secretEnv: "GOOGLE_CLIENT_SECRET",
	},
	tools: [],
};
