/**
 * Gmail connector (#711) — the mailbox as a set of declared tools.
 *
 * Gmail has been a connector since #352 Stage 1, but it was declared with `tools: []` and lived
 * in `connected-accounts.ts` alongside Drive and WorkDrive. That grouping said something true at
 * the time: none of the three was a thing an agent CALLS mid-turn, because Drive and WorkDrive
 * are ingestion sources and Gmail's only tool (`find_confirmation_link`) is granted by a
 * permission flag the registry has no category for.
 *
 * It stopped being true the moment "read the mail I was sent and act on what was attached"
 * became a thing to support. That is a mid-turn call by any reading: the agent decides which
 * message, decides which attachment, and does it inside one turn. So Gmail moves here and
 * declares its tools like any other connector; Drive and WorkDrive keep the `tools: []`
 * reasoning, which still holds for them.
 *
 * `find_confirmation_link` does NOT move. It stays a built-in in `storage-tools.ts`, still
 * excluded from `CREATOR_SELECTABLE_TOOLS`, still granted only by `permissions.email`. Its
 * grant model is genuinely the odd one out and folding it in would mean inventing a third
 * `grantModel` or softening its gate — the original argument, unchanged.
 *
 * ── The gate, and why it is belt AND braces ─────────────────────────────────
 * Every tool here calls `requireEmailPermission` before touching the mailbox, on top of the
 * `capabilities.tools` allowlist that `runRegistryTool` already enforces. That is deliberate
 * duplication. `permissions.email` is an OWNER-facing switch that exists today and means "this
 * agent may read my mail"; `capabilities.tools` is a CREATOR-facing declaration. If declaring
 * `gmail_search` were sufficient, a catalog agent would gain mailbox reach by its own
 * declaration and the owner's switch would quietly stop being load-bearing. So the switch stays
 * the authority, and the declaration only narrows it further.
 */
import type { Connector, RegistryToolCtx, RegistryToolResult, ToolDef } from "./types.js";
import { compileConnector, type ConnectorManifest } from "./manifest.js";
import type { Env } from "../../types.js";

/** Raw bytes we are willing to pull through the Worker for one attachment.
 *  Base64 inflates by ~4/3 and the DO round-trip holds another copy, so this is well under the
 *  128MB isolate limit on purpose — a club form is kilobytes; a 25MB video is a mistake. */
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

function fail(message: string): RegistryToolResult {
	return { content: message, success: false };
}

function ok(payload: unknown): RegistryToolResult {
	return { content: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2), success: true };
}

/**
 * The owner's `permissions.email` flag for the instance this call runs under.
 *
 * Read from the instance's own DO state, which is where the console writes it and where
 * `agent-think.ts` reads it for the chat path (`state.permissions?.email === true`). Fail-closed
 * on every uncertainty: no instance id, no state, an unreadable response — all "not permitted".
 * A permission that defaults to granted when its source is unreachable is not a permission.
 */
async function emailPermitted(env: Env, instanceId: string | undefined): Promise<boolean> {
	if (!instanceId) return false;
	try {
		const stub = env.AGENT.get(env.AGENT.idFromName(instanceId));
		const res = await stub.fetch(new Request("https://agent/state"));
		if (!res.ok) return false;
		const state = (await res.json()) as { permissions?: { email?: boolean } };
		return state.permissions?.email === true;
	} catch {
		return false;
	}
}

/** Resolve an access token, or an explanatory refusal. Never throws for the expected causes —
 *  "not connected" and "not permitted" are answers the model should read and relay, not errors. */
async function gmailToken(ctx: RegistryToolCtx): Promise<{ token: string } | { refusal: RegistryToolResult }> {
	if (!ctx.env || !ctx.userId) {
		return { refusal: fail("Gmail access requires an authenticated user context.") };
	}
	if (!(await emailPermitted(ctx.env, ctx.instanceId))) {
		return {
			refusal: fail(
				"Email access is not enabled for this agent. The owner turns it on in the console under Settings → Permissions & Connections.",
			),
		};
	}
	if (!ctx.connectorClient) {
		return { refusal: fail("Connector client unavailable in this context.") };
	}
	try {
		const token = await ctx.connectorClient("gmail").token({ scope: "read" });
		if (!token) return { refusal: fail("Gmail is not connected. Connect it in the console under Preferences → Connections.") };
		return { token };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { refusal: fail(`Gmail is not connected or its access could not be refreshed: ${msg}`) };
	}
}

