/**
 * The connected ACCOUNTS that carry no tools — Google Drive and Zoho WorkDrive (#352 Stage 1).
 *
 * Gmail was declared here too until #711. It has moved to `connectors/gmail.ts` because it now
 * declares real tools, which is the one thing this module is about NOT doing. The rest of the
 * reasoning below is unchanged and still applies to the two that remain.
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
 * #352 Stage 2: both now CONNECT through the generic flow (`lib/connector-oauth-flow.ts`) — the
 * dedicated start/callback implementations are gone. Each declares the `redirectPath` its OAuth app
 * already has registered (`/v1/drive/google/callback`, `/v1/workdrive/zoho/callback`), which is
 * mounted as an alias of the generic callback: the provider sees the URI it has always accepted, so
 * no dashboard change was needed to retire the flows and no in-flight connect broke. Moving to the
 * id-less generic `/v1/connectors/oauth/callback` is a dashboard registration first, then one line.
 */
import { DRIVE_SCOPE } from "../drive.js";
import { WORKDRIVE_SCOPE, workDriveAccountsBase } from "../workdrive.js";
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
		// Registered on the Google OAuth app since Drive shipped; see the header.
		redirectPath: "/v1/drive/google/callback",
		// One Drive connection per owner, labelled with the Google address — the row every existing
		// connection already is (`account_id = ''`), so a reconnect updates it.
		identity: { label: "userinfo-email" },
	},
	tools: [],
};

export const ZOHO_WORKDRIVE_CONNECTOR: Connector = {
	id: "zoho_workdrive",
	label: "Zoho WorkDrive",
	auth: "oauth",
	scopes: { read: true, write: false },
	grantModel: "instance-resource",
	// Zoho's authorize/token endpoints are per data-centre (`workDriveAccountsBase(env)` reads
	// ZOHO_ACCOUNTS_BASE). `endpointsFromEnv` is what lets the generic flow reach the RIGHT one —
	// the reason this connector used to declare no `oauth` block at all. The static URLs are the
	// default data-centre's, the same fallback `workDriveAccountsBase` uses.
	oauth: {
		authUrl: "https://accounts.zoho.com/oauth/v2/auth",
		tokenUrl: "https://accounts.zoho.com/oauth/v2/token",
		endpointsFromEnv: (env) => {
			const base = workDriveAccountsBase(env);
			return { authUrl: `${base}/oauth/v2/auth`, tokenUrl: `${base}/oauth/v2/token` };
		},
		scopes: [WORKDRIVE_SCOPE],
		clientIdEnv: "ZOHO_CLIENT_ID",
		secretEnv: "ZOHO_CLIENT_SECRET",
		redirectPath: "/v1/workdrive/zoho/callback",
		// Zoho returns no userinfo on this scope; the dedicated flow stored this fixed label.
		identity: { label: "Zoho WorkDrive" },
	},
	credentialEnv: ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET"],
	tools: [],
};
