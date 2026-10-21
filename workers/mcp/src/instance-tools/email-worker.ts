import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * Management of an instance's worker-backed (Cloudflare Email Routing/Sending bridge) mail connection (#1277).
 *
 * #1269/#1270 shipped the connector and the bridge APIs; the owner could only configure them in the console. These
 * tools drive the SAME API services as the owner, with the owner's own authorization — there is no second path.
 *
 * CREDENTIAL POSTURE. No tool here has a `secret` parameter, and none returns one. Enrolling a bridge secret is a
 * handoff: `begin_email_worker_enrollment` returns a console link, the OWNER types the secret into the console's
 * secure-input page (envelope-encrypted, one-shot), and `complete_email_worker_enrollment` makes the server consume
 * it, test the bridge and store the connection. Write consent for sending stays the owner's console decision; it is
 * REPORTED by `get_instance_email_worker`, never changed here.
 */
export function registerEmailWorkerTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;
	const base = (instance_id: string) => `/v1/instances/${encodeURIComponent(instance_id)}/email-worker`;
	const token = z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.");
	const instance = z.string().describe("Private instance ID or slug from my_instances. Copy it exactly.");
	const endpointArg = z.string().describe("The https URL of the owner's bridge Worker, e.g. https://mail.example.com.");
	const accountArg = z.string().optional().describe("Account id on that endpoint. Omit for the default (unnamed) account.");

	server.tool(
		"get_instance_email_worker",
		"Read-only. Everything about this instance's worker-backed mail (Cloudflare Email Routing/Sending bridge, #1277): `state` (absent = no connection exists; ambiguous = several and none pinned; stale_pin = pinned to a connection that is gone; connected), the pin, every connection with its contract version and identities (domains, send-capable senders with approved/reply flags, routed-only addresses, bridge health), the instance's write-consent mode for this connector, and `blockers[]` — each a named reason mail cannot flow: no_connection, ambiguous_connection, stale_pin, bridge_unreachable (with failureClass auth | protocol | bridge_unavailable), no_identity_report, no_approved_sender, no_reply_identity, write_consent_off, write_consent_ask. `readyToRead` / `readyToSend` summarise them. Pass enrollment_id to also see where a secure enrollment stands (pending, ready, connected, probe_failed, expired) and the length of what the owner entered — never the value. Contains no credential.",
		{ token, instance_id: instance, enrollment_id: z.string().optional().describe("An enrollmentId from begin_email_worker_enrollment.") },
		async ({ token: t, instance_id, enrollment_id }) => {
			const sessionToken = tokenFor(t);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(t), "read", "get_instance_email_worker", { instance_id, enrollment_id });
			if (denied) return denied;
			const q = enrollment_id ? `?enrollment=${encodeURIComponent(enrollment_id)}` : "";
			const data = (await authedCall(`${base(instance_id)}/status${q}`, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"begin_email_worker_enrollment",
		"Start a SECURE enrollment of a worker-backed mail connection (#1277). This tool takes no secret and returns none: it opens a one-shot secure-input request bound to this endpoint and account and returns `consoleUrl` — hand that link to the OWNER, who types the bridge's bearer secret into the console (encrypted at rest; never visible to you, the chat or logs). Then call get_instance_email_worker with the enrollment_id until the enrollment is `ready`, and complete_email_worker_enrollment. Do not ask anyone to paste the secret into chat. Call with dry_run first.",
		{
			token,
			instance_id: instance,
			endpoint: endpointArg,
			account_id: accountArg,
			label: z.string().max(120).optional().describe("A name for the connection in the console, e.g. 'Hiring Comms'."),
			dry_run: z.boolean().optional().describe("Report what would be opened without opening it."),
		},
		async ({ token: t, instance_id, endpoint, account_id, label, dry_run }) => {
			const sessionToken = tokenFor(t);
			if (!sessionToken) return authRequired();
			const body = { endpoint, ...(account_id !== undefined ? { accountId: account_id } : {}), ...(label ? { label } : {}) };
			const input = { instance_id, ...body };
			const denied = await requirePermission(safetyFor(t), "write", "begin_email_worker_enrollment", input);
			if (denied) return denied;
			const path = `${base(instance_id)}/enrollments`;
			if (dry_run) return dryRun(safetyFor(t), "begin_email_worker_enrollment", `open a secure enrollment for ${endpoint}`, input, { endpoint: path, method: "POST", body });
			const data = (await authedCall(path, sessionToken, { method: "POST", body: JSON.stringify(body) }, env)) as { error?: string };
			if (!data.error) await audit(safetyFor(t), { tool: "begin_email_worker_enrollment", action: "completed", input, result: data });
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"complete_email_worker_enrollment",
		"Finish a secure enrollment once the owner has entered the bridge secret in the console (#1277): the server consumes the entered value, tests the bridge with it (`/v1/email-worker/identity`) and, only if the bridge identifies itself, stores the connection. Answers `ok` with the contract version and bridge address, or a distinct refusal: `not_entered` (the owner has not typed it yet, or it expired — nothing consumed), `probe_failed` with failureClass auth | protocol | bridge_unavailable (the value is kept so the owner need not retype it once the Worker is fixed), `already_connected`, `not_found`. Never returns the secret. Afterwards: set_instance_email_worker_account to pin it, set_email_worker_identities to approve senders.",
		{ token, instance_id: instance, enrollment_id: z.string().describe("The enrollmentId from begin_email_worker_enrollment. Copy it exactly."), dry_run: z.boolean().optional().describe("Report what would be done without consuming anything.") },
		async ({ token: t, instance_id, enrollment_id, dry_run }) => {
			const sessionToken = tokenFor(t);
			if (!sessionToken) return authRequired();
			const input = { instance_id, enrollment_id };
			const denied = await requirePermission(safetyFor(t), "write", "complete_email_worker_enrollment", input);
			if (denied) return denied;
			const path = `${base(instance_id)}/enrollments/${encodeURIComponent(enrollment_id)}/complete`;
			if (dry_run) return dryRun(safetyFor(t), "complete_email_worker_enrollment", `consume the entered secret for enrollment ${enrollment_id}, test the bridge and store the connection`, input, { endpoint: path, method: "POST" });
			const data = (await authedCall(path, sessionToken, { method: "POST" }, env)) as { error?: string };
			if (!data.error) await audit(safetyFor(t), { tool: "complete_email_worker_enrollment", action: "completed", input, result: data });
			return data.error ? text(`Error: ${data.error}${(data as { code?: string }).code ? ` (${(data as { code?: string }).code})` : ""}`) : jsonText(data);
		},
	);

	server.tool(
		"test_email_worker_connection",
		"Test a stored worker-backed mail connection against its bridge (#1277): calls the bridge's identity endpoint with the STORED credential (this tool takes no secret), refreshes the recorded contract version, identities and health, and distinguishes `bridge_failure` with failureClass auth | protocol | bridge_unavailable from `no_connection` and the ambiguous / stale-pin states. Omit endpoint to test the connection this instance resolves to. Sends and reads no mail.",
		{ token, instance_id: instance, endpoint: endpointArg.optional(), account_id: accountArg, dry_run: z.boolean().optional().describe("Report which connection would be tested without calling the bridge.") },
		async ({ token: t, instance_id, endpoint, account_id, dry_run }) => {
			const sessionToken = tokenFor(t);
			if (!sessionToken) return authRequired();
			const body = { ...(endpoint ? { endpoint } : {}), ...(account_id !== undefined ? { accountId: account_id } : {}) };
			const input = { instance_id, ...body };
			const denied = await requirePermission(safetyFor(t), "write", "test_email_worker_connection", input);
			if (denied) return denied;
			if (dry_run) return dryRun(safetyFor(t), "test_email_worker_connection", endpoint ? `test the stored credential for ${endpoint}` : `test the connection ${instance_id} resolves to`, input, { endpoint: `${base(instance_id)}/test`, method: "POST", body });
			const data = (await authedCall(`${base(instance_id)}/test`, sessionToken, { method: "POST", body: JSON.stringify(body) }, env)) as { error?: string };
			if (!data.error || (data as { ok?: boolean }).ok === false) await audit(safetyFor(t), { tool: "test_email_worker_connection", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"set_instance_email_worker_account",
		"Pin this instance to ONE worker-backed mail connection (#1277), or clear the pin by omitting endpoint. Refused when the named endpoint/account is not a stored connection, so a pin to something that was never connected is caught now. The pin is what stops an instance from reading or sending through another connection of the same owner; read it back with get_instance_email_worker. Call with dry_run first.",
		{ token, instance_id: instance, endpoint: endpointArg.optional().describe("Omit to clear the pin."), account_id: accountArg, dry_run: z.boolean().optional().describe("Report the change without saving it.") },
		async ({ token: t, instance_id, endpoint, account_id, dry_run }) => {
			const sessionToken = tokenFor(t);
			if (!sessionToken) return authRequired();
			const body = endpoint ? { endpoint, accountId: account_id ?? "" } : {};
			const input = { instance_id, ...body };
			const denied = await requirePermission(safetyFor(t), "write", "set_instance_email_worker_account", input);
			if (denied) return denied;
			const path = `${base(instance_id)}/account`;
			if (dry_run) return dryRun(safetyFor(t), "set_instance_email_worker_account", endpoint ? `pin ${instance_id} to ${endpoint}` : `clear the mail connection pin on ${instance_id}`, input, { endpoint: path, method: "PUT", body });
			const data = (await authedCall(path, sessionToken, { method: "PUT", body: JSON.stringify(body) }, env)) as { error?: string };
			if (!data.error) await audit(safetyFor(t), { tool: "set_instance_email_worker_account", action: "completed", input, result: data });
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"set_email_worker_identities",
		"Approve which sender identities a worker-backed connection may send as, and which one replies (#1277, #1270). You can only NARROW what the bridge reports: an address the bridge does not list as send-capable — in particular a routed-only alias — is refused with the reason, as is a reply identity that is not among the approved senders. `approved_senders` replaces the approved set (empty = none). Read the result back with get_instance_email_worker. Call with dry_run first.",
		{
			token,
			instance_id: instance,
			endpoint: endpointArg,
			account_id: accountArg,
			approved_senders: z.array(z.string()).max(50).describe("Plain addresses the bridge reports as send-capable. Replaces the approved set."),
			reply_identity: z.string().nullable().optional().describe("The approved sender replies go out as; null or omitted = none."),
			dry_run: z.boolean().optional().describe("Report the change without saving it."),
		},
		async ({ token: t, instance_id, endpoint, account_id, approved_senders, reply_identity, dry_run }) => {
			const sessionToken = tokenFor(t);
			if (!sessionToken) return authRequired();
			const body = { endpoint, accountId: account_id ?? "", approvedSenders: approved_senders, replyIdentity: reply_identity ?? null };
			const input = { instance_id, ...body };
			const denied = await requirePermission(safetyFor(t), "write", "set_email_worker_identities", input);
			if (denied) return denied;
			const path = "/v1/email-worker/connections/identities";
			if (dry_run) return dryRun(safetyFor(t), "set_email_worker_identities", `approve ${approved_senders.length} sender(s)${reply_identity ? ` with reply identity ${reply_identity}` : ""} on ${endpoint}`, input, { endpoint: path, method: "PUT", body });
			const data = (await authedCall(path, sessionToken, { method: "PUT", body: JSON.stringify(body) }, env)) as { error?: string };
			if (!data.error) await audit(safetyFor(t), { tool: "set_email_worker_identities", action: "completed", input, result: data });
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);
}
