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
 * Since #713 it also SENDS (`gmail_reply`, `gmail_send`). That flips `scopes.write` to true —
 * derived from the tools by `compileConnector`, not hand-declared — which is what brings sending
 * under the #90 per-instance write-consent gate. So a send passes THREE gates: the owner's
 * `permissions.email` flag, the agent's `capabilities.tools` allowlist, and an explicit
 * per-instance write consent. That is proportionate: mail leaves under the owner's own name, to
 * a real person, and cannot be recalled.
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
 *
 * EXPORTED since #721, and the reason is worth stating: the tool LISTING
 * (`instance-tool-policy.ts`) now has to answer the same question the chat runtime answers, and
 * the whole defect it fixes was two places computing "this agent's tools" from different inputs.
 * A second reader of `https://agent/state` — with its own idea of what an unreadable response
 * means — would be that defect again, one layer down. This is the one that fails closed and it
 * stays the only one.
 */
export async function emailPermitted(env: Env, instanceId: string | undefined): Promise<boolean> {
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

/** Gmail caps a message at 25MB; stay under it with room for base64 inflation and headers. */
const MAX_OUTGOING_BYTES = 15 * 1024 * 1024;

/**
 * Has this user's stored Gmail grant got the send scope?
 *
 * Read from `user_api_keys.granted_scopes` (migration 0133) rather than discovered by attempting
 * a send. The whole point is to refuse BEFORE the API call, with a sentence naming the fix — a
 * raw Google 403 says "insufficient authentication scopes", which tells the owner nothing about
 * where the reconnect button is.
 */
async function grantedScopesFor(env: Env, userId: string, instanceId: string | undefined): Promise<string | null | undefined> {
	const { listConnectorAccounts, pinnedAccountFor, resolveConnectorAccount } = await import("../connector-accounts.js");
	const accounts = await listConnectorAccounts(env, userId, "gmail");
	const resolved = resolveConnectorAccount(accounts, await pinnedAccountFor(env, instanceId, "gmail"), "Gmail");
	return resolved.ok ? resolved.account.grantedScopes : null;
}

/** May the mailbox this agent resolves to be MODIFIED — archived, marked read, relabelled? */
async function canModify(env: Env, userId: string, instanceId: string | undefined): Promise<boolean> {
	const { scopesAllowModify } = await import("../gmail.js");
	return scopesAllowModify(await grantedScopesFor(env, userId, instanceId));
}

async function canSend(env: Env, userId: string, instanceId: string | undefined): Promise<boolean> {
	// Resolve WHICH mailbox first (#715). This read was `.first()` over `(user_id, provider)`,
	// which stopped identifying one row the moment a second Gmail could exist: with two accounts
	// connected it answered from whichever row SQLite returned, so a send could be waved through
	// on the strength of a different mailbox's scopes — or blocked on it. The same defect class
	// as /v1/email/status and the connector catalog, missed here in that sweep.
	const { scopesAllowSend } = await import("../gmail.js");
	return scopesAllowSend(await grantedScopesFor(env, userId, instanceId));
}

const RECONNECT_TO_MODIFY =
	"This Gmail account was not authorised to change messages, so it cannot archive or mark mail " +
	"read. Reconnect it in the console (Preferences → Connections) and allow the manage-mail " +
	"permission — reading and sending are unaffected either way.";

const RECONNECT_TO_SEND =
	"Gmail is connected but was authorised for reading only. Reconnect Gmail in the console " +
	"(Preferences → Connections) to grant send access — the consent screen will now ask for it.";

/** Pull one instance file's bytes back out as standard base64, for attaching. */
async function readInstanceFile(
	env: Env,
	instanceId: string,
	fileId: string,
): Promise<{ base64: string; mimeType: string; filename: string; bytes: number } | { error: string }> {
	const stub = env.AGENT.get(env.AGENT.idFromName(instanceId));
	const res = await stub.fetch(new Request(`https://agent/files/${encodeURIComponent(fileId)}`));
	if (!res.ok) return { error: `No file ${fileId} in this agent's files.` };
	const buf = await res.arrayBuffer();
	if (buf.byteLength > MAX_OUTGOING_BYTES) {
		return { error: `File ${fileId} is ${Math.round(buf.byteLength / 1024 / 1024)}MB, over the ${MAX_OUTGOING_BYTES / 1024 / 1024}MB attachment limit.` };
	}
	let meta: { name?: string } = {};
	try {
		meta = JSON.parse(res.headers.get("X-File-Meta") ?? "{}") as { name?: string };
	} catch {
		/* the header is a convenience; a missing name falls back below */
	}
	// Chunked so a multi-MB file cannot blow the argument limit on String.fromCharCode.
	const bytes = new Uint8Array(buf);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 8192) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
	}
	return {
		base64: btoa(binary),
		mimeType: res.headers.get("Content-Type") || "application/octet-stream",
		filename: meta.name || fileId,
		bytes: buf.byteLength,
	};
}

