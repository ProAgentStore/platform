// Meta connector — WhatsApp Business Cloud API + Instagram Messaging (issue #89-meta).
// Both are Meta Graph API BUSINESS messaging: send-only, WRITE-scoped (they ride the
// #90 consent gate). Defined as a declarative connector MANIFEST (#146): the shape is data
// (META_MANIFEST); each tool keeps its custom logic (Graph body branching, template-vs-text,
// recipient sanitization) via the manifest `handler` escape hatch. Credentials are platform-level
// env (auth "platform-token" → META_ACCESS_TOKEN) — the operator's Meta business. INERT until the
// Meta app + business accounts + APP REVIEW are complete; with creds unset each tool returns a
// clear "not configured" result instead of failing.
//
// Hard limits imposed by Meta (not us):
// - WhatsApp: outside a 24h customer-service window you can only send a PRE-APPROVED
//   template, not free text. `text` works only inside an open window.
// - Instagram: business/creator account linked to a FB Page; messaging windows apply; no cold-DM.
import type { ToolDef, RegistryToolCtx } from "../tool-registry.js";
import { compileConnector, type ConnectorManifest } from "./manifest.js";
import type { Connector } from "./registry.js";

const GRAPH = "https://graph.facebook.com/v20.0";

// Cap outbound message text. Meta's own limits (WhatsApp 4096, IG 1000) are generous;
// this bounds the platform-credentialed egress so a caller can't push an arbitrarily
// large body through the operator's Meta token.
const MAX_TEXT = 4096;

// Auth via the connectorClient (issue #86): the "meta" connector is auth:"token" backed
// by the platform env META_ACCESS_TOKEN. Caught to null so the handlers keep emitting their
// combined "not configured" message (which also names the missing phone/IG id).
async function metaToken(ctx: RegistryToolCtx): Promise<string | null> {
	return (await ctx.connectorClient?.("meta").token().catch(() => null)) || null;
}

async function graphPost(token: string, path: string, body: unknown): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
	const res = await fetch(`${GRAPH}/${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
	if (!res.ok) return { ok: false, error: `Meta Graph ${res.status}: ${data.error?.message || "request failed"}` };
	return { ok: true, data };
}

const whatsappSendHandler: ToolDef["handler"] = async (ctx, input) => {
	const token = await metaToken(ctx);
	const phoneId = ctx.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
	if (!token || !phoneId) return { content: "WhatsApp Business API not configured (set META_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID after Meta app review).", success: false };
	const to = String(input.to || "").replace(/[^\d+]/g, "");
	if (!to) return { content: "A recipient `to` phone (E.164) is required.", success: false };

	let body: Record<string, unknown>;
	if (input.template_name) {
		const params = String(input.template_params || "").split(",").map((s) => s.trim()).filter(Boolean);
		body = {
			messaging_product: "whatsapp",
			to,
			type: "template",
			template: {
				name: String(input.template_name),
				language: { code: String(input.template_lang || "en_US") },
				...(params.length ? { components: [{ type: "body", parameters: params.map((t) => ({ type: "text", text: t })) }] } : {}),
			},
		};
	} else if (input.text) {
		body = { messaging_product: "whatsapp", to, type: "text", text: { body: String(input.text).slice(0, MAX_TEXT) } };
	} else {
		return { content: "Provide `text` (inside a 24h window) or a `template_name`.", success: false };
	}
	const r = await graphPost(token, `${phoneId}/messages`, body);
	return r.ok ? { content: `WhatsApp message sent to ${to}.`, success: true } : { content: r.error, success: false };
};

const instagramSendHandler: ToolDef["handler"] = async (ctx, input) => {
	const token = await metaToken(ctx);
	const igId = ctx.env.META_IG_ID?.trim();
	if (!token || !igId) return { content: "Instagram messaging not configured (set META_ACCESS_TOKEN + META_IG_ID after Meta app review).", success: false };
	const recipient = String(input.recipient_id || "").trim();
	const text = String(input.text || "").trim().slice(0, MAX_TEXT);
	if (!recipient || !text) return { content: "`recipient_id` and `text` are required.", success: false };
	const r = await graphPost(token, `${igId}/messages`, { recipient: { id: recipient }, message: { text } });
	return r.ok ? { content: `Instagram DM sent to ${recipient}.`, success: true } : { content: r.error, success: false };
};

export const META_MANIFEST: ConnectorManifest = {
	id: "meta",
	label: "Meta (WhatsApp + Instagram)",
	auth: { type: "platform-token", tokenEnv: "META_ACCESS_TOKEN" },
	tools: [
		{
			name: "whatsapp_send_message",
			scope: "write",
			description:
				"Send a WhatsApp message via the WhatsApp Business Cloud API. Use `text` only inside a 24h reply window; otherwise supply `template_name` (a pre-approved template) with `template_lang` and optional `template_params`. WRITE — requires the meta connector's write consent.",
			handler: "whatsapp_send_message",
			params: {
				to: { type: "string", required: true, description: "Recipient phone in E.164, e.g. +14155552671." },
				text: { type: "string", description: "Message text (valid only inside an open 24h window)." },
				template_name: { type: "string", description: "Approved template name (required outside the 24h window)." },
				template_lang: { type: "string", description: "Template language code, e.g. en_US (default en_US)." },
				template_params: { type: "string", description: "Comma-separated body variables for the template, in order." },
			},
		},
		{
			name: "instagram_send_dm",
			scope: "write",
			description:
				"Send/reply to an Instagram Direct Message from a connected Instagram Business account (Instagram Messaging API). Messaging-window rules apply — you can reply to people who messaged you; no cold-DM. WRITE — requires the meta connector's write consent.",
			handler: "instagram_send_dm",
			params: {
				recipient_id: { type: "string", required: true, description: "The recipient's Instagram-scoped ID (IGSID) from an incoming message." },
				text: { type: "string", required: true, description: "The message text." },
			},
		},
	],
};

const compiled = compileConnector(META_MANIFEST, {
	whatsapp_send_message: whatsappSendHandler,
	instagram_send_dm: instagramSendHandler,
});
/** Tool defs (kept for direct-import tests). */
export const META_TOOLS: ToolDef[] = compiled.tools;
/** Compiled Connector — consumed by the registry exactly like a hand-written connector. */
export const META_CONNECTOR: Connector = compiled.connector;
