// Meta connector — WhatsApp Business Cloud API + Instagram Messaging (issue #89-meta).
// Both are Meta Graph API BUSINESS messaging: send-only, WRITE-scoped (they ride the
// #90 consent gate). Credentials are platform-level env (the operator's Meta business)
// for now — per-instance BYO-creds is a follow-up. INERT until you complete the Meta
// app + business accounts + APP REVIEW (instagram/whatsapp messaging permissions);
// with creds unset each tool returns a clear "not configured" result instead of failing.
//
// Hard limits imposed by Meta (not us):
// - WhatsApp: outside a 24h customer-service window you can only send a PRE-APPROVED
//   template, not free text. `text` works only inside an open window.
// - Instagram: business/creator account linked to a FB Page; messaging windows apply;
//   no cold-DM.
import type { RegistryTool, RegistryToolCtx } from "../tool-registry.js";

const GRAPH = "https://graph.facebook.com/v20.0";

function metaToken(ctx: RegistryToolCtx): string | null {
	return ctx.env.META_ACCESS_TOKEN?.trim() || null;
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

export const META_TOOLS: RegistryTool[] = [
	{
		name: "whatsapp_send_message",
		connector: "meta",
		scope: "write",
		description:
			"Send a WhatsApp message via the WhatsApp Business Cloud API. Use `text` only inside a 24h reply window; otherwise supply `template_name` (a pre-approved template) with `template_lang` and optional `template_params`. WRITE — requires the meta connector's write consent.",
		parameters: {
			to: { type: "string", description: "Recipient phone in E.164, e.g. +14155552671.", required: true },
			text: { type: "string", description: "Message text (valid only inside an open 24h window)." },
			template_name: { type: "string", description: "Approved template name (required outside the 24h window)." },
			template_lang: { type: "string", description: "Template language code, e.g. en_US (default en_US)." },
			template_params: { type: "string", description: "Comma-separated body variables for the template, in order." },
		},
		handler: async (ctx, input) => {
			const token = metaToken(ctx);
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
				body = { messaging_product: "whatsapp", to, type: "text", text: { body: String(input.text) } };
			} else {
				return { content: "Provide `text` (inside a 24h window) or a `template_name`.", success: false };
			}
			const r = await graphPost(token, `${phoneId}/messages`, body);
			return r.ok ? { content: `WhatsApp message sent to ${to}.`, success: true } : { content: r.error, success: false };
		},
	},
	{
		name: "instagram_send_dm",
		connector: "meta",
		scope: "write",
		description:
			"Send/reply to an Instagram Direct Message from a connected Instagram Business account (Instagram Messaging API). Messaging-window rules apply — you can reply to people who messaged you; no cold-DM. WRITE — requires the meta connector's write consent.",
		parameters: {
			recipient_id: { type: "string", description: "The recipient's Instagram-scoped ID (IGSID) from an incoming message.", required: true },
			text: { type: "string", description: "The message text.", required: true },
		},
		handler: async (ctx, input) => {
			const token = metaToken(ctx);
			const igId = ctx.env.META_IG_ID?.trim();
			if (!token || !igId) return { content: "Instagram messaging not configured (set META_ACCESS_TOKEN + META_IG_ID after Meta app review).", success: false };
			const recipient = String(input.recipient_id || "").trim();
			const text = String(input.text || "").trim();
			if (!recipient || !text) return { content: "`recipient_id` and `text` are required.", success: false };
			const r = await graphPost(token, `${igId}/messages`, { recipient: { id: recipient }, message: { text } });
			return r.ok ? { content: `Instagram DM sent to ${recipient}.`, success: true } : { content: r.error, success: false };
		},
	},
];