/** Resolve `attachment_file_ids` into MIME parts, or the first refusal encountered. */
async function collectOutgoingAttachments(
	env: Env,
	instanceId: string,
	input: Record<string, unknown>,
): Promise<{ attachments: Array<{ filename: string; mimeType: string; base64: string }>; total: number } | { refusal: RegistryToolResult }> {
	const ids = Array.isArray(input.attachment_file_ids) ? input.attachment_file_ids : [];
	const attachments: Array<{ filename: string; mimeType: string; base64: string }> = [];
	let total = 0;
	for (const raw of ids) {
		const fileId = String(raw ?? "").trim();
		if (!fileId) continue;
		const file = await readInstanceFile(env, instanceId, fileId);
		if ("error" in file) return { refusal: fail(file.error) };
		total += file.bytes;
		if (total > MAX_OUTGOING_BYTES) {
			return { refusal: fail(`Those attachments total over the ${MAX_OUTGOING_BYTES / 1024 / 1024}MB limit for one message.`) };
		}
		attachments.push({ filename: file.filename, mimeType: file.mimeType, base64: file.base64 });
	}
	return { attachments, total };
}

/**
 * Reply to a message, in its thread, optionally attaching files from this agent's store.
 *
 * Recipients are taken from the PARENT message, never from the model. That is the one design
 * choice here worth defending: an agent that has just read untrusted mail is exactly the agent
 * whose "who should this go to" answer cannot be trusted, and a prompt-injected reply-to is a
 * silent exfiltration channel out of the owner's own mailbox. Wanting a different recipient is
 * what gmail_send is for, where the address is the caller's explicit, auditable input.
 */
const replyHandler: ToolDef["handler"] = async (ctx, input) => {
	const messageId = typeof input.message_id === "string" ? input.message_id.trim() : "";
	const body = typeof input.body === "string" ? input.body : "";
	if (!messageId) return fail("message_id is required — the message to reply to.");
	if (!body.trim()) return fail("body is required — the text of the reply.");
	if (!ctx.instanceId) return fail("Replying requires an agent instance.");

	const resolved = await gmailToken(ctx);
	if ("refusal" in resolved) return resolved.refusal;
	const env = ctx.env;
	if (!(await canSend(env, ctx.userId ?? "", ctx.instanceId))) return fail(RECONNECT_TO_SEND);

	const { getMessage, replyHeaders, replySubject, buildMimeMessage, sendMessage, GmailError } = await import("../gmail.js");
	try {
		const parent = await getMessage(resolved.token, messageId, 1);
		const gathered = await collectOutgoingAttachments(env, ctx.instanceId, input);
		if ("refusal" in gathered) return gathered.refusal;

		// Reply to the sender. `reply_all` adds the original To/Cc, minus nothing — Gmail dedupes
		// the owner's own address on delivery, and guessing which of several aliases is "me" here
		// would drop a legitimate recipient more often than it would avoid a self-copy.
		const to = parent.from;
		const cc = input.reply_all === true ? [parent.to, parent.cc].filter(Boolean).join(", ") : undefined;

		const mime = buildMimeMessage({
			to,
			...(cc ? { cc } : {}),
			subject: replySubject(parent.subject),
			body,
			...replyHeaders(parent),
			attachments: gathered.attachments,
		});
		const sent = await sendMessage(resolved.token, mime, parent.threadId);
		return ok({
			sent: true,
			to,
			...(cc ? { cc } : {}),
			subject: replySubject(parent.subject),
			attachments: gathered.attachments.map((a) => a.filename),
			message_id: sent.id,
			thread_id: sent.threadId,
		});
	} catch (e) {
		return fail(e instanceof GmailError ? e.message : `Reply failed: ${e instanceof Error ? e.message : String(e)}`);
	}
};

