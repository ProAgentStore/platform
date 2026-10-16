/**
 * GitHub as a first-class connector (#1080): the accounts of an `app` connector.
 *
 * Every other credential-holding connector keeps its accounts in `user_api_keys` (one row per mailbox,
 * Drive, …), so `GET /v1/instances/:id/connector-accounts` and `GET /v1/connectors` listed them — and never
 * listed GitHub, whose credential is the account's VERIFIED App installation bindings in
 * `github_installations`. "Connectors you hold an account on: http, gmail" was true and useless.
 *
 * This is a READ-ONLY account source over those bindings, used by those two listings only. It changes
 * nothing about how a GitHub token is minted: `connectorClient`'s `app` branch (`client.ts`) still picks the
 * installation by the repository's OWNER through `resolveGithubAccess`, and `listConnectorAccounts` — what
 * the oauth/token branch resolves pins against — is untouched. That is also why a GitHub account cannot be
 * pinned per agent: the repository decides, and a pin would be a second authority the minting never reads.
 * New organisations join the list through the existing proof — Sync installations (#1081).
 */
import type { Env } from "../../types.js";
import type { ConnectorAccount } from "../connector-accounts.js";
import { listUserInstallations } from "../github-app.js";
import type { Connector } from "./types.js";

/** Why an `app` connector has no per-agent account choice, and how an organisation is added. */
export const APP_ACCOUNT_CHOICE =
	"GitHub is not chosen per agent: every call uses the ProAgentStore App installation on the repository's owner, so each account listed is reachable by any of your agents. To add an organisation, install the App there and Sync installations (Preferences → Connections → GitHub, or the MCP tool sync_github_installations).";

/**
 * The accounts an `app` connector reaches for this user, or null when the connector keeps its accounts
 * in the vault like every other one. GitHub: one per verified installation binding, newest first.
 */
export async function appConnectorAccounts(env: Env, userId: string, connector: Pick<Connector, "id" | "auth">): Promise<ConnectorAccount[] | null> {
	if (connector.auth !== "app") return null;
	if (connector.id !== "github") return [];
	return (await listUserInstallations(env, userId)).map((i) => ({
		accountId: i.account,
		label: `${i.account} (${i.type === "Organization" ? "organisation" : "personal account"} · App installation ${i.id})`,
		connectedAt: null,
		grantedScopes: null,
	}));
}
