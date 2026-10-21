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
import { clipMarked } from "../clip-marked.js";
import { addressesIn, MAX_READ_CHARS, replyRecipient, scopedQuery, SUMMARY_FIELD_CHARS, validPageToken } from "../gmail-identity.js";
import { identityFor, NOT_IN_SCOPE, outsideScope, replyAllCc, resolvePinnedSender } from "./gmail-identity-guard.js";
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
 * A tool result carrying text SOMEONE ELSE WROTE (#725).
 *
 * The platform fenced a web page it fetched, a search result, an MCP resource and an HTTP body —
 * and not the mail a stranger sent you. That was backwards. Anyone who knows the owner's address
 * can put an instruction in a subject line and wait; unlike a search result, they do not even
 * have to rank for anything. Mail is the most cheaply attacker-authored text this platform
 * touches, and it was the one input reaching the model bare.
 *
 * The WRAP is no longer applied here (#752). These two tools declare `untrustedOutput: true` in the
 * manifest and `runRegistryTool` fences once, which covers chat, a pipeline step,
 * `POST /v1/instances/:id/tools/:name` and MCP from the declaration rather than from this helper
 * having been called. What survives is the `origin` — "an email from <sender>" is a fact only this
 * module has, and it is the part of a fence a reader actually uses.
 *
 * That this helper had to exist at all is the argument for the move: it is a THIRD wording of the
 * same idea (after `mcp.ts` and `web-search.ts`), each written by an author who could not tell from
 * any declaration whether their connector needed one. The pipeline binder unwraps the fence
 * (`unfenceUntrusted`), so a `$ref` off a message still resolves — the fence is for the model, and
 * the binder is not one.
 *
 * Only the tools that return third-party prose declare it. `gmail_archive`'s label list is OUR
 * words about an outcome. `gmail_download_attachment` is mostly ours too — `stored`, `file_id`,
 * `mime_type`, `size` and the `note` are platform sentences — but `name: meta.name ?? att.filename`
 * is the sender's, and the three refusal strings above it also interpolate `att.filename`. The
 * payload is left unfenced (ADR 0006 F2) because a filename is a short string with little room for
 * prose injection, and wrapping a mostly-ours result teaches the model that a fence means nothing
 * in particular — which is the exact defect F2 exists to prevent. The declaration is explicit
 * (`untrustedOutput: false` in the manifest, now required) so the choice is on record (#725 AC4).
 */
function okUntrusted(payload: unknown, origin: string): RegistryToolResult {
	const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
	return { content: body, success: true, origin };
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
				"Email access is not enabled for this agent. The owner turns it on in the console under Permissions → Permissions & Connections.",
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
	const { searchMessages, buildQuery, GmailError } = await import("../gmail.js");
	const identity = await identityFor(ctx.env, ctx.instanceId);
	if ("refusal" in identity) return fail(identity.refusal);
	const pin = identity.pin;
	const pageToken = input.page_token === undefined || input.page_token === "" ? undefined : validPageToken(input.page_token);
	if (pageToken === null) return fail("page_token must be the next_page_token a previous gmail_search returned, copied exactly.");

	// A raw `query` wins when given — Gmail's search syntax is far more expressive than the three
	// structured hints, and an agent that knows it should not be forced to round-trip through them.
	const raw = typeof input.query === "string" ? input.query.trim() : "";
	const query = raw || buildQuery({
		from: typeof input.from === "string" ? input.from : undefined,
		subject: typeof input.subject === "string" ? input.subject : undefined,
		withinDays: typeof input.within_days === "number" ? input.within_days : undefined,
	});
	try {
		// A scoped instance's query is the owner's scope AND the agent's query — the agent can narrow it, never widen it.
		const scoped = pin && pin.inboundScope.length > 0;
		const page = await searchMessages(resolved.token, pin ? scopedQuery(pin.inboundScope, query) : query, {
			max: typeof input.max === "number" ? input.max : 10,
			pageToken,
			recipients: !!scoped,
		});
		// The query filter is a convenience; the header check is the enforcement, so a hit Gmail matched loosely is still dropped.
		const inScope = page.hits.filter((h) => !h.recipients || !outsideScope(pin, h.recipients));
		const omitted = page.hits.length - inScope.length;
		const hits = inScope.map(({ recipients: _recipients, ...h }) =>
			pin
				? {
						...h,
						from: clipMarked(h.from, SUMMARY_FIELD_CHARS),
						subject: clipMarked(h.subject, SUMMARY_FIELD_CHARS),
						snippet: clipMarked(h.snippet, SUMMARY_FIELD_CHARS),
					}
				: h,
		);
		const paging = {
			...(page.nextPageToken ? { next_page_token: page.nextPageToken } : {}),
			...(page.unreadable > 0 ? { unreadable: page.unreadable } : {}),
			...(omitted > 0 ? { out_of_scope_omitted: omitted } : {}),
		};

		// "No matches" is OUR sentence about an empty result — nothing in it came from a stranger,
		// so it goes in `head` with an empty body and the dispatcher fences nothing (#752). The
		// declaration is per TOOL and fail-safe; this is the one branch where the per-RESULT fact
		// differs, and F2 says a platform sentence must not end up inside a block.
		if (hits.length === 0 && Object.keys(paging).length === 0) return { head: `No messages matched: ${query}`, content: "", success: true };
		// Every field here is written by whoever sent the mail: the sender name, the subject, the
		// snippet, and the attachment filenames.
		return okUntrusted({ query, count: hits.length, messages: hits, ...paging }, "the owner's Gmail inbox");
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
	const identity = await identityFor(ctx.env, ctx.instanceId);
	if ("refusal" in identity) return fail(identity.refusal);
	const pin = identity.pin;
	// A scoped instance reads a bounded preview and continues with `offset`; an unconfigured one keeps the 40000-char read, now announced when it cuts.
	const wanted = typeof input.max_chars === "number" && Number.isFinite(input.max_chars) ? Math.floor(input.max_chars) : pin ? pin.previewChars : MAX_READ_CHARS;
	const maxChars = Math.max(1, Math.min(MAX_READ_CHARS, wanted));
	const offset = typeof input.offset === "number" && Number.isFinite(input.offset) ? Math.max(0, Math.floor(input.offset)) : 0;
	try {
		const { deliveredTo, xOriginalTo, ...msg } = await getMessage(resolved.token, id, maxChars, offset);
		if (outsideScope(pin, { to: msg.to, cc: msg.cc, deliveredTo, xOriginalTo })) return fail(NOT_IN_SCOPE);
		return okUntrusted(msg, `an email from ${msg.from || "an unknown sender"}`);
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
	const attachmentRef = typeof input.attachment_id === "string" ? input.attachment_id.trim() : "";
	if (!messageId || !attachmentRef) {
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
		//
		// Resolve the attachment by EITHER the opaque attachmentId OR the filename (#755). The id the
		// model holds may have been garbled, truncated by capToolResult, or rotated by Gmail between
		// two calls — any of which makes an exact-id match impossible. A filename is short, human-
		// readable, and cannot be cut by the cap. The att we find here is authoritative: we use
		// att.attachmentId (from Gmail's own response) for the download call, never the model-supplied
		// token. That preserves the property the re-fetch exists to protect (filename → R2 key comes
		// from Gmail, not from the model) while removing the fragile round-trip of a long opaque token.
		const msg = await getMessage(resolved.token, messageId, 1);
		const identity = await identityFor(env, ctx.instanceId);
		if ("refusal" in identity) return fail(identity.refusal);
		if (outsideScope(identity.pin, msg)) return fail(NOT_IN_SCOPE);
		// Prefer exact attachmentId match; fall back to filename match.
		let att = msg.attachments.find((a) => a.attachmentId === attachmentRef);
		if (!att) {
			const byName = msg.attachments.filter((a) => a.filename === attachmentRef);
			if (byName.length === 1) {
				att = byName[0];
			} else if (byName.length > 1) {
				const refs = byName.map((a, i) => `att${i + 1}: "${a.filename}"`).join(", ");
				return fail(`"${attachmentRef}" matches more than one attachment in this message (${refs}). Use the attachment_id from gmail_read_message to disambiguate.`);
			}
		}
		if (!att) {
			// Refusal text lists filename + ordinal refs — NOT the raw opaque attachmentId tokens,
			// which are long blobs the model cannot reliably copy. (#755)
			const refs = msg.attachments.map((a, i) => `att${i + 1}: "${a.filename}"`).join(", ");
			return fail(`That message has no attachment matching "${attachmentRef}".${refs ? ` It has: ${refs}` : " It has no attachments."}`);
		}
		if (!att.attachmentId) {
			return fail(`"${att.filename}" is stored inline in the message rather than as a fetchable attachment, so it cannot be downloaded by id.`);
		}
		if (att.size > MAX_ATTACHMENT_BYTES) {
			return fail(`"${att.filename}" is ${Math.round(att.size / 1024 / 1024)}MB, over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB limit for agent downloads.`);
		}

		// Use att.attachmentId (from Gmail's fresh response), not the model-supplied attachmentRef.
		const { base64url, size } = await downloadAttachment(resolved.token, messageId, att.attachmentId);
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

/**
 * The two optional Gmail powers (#718). `gmail.send` is send-ONLY — it cannot read, delete or modify.
 * `gmail.modify` (#716) is archive, mark read, relabel; there is no narrower scope for it. It can move
 * mail to Trash but NOT permanently delete (that needs https://mail.google.com/, never requested), so
 * the worst an agent can do to a message is recoverable by the owner.
 *
 * The labels are what the console's "Allow …" buttons say, and the refusals below quote them, so a
 * refusal names an action that exists on screen (#517).
 */
export const GMAIL_SEND_GRANT = { id: "send", label: "Send and reply as you", scopes: ["https://www.googleapis.com/auth/gmail.send"] };
export const GMAIL_MODIFY_GRANT = { id: "modify", label: "Archive and mark read", scopes: ["https://www.googleapis.com/auth/gmail.modify"] };
/**
 * Filter management (#719) — `gmail.settings.basic`. Optional like the two above, so it is never in
 * the connect-time bundle. The scope also reaches forwarding settings; no tool uses that, and
 * `gmail_create_filter` refuses forwarding at its boundary and runs only on a per-call approval.
 */
export const GMAIL_FILTER_GRANT = { id: "filters", label: "Create filters (each one approved by you)", scopes: ["https://www.googleapis.com/auth/gmail.settings.basic"] };

const allowAction = (label: string) =>
	`In the console, open Preferences → Connections and use "Allow: ${label}" on Gmail — what it can already do is kept, nothing is reconnected from scratch.`;

const RECONNECT_TO_MODIFY =
	`This Gmail account has not been allowed to change messages, so it cannot archive or mark mail read. ${allowAction(GMAIL_MODIFY_GRANT.label)}`;

const RECONNECT_TO_SEND = `This Gmail account has not been allowed to send. ${allowAction(GMAIL_SEND_GRANT.label)}`;

const RECONNECT_TO_FILTER = `This Gmail account has not been allowed to manage filters. ${allowAction(GMAIL_FILTER_GRANT.label)}`;

/** The mailbox this agent's Gmail calls resolve to (#715) — what a filter card names and is bound to. */
async function resolveMailbox(env: Env, userId: string, instanceId: string | undefined): Promise<{ ok: true; accountId: string; display: string; grantedScopes: string | null } | { ok: false; error: string }> {
	const { listConnectorAccounts, pinnedAccountFor, resolveConnectorAccount } = await import("../connector-accounts.js");
	const resolved = resolveConnectorAccount(await listConnectorAccounts(env, userId, "gmail"), await pinnedAccountFor(env, instanceId, "gmail"), "Gmail");
	if (!resolved.ok) return { ok: false, error: resolved.message };
	const a = resolved.account;
	return { ok: true, accountId: a.accountId, display: a.label?.trim() || a.accountId || "the connected Gmail account", grantedScopes: a.grantedScopes };
}

/**
 * When `gmail_create_filter` is QUEUED (#719): validate it, check the mailbox may manage filters,
 * bind the call to that mailbox, and compose the card the owner reads. An invalid filter is refused
 * here, so nothing the platform would refuse is ever put in front of the owner to approve.
 */
const prepareFilterApproval: NonNullable<ToolDef["approval"]>["prepare"] = async (ctx, args) => {
	const { parseFilterRequest, filterApprovalCard } = await import("../gmail-filter.js");
	const parsed = parseFilterRequest(args);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	if (!ctx.env || !ctx.userId) return { ok: false, error: "Gmail access requires an authenticated user context." };
	if (!(await emailPermitted(ctx.env, ctx.instanceId))) {
		return { ok: false, error: "Email access is not enabled for this agent. The owner turns it on in the console under Permissions → Permissions & Connections." };
	}
	const mailbox = await resolveMailbox(ctx.env, ctx.userId, ctx.instanceId);
	if (!mailbox.ok) return { ok: false, error: mailbox.error };
	const { scopesAllowFilters } = await import("../gmail.js");
	if (!scopesAllowFilters(mailbox.grantedScopes)) return { ok: false, error: RECONNECT_TO_FILTER };
	// The mailbox goes INTO the call: the approved call is checked against what the owner saw.
	const { mailbox_account: _ignored, ...rest } = args;
	return { ok: true, args: { ...rest, mailbox_account: mailbox.accountId }, card: filterApprovalCard(parsed.request, mailbox.display) };
};

/** Runs only from an approved ticket — the registry queues every other call (#719). */
const createFilterHandler: ToolDef["handler"] = async (ctx, input) => {
	const { parseFilterRequest, gmailFilterBody, describeCriteria, describeActions } = await import("../gmail-filter.js");
	const parsed = parseFilterRequest(input);
	if (!parsed.ok) return fail(parsed.error);
	const resolved = await gmailToken(ctx);
	if ("refusal" in resolved) return resolved.refusal;
	const mailbox = await resolveMailbox(ctx.env, ctx.userId ?? "", ctx.instanceId);
	if (!mailbox.ok) return fail(mailbox.error);
	// An approval is for ONE mailbox. If this agent now resolves to a different one (re-pinned,
	// reconnected), the owner approved something else, so nothing is created.
	if (typeof input.mailbox_account !== "string" || input.mailbox_account !== mailbox.accountId) {
		return fail(`This filter was approved for a different Gmail account than the one this agent now uses (${mailbox.display}), so it was not created. Ask for it again.`);
	}
	const { scopesAllowFilters, listLabels, createFilter, GmailError } = await import("../gmail.js");
	if (!scopesAllowFilters(mailbox.grantedScopes)) return fail(RECONNECT_TO_FILTER);
	try {
		let labelId: string | null = null;
		if (parsed.request.label) {
			const label = (await listLabels(resolved.token)).find((l) => l.type === "user" && l.name === parsed.request.label);
			if (!label) return fail(`There is no label named "${parsed.request.label}" in ${mailbox.display}. Create it in Gmail first; this tool does not create labels.`);
			labelId = label.id;
		}
		const out = await createFilter(resolved.token, gmailFilterBody(parsed.request, labelId));
		return ok({
			filter_id: out.id,
			mailbox: mailbox.display,
			matches: describeCriteria(parsed.request.criteria),
			does: describeActions(parsed.request),
			note: "Created. It applies to future matching mail until it is deleted in Gmail → Settings → Filters.",
		});
	} catch (e) {
		return fail(e instanceof GmailError ? e.message : `Could not create the filter: ${e instanceof Error ? e.message : String(e)}`);
	}
};

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
	const identity = await identityFor(env, ctx.instanceId);
	if ("refusal" in identity) return fail(identity.refusal);
	const sender = identity.pin ? await resolvePinnedSender(resolved.token, identity.pin) : null;
	if (sender && "refusal" in sender) return fail(sender.refusal);
	try {
		const parent = await getMessage(resolved.token, messageId, 1);
		if (outsideScope(identity.pin, parent)) return fail(NOT_IN_SCOPE);
		const gathered = await collectOutgoingAttachments(env, ctx.instanceId, input);
		if ("refusal" in gathered) return gathered.refusal;

		// Reply to the sender. Unconfigured: `reply_all` adds the original To/Cc, minus nothing — Gmail dedupes
		// the owner's own address on delivery. A pinned instance knows which addresses are "me" (its sender and
		// its scope), so those are dropped, and it honours a single valid Reply-To on the parent (#1279).
		const target = sender ? replyRecipient(parent, sender.sender.own) : { to: parent.from, viaReplyTo: false };
		const to = target.to;
		const cc = input.reply_all !== true ? undefined : sender ? replyAllCc(parent, [...sender.sender.own, ...addressesIn(to)]) : [parent.to, parent.cc].filter(Boolean).join(", ");

		const mime = buildMimeMessage({
			...(sender ? { from: sender.sender.from, replyTo: sender.sender.replyTo } : {}),
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
			...(sender ? { from: sender.sender.alias.email, reply_to_honoured: target.viaReplyTo } : {}),
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
	const identity = await identityFor(env, ctx.instanceId);
	if ("refusal" in identity) return fail(identity.refusal);
	const sender = identity.pin ? await resolvePinnedSender(resolved.token, identity.pin) : null;
	if (sender && "refusal" in sender) return fail(sender.refusal);
	try {
		const gathered = await collectOutgoingAttachments(env, ctx.instanceId, input);
		if ("refusal" in gathered) return gathered.refusal;
		const cc = typeof input.cc === "string" && input.cc.trim() ? input.cc.trim() : undefined;
		const mime = buildMimeMessage({ ...(sender ? { from: sender.sender.from, replyTo: sender.sender.replyTo } : {}), to, ...(cc ? { cc } : {}), subject, body, attachments: gathered.attachments });
		const sent = await sendMessage(resolved.token, mime);
		return ok({
			sent: true,
			...(sender ? { from: sender.sender.alias.email } : {}),
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
 * Save a reply as a Gmail DRAFT — the message goes to Drafts, not to the wire.
 *
 * Everything up to and including the MIME is identical to `replyHandler` — the same recipient
 * derivation (from the parent, never from the model), the same threading headers, the same
 * attachment resolution. The only difference is the API call: `createDraft` instead of
 * `sendMessage`, which POSTs `{message:{raw,threadId}}` to `/drafts` rather than `{raw,threadId}`
 * to `/messages/send`. That single fork is what keeps the message out of the recipient's inbox.
 *
 * Gated by `canModify` (gmail.modify) because `drafts.create` needs it. The #90 write-consent
 * gate still applies because the tool declares `scope: "write"`.
 *
 * Recipients are taken from the PARENT message, never from the model — same reasoning as
 * `replyHandler`. A draft tool that accepted a model-supplied `to` would still be an
 * exfiltration channel: the owner reviews the draft and sends it, including to wherever the
 * model put it.
 */
const draftReplyHandler: ToolDef["handler"] = async (ctx, input) => {
	const messageId = typeof input.message_id === "string" ? input.message_id.trim() : "";
	const body = typeof input.body === "string" ? input.body : "";
	if (!messageId) return fail("message_id is required — the message to reply to.");
	if (!body.trim()) return fail("body is required — the text of the draft reply.");
	if (!ctx.instanceId) return fail("Drafting requires an agent instance.");

	const resolved = await gmailToken(ctx);
	if ("refusal" in resolved) return resolved.refusal;
	const env = ctx.env;
	if (!(await canModify(env, ctx.userId ?? "", ctx.instanceId))) return fail(RECONNECT_TO_MODIFY);

	const { getMessage, replyHeaders, replySubject, buildMimeMessage, createDraft, GmailError } = await import("../gmail.js");
	const identity = await identityFor(env, ctx.instanceId);
	if ("refusal" in identity) return fail(identity.refusal);
	const sender = identity.pin ? await resolvePinnedSender(resolved.token, identity.pin) : null;
	if (sender && "refusal" in sender) return fail(sender.refusal);
	try {
		const parent = await getMessage(resolved.token, messageId, 1);
		if (outsideScope(identity.pin, parent)) return fail(NOT_IN_SCOPE);
		const gathered = await collectOutgoingAttachments(env, ctx.instanceId, input);
		if ("refusal" in gathered) return gathered.refusal;

		const target = sender ? replyRecipient(parent, sender.sender.own) : { to: parent.from, viaReplyTo: false };
		const to = target.to;
		const cc = input.reply_all !== true ? undefined : sender ? replyAllCc(parent, [...sender.sender.own, ...addressesIn(to)]) : [parent.to, parent.cc].filter(Boolean).join(", ");

		const mime = buildMimeMessage({
			...(sender ? { from: sender.sender.from, replyTo: sender.sender.replyTo } : {}),
			to,
			...(cc ? { cc } : {}),
			subject: replySubject(parent.subject),
			body,
			...replyHeaders(parent),
			attachments: gathered.attachments,
		});
		const draft = await createDraft(resolved.token, mime, parent.threadId);
		return ok({
			drafted: true,
			...(sender ? { from: sender.sender.alias.email, reply_to_honoured: target.viaReplyTo } : {}),
			to,
			...(cc ? { cc } : {}),
			subject: replySubject(parent.subject),
			attachments: gathered.attachments.map((a) => a.filename),
			draft_id: draft.draftId,
			gmail_url: draft.gmailUrl,
			note: "Saved to Gmail Drafts. Open the link to review and send.",
		});
	} catch (e) {
		return fail(e instanceof GmailError ? e.message : `Draft reply failed: ${e instanceof Error ? e.message : String(e)}`);
	}
};

/**
 * Send an existing Gmail draft that the owner has approved, by its draft id.
 *
 * Gated by `canSend` (gmail.send) — the same gate as `sendHandler`. The draft is moved out of
 * Drafts and delivered; after a successful call the draft id is no longer valid.
 *
 * The canonical flow is: `gmail_draft_reply` → owner reviews in Gmail → `gmail_draft_send`.
 */
const draftSendHandler: ToolDef["handler"] = async (ctx, input) => {
	const draftId = typeof input.draft_id === "string" ? input.draft_id.trim() : "";
	if (!draftId) return fail("draft_id is required — get it from gmail_draft_reply.");

	const resolved = await gmailToken(ctx);
	if ("refusal" in resolved) return resolved.refusal;
	const env = ctx.env;
	if (!(await canSend(env, ctx.userId ?? "", ctx.instanceId))) return fail(RECONNECT_TO_SEND);

	const { sendDraft, getDraftFrom, GmailError } = await import("../gmail.js");
	const identity = await identityFor(env, ctx.instanceId);
	if ("refusal" in identity) return fail(identity.refusal);
	try {
		// A pinned instance sends a draft only if it was written as the pinned, still-verified sender.
		if (identity.pin) {
			const sender = await resolvePinnedSender(resolved.token, identity.pin);
			if ("refusal" in sender) return fail(sender.refusal);
			if (addressesIn(await getDraftFrom(resolved.token, draftId))[0] !== sender.sender.alias.email) {
				return fail(`That draft is not from ${sender.sender.alias.email}, this agent's sender, so it was not sent.`);
			}
		}
		const sent = await sendDraft(resolved.token, draftId);
		return ok({
			sent: true,
			message_id: sent.id,
			thread_id: sent.threadId,
			note: "Draft sent. It no longer exists in Drafts.",
		});
	} catch (e) {
		return fail(e instanceof GmailError ? e.message : `Draft send failed: ${e instanceof Error ? e.message : String(e)}`);
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

		const { modifyMessageLabels, getMessageRecipients, INBOX_LABEL, UNREAD_LABEL, GmailError } = await import("../gmail.js");
		const identity = await identityFor(env, ctx.instanceId);
		if ("refusal" in identity) return fail(identity.refusal);
		try {
			if (identity.pin && identity.pin.inboundScope.length > 0 && outsideScope(identity.pin, await getMessageRecipients(resolved.token, messageId))) return fail(NOT_IN_SCOPE);
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
		"Send and reply to mail from your own mailbox, as you, to anyone the agent addresses. Sent mail cannot be recalled. It can also save draft replies for you to review before sending, archive messages and mark them read, and propose Gmail filters that you approve one at a time (never forwarding); it cannot delete anything.",
	auth: {
		type: "oauth2",
		authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: "https://oauth2.googleapis.com/token",
		// What a PLAIN connect asks for (#718): read-only. `openid email` is what lets the status
		// route say WHICH account is connected; gmail.readonly covers search, message read AND
		// messages.attachments.get. Gmail is the connector whose content strangers write, and
		// sending is "the most consequential thing an agent on this platform can do"
		// (lib/gmail.ts), so it is not held until the owner chooses it.
		scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
		// Asked for only when chosen — ticked at connect, or "Allow …" later (#718). Requested with
		// `include_granted_scopes`, and the stored grant is MERGED, so allowing one never drops
		// another (routes/email.ts). Connections made before this hold whatever they were granted
		// and lose nothing; missing one of these is an offer, never a "reconnect".
		optionalGrants: [GMAIL_SEND_GRANT, GMAIL_MODIFY_GRANT, GMAIL_FILTER_GRANT],
		clientIdEnv: "GOOGLE_CLIENT_ID",
		secretEnv: "GOOGLE_CLIENT_SECRET",
	},
	tools: [
		{
			name: "gmail_search",
			untrustedOutput: true,
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
				page_token: { type: "string", description: "The next_page_token from a previous gmail_search, to get the following page of the same query.", maxLength: 512 },
			},
		},
		{
			name: "gmail_read_message",
			untrustedOutput: true,
			scope: "read",
			description:
				"Read one Gmail message in full: body text, sender/recipients, and a manifest of its attachments with the ids gmail_download_attachment needs. Also returns the threading headers required to reply in-thread.",
			handler: "gmail_read_message",
			params: {
				message_id: { type: "string", required: true, description: "Message id from gmail_search.", maxLength: 100 },
				max_chars: { type: "number", description: "How many body characters to return (1-40000). Defaults to a bounded preview for an agent with a pinned Gmail identity, else 40000." },
				offset: { type: "number", description: "Where in the body to start — pass nextOffset from a previous read to continue a truncated body." },
			},
		},
		{
			name: "gmail_reply",
			untrustedOutput: false,
			scope: "write",
			description:
				"Reply to a Gmail message in its own thread, as the owner, optionally attaching files from this agent's file store by id. The recipient is taken from the message being replied to and cannot be overridden — use gmail_send to write to a different address. This really sends: there is no draft step and no undo. To save the reply for the owner to review first, use gmail_draft_reply.",
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
			untrustedOutput: false,
			scope: "write",
			description:
				"Send a NEW Gmail message as the owner, to an address you name explicitly, optionally with attachments from this agent's file store. This really sends: there is no draft step and no undo, and no tool drafts a NEW message (gmail_draft_reply drafts replies only). To answer a message you received, prefer gmail_reply so it threads.",
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
			name: "gmail_draft_reply",
			untrustedOutput: false,
			scope: "write",
			description:
				"Save a reply to a Gmail message as a DRAFT — nothing is sent until the owner clicks Send in Gmail. Returns a link to the draft. The recipient is the original sender and cannot be overridden. Needs the manage-mail permission (gmail.modify). To send without a draft, use gmail_reply.",
			handler: "gmail_draft_reply",
			params: {
				message_id: { type: "string", required: true, description: "The message to reply to, from gmail_search.", maxLength: 100 },
				body: { type: "string", required: true, description: "The reply text. Plain text; write it as you want it read.", maxLength: 20000 },
				attachment_file_ids: { type: "array", description: "File ids from this agent's file store to attach." },
				reply_all: { type: "boolean", description: "Also copy the original To and Cc recipients. Default false — reply to the sender only." },
			},
		},
		{
			name: "gmail_draft_send",
			untrustedOutput: false,
			scope: "write",
			description:
				"Send an existing Gmail draft that the owner has reviewed and approved, by its draft id. The draft is moved out of Drafts and delivered. Needs the send permission (gmail.send). Get the draft_id from gmail_draft_reply.",
			handler: "gmail_draft_send",
			params: {
				draft_id: { type: "string", required: true, description: "The draft id returned by gmail_draft_reply.", maxLength: 200 },
			},
		},
		{
			name: "gmail_archive",
			untrustedOutput: false,
			scope: "write",
			description:
				"Archive a Gmail message — remove it from the inbox. It stays in All Mail and can be found by search — reversible. Needs the manage-mail permission.",
			handler: "gmail_archive",
			params: {
				message_id: { type: "string", required: true, description: "Message id from gmail_search.", maxLength: 100 },
			},
		},
		{
			name: "gmail_mark_read",
			untrustedOutput: false,
			scope: "write",
			description:
				"Mark a Gmail message as read. Needs the manage-mail permission.",
			handler: "gmail_mark_read",
			params: {
				message_id: { type: "string", required: true, description: "Message id from gmail_search.", maxLength: 100 },
			},
		},
		{
			name: "gmail_create_filter",
			untrustedOutput: false,
			scope: "write",
			description:
				"Propose a Gmail filter for future mail; each needs the owner's approval. No forwarding, trash, delete or spam.",
			handler: "gmail_create_filter",
			params: {
				from: { type: "string", description: "Sender to match.", maxLength: 300 },
				to: { type: "string", description: "Match the recipient.", maxLength: 300 },
				subject: { type: "string", description: "Subject words.", maxLength: 300 },
				query: { type: "string", description: "Gmail search the message must match.", maxLength: 300 },
				negated_query: { type: "string", description: "Gmail search the message must NOT match.", maxLength: 300 },
				has_attachment: { type: "boolean", description: "Only mail with attachments." },
				actions: { type: "array", required: true, description: "Any of: skip_inbox, mark_read, star, add_label." },
				label: { type: "string", description: "Existing label name (add_label).", maxLength: 200 },
				reason: { type: "string", required: true, description: "Shown to the owner.", maxLength: 500 },
			},
		},
		{
			name: "gmail_download_attachment",
			untrustedOutput: false,
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
const COMPILED_GMAIL: Connector = compileConnector(GMAIL_MANIFEST, {
	gmail_search: searchHandler,
	gmail_read_message: readHandler,
	gmail_download_attachment: downloadHandler,
	gmail_reply: replyHandler,
	gmail_send: sendHandler,
	gmail_draft_reply: draftReplyHandler,
	gmail_draft_send: draftSendHandler,
	gmail_archive: labelChangeHandler("archive"),
	gmail_mark_read: labelChangeHandler("mark_read"),
	gmail_create_filter: createFilterHandler,
}).connector;

/**
 * The compiled connector plus the two facts a manifest has no key for (#352 Stage 2): the callback
 * path Google has registered for Gmail, and that each connected MAILBOX is its own row (#715). With
 * them the generic flow is exactly the dedicated one it replaced — same URI, same rows.
 */
export const GMAIL_CONNECTOR: Connector = {
	...COMPILED_GMAIL,
	// #719: a filter is never created on standing authority — every call is an approval card.
	tools: COMPILED_GMAIL.tools.map((t) => (t.name === "gmail_create_filter" ? { ...t, approval: { everyCall: true as const, prepare: prepareFilterApproval } } : t)),
	oauth: COMPILED_GMAIL.oauth && { ...COMPILED_GMAIL.oauth, redirectPath: "/v1/email/google/callback", identity: { label: "userinfo-email", perAccount: true } },
};