/** Send a new message to explicitly named recipients. */
const sendHandler: ToolDef["handler"] = async (ctx, input) => {
	const to = typeof input.to === "string" ? input.to.trim() : "";
	const subject = typeof input.subject === "string" ? input.subject : "";
	const body = typeof input.body === "string" ? input.body : "";
	if (!to) return fail("to is required — the recipient address.");
	if (!subject.trim()) return fail("subject is required.");
	if (!body.trim()) return fail("body is required.");
	if (!ctx.instanceId) return fail("Sending requires an agent instance.");

	const resolved = await gmailToken(ctx);
	if ("refusal" in resolved) return resolved.refusal;
	const env = ctx.env;
	if (!(await canSend(env, ctx.userId ?? "", ctx.instanceId))) return fail(RECONNECT_TO_SEND);

	const { buildMimeMessage, sendMessage, GmailError } = await import("../gmail.js");
	try {
		const gathered = await collectOutgoingAttachments(env, ctx.instanceId, input);
		if ("refusal" in gathered) return gathered.refusal;
		const cc = typeof input.cc === "string" && input.cc.trim() ? input.cc.trim() : undefined;
		const mime = buildMimeMessage({ to, ...(cc ? { cc } : {}), subject, body, attachments: gathered.attachments });
		const sent = await sendMessage(resolved.token, mime);
		return ok({
			sent: true,
			to,
			...(cc ? { cc } : {}),
			subject,
			attachments: gathered.attachments.map((a) => a.filename),
			message_id: sent.id,
			thread_id: sent.threadId,
		});
	} catch (e) {
		return fail(e instanceof GmailError ? e.message : `Send failed: ${e instanceof Error ? e.message : String(e)}`);
	}
};

/**
 * Archive, or mark read — both are `messages.modify` with a label removed.
 *
 * Archiving is REVERSIBLE and that is why it is here while trashing is not: an archived message
 * is still in All Mail and one search away, so the worst case of a wrong call is that the owner
 * finds it again. Deleting is a different promise, needs no more scope than this, and is
 * deliberately not offered — an agent acting on mail it just read should not be one prompt
 * injection away from emptying an inbox.
 */
function labelChangeHandler(
	action: "archive" | "mark_read",
): NonNullable<ToolDef["handler"]> {
	return async (ctx, input) => {
		const messageId = typeof input.message_id === "string" ? input.message_id.trim() : "";
		if (!messageId) return fail("message_id is required — get one from gmail_search.");
		const resolved = await gmailToken(ctx);
		if ("refusal" in resolved) return resolved.refusal;
		const env = ctx.env;
		if (!(await canModify(env, ctx.userId ?? "", ctx.instanceId))) return fail(RECONNECT_TO_MODIFY);

		const { modifyMessageLabels, INBOX_LABEL, UNREAD_LABEL, GmailError } = await import("../gmail.js");
		try {
			const remove = action === "archive" ? [INBOX_LABEL] : [UNREAD_LABEL];
			const out = await modifyMessageLabels(resolved.token, messageId, { removeLabelIds: remove });
			return ok({
				message_id: out.id,
				action,
				labels_now: out.labelIds,
				note:
					action === "archive"
						? "Removed from the inbox. It is still in All Mail and can be found by search."
						: "Marked as read.",
			});
		} catch (e) {
			return fail(e instanceof GmailError ? e.message : `Could not ${action} that message: ${e instanceof Error ? e.message : String(e)}`);
		}
	};
}