const searchHandler: ToolDef["handler"] = async (ctx, input) => {
	const resolved = await gmailToken(ctx);
	if ("refusal" in resolved) return resolved.refusal;
	const { listMessages, buildQuery, GmailError } = await import("../gmail.js");

	// A raw `query` wins when given — Gmail's search syntax is far more expressive than the three
	// structured hints, and an agent that knows it should not be forced to round-trip through them.
	const raw = typeof input.query === "string" ? input.query.trim() : "";
	const query = raw || buildQuery({
		from: typeof input.from === "string" ? input.from : undefined,
		subject: typeof input.subject === "string" ? input.subject : undefined,
		withinDays: typeof input.within_days === "number" ? input.within_days : undefined,
	});
	try {
		const hits = await listMessages(resolved.token, query, typeof input.max === "number" ? input.max : 10);
		if (hits.length === 0) return ok(`No messages matched: ${query}`);
		return ok({ query, count: hits.length, messages: hits });
	} catch (e) {
		return fail(e instanceof GmailError ? e.message : `Gmail search failed: ${e instanceof Error ? e.message : String(e)}`);
	}
};

const readHandler: ToolDef["handler"] = async (ctx, input) => {
	const id = typeof input.message_id === "string" ? input.message_id.trim() : "";
	if (!id) return fail("message_id is required — get one from gmail_search.");
	const resolved = await gmailToken(ctx);
	if ("refusal" in resolved) return resolved.refusal;
	const { getMessage, GmailError } = await import("../gmail.js");
	try {
		const msg = await getMessage(resolved.token, id);
		return ok(msg);
	} catch (e) {
		return fail(e instanceof GmailError ? e.message : `Gmail message fetch failed: ${e instanceof Error ? e.message : String(e)}`);
	}
};

/**
 * Download one attachment INTO THE INSTANCE FILE STORE, and return its file id.
 *
 * It deliberately does not return the bytes. An attachment is a PDF or a spreadsheet; base64 of
 * one in a tool result is both useless to the model and large enough to evict the rest of the
 * context. Landing it in the file store instead puts it where every other surface already looks —
 * RAG indexes it, `fill_pdf_form` (#712) reads it by id, and the reply tool (#713) attaches it by
 * id — so the bytes cross the model's context exactly never.
 */
const downloadHandler: ToolDef["handler"] = async (ctx, input) => {
	const messageId = typeof input.message_id === "string" ? input.message_id.trim() : "";
	const attachmentId = typeof input.attachment_id === "string" ? input.attachment_id.trim() : "";
	if (!messageId || !attachmentId) {
		return fail("message_id and attachment_id are both required — gmail_read_message lists them.");
	}
	if (!ctx.instanceId) return fail("Downloading an attachment requires an agent instance to store it in.");
	const resolved = await gmailToken(ctx);
	if ("refusal" in resolved) return resolved.refusal;
	const env = ctx.env;

	const { getMessage, downloadAttachment, base64UrlToBase64, GmailError } = await import("../gmail.js");
	try {
		// Re-read the message for the attachment's declared name/type/size. The alternative is
		// trusting three more model-supplied strings, and the filename becomes an R2 key.
		const msg = await getMessage(resolved.token, messageId, 1);
		const att = msg.attachments.find((a) => a.attachmentId === attachmentId);
		if (!att) {
			const names = msg.attachments.map((a) => `${a.filename} (${a.attachmentId || "inline, no id"})`).join(", ");
			return fail(`That message has no attachment with id ${attachmentId}.${names ? ` It has: ${names}` : " It has no attachments."}`);
		}
		if (!att.attachmentId) {
			return fail(`"${att.filename}" is stored inline in the message rather than as a fetchable attachment, so it cannot be downloaded by id.`);
		}
		if (att.size > MAX_ATTACHMENT_BYTES) {
			return fail(`"${att.filename}" is ${Math.round(att.size / 1024 / 1024)}MB, over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB limit for agent downloads.`);
		}

		const { base64url, size } = await downloadAttachment(resolved.token, messageId, attachmentId);
		const stub = env.AGENT.get(env.AGENT.idFromName(ctx.instanceId));
		const doRes = await stub.fetch(
			new Request("https://agent/files", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: att.filename,
					content: "",
					contentBase64: base64UrlToBase64(base64url),
					mime_type: att.mimeType,
					tags: ["gmail", `message:${messageId}`],
					user_id: ctx.userId,
				}),
			}),
		);
		if (!doRes.ok) {
			return fail(`Downloaded "${att.filename}" but could not store it (${doRes.status}): ${(await doRes.text()).slice(0, 200)}`);
		}
		const meta = (await doRes.json()) as { id?: string; name?: string; size?: number };
		return ok({
			stored: true,
			file_id: meta.id,
			name: meta.name ?? att.filename,
			mime_type: att.mimeType,
			size: meta.size ?? size,
			note: "Saved to this agent's files. Refer to it by file_id from here on.",
		});
	} catch (e) {
		return fail(e instanceof GmailError ? e.message : `Attachment download failed: ${e instanceof Error ? e.message : String(e)}`);
	}
};

