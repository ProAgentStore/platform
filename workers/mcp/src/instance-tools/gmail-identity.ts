import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * Owner configuration of an instance's Gmail identity (#1279): which VERIFIED send-as address it writes as, and which
 * inbound recipient address(es) its mail is scoped to.
 *
 * These drive `GET|PUT /v1/instances/:id/gmail/identity` with the owner's own authorization. No tool here takes or returns
 * a credential: the connected account's token never leaves the API, and Gmail's own consent screen (owner OAuth) remains the
 * only way a mailbox is connected. Write consent for sending stays the owner's console decision — REPORTED, never changed.
 */
export function registerGmailIdentityTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;
	const path = (instance_id: string) => `/v1/instances/${encodeURIComponent(instance_id)}/gmail/identity`;
	const token = z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.");
	const instance = z.string().describe("Private instance ID or slug from my_instances. Copy it exactly.");

	server.tool(
		"get_instance_gmail_identity",
		"Read-only. This instance's Gmail identity (#1279): `state` (none = never configured, so it sends as the connected account's default and reads the whole mailbox; configured; invalid = stored setting unreadable, so mail is paused), the `pin` (`sendAs` = the verified send-as address it writes as, `inboundScope` = the recipient addresses its mail is limited to, `previewChars` = body characters per read), the connected account's live send-as `aliases` with Google's verification status (read with gmail.readonly), the Gmail write-consent mode, and `blockers[]` — email_permission_off, no_gmail_connection, send_scope_missing, aliases_unreadable, identity_invalid, no_sender_pinned, alias_missing, alias_unverified, no_inbound_scope, write_consent_off, write_consent_ask. `readyToRead` / `readyToSend` summarise them. Contains no credential.",
		{ token, instance_id: instance },
		async ({ token: t, instance_id }) => {
			const sessionToken = tokenFor(t);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(t), "read", "get_instance_gmail_identity", { instance_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/gmail/identity`, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"set_instance_gmail_identity",
		"Pin the verified sender and the inbound scope this instance's Gmail uses (#1279). REPLACES the stored identity. `send_as` must be an address the connected account can write as that Google reports verified — an unverified or unknown alias is refused (Gmail would silently send it as the primary address); the sender is then emitted as an explicit sanitized From and Reply-To on every send, reply and draft, and a missing/unverified identity refuses instead of sending as the default. `inbound_scope` limits which mail the instance can search, read, reply to, download from or change — enforced on the search query AND on every message by id. `clear: true` removes the identity (the instance returns to the account's default sender and whole mailbox). Cannot connect a mailbox, hold or return a credential, or change write consent — those stay the owner's. Read the result back with get_instance_gmail_identity. Call with dry_run first.",
		{
			token,
			instance_id: instance,
			send_as: z.string().nullable().optional().describe("A verified send-as address of the connected Gmail account, e.g. admin@freeappstore.online; null/omitted = none (a scoped instance then cannot send)."),
			inbound_scope: z.array(z.string()).max(10).optional().describe("Recipient addresses this instance's mail is limited to (matched on To, Cc, X-Original-To and the receiving Delivered-To). Omit/empty = the whole mailbox."),
			preview_chars: z.coerce.number().int().min(500).max(40000).optional().describe("Body characters one gmail_read_message returns before it must continue with offset. Default 8000."),
			clear: z.boolean().optional().describe("Remove the identity entirely."),
			dry_run: z.boolean().optional().describe("Report the change without saving it."),
		},
		async ({ token: t, instance_id, send_as, inbound_scope, preview_chars, clear, dry_run }) => {
			const sessionToken = tokenFor(t);
			if (!sessionToken) return authRequired();
			const body = clear
				? { clear: true }
				: { sendAs: send_as ?? null, inboundScope: inbound_scope ?? [], ...(preview_chars !== undefined ? { previewChars: preview_chars } : {}) };
			const input = { instance_id, ...(clear ? { clear: true } : { send_as: send_as ?? null, inbound_scope: inbound_scope ?? [], ...(preview_chars !== undefined ? { preview_chars } : {}) }) };
			const denied = await requirePermission(safetyFor(t), "write", "set_instance_gmail_identity", input);
			if (denied) return denied;
			if (dry_run) {
				const what = clear ? `clear the Gmail identity on ${instance_id}` : `pin ${instance_id} to send as ${send_as ?? "(none)"}, scoped to ${(inbound_scope ?? []).join(", ") || "the whole mailbox"}`;
				return dryRun(safetyFor(t), "set_instance_gmail_identity", what, input, { endpoint: path(instance_id), method: "PUT", body });
			}
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/gmail/identity`, sessionToken, { method: "PUT", body: JSON.stringify(body) }, env)) as { error?: string };
			if (!data.error) await audit(safetyFor(t), { tool: "set_instance_gmail_identity", action: "completed", input, result: data });
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);
}
