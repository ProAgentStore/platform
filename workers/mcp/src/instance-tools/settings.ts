import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * The knobs on an instance and on an agent: typed settings, name, special instructions,
 * model, translation display, read-only DO state, and the creator-side settings schema.
 *
 * Every one of these is configuration a human could set in the console; none of them runs
 * anything. So the group is entirely `write`-or-read, with no confirmation and no runtime
 * scope — which is the fastest way to see that a new tool does not belong here.
 */
export function registerSettingsTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"get_instance_settings",
		"Read a subscribed instance's typed agent settings (values + the agent's declared settings schema, e.g. Language Buddy's target language).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/settings`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_instance_settings",
		"Update a subscribed instance's typed agent settings (patch — only sent fields change; a voiceLanguage field also syncs the voice STT/TTS language).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			settings: z.record(z.unknown()).describe("Field id → new value, per the agent's settings schema"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, settings, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, fields: Object.keys(settings) };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_settings", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_instance_settings", "update instance agent settings", input, {
					endpoint: `/v1/instances/${instance_id}/settings`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/settings`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ settings }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_instance_settings", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"rename_instance",
		"Set (or clear) a subscribed instance's display name — how it appears in the console when you run several instances of the same agent.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			name: z.string().optional().describe("New display name (max 60 chars). Omit or empty to reset to the agent's name."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, name, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, name: name ?? "" };
			const denied = await requirePermission(safetyFor(token), "write", "rename_instance", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "rename_instance", "rename instance", input, {
					endpoint: `/v1/instances/${instance_id}/name`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/name`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ name: name ?? "" }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "rename_instance", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"get_instance_operator_manual",
		"Read the operator manual for a subscribed instance — caller-facing notes about HOW this instance is meant to be driven (not an instruction to the agent). Returns { manual, rules, context }: `manual` is the stored document, `rules` echoes the agent's Special Instructions so you can see the standing orders that will make it refuse things, `context` is reserved.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/operator-manual`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_instance_operator_manual",
		"Replace the operator manual for a subscribed instance (max 16000 chars). The manual is caller-facing guidance — notes for the human or MCP client driving this instance. It is NOT injected as an agent instruction; it is fenced as data when the agent reads it via read_operator_manual. To write the agent's standing orders instead, use set_instance_instructions.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			manual: z.string().describe("The full new operator manual text (replaces the old one; empty string clears it)"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, manual, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, bytes: manual.length };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_operator_manual", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_instance_operator_manual", "replace instance operator manual", input, {
					endpoint: `/v1/instances/${instance_id}/operator-manual`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/operator-manual`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ manual }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_instance_operator_manual", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"get_instance_instructions",
		"Read a subscribed instance's Special Instructions (the subscriber's free-text rules injected at the top of the agent's prompt — console Knowledge → Rules & Tips).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/instructions`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_instance_instructions",
		"Replace a subscribed instance's Special Instructions (max 4000 chars; these override the agent's defaults).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			instructions: z.string().describe("The full new rules text (replaces the old text; empty string clears)"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, instructions, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, bytes: instructions.length };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_instructions", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_instance_instructions", "replace instance special instructions", input, {
					endpoint: `/v1/instances/${instance_id}/instructions`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/instructions`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ instructions }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_instance_instructions", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"set_instance_model",
		"Change a subscribed instance's chat model — the programmatic path to move an instance off a model stuck from a pre-fix subscribe (#151). An instance copies its model at subscribe and never re-reads the template, so a pre-fix instance can be frozen on a non-tool-capable model (it then confabulates instead of querying its collections). Recommended tool-capable Cloudflare models: @cf/meta/llama-4-scout-17b-16e-instruct (default), @cf/meta/llama-3.3-70b-instruct-fp8-fast, @cf/mistralai/mistral-small-3.1-24b-instruct, @cf/qwen/qwen2.5-coder-32b-instruct. BYOK Anthropic (e.g. claude-sonnet-4-6) is tool-capable and used when the owner has an Anthropic key.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			model: z.string().describe('The model id to set, e.g. "@cf/meta/llama-4-scout-17b-16e-instruct" or "claude-sonnet-4-6".'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, model, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const m = String(model || "").trim();
			if (!m) return jsonText({ error: "A non-empty `model` id is required." });
			const input = { instance_id, model: m };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_model", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_instance_model", `set instance model to ${m}`, input, {
					endpoint: `/v1/instances/${instance_id}/state`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/state`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ model: m }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_instance_model", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"get_translation_config",
		"Read a subscribed instance's translation display config (translation under messages, transliteration/pinyin, word-tap pronunciation, font size).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/translation`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_translation_config",
		"Update a subscribed instance's translation display config. Only sent fields change.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			enabled: z.boolean().optional().describe("Show a translation under every message"),
			target: z.string().optional().describe("Translation target language name (e.g. English)"),
			transliterate: z.boolean().optional().describe("Word-by-word interlinear transliteration (e.g. pinyin for Chinese)"),
			word_tap: z.boolean().optional().describe("Tap a word to hear it pronounced"),
			font_size: z.string().optional().describe("Interlinear text size: small | medium | large"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, enabled, target, transliterate, word_tap, font_size, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const patch: Record<string, unknown> = {};
			if (enabled !== undefined) patch.enabled = enabled;
			if (target !== undefined) patch.target = target;
			if (transliterate !== undefined) patch.transliterate = transliterate;
			if (word_tap !== undefined) patch.wordTap = word_tap;
			if (font_size !== undefined) patch.fontSize = font_size;
			const input = { instance_id, ...patch };
			const denied = await requirePermission(safetyFor(token), "write", "set_translation_config", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_translation_config", "update instance translation config", input, {
					endpoint: `/v1/instances/${instance_id}/translation`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/translation`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify(patch) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_translation_config", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"get_instance_state",
		"Read a subscribed instance's DO state (identity, guardrails, permissions). Read-only — permission toggles stay in the console.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/state`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	// ── Creator: agent settings schema ─────────────────────────────────────────

	server.tool(
		"get_agent_settings_schema",
		"Read an agent's declared typed settings schema (creator view — the fields subscribers see in Settings → Agent settings).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			agent_id: z.string(),
		},
		async ({ token, agent_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/agents/${agent_id}/settings-schema`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_agent_settings_schema",
		"Replace an agent's typed settings schema (owner only). Fields: {id, label, type: select|text|number|toggle, options?, default?, description?, voiceLanguage?, prompt?}. Max 12 fields.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			agent_id: z.string(),
			settings_schema: z.array(z.record(z.unknown())).describe("The full schema array (replaces the old one; [] clears)"),
			dry_run: z.boolean().optional(),
		},
		async ({ token, agent_id, settings_schema, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { agent_id, fields: settings_schema.length };
			const denied = await requirePermission(safetyFor(token), "write", "set_agent_settings_schema", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_agent_settings_schema", "replace agent settings schema", input, {
					endpoint: `/v1/agents/${agent_id}/settings-schema`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/agents/${agent_id}/settings-schema`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ settingsSchema: settings_schema }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_agent_settings_schema", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
}
