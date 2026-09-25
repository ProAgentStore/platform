import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * The knobs on an instance and on an agent: typed settings, name, special instructions,
 * model, translation display, read-only DO state, and the creator-side settings schema.
 *
 * Most of these are configuration a human could set in the console; none runs an agent. The
 * exception is resync_instance_personality: it overwrites durable prompt identity from the
 * template, so it is destructive-scoped and confirmed even though it does not delete data.
 */
export function registerSettingsTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"get_instance_behaviour_schema",
		"Read the platform's behaviour field table — labels, allowed bands, and the prompt prose each setting controls. It is static product vocabulary shared by every instance; read it with the instance's behaviour values before explaining or changing a behaviour setting.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			return jsonText(await authedCall("/v1/instances/behaviour-schema", sessionToken, {}, env));
		},
	);

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
		"Pick the model that runs a subscribed instance's BRAIN — its chat and orchestration: reading the terminal, calling tools, driving the coding engine. Brain models (all tool-capable): claude-sonnet-4-6 (most capable · premium cost, needs the owner's Anthropic key); @cf/meta/llama-4-scout-17b-16e-instruct (cheap · fast · good default for light orchestration); @cf/meta/llama-3.3-70b-instruct-fp8-fast (cheap · stronger reasoning · slower); @cf/qwen/qwen2.5-coder-32b-instruct (cheap · code-optimized). A Cloudflare pick runs on the owner's Cloudflare Workers AI credentials even when an Anthropic key is also stored, and is refused when no Cloudflare credentials are stored. A model that cannot call tools is refused, since a brain without tools confabulates instead of acting. Also the way to move an instance off a model it inherited at subscribe (#151).",
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
		"resync_instance_personality",
		"Replace a subscribed instance's personality with its agent template's current seed personality. This is an explicit owner repair for instances created before the template changed — it does NOT touch guardrails, goal, welcomeMessage, model, memory, knowledge, or chat history. It can change how future turns behave, so inspect get_instance_state, dry-run, then confirm. The result says whether anything changed; it returns both personalities for the owner to verify, but the audit records only the instance id and changed flag.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Subscribed instance id from my_instances — not the agent template id."),
			confirm: z.string().optional().describe('Must be "resync_instance_personality" to replace this instance personality.'),
			dry_run: z.boolean().optional().describe("Describe the identity resync without fetching or changing the instance."),
		},
		async ({ token, instance_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "resync_instance_personality", input);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/resync-identity`;
			if (dry_run) {
				return dryRun(safetyFor(token), "resync_instance_personality", "replace the instance personality from its template seed", input, {
					endpoint,
					method: "POST",
					effect: "Only the instance's personality would be replaced. Guardrails, goal, welcomeMessage, model, memory, knowledge, and chat history would remain unchanged.",
					alternative: "Use get_instance_state to inspect the current instance identity; this standard dry run does not fetch the template's personality.",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "resync_instance_personality", confirm, "resync_instance_personality", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(endpoint, sessionToken, { method: "POST" }, env) as { error?: string; changed?: unknown };
			// The route returns current and seed prompt text to its authorised owner. Keep that text
			// out of the durable MCP audit; the audit proves the mutation without becoming a second
			// prompt store.
			if (!data.error) await audit(safetyFor(token), { tool: "resync_instance_personality", action: "completed", input, result: { changed: data.changed === true } });
			return jsonText(data);
		},
	);

	server.tool(
		"get_instance_state",
		"Read a subscribed instance's DO state (identity, guardrails, permissions) and whether anything is running on it. Read-only — permission toggles stay in the console. WHICH FIELD ANSWERS WHAT (#791): `status` (`idle`/`thinking`/`error`) and `inflight` describe the agent's own CHAT TURN and nothing else — an autonomous run drives a separate workflow and leaves both of them idle, so neither is evidence that the instance is free. `runs` is the one to read for that: `runs.active` counts the runs still open on this instance and `runs.runs[]` carries each one's `runId` and `health` — the platform's own verdict, `working`/`waiting`/`stalled`/`ended`. Quote `health` rather than deriving one from the timestamps beside it. Before starting new work, check `runs.active`, not `status`. `runs.active: null` with `unavailable: true` means the lookup FAILED and nothing was measured — it is not the same answer as 0, and must not be read as one. For a live run's engine-level detail use coding_loop_status or coding_loop_trace.",
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
	// ── Voice settings (#613, the voice-settings group) ────────────────────────
	//
	// The per-agent voice override: TTS transport and speed, STT mode and model, language,
	// the end-of-turn knobs, and the voice-command switch. A different table from
	// `get_instance_settings`, which reads the agent's DECLARED typed settings.
	//
	// Three things about the route shape the tools below have to absorb, all verified in
	// `workers/api/src/routes/instances.ts` and `lib/preferences.ts`:
	//
	//  1. GET/PUT/DELETE all answer the same body — `{voiceSettings, hasOverride}` — where
	//     `voiceSettings` is the RESOLVED object (account defaults, then this instance's
	//     override, then a declared `voiceLanguage` setting on top of the language), not the
	//     stored override. `hasOverride` is presence, not difference.
	//  2. PUT is NOT a patch. It sanitizes the body against `overrideVoiceBase(account, current)`
	//     (`lib/preferences.ts:389`), which supplies the ACCOUNT value for every field — so a
	//     field the caller leaves out snaps back to the account default and the rest of the
	//     instance's override is silently discarded. Hence the read-merge-write below; the
	//     console does the same thing for the same reason (`SettingsTab.tsx` `saveVoice`).
	//  3. `vocabulary` UNIONS across scopes instead of overriding (#373), so the GET's value is
	//     account words + this agent's words. Echoing that back would write the account's words
	//     into the agent's own list — the snapshot `overrideVoiceBase`'s docstring exists to
	//     prevent, and it is permanent and invisible once made. So the merge DROPS it, which
	//     makes the route keep the agent's own list untouched.

	server.tool(
		"get_instance_voice_settings",
		"Read a subscribed instance's voice configuration — TTS provider/speed, STT mode/model, language, voice commands, and the end-of-turn knobs. Returns {voiceSettings, hasOverride}: `voiceSettings` is what this agent ACTUALLY uses (your account defaults, then this agent's override, then a declared voiceLanguage setting), and `hasOverride` says whether this agent has its own customisation at all rather than inheriting yours. Inside `voiceSettings`, `inheritedVocabulary` (your account words, which apply here as well) and `derivedVocabulary` (words the platform inferred, e.g. from attached repos) are read-only companions to `vocabulary`, not settings.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/voice-settings`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"set_instance_voice_settings",
		"Customise a subscribed instance's voice configuration. Only the fields you name change — the tool reads the current settings first and sends them back merged, because the route itself re-seeds any unnamed field from your ACCOUNT default rather than keeping this agent's. Writing at all creates the override (hasOverride becomes true); use clear_instance_voice_settings to go back to your account defaults. Numeric fields are clamped by the server to the ranges named below, and the response reports what was actually stored.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			provider: z.enum(["browser", "openai-realtime", "gemini-live"]).optional().describe("TTS transport that reads replies aloud"),
			speed: z.coerce.number().optional().describe("Speech rate, percent (50-200; 100 = normal)"),
			stt_mode: z.enum(["browser", "openai"]).optional().describe("Speech recognition: browser dictation, or OpenAI transcription (needs an OpenAI key in the vault)"),
			stt_model: z.enum(["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"]).optional().describe("Transcription model when stt_mode is openai; gpt-4o-transcribe streams partials, whisper-1 does not"),
			language: z.string().optional().describe("BCP-47 tag for both STT and TTS, e.g. en-US, de-DE, zh-CN. An agent with a declared voiceLanguage setting overrides this at resolve time."),
			commands_enabled: z.boolean().optional().describe("Whether spoken commands (repeat, mute, …) are matched at all"),
			disabled_commands: z.array(z.enum(["repeat", "mute", "unmute", "exit", "next", "back", "scrap"])).optional().describe("Individual voice commands switched OFF; [] means every command is on"),
			sensitivity: z.coerce.number().optional().describe("Mic end-of-turn sensitivity (0.4-2; lower is less likely to hear background noise as speech)"),
			silence_ms: z.coerce.number().optional().describe("Silence that ends a spoken turn, ms (500-6000)"),
			max_dictation_ms: z.coerce.number().optional().describe("Longest single dictation, ms (10000-300000)"),
			tts_max_chars: z.coerce.number().optional().describe("How much of a reply is read aloud, characters (200-4096)"),
			keep_awake: z.boolean().optional().describe("Hold a screen wake lock while voice mode is on"),
			vocabulary: z
				.array(z.string())
				.optional()
				.describe(
					"Words THIS agent's owner says that a recogniser gets wrong (repo names, product names). Replaces this agent's own list; it is ADDED to your account vocabulary rather than replacing it, so leaving it out here never disturbs either list.",
				),
			dry_run: z.boolean().optional(),
		},
		async ({
			token,
			instance_id,
			provider,
			speed,
			stt_mode,
			stt_model,
			language,
			commands_enabled,
			disabled_commands,
			sensitivity,
			silence_ms,
			max_dictation_ms,
			tts_max_chars,
			keep_awake,
			vocabulary,
			dry_run,
		}) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const patch: Record<string, unknown> = {};
			if (provider !== undefined) patch.provider = provider;
			if (speed !== undefined) patch.speed = speed;
			if (stt_mode !== undefined) patch.sttMode = stt_mode;
			if (stt_model !== undefined) patch.sttModel = stt_model;
			if (language !== undefined) patch.language = language;
			if (commands_enabled !== undefined) patch.commandsEnabled = commands_enabled;
			if (disabled_commands !== undefined) patch.disabledCommands = disabled_commands;
			if (sensitivity !== undefined) patch.sensitivity = sensitivity;
			if (silence_ms !== undefined) patch.silenceMs = silence_ms;
			if (max_dictation_ms !== undefined) patch.maxDictationMs = max_dictation_ms;
			if (tts_max_chars !== undefined) patch.ttsMaxChars = tts_max_chars;
			if (keep_awake !== undefined) patch.keepAwake = keep_awake;
			if (vocabulary !== undefined) patch.vocabulary = vocabulary;
			const fields = Object.keys(patch);
			// Refuse rather than send: an empty body through this route is not a no-op, it is
			// "replace the override with your account defaults" — which is what the clear tool is
			// for, and is never what a caller who named no field meant.
			if (fields.length === 0) {
				return jsonText({
					error: "nothing to update — name at least one voice field, or use clear_instance_voice_settings to go back to your account defaults",
				});
			}
			const input = { instance_id, fields };
			const denied = await requirePermission(safetyFor(token), "write", "set_instance_voice_settings", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_instance_voice_settings", "update instance voice settings", input, {
					endpoint: `/v1/instances/${instance_id}/voice-settings`,
					method: "PUT",
					fields,
				});
			}
			// Read first. The PUT rebuilds the whole override from the account defaults, so sending
			// the patch alone would reset every field the caller did not name.
			const current = await authedCall(`/v1/instances/${instance_id}/voice-settings`, sessionToken, {}, env);
			if ((current as { error?: string }).error) return jsonText(current);
			const existing = (current as { voiceSettings?: Record<string, unknown> }).voiceSettings ?? {};
			// `vocabulary` and its two read-only companions are removed before the merge — see the
			// header comment. Dropping `vocabulary` is what keeps the union a union.
			const { vocabulary: _resolvedVocabulary, inheritedVocabulary: _inherited, derivedVocabulary: _derived, ...carried } = existing;
			const data = await authedCall(
				`/v1/instances/${instance_id}/voice-settings`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ ...carried, ...patch }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "set_instance_voice_settings", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"clear_instance_voice_settings",
		"Drop a subscribed instance's voice override so it inherits your account voice preferences again (the console's \"Use my defaults\"). Answers the same shape as get_instance_voice_settings, now resolved from your account, with hasOverride false. Your account preferences are untouched — set those with set_account_preferences.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id };
			const denied = await requirePermission(safetyFor(token), "write", "clear_instance_voice_settings", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "clear_instance_voice_settings", "drop instance voice override", input, {
					endpoint: `/v1/instances/${instance_id}/voice-settings`,
					method: "DELETE",
				});
			}
			const data = await authedCall(`/v1/instances/${instance_id}/voice-settings`, sessionToken, { method: "DELETE" }, env);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "clear_instance_voice_settings", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
}
