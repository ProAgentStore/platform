// Sign a coding engine in from any device (#881).
//
// A run whose engine lost its login used to stall on "Not logged in · Please run /login" until
// somebody sat down at the runner. This drives the engine's SUBSCRIPTION login on the runner — the
// paste-code flow for Claude, the device-code flow for Codex — and relays it: the URL and code come
// back here, and the code from the sign-in page goes back in. Subscription login only; it never
// signs an engine in with an API key. The API side is `workers/api/src/routes/coding-reauth.ts`.
//
// Its own file for the reason `coding-engine-tools.ts` is: `coding-tools.ts` is at its size limit.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, type McpEnv, jsonText } from "./http.js";
import { audit, dryRun, requirePermission, type SafetyContext } from "./safety.js";

export function registerCodingReauthTools(
	server: McpServer,
	env: McpEnv,
	tokenFor: (provided?: string) => string | null,
	safetyFor: (provided?: string) => SafetyContext,
): void {
	server.tool(
		"coding_engine_reauth",
		'Sign a coding engine back in from any device when it is blocked on its own login ("Not logged in · Please run /login"; coding_diagnostics `summary.needsReauth`, coding_session_capture `needsReauth`, or a run stopped with `engine_auth`). Subscription login only — never an API key. `start` runs the engine\'s login on the runner in its own terminal and answers `{status, loginState, url, deviceCode, nextStep, lands, warning}`: open `url` on any device and sign in. Claude then shows a code on the page — send it with action `input` (text: the code). Codex and Grok show `deviceCode` to enter at `url` (Grok: sign in with the Grok/grok.com account), and nothing is sent back. `status` reads progress; `cancel` stops it. `lands` says where the credential goes and why the engine reads it there: with a Claude token stored on the platform the relay replaces THAT token (a machine /login would be shadowed by it). On success a run parked on sign-in continues by itself, and `resumableRuns` lists stopped ones to continue with continue_instance_run. The runner must be online.',
		{
			instance_id: z.string().describe("Instance ID"),
			action: z.enum(["start", "status", "input", "cancel"]).describe("start | status | input | cancel"),
			client_type: z.enum(["claude", "codex", "grok"]).optional().describe("Which engine to sign in (start only). Omit for the instance's default engine."),
			text: z.string().optional().describe("For `input`: the code shown on the sign-in page, or a menu choice such as \"1\". Submitted with Enter."),
			keys: z.array(z.enum(["Enter", "Up", "Down", "Escape"])).optional().describe("For `input`: menu keys to press instead of, or after, `text`."),
			dry_run: z.boolean().optional().describe("For `start`/`cancel`: report what would happen, without doing it."),
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ instance_id, action, client_type, text, keys, dry_run, token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			// The code is a one-time credential: its LENGTH is audited, never its value.
			const input = { instance_id, action, client_type, textLength: text?.length ?? 0, keys };
			const base = `/v1/instances/${encodeURIComponent(instance_id)}/coding/engine-reauth`;
			// ONE scope for every action, `runtime`: the tool acts on the machine (it opens a terminal and
			// drives a CLI there), and a tool's published annotation must match the gate it enforces.
			const denied = await requirePermission(safetyFor(token), "runtime", "coding_engine_reauth", input);
			if (denied) return denied;
			if (action === "status") return jsonText(await authedCall(base, sessionToken, {}, env));
			if (dry_run && (action === "start" || action === "cancel")) {
				return dryRun(safetyFor(token), "coding_engine_reauth", `${action} an engine sign-in`, input, {
					endpoint: base,
					method: action === "start" ? "POST" : "DELETE",
					effect:
						action === "start"
							? `Would open a terminal on ${instance_id}'s runner and run the ${client_type ?? "default"} engine's subscription login there, replacing any sign-in already in progress.`
							: "Would stop the sign-in in progress and close its terminal on the runner.",
				});
			}
			const r =
				action === "start"
					? await authedCall(base, sessionToken, { method: "POST", body: JSON.stringify(client_type ? { clientType: client_type } : {}) }, env)
					: action === "input"
						? await authedCall(`${base}/input`, sessionToken, { method: "POST", body: JSON.stringify({ text, keys }) }, env)
						: await authedCall(base, sessionToken, { method: "DELETE" }, env);
			const err = (r as { error?: string } | null)?.error;
			if (!err) await audit(safetyFor(token), { tool: "coding_engine_reauth", action: "completed", input, result: { status: (r as { status?: string }).status ?? null } });
			return jsonText(r);
		},
	);

	// Put a coding CLI on the runner's machine (#1156) — the install half of the preflight's "install it, then sign it in".
	server.tool(
		"coding_engine_install",
		"Install a coding CLI on the machine an instance's runner is on, remotely (#1156) — what coding_engine_get `machine` shows as `installed: false` or a `problem`. Fixed, never your command: Grok is xAI's own installer (`curl -fsSL https://x.ai/cli/install.sh | bash`, a native binary in ~/.grok/bin — not the community npm package of the same name, which bills an API key); Claude, Codex and Gemini are `npm i -g` of their official packages. `start` runs it in its own terminal on the runner (tmux required) and answers at once; `status` reads how it stands — `running`, `succeeded` or `failed` with `exitCode` and the installer's last output — and always includes `engine`, what the machine has for that CLI right now (`installed`, `path`, `version`, `login`, and for Grok `vendor`); `cancel` stops it. Afterwards the CLI still has to be signed in: coding_engine_reauth. Installs software on the owner's machine, so it needs the runtime scope; pass dry_run to see what would run without running it. The runner must be online. Windows machines have no tmux relay: install there by hand (`irm https://x.ai/cli/install.ps1 | iex` for Grok).",
		{
			instance_id: z.string().describe("Instance ID; its runner's machine is the one installed on."),
			action: z.enum(["start", "status", "cancel"]).describe("start | status | cancel"),
			client_type: z.enum(["claude", "codex", "gemini", "grok"]).describe("Which CLI to install."),
			dry_run: z.boolean().optional().describe("For `start`: report what would run on the machine, without running it."),
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
		},
		async ({ instance_id, action, client_type, dry_run, token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, action, client_type };
			const base = `/v1/instances/${encodeURIComponent(instance_id)}/coding/engine-install`;
			// `runtime` for every action: it installs software on the machine and drives a terminal there.
			const denied = await requirePermission(safetyFor(token), "runtime", "coding_engine_install", input);
			if (denied) return denied;
			if (action === "status") return jsonText(await authedCall(`${base}?clientType=${encodeURIComponent(client_type)}`, sessionToken, {}, env));
			if (dry_run && action === "start") {
				return dryRun(safetyFor(token), "coding_engine_install", `install ${client_type} on the runner's machine`, input, {
					endpoint: base,
					method: "POST",
					effect: `Would open a terminal on ${instance_id}'s runner and run the ${client_type} CLI's official installer there (${client_type === "grok" ? "curl -fsSL https://x.ai/cli/install.sh | bash" : `npm i -g ${{ claude: "@anthropic-ai/claude-code", codex: "@openai/codex", gemini: "@google/gemini-cli" }[client_type]}`}).`,
				});
			}
			const r =
				action === "start"
					? await authedCall(base, sessionToken, { method: "POST", body: JSON.stringify({ clientType: client_type }) }, env)
					: await authedCall(`${base}?clientType=${encodeURIComponent(client_type)}`, sessionToken, { method: "DELETE" }, env);
			const err = (r as { error?: string } | null)?.error;
			if (!err) await audit(safetyFor(token), { tool: "coding_engine_install", action: "completed", input, result: { status: (r as { status?: string }).status ?? null } });
			return jsonText(r);
		},
	);
}