export const GMAIL_MANIFEST: ConnectorManifest = {
	id: "gmail",
	label: "Gmail",
	// #720. The four write tools are gmail_reply, gmail_send, gmail_archive and gmail_mark_read.
	// Sending leads because it is the irreversible one and the one that leaves the building: OAuth
	// is on the owner's own mailbox, so mail really does go out under their name, to whoever the
	// agent addresses it to.
	//
	// Archive and mark-read are named too, and NOT hedged on whether `gmail.modify` was actually
	// granted on a given connection (#717 owns that): this sentence says what granting the
	// connector PERMITS, and an owner deciding is entitled to the whole answer. There is no delete
	// or trash tool, deliberately (#716), so nothing here says one.
	writeMeaning:
		"Send and reply to mail from your own mailbox, as you, to anyone the agent addresses. Sent mail cannot be recalled. It can also archive messages and mark them read; it cannot delete anything.",
	auth: {
		type: "oauth2",
		authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: "https://oauth2.googleapis.com/token",
		// `openid email` is what lets the status route say WHICH account is connected.
		// gmail.readonly covers search, message read AND messages.attachments.get.
		// gmail.send (#713) is send-ONLY — it cannot read, delete or modify. `gmail.modify` would
		// also cover sending and is deliberately NOT requested: it would let a bug delete mail.
		//
		// This list is what a NEW consent asks for. Connections made before #713 hold readonly
		// alone, keep working for the read tools, and are caught by the `canSend` check rather
		// than by a 403 — see routes/email.ts and migration 0133.
		scopes: [
			"openid",
			"email",
			"https://www.googleapis.com/auth/gmail.readonly",
			"https://www.googleapis.com/auth/gmail.send",
			// gmail.modify (#716) — archive, mark read, relabel. There is no narrower scope for it.
			// It can also move mail to Trash, but NOT permanently delete: that needs
			// https://mail.google.com/, which this codebase never requests. So the worst an agent
			// can do to a message is recoverable by the owner.
			//
			// Declared, not required. Google's consent screen lets a person grant send but decline
			// this, and only what was actually GRANTED is recorded — so an account without it keeps
			// reading and sending, and only the two action tools refuse.
			"https://www.googleapis.com/auth/gmail.modify",
		],
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
			name: "gmail_reply",
			scope: "write",
			description:
				"Reply to a Gmail message in its own thread, as the owner, optionally attaching files from this agent's file store by id. The recipient is taken from the message being replied to and cannot be overridden — use gmail_send to write to a different address. This really sends: there is no draft step and no undo.",
			handler: "gmail_reply",
			params: {
				message_id: { type: "string", required: true, description: "The message to reply to, from gmail_search.", maxLength: 100 },
				body: { type: "string", required: true, description: "The reply text. Plain text; write it as you want it read.", maxLength: 20000 },
				attachment_file_ids: { type: "array", description: "File ids from this agent's file store to attach, e.g. a filled form." },
				reply_all: { type: "boolean", description: "Also copy the original To and Cc recipients. Default false — reply to the sender only." },
			},
		},
		{
			name: "gmail_send",
			scope: "write",
			description:
				"Send a NEW Gmail message as the owner, to an address you name explicitly, optionally with attachments from this agent's file store. This really sends: there is no draft step and no undo. To answer a message you received, prefer gmail_reply so it threads.",
			handler: "gmail_send",
			params: {
				to: { type: "string", required: true, description: "Recipient address.", maxLength: 500 },
				cc: { type: "string", description: "Cc addresses, comma-separated.", maxLength: 500 },
				subject: { type: "string", required: true, description: "Subject line.", maxLength: 500 },
				body: { type: "string", required: true, description: "Message text.", maxLength: 20000 },
				attachment_file_ids: { type: "array", description: "File ids from this agent's file store to attach." },
			},
		},
		{
			name: "gmail_archive",
			scope: "write",
			description:
				"Archive a Gmail message — remove it from the inbox. It stays in All Mail and can still be found by search, so this is reversible. Needs the manage-mail permission on the connected account.",
			handler: "gmail_archive",
			params: {
				message_id: { type: "string", required: true, description: "Message id from gmail_search.", maxLength: 100 },
			},
		},
		{
			name: "gmail_mark_read",
			scope: "write",
			description:
				"Mark a Gmail message as read. Needs the manage-mail permission on the connected account.",
			handler: "gmail_mark_read",
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
	gmail_reply: replyHandler,
	gmail_send: sendHandler,
	gmail_archive: labelChangeHandler("archive"),
	gmail_mark_read: labelChangeHandler("mark_read"),
}).connector;