export const GMAIL_MANIFEST: ConnectorManifest = {
	id: "gmail",
	label: "Gmail",
	auth: {
		type: "oauth2",
		authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: "https://oauth2.googleapis.com/token",
		// `openid email` is what lets the status route say WHICH account is connected.
		// gmail.readonly covers search, message read AND messages.attachments.get — the whole of
		// this issue needs no scope the existing connections were not already granted.
		scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
		clientIdEnv: "GOOGLE_CLIENT_ID",
		secretEnv: "GOOGLE_CLIENT_SECRET",
	},
	tools: [
		{
			name: "gmail_search",
			scope: "read",
			description:
				"Search the owner's Gmail and list matching messages (newest first) with sender, subject, date, a snippet and the names of any attachments. Use `query` for full Gmail search syntax (e.g. 'from:kelly has:attachment newer_than:14d'), or the from/subject/within_days hints. Returns message ids for gmail_read_message.",
			handler: "gmail_search",
			params: {
				query: { type: "string", description: "Gmail search syntax. Overrides the hints below when given.", maxLength: 500 },
				from: { type: "string", description: "Sender filter, e.g. 'kelly' or 'str8.sets@bigpond.com'.", maxLength: 200 },
				subject: { type: "string", description: "Words expected in the subject.", maxLength: 200 },
				within_days: { type: "number", description: "How many days back to search." },
				max: { type: "number", description: "How many messages to return (1-25, default 10)." },
			},
		},
		{
			name: "gmail_read_message",
			scope: "read",
			description:
				"Read one Gmail message in full: body text, sender/recipients, and a manifest of its attachments with the ids gmail_download_attachment needs. Also returns the threading headers required to reply in-thread.",
			handler: "gmail_read_message",
			params: {
				message_id: { type: "string", required: true, description: "Message id from gmail_search.", maxLength: 100 },
			},
		},
		{
			name: "gmail_download_attachment",
			scope: "read",
			description:
				"Download one attachment from a Gmail message into this agent's file store and return its file_id. Does NOT return the file contents — use the file_id with the tools that read or fill files.",
			handler: "gmail_download_attachment",
			params: {
				message_id: { type: "string", required: true, description: "Message id the attachment belongs to.", maxLength: 100 },
				attachment_id: { type: "string", required: true, description: "Attachment id, from gmail_read_message.", maxLength: 400 },
			},
		},
	],
};

/** Compiled Connector — consumed by the registry exactly like any other connector.
 *  `scopes` derives from the tools: all three are `read`, so this still declares
 *  `{read:true, write:false}`, byte-for-byte the reach Gmail had before #711. */
export const GMAIL_CONNECTOR: Connector = compileConnector(GMAIL_MANIFEST, {
	gmail_search: searchHandler,
	gmail_read_message: readHandler,
	gmail_download_attachment: downloadHandler,
}).connector;
